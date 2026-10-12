// Cobranças automáticas (opcional por loja) e confirmação segura do pagamento.
//
// Provedores para o QR da mesa (migração 027): Mercado Pago, PagBank (PagSeguro), Getnet e InfinitePay.
// O PDV e o delivery continuam usando o Mercado Pago (token salvo em Configurações › Pagamentos).
// Regra de ouro contra fraude: um pagamento só vira "pago" quando o PROVEDOR confirma,
// seja por consulta direta à API dele, seja por aviso (webhook) protegido pelo segredo da loja
// e conferido de novo na API quando o provedor permite.
//
// Ações:
//   pix_criar  { token }            → cliente do delivery gera a cobrança do pedido (público, Mercado Pago)
//   pix_criar  { valor, descricao } → caixa do PDV gera uma cobrança (logado, Mercado Pago)
//   pix_status { token } | { payment_id } → consulta e, se aprovado, marca o pedido como pago
//   mesa_pix_criar  { mesa, valor, retorno? }  → cliente na mesa paga parte ou toda a conta (público)
//   mesa_pix_status { mesa, pagamento_id, transaction_nsu?, slug? } → consulta no provedor
//   webhook ?acao=webhook&e=<empresa>[&p=<provedor>&k=<segredo>] → aviso do provedor
import { createClient } from "npm:@supabase/supabase-js@2";
import { sessaoSuporte } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
class Erro extends Error { constructor(public status: number, m: string) { super(m); } }
const MP = "https://api.mercadopago.com";
const UUID = /^[0-9a-f-]{36}$/i;
const centavos = (v: number) => Math.round(Number(v) * 100);
const r2 = (v: number) => Math.round(Number(v) * 100) / 100;
const NOME_PROV: Record<string, string> = { mercadopago: "Mercado Pago", pagbank: "PagBank", getnet: "Getnet", infinitepay: "InfinitePay" };

/** Data ISO no fuso de Brasília (PagBank exige o deslocamento). */
const isoBrasilia = (msAFrente: number) => new Date(Date.now() + msAFrente - 3 * 3600e3).toISOString().slice(0, 19) + "-03:00";

/** Compara textos sem vazar tempo (segredo do webhook). */
function iguais(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function http(nome: string, url: string, init: RequestInit) {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Erro(502, `Sem resposta do ${nome}. Tente de novo.`); }
  const txt = await res.text();
  let dados: any = {};
  try { dados = txt ? JSON.parse(txt) : {}; } catch { dados = { bruto: txt.slice(0, 300) }; }
  if (!res.ok) {
    const msg = dados?.message || dados?.error_messages?.[0]?.description || dados?.details?.[0]?.description || dados?.error_description || dados?.error;
    const e = new Erro(502, msg ? `${nome}: ${String(msg).slice(0, 160)}` : `Falha ao falar com o ${nome} (${res.status})`);
    (e as any).http = res.status;
    throw e;
  }
  return dados;
}

async function mp(token: string, method: string, path: string, body?: unknown, idem?: string) {
  return http("Mercado Pago", MP + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(idem ? { "X-Idempotency-Key": idem } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const resumo = (p: any) => ({
  id: String(p.id), status: p.status,
  qr_code: p.point_of_interaction?.transaction_data?.qr_code ?? null,
  qr_code_base64: p.point_of_interaction?.transaction_data?.qr_code_base64 ?? null,
  expira_em: p.date_of_expiration ?? null,
});

// ---------------------------------------------------------------------
// Integração da loja
// ---------------------------------------------------------------------
type Integ = { provedor: string | null; ambiente: string; credenciais: Record<string, string>; mp_access_token: string | null; webhook_segredo: string };

function provedorAtivo(i: Integ | null): string | null {
  if (!i) return null;
  const c = i.credenciais || {};
  const p = i.provedor || (i.mp_access_token ? "mercadopago" : null);
  if (p === "mercadopago") return i.mp_access_token ? p : null;
  if (p === "pagbank") return c.pagbank_token ? p : null;
  if (p === "getnet") return c.getnet_client_id && c.getnet_client_secret && c.getnet_seller_id ? p : null;
  if (p === "infinitepay") return c.infinitepay_handle ? p : null;
  return null;
}

type Cobranca = { ref: string; qr_code?: string | null; qr_code_base64?: string | null; link?: string | null; expira_em?: string | null };
type Consulta = { pago: boolean; valor?: number; status: string };
type Dados = { id: string; valor: number; descricao: string; aviso: string; retorno?: string | null; doc?: string | null; mesa: string };

// ---------- PagBank (PagSeguro) ----------
const pbBase = (i: Integ) => i.ambiente === "teste" ? "https://sandbox.api.pagseguro.com" : "https://api.pagseguro.com";
const pbHeaders = (i: Integ, idem?: string) => ({
  Authorization: `Bearer ${i.credenciais.pagbank_token}`, "Content-Type": "application/json", accept: "application/json",
  ...(idem ? { "x-idempotency-key": idem } : {}),
});
async function pagbankConsultar(i: Integ, ref: string): Promise<Consulta & { reference_id?: string }> {
  const o = await http("PagBank", `${pbBase(i)}/orders/${encodeURIComponent(ref)}`, { method: "GET", headers: pbHeaders(i) });
  const pagas = (o.charges || []).filter((c: any) => c.status === "PAID");
  const valor = pagas.reduce((a: number, c: any) => a + Number(c.amount?.summary?.paid ?? c.amount?.value ?? 0), 0) / 100;
  return { pago: pagas.length > 0, valor, status: pagas.length ? "PAID" : (o.charges?.[0]?.status || "WAITING"), reference_id: o.reference_id };
}

// ---------- Getnet ----------
const gnBase = (i: Integ) => i.ambiente === "teste" ? "https://api-homologacao.getnet.com.br" : "https://api.getnet.com.br";
async function getnetToken(i: Integ) {
  const basic = btoa(`${i.credenciais.getnet_client_id}:${i.credenciais.getnet_client_secret}`);
  const t = await http("Getnet", `${gnBase(i)}/auth/oauth/v2/token`, {
    method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "scope=oob&grant_type=client_credentials",
  });
  if (!t.access_token) throw new Erro(502, "Getnet: credenciais recusadas");
  return t.access_token as string;
}
async function getnetConsultar(i: Integ, ref: string): Promise<Consulta | null> {
  // Consulta direta (quando a conta Getnet tem o serviço); sem ela vale o aviso protegido pelo segredo
  try {
    const tk = await getnetToken(i);
    const p = await http("Getnet", `${gnBase(i)}/v1/payments/qrcode/${encodeURIComponent(ref)}`, {
      method: "GET", headers: { Authorization: `Bearer ${tk}`, seller_id: i.credenciais.getnet_seller_id },
    });
    const st = String(p.status || p.payment?.status || "").toUpperCase();
    const amount = Number(p.amount ?? p.payment?.amount ?? 0);
    return { pago: st === "APPROVED" || st === "PAID", valor: amount ? amount / 100 : undefined, status: st || "WAITING" };
  } catch { return null; }
}

// ---------- InfinitePay ----------
const IP = "https://api.checkout.infinitepay.io";
async function infinitepayConsultar(i: Integ, orderNsu: string, transactionNsu: string, slug: string): Promise<Consulta> {
  const r = await http("InfinitePay", `${IP}/payment_check`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: i.credenciais.infinitepay_handle, order_nsu: orderNsu, transaction_nsu: transactionNsu, slug }),
  });
  const valor = Number(r.paid_amount ?? r.amount ?? 0) / 100;
  return { pago: !!(r.success && r.paid), valor, status: r.paid ? "paid" : "pending" };
}

/** Cria a cobrança no provedor da loja. */
async function criarCobranca(prov: string, i: Integ, d: Dados): Promise<Cobranca> {
  const cents = centavos(d.valor);
  if (prov === "mercadopago") {
    const p = await mp(i.mp_access_token!, "POST", "/v1/payments", {
      transaction_amount: d.valor, payment_method_id: "pix", description: d.descricao.slice(0, 60), external_reference: `mp:${d.id}`,
      payer: { email: "pagador@cliente.com.br" }, notification_url: d.aviso,
      date_of_expiration: new Date(Date.now() + 30 * 60e3).toISOString().replace("Z", "-00:00"),
    }, `mesa-${d.id}`);
    return { ref: String(p.id), ...resumo(p) };
  }
  if (prov === "pagbank") {
    const corpo: Record<string, unknown> = {
      reference_id: `mp:${d.id}`,
      items: [{ name: d.descricao.slice(0, 64), quantity: 1, unit_amount: cents }],
      qr_codes: [{ amount: { value: cents }, expiration_date: isoBrasilia(30 * 60e3) }],
      notification_urls: [d.aviso],
    };
    // O PagBank pede um comprador: usa a própria loja (o cliente da mesa é anônimo)
    if (d.doc && (d.doc.length === 11 || d.doc.length === 14)) corpo.customer = { name: `Cliente ${d.mesa}`.slice(0, 60), email: "cliente.mesa@lispdv.com.br", tax_id: d.doc };
    const o = await http("PagBank", `${pbBase(i)}/orders`, { method: "POST", headers: pbHeaders(i, `mesa-${d.id}`), body: JSON.stringify(corpo) });
    const qr = o.qr_codes?.[0];
    if (!qr?.text) throw new Erro(502, "PagBank não devolveu o QR do PIX");
    return { ref: String(o.id), qr_code: qr.text, expira_em: qr.expiration_date ?? null };
  }
  if (prov === "getnet") {
    const tk = await getnetToken(i);
    const p = await http("Getnet", `${gnBase(i)}/v1/payments/qrcode/pix`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tk}`, seller_id: i.credenciais.getnet_seller_id, "x-qrcode-expiration-time": "1800", "Content-Type": "application/json" },
      body: JSON.stringify({ amount: cents, currency: "BRL", order_id: d.id, customer_id: `mesa-${d.id.slice(0, 8)}` }),
    });
    const qr = p.additional_data?.qr_code;
    if (!p.payment_id || !qr) throw new Erro(502, "Getnet não devolveu o QR do PIX");
    return { ref: String(p.payment_id), qr_code: qr, expira_em: p.additional_data?.expiration_date_qrcode ?? null };
  }
  if (prov === "infinitepay") {
    const r = await http("InfinitePay", `${IP}/links`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: i.credenciais.infinitepay_handle, order_nsu: d.id,
        items: [{ quantity: 1, price: cents, description: d.descricao.slice(0, 80) }],
        webhook_url: d.aviso, ...(d.retorno ? { redirect_url: d.retorno } : {}),
      }),
    });
    const link = r.url || r.link || r.checkout_url || r.payment_url || r.data?.url;
    if (!link || !/^https:\/\//.test(String(link))) throw new Erro(502, "InfinitePay não devolveu o link de pagamento");
    return { ref: String(r.slug || r.invoice_slug || r.id || ""), link: String(link) };
  }
  throw new Erro(400, "Provedor não configurado");
}

/** Consulta o pagamento no provedor. null = provedor não permite consulta agora (espera o aviso). */
async function consultarCobranca(prov: string, i: Integ, pg: any, extra: { transaction_nsu?: string; slug?: string }): Promise<Consulta | null> {
  if (prov === "mercadopago") {
    if (!pg.mp_id) return null;
    const p = await mp(i.mp_access_token!, "GET", `/v1/payments/${encodeURIComponent(pg.mp_id)}`);
    return { pago: p.status === "approved", valor: Number(p.transaction_amount), status: p.status };
  }
  if (prov === "pagbank") return pg.mp_id ? await pagbankConsultar(i, pg.mp_id) : null;
  if (prov === "getnet") return pg.mp_id ? await getnetConsultar(i, pg.mp_id) : null;
  if (prov === "infinitepay") {
    const tnsu = String(extra.transaction_nsu || ""), slug = String(extra.slug || pg.mp_id || "");
    if (!/^[\w-]{3,80}$/.test(tnsu) || !/^[\w-]{3,80}$/.test(slug)) return null;
    return await infinitepayConsultar(i, pg.id, tnsu, slug);
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const integracao = async (empresa_id: string) => {
    const { data } = await admin.from("integracoes_pagamento")
      .select("provedor, ambiente, credenciais, mp_access_token, webhook_segredo").eq("empresa_id", empresa_id).maybeSingle();
    return (data as Integ | null) ?? null;
  };
  const tokenDaLoja = async (empresa_id: string) => (await integracao(empresa_id))?.mp_access_token ?? undefined;
  const marcarPago = async (vendaId: string, empresaId: string) => {
    await admin.from("vendas").update({ pagamento_status: "pago", pago_em: new Date().toISOString(), alterado_em: new Date().toISOString() })
      .eq("id", vendaId).eq("empresa_id", empresaId).eq("status", "aberta");
  };
  const urlAviso = (emp: string, prov?: string, segredo?: string) =>
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/pagamentos?acao=webhook&e=${emp}` + (prov && prov !== "mercadopago" ? `&p=${prov}&k=${segredo}` : "");

  // Pagamento da mesa confirmado pelo provedor: confere loja e valor (centavo a centavo) antes de marcar.
  // O gatilho do banco avisa o garçom.
  const marcarMesaPaga = async (id: string, empresaId: string, valorPago: number | undefined, ref?: string) => {
    if (!UUID.test(id)) return false;
    const { data: pg } = await admin.from("mesa_pagamentos").select("id, valor, status").eq("id", id).eq("empresa_id", empresaId).maybeSingle();
    if (!pg || pg.status !== "pendente") return pg?.status === "pago";
    if (valorPago !== undefined && centavos(valorPago) < centavos(pg.valor)) { console.warn("valor pago menor", id, valorPago, pg.valor); return false; }
    const { data } = await admin.from("mesa_pagamentos").update({ status: "pago", pago_em: new Date().toISOString(), ...(ref ? { mp_id: ref } : {}) })
      .eq("id", id).eq("status", "pendente").select("id");
    return !!data?.length;
  };

  try {
    // ---------- Aviso do provedor (webhook) ----------
    if (url.searchParams.get("acao") === "webhook") {
      const empresa = url.searchParams.get("e") || "";
      const prov = url.searchParams.get("p") || "mercadopago";
      if (!UUID.test(empresa)) return json({ ok: true });
      const corpo: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      const q = (k: string) => corpo?.[k] ?? url.searchParams.get(k);
      const i = await integracao(empresa);
      if (!i) return json({ ok: true });

      if (prov === "mercadopago") {
        const id = corpo?.data?.id || url.searchParams.get("data.id") || url.searchParams.get("id");
        const tipo = corpo?.type || url.searchParams.get("type") || url.searchParams.get("topic");
        if (!id || (tipo && tipo !== "payment") || !i.mp_access_token) return json({ ok: true });
        // Nunca confia no corpo do aviso: consulta o pagamento direto no Mercado Pago
        const p = await mp(i.mp_access_token, "GET", `/v1/payments/${encodeURIComponent(String(id))}`);
        const ref = String(p.external_reference || "");
        if (p.status === "approved" && ref.startsWith("v:")) await marcarPago(ref.slice(2), empresa);
        if (p.status === "approved" && ref.startsWith("mp:")) await marcarMesaPaga(ref.slice(3), empresa, Number(p.transaction_amount), String(p.id));
        return json({ ok: true });
      }

      // Demais provedores: o endereço do aviso leva o segredo da loja
      if (!iguais(url.searchParams.get("k") || "", i.webhook_segredo || "")) return json({ error: "Aviso não autorizado" }, 401);

      if (prov === "pagbank" && i.credenciais?.pagbank_token) {
        const id = String(corpo?.id || "");
        if (!/^[\w-]{5,80}$/.test(id)) return json({ ok: true });
        const c = await pagbankConsultar(i, id); // confere na API, não no corpo do aviso
        const ref = String(c.reference_id || "");
        if (c.pago && ref.startsWith("mp:")) await marcarMesaPaga(ref.slice(3), empresa, c.valor, id);
        return json({ ok: true });
      }

      if (prov === "getnet" && i.credenciais?.getnet_seller_id) {
        const orderId = String(q("order_id") || ""), paymentId = String(q("payment_id") || "");
        const status = String(q("status") || "").toUpperCase();
        if (!UUID.test(orderId) || !paymentId) return json({ ok: true });
        const { data: pg } = await admin.from("mesa_pagamentos").select("id, mp_id, valor").eq("id", orderId).eq("empresa_id", empresa).maybeSingle();
        if (!pg || pg.mp_id !== paymentId) return json({ ok: true }); // só a cobrança que nós criamos
        const c = await getnetConsultar(i, paymentId);
        const pago = c ? c.pago : status === "APPROVED";
        const valor = c?.valor ?? (q("amount") ? Number(q("amount")) / 100 : undefined);
        if (pago) await marcarMesaPaga(pg.id, empresa, valor);
        return json({ ok: true });
      }

      if (prov === "infinitepay" && i.credenciais?.infinitepay_handle) {
        const orderNsu = String(corpo?.order_nsu || ""), tnsu = String(corpo?.transaction_nsu || ""), slug = String(corpo?.invoice_slug || "");
        if (!UUID.test(orderNsu) || !tnsu || !slug) return json({ ok: true });
        const c = await infinitepayConsultar(i, orderNsu, tnsu, slug); // confere na InfinitePay
        if (c.pago) await marcarMesaPaga(orderNsu, empresa, c.valor, slug);
        return json({ ok: true });
      }
      return json({ ok: true });
    }

    if (req.method !== "POST") throw new Erro(405, "Método não permitido");
    const body = await req.json().catch(() => ({}));

    // ---------- Cliente na mesa pelo QR Code (sem login) ----------
    if (body.mesa) {
      if (!UUID.test(String(body.mesa))) throw new Erro(400, "QR Code inválido");
      const { data: m } = await admin.from("mesas").select("id, empresa_id, nome, ativo").eq("qr_token", body.mesa).maybeSingle();
      if (!m || !m.ativo) throw new Erro(404, "QR Code inválido ou desativado");
      const { data: e } = await admin.from("empresas").select("nome_fantasia, razao_social, cnpj, config_restaurante").eq("id", m.empresa_id).single();
      const cfg = (e?.config_restaurante || {}) as Record<string, unknown>;
      if (cfg.qr_ativo === false || cfg.qr_pagar === false || cfg.qr_pagar_auto === false) throw new Erro(403, "Pagamento pelo QR desligado nesta loja. Chame o garçom.");
      const i = await integracao(m.empresa_id);
      const prov = provedorAtivo(i);
      if (!i || !prov) throw new Erro(400, "Esta loja confere o PIX pelo garçom");

      if (body.acao === "mesa_pix_status") {
        if (!UUID.test(String(body.pagamento_id))) throw new Erro(400, "Pagamento inválido");
        const { data: pg } = await admin.from("mesa_pagamentos").select("id, status, mp_id, valor, empresa_id, provedor")
          .eq("id", body.pagamento_id).eq("mesa_id", m.id).maybeSingle();
        if (!pg) throw new Erro(404, "Pagamento não encontrado");
        if (pg.status === "pago") return json({ status: "approved", pago: true, valor: Number(pg.valor) });
        if (pg.status !== "pendente") return json({ status: pg.status, pago: false });
        const c = await consultarCobranca(pg.provedor || prov, i, pg, { transaction_nsu: body.transaction_nsu, slug: body.slug }).catch(() => null);
        if (c?.pago) {
          const ok = await marcarMesaPaga(pg.id, pg.empresa_id, c.valor, (pg.provedor === "infinitepay" && body.slug) ? String(body.slug) : undefined);
          return json({ status: ok ? "approved" : "divergente", pago: ok, valor: Number(pg.valor) });
        }
        return json({ status: c?.status || "pending", pago: false });
      }

      if (body.acao === "mesa_pix_criar") {
        const { data: v } = await admin.from("vendas").select("id, numero, total, status")
          .eq("mesa_id", m.id).eq("status", "aberta").eq("canal", "mesa").order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (!v) throw new Erro(400, "A conta desta mesa já foi fechada");
        const [{ data: pagos }, { data: avisos }] = await Promise.all([
          admin.from("mesa_pagamentos").select("id, valor, status, mp_id, link, provedor, criado_em").eq("venda_id", v.id),
          admin.from("mesa_chamados").select("valor").eq("venda_id", v.id).eq("tipo", "pix").eq("status", "pendente").eq("automatico", false),
        ]);
        const pago = (pagos || []).filter((x) => x.status === "pago").reduce((a, x) => a + Number(x.valor), 0);
        const informado = (avisos || []).reduce((a, x) => a + Number(x.valor), 0);
        const falta = r2(Number(v.total) - pago - informado);
        if (falta < 0.01) throw new Erro(400, informado > 0 ? "O restante já foi informado como pago. Aguarde o garçom conferir." : "Esta conta já está paga");
        const valor = r2(Number(body.valor));
        if (!(valor >= 0.01) || valor > falta + 0.001) throw new Erro(400, `Valor inválido. Falta pagar R$ ${falta.toFixed(2).replace(".", ",")}`);
        const pendentes = (pagos || []).filter((x) => x.status === "pendente");
        // Mesmo valor pedido há pouco no mesmo provedor: reaproveita a cobrança (não cria várias para o mesmo toque)
        const igual = pendentes.find((x) => Number(x.valor) === valor && (x.mp_id || x.link) && (x.provedor || "mercadopago") === prov
          && Date.now() - new Date(x.criado_em).getTime() < 20 * 60e3);
        if (igual && prov === "mercadopago") {
          const atual = await mp(i.mp_access_token!, "GET", `/v1/payments/${igual.mp_id}`);
          if (atual.status === "approved") { await marcarMesaPaga(igual.id, m.empresa_id, Number(atual.transaction_amount)); return json({ ...resumo(atual), provedor: prov, pagamento_id: igual.id, pago: true }); }
          if (atual.status === "pending") return json({ ...resumo(atual), provedor: prov, pagamento_id: igual.id });
        } else if (igual && igual.link) {
          return json({ provedor: prov, pagamento_id: igual.id, link: igual.link });
        }
        if (pendentes.filter((x) => Date.now() - new Date(x.criado_em).getTime() < 10 * 60e3).length >= 6) {
          throw new Erro(429, "Muitas cobranças abertas nesta mesa. Aguarde alguns minutos ou chame o garçom.");
        }
        const { data: novo, error: eIns } = await admin.from("mesa_pagamentos")
          .insert({ empresa_id: m.empresa_id, mesa_id: m.id, venda_id: v.id, valor, provedor: prov }).select("id").single();
        if (eIns || !novo) throw new Erro(500, "Não foi possível criar a cobrança");
        // Volta para a página da mesa depois do checkout (InfinitePay)
        let retorno: string | null = null;
        try {
          const r = new URL(String(body.retorno || ""));
          if (r.protocol === "https:" && r.searchParams.get("t") === String(body.mesa).toLowerCase()) { r.searchParams.set("pg", novo.id); retorno = r.toString(); }
        } catch { /* sem retorno */ }
        const loja = e?.nome_fantasia || e?.razao_social || "";
        let cob: Cobranca;
        try {
          cob = await criarCobranca(prov, i, {
            id: novo.id, valor, descricao: `${m.nome} · ${loja}`, aviso: urlAviso(m.empresa_id, prov, i.webhook_segredo),
            retorno, doc: String(e?.cnpj || "").replace(/\D/g, ""), mesa: m.nome,
          });
        } catch (err) {
          await admin.from("mesa_pagamentos").update({ status: "cancelado" }).eq("id", novo.id);
          throw err;
        }
        await admin.from("mesa_pagamentos").update({ mp_id: cob.ref || null, link: cob.link || null }).eq("id", novo.id);
        return json({ provedor: prov, nome_provedor: NOME_PROV[prov], pagamento_id: novo.id, qr_code: cob.qr_code ?? null,
          qr_code_base64: cob.qr_code_base64 ?? null, link: cob.link ?? null, expira_em: cob.expira_em ?? null });
      }
      throw new Erro(400, "Ação inválida");
    }

    // ---------- Pedido do delivery (cliente, sem login) — Mercado Pago ----------
    if (body.token) {
      if (!UUID.test(String(body.token))) throw new Erro(400, "Pedido inválido");
      const { data: v } = await admin.from("vendas")
        .select("id, empresa_id, numero, total, status, forma_prevista, pagamento_status, pagamento_ref")
        .eq("token_publico", body.token).maybeSingle();
      if (!v) throw new Erro(404, "Pedido não encontrado");
      const tk = await tokenDaLoja(v.empresa_id);
      if (!tk) throw new Erro(400, "Esta loja usa PIX com confirmação manual");

      if (body.acao === "pix_status") {
        if (!v.pagamento_ref) return json({ status: v.pagamento_status === "pago" ? "approved" : "none" });
        const p = await mp(tk, "GET", `/v1/payments/${v.pagamento_ref}`);
        if (p.status === "approved" && v.pagamento_status !== "pago") await marcarPago(v.id, v.empresa_id);
        return json(resumo(p));
      }

      if (body.acao === "pix_criar") {
        if (v.status !== "aberta") throw new Erro(400, "Este pedido já foi encerrado");
        if (v.pagamento_status === "pago") return json({ status: "approved" });
        if (v.pagamento_ref) {
          const atual = await mp(tk, "GET", `/v1/payments/${v.pagamento_ref}`);
          if (atual.status === "approved") { await marcarPago(v.id, v.empresa_id); return json(resumo(atual)); }
          if (atual.status === "pending" && Number(atual.transaction_amount) === Number(v.total)) return json(resumo(atual));
        }
        const p = await mp(tk, "POST", "/v1/payments", {
          transaction_amount: Number(v.total), payment_method_id: "pix",
          description: `Pedido ${v.numero}`, external_reference: `v:${v.id}`,
          payer: { email: "pagador@cliente.com.br" },
          notification_url: urlAviso(v.empresa_id),
          date_of_expiration: new Date(Date.now() + 60 * 60e3).toISOString().replace("Z", "-00:00"),
        }, `pedido-${v.id}-${v.total}`);
        await admin.from("vendas").update({ pagamento_ref: String(p.id) }).eq("id", v.id);
        return json(resumo(p));
      }
      throw new Erro(400, "Ação inválida");
    }

    // ---------- PDV (caixa logado) — Mercado Pago ----------
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) throw new Erro(401, "Entre no sistema");
    let { data: perfil } = await admin.from("perfis").select("empresa_id, ativo, papel").eq("id", u.user.id).maybeSingle();
    // Modo suporte (020): a equipe age como administrador da loja atendida (só no acesso total)
    const suporte = await sessaoSuporte(admin, u.user.id).catch(() => null);
    if (suporte) {
      if (suporte.modo !== "total") throw new Erro(403, "Modo suporte somente leitura");
      perfil = { empresa_id: suporte.empresa_id, ativo: true, papel: "admin" };
    }
    // Caixa e garçom (fechamento de conta no app) geram cobrança PIX; cozinha não
    if (!perfil?.ativo || perfil.papel === "cozinha") throw new Erro(403, "Sem permissão");

    // Teste das credenciais salvas (Configurações › Pagamentos), só administrador
    if (body.acao === "provedor_testar") {
      if (perfil.papel !== "admin") throw new Erro(403, "Somente o administrador");
      const i = await integracao(perfil.empresa_id);
      const prov = provedorAtivo(i);
      if (!i || !prov) throw new Erro(400, "Nenhum provedor configurado");
      if (prov === "mercadopago") await mp(i.mp_access_token!, "GET", "/users/me");
      if (prov === "pagbank") {
        try { await pagbankConsultar(i, "ORDE_00000000-0000-0000-0000-000000000000"); }
        catch (err) { if ((err as any).http === 401 || (err as any).http === 403) throw new Erro(400, "PagBank recusou o token"); }
      }
      if (prov === "getnet") await getnetToken(i);
      if (prov === "infinitepay") {
        try {
          await infinitepayConsultar(i, crypto.randomUUID(), "teste", "teste");
        } catch (err) { if ((err as any).http === 404 || /handle/i.test((err as Error).message)) throw new Erro(400, "InfiniteTag não encontrada na InfinitePay"); }
      }
      return json({ ok: true, provedor: prov, nome: NOME_PROV[prov] });
    }

    const tk = await tokenDaLoja(perfil.empresa_id);
    if (!tk) throw new Erro(400, "Cobrança automática não configurada");

    if (body.acao === "pix_criar") {
      const valor = r2(Number(body.valor));
      if (!(valor >= 0.01 && valor <= 100000)) throw new Erro(400, "Valor inválido");
      const ref = crypto.randomUUID();
      const p = await mp(tk, "POST", "/v1/payments", {
        transaction_amount: valor, payment_method_id: "pix",
        description: String(body.descricao || "Venda no caixa").slice(0, 60), external_reference: `pdv:${ref}`,
        payer: { email: "pagador@cliente.com.br" },
        date_of_expiration: new Date(Date.now() + 30 * 60e3).toISOString().replace("Z", "-00:00"),
      }, `pdv-${ref}`);
      return json(resumo(p));
    }
    if (body.acao === "pix_status") {
      if (!/^\d{3,20}$/.test(String(body.payment_id))) throw new Erro(400, "Cobrança inválida");
      return json(resumo(await mp(tk, "GET", `/v1/payments/${body.payment_id}`)));
    }
    throw new Erro(400, "Ação inválida");
  } catch (e) {
    const status = e instanceof Erro ? e.status : 500;
    if (!(e instanceof Erro)) console.error(e);
    return json({ error: e instanceof Erro ? e.message : "Erro inesperado" }, status);
  }
});
