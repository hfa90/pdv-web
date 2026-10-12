// Cobrança recorrente da mensalidade das lojas pelo Asaas (migração 028).
//
// Cada loja ativa vira um cliente + uma assinatura mensal no Asaas. As cobranças que o Asaas gera
// (PIX, boleto ou cartão — o cliente escolhe) viram faturas aqui. Regra contra fraude: o sistema
// nunca confia no corpo de um aviso; sempre consulta a cobrança direto na API do Asaas.
//
// Ações (POST JSON { acao, ... }):
//   webhook (?acao=webhook)        → aviso do Asaas; header asaas-access-token = token da plataforma
//   cron                           → sincronização diária (header x-cron-token)
//   testar                         → superusuário: confere a chave de API
//   sincronizar { empresa_id }     → superusuário: cria/atualiza cliente e assinatura e importa as cobranças
//   sincronizar_todas              → superusuário: todas as lojas
//   (loja cancelada ou sem mensalidade: a sincronização encerra a assinatura no Asaas)
//   conferir { fatura_id }         → lojista (admin/gerente) ou superusuário: confere o pagamento agora
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
class Erro extends Error { constructor(public status: number, m: string) { super(m); } }
const UUID = /^[0-9a-f-]{36}$/i;
const so = (s: unknown) => String(s ?? "").replace(/\D/g, "");

function iguais(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

type Cfg = { ambiente: string; api_key: string | null; ativo: boolean; webhook_token: string; cron_token: string;
  forma_padrao: string; multa_pct: number; juros_mes_pct: number };

/** Hoje em Brasília (AAAA-MM-DD). */
const hojeSP = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

const PAGO = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH", "DUNNING_RECEIVED"]);
const CANCELADO = new Set(["REFUNDED", "REFUND_IN_PROGRESS", "DELETED"]);
const FORMA: Record<string, string> = { PIX: "PIX", BOLETO: "Boleto", CREDIT_CARD: "Cartão", DEBIT_CARD: "Cartão de débito" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: cfgRow } = await admin.from("plataforma_cobranca").select("*").eq("id", true).maybeSingle();
  const cfg = cfgRow as Cfg | null;

  // ---------- Cliente HTTP do Asaas ----------
  async function asaas(method: string, path: string, body?: unknown) {
    if (!cfg?.api_key) throw new Erro(400, "Cobrança automática não configurada (chave do Asaas)");
    const base = cfg.ambiente === "teste" ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3";
    let res: Response;
    try {
      res = await fetch(base + path, {
        method, signal: AbortSignal.timeout(20000),
        headers: { access_token: cfg.api_key, "Content-Type": "application/json", "User-Agent": "LisPDV/1.0" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Erro(502, "Sem resposta do Asaas. Tente de novo."); }
    const txt = await res.text();
    let d: any = {};
    try { d = txt ? JSON.parse(txt) : {}; } catch { d = {}; }
    if (!res.ok) {
      const msg = d?.errors?.map((e: any) => e.description).join("; ") || d?.message;
      const e = new Erro(res.status === 401 ? 400 : 502, msg ? `Asaas: ${String(msg).slice(0, 200)}` : `Falha no Asaas (${res.status})`);
      (e as any).http = res.status;
      throw e;
    }
    return d;
  }

  // ---------- Fatura a partir de uma cobrança do Asaas ----------
  async function empresaDaCobranca(p: any): Promise<string | null> {
    if (UUID.test(String(p.externalReference || ""))) {
      const { data } = await admin.from("empresas").select("id").eq("id", p.externalReference).maybeSingle();
      if (data) return data.id;
    }
    if (p.subscription) {
      const { data } = await admin.from("assinaturas").select("empresa_id").eq("assinatura_ref", p.subscription).maybeSingle();
      if (data) return data.empresa_id;
    }
    if (p.customer) {
      const { data } = await admin.from("assinaturas").select("empresa_id").eq("cliente_ref", p.customer).maybeSingle();
      if (data) return data.empresa_id;
    }
    return null;
  }

  async function gravarFatura(emp: string, p: any) {
    const st = p.deleted ? "DELETED" : String(p.status || "");
    const status = PAGO.has(st) ? "pago" : CANCELADO.has(st) ? "cancelado" : "pendente";
    const venc = String(p.dueDate || "").slice(0, 10);
    const competencia = venc ? venc.slice(0, 8) + "01" : null;
    const pagoEm = status === "pago"
      ? (p.clientPaymentDate || p.paymentDate || p.confirmedDate ? `${(p.clientPaymentDate || p.paymentDate || p.confirmedDate).slice(0, 10)}T12:00:00-03:00` : new Date().toISOString())
      : null;
    const dados: Record<string, unknown> = {
      empresa_id: emp, provedor: "asaas", cobranca_ref: String(p.id), valor: Number(p.value), vencimento: venc,
      descricao: String(p.description || `Mensalidade ${venc.slice(5, 7)}/${venc.slice(0, 4)}`).slice(0, 200),
      status, pago_em: pagoEm, forma: FORMA[p.billingType] ?? null, situacao_provedor: st,
      link_pagamento: /^https:\/\//.test(String(p.invoiceUrl || "")) ? p.invoiceUrl : null,
      boleto_url: /^https:\/\//.test(String(p.bankSlipUrl || "")) ? p.bankSlipUrl : null,
    };
    // PIX copia e cola e linha digitável (só enquanto em aberto)
    if (status === "pendente") {
      try { const q = await asaas("GET", `/payments/${encodeURIComponent(p.id)}/pixQrCode`); if (q?.payload) dados.pix_copia_cola = q.payload; } catch { /* cobrança sem PIX */ }
      try { const b = await asaas("GET", `/payments/${encodeURIComponent(p.id)}/identificationField`); if (b?.identificationField) dados.linha_digitavel = b.identificationField; } catch { /* sem boleto */ }
    }

    const { data: atual } = await admin.from("faturas").select("id").eq("cobranca_ref", String(p.id)).maybeSingle();
    if (atual) {
      const { error } = await admin.from("faturas").update(dados).eq("id", atual.id);
      if (error) throw new Erro(500, error.message);
      return atual.id;
    }
    // Mensalidade manual do mesmo mês ainda em aberto: passa a ser esta cobrança
    if (competencia) {
      const { data: manual } = await admin.from("faturas").select("id").eq("empresa_id", emp).eq("competencia", competencia)
        .is("cobranca_ref", null).eq("status", "pendente").maybeSingle();
      if (manual) { await admin.from("faturas").update(dados).eq("id", manual.id); return manual.id; }
    }
    let { data: nova, error } = await admin.from("faturas").insert({ ...dados, competencia: status === "cancelado" ? null : competencia }).select("id").single();
    if (error && /faturas_mensal_uk|duplicate/i.test(error.message)) {
      // Já existe outra fatura do mês (ex.: paga à mão): guarda sem competência para não duplicar a mensalidade
      ({ data: nova, error } = await admin.from("faturas").insert({ ...dados, competencia: null }).select("id").single());
    }
    if (error) throw new Erro(500, error.message);
    return nova!.id;
  }

  async function processarCobranca(id: string) {
    const p = await asaas("GET", `/payments/${encodeURIComponent(id)}`);
    const emp = await empresaDaCobranca(p);
    if (!emp) return { ok: false, motivo: "cobrança não pertence a nenhuma loja" };
    await gravarFatura(emp, p);
    return { ok: true, empresa: emp, status: p.status };
  }

  // ---------- Assinatura da loja ----------
  function proximoVencimento(dia: number, jaTemMesAtual: boolean) {
    const h = hojeSP();
    const [a, m] = h.split("-").map(Number);
    const doMes = (ano: number, mes: number) => `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    let alvo = doMes(a, m);
    if (alvo <= h || jaTemMesAtual) alvo = m === 12 ? doMes(a + 1, 1) : doMes(a, m + 1);
    return alvo;
  }

  async function sincronizarLoja(emp: string) {
    const { data: e } = await admin.from("empresas")
      .select("id, razao_social, nome_fantasia, cnpj, email, telefone, status_conta, plano, valor_mensal, dia_vencimento").eq("id", emp).single();
    if (!e) throw new Erro(404, "Loja não encontrada");
    const { data: a0 } = await admin.from("assinaturas").select("*").eq("empresa_id", emp).maybeSingle();
    const a: any = a0 || { empresa_id: emp };
    const salvar = async (campos: Record<string, unknown>) => {
      await admin.from("assinaturas").upsert({ empresa_id: emp, provedor: "asaas", ...a, ...campos, sincronizado_em: new Date().toISOString() });
      Object.assign(a, campos);
    };

    // Loja cancelada ou sem mensalidade: encerra a assinatura
    const deveCobrar = ["ativo", "suspenso"].includes(e.status_conta) && Number(e.valor_mensal) > 0 && e.plano !== "interno";
    if (!deveCobrar) {
      if (a.assinatura_ref && a.status === "ativa") {
        try { await asaas("DELETE", `/subscriptions/${a.assinatura_ref}`); } catch (err) { if ((err as any).http !== 404) throw err; }
        await admin.from("faturas").update({ status: "cancelado" }).eq("empresa_id", emp).eq("provedor", "asaas").eq("status", "pendente");
        await salvar({ status: "cancelada", erro: null });
      }
      return { empresa: emp, acao: "sem cobrança", status: a.status || "pendente" };
    }

    const doc = so(e.cnpj);
    if (doc.length !== 11 && doc.length !== 14) {
      await salvar({ status: "erro", erro: "Cadastre o CPF ou CNPJ da loja (Configurações › Loja) para criar a cobrança." });
      return { empresa: emp, acao: "erro", erro: a.erro };
    }

    try {
      // Cliente
      if (!a.cliente_ref) {
        const busca = await asaas("GET", `/customers?externalReference=${emp}&limit=1`);
        let cli = busca?.data?.[0];
        if (!cli) {
          const fone = so(e.telefone);
          cli = await asaas("POST", "/customers", {
            name: (e.razao_social || e.nome_fantasia || "Loja").slice(0, 100), cpfCnpj: doc,
            email: e.email || undefined, mobilePhone: fone.length >= 10 && fone.length <= 11 ? fone : undefined,
            externalReference: emp, notificationDisabled: false,
          });
        }
        await salvar({ cliente_ref: cli.id });
      }

      // Assinatura
      if (!a.assinatura_ref || a.status === "cancelada") {
        const lista = await asaas("GET", `/subscriptions?customer=${a.cliente_ref}&status=ACTIVE&limit=10`);
        let sub = (lista?.data || []).find((s: any) => s.externalReference === emp);
        if (!sub) {
          const mes = hojeSP().slice(0, 8) + "01";
          const { data: doMes } = await admin.from("faturas").select("id").eq("empresa_id", emp).eq("competencia", mes).neq("status", "cancelado").limit(1);
          sub = await asaas("POST", "/subscriptions", {
            customer: a.cliente_ref, billingType: cfg!.forma_padrao || "UNDEFINED", value: Number(e.valor_mensal),
            nextDueDate: proximoVencimento(Number(e.dia_vencimento) || 10, !!doMes?.length), cycle: "MONTHLY",
            description: `Lis PDV · plano ${e.plano} · ${(e.nome_fantasia || e.razao_social || "").slice(0, 60)}`,
            externalReference: emp,
            fine: { value: Number(cfg!.multa_pct) || 0 }, interest: { value: Number(cfg!.juros_mes_pct) || 0 },
          });
        }
        await salvar({ assinatura_ref: sub.id, valor: Number(sub.value), status: "ativa", erro: null });
      } else if (Number(a.valor) !== Number(e.valor_mensal)) {
        // Mudou o plano/valor: vale para as próximas e para as em aberto
        await asaas("PUT", `/subscriptions/${a.assinatura_ref}`, { value: Number(e.valor_mensal), updatePendingPayments: true });
        await salvar({ valor: Number(e.valor_mensal), status: "ativa", erro: null });
      }

      // Importa as cobranças já geradas
      const pags = await asaas("GET", `/subscriptions/${a.assinatura_ref}/payments?limit=24`);
      for (const p of pags?.data || []) await gravarFatura(emp, p);
      await salvar({ status: "ativa", erro: null });
      return { empresa: emp, acao: "ok", cobrancas: (pags?.data || []).length };
    } catch (err) {
      await salvar({ status: "erro", erro: (err as Error).message.slice(0, 300) });
      throw err;
    }
  }

  async function sincronizarTodas() {
    const { data: lojas } = await admin.from("empresas").select("id").in("status_conta", ["ativo", "suspenso", "cancelado"]).neq("plano", "interno");
    const r: unknown[] = [];
    for (const l of lojas || []) {
      try { r.push(await sincronizarLoja(l.id)); }
      catch (err) { r.push({ empresa: l.id, erro: (err as Error).message }); }
    }
    return r;
  }

  // ---------- Quem está chamando ----------
  async function usuario() {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) throw new Erro(401, "Entre no sistema");
    // ilike sem curingas: _ e % do e-mail valem como texto
    const email = (u.user.email || "").replace(/[\\%_]/g, (c: string) => "\\" + c);
    const { data: eq } = email ? await admin.from("plataforma_admins").select("nivel, ativo").ilike("email", email).maybeSingle() : { data: null };
    const superusuario = !!(eq?.ativo && eq.nivel === "super" && u.user.email_confirmed_at);
    const { data: perfil } = await admin.from("perfis").select("empresa_id, papel, ativo").eq("id", u.user.id).maybeSingle();
    return { superusuario, perfil };
  }

  try {
    // ---------- Aviso do Asaas ----------
    if (url.searchParams.get("acao") === "webhook") {
      if (!cfg || !iguais(req.headers.get("asaas-access-token") || "", cfg.webhook_token)) return json({ error: "Não autorizado" }, 401);
      const ev = await req.json().catch(() => ({}));
      const id = String(ev?.id || "");
      const evento = String(ev?.event || "");
      if (!id || !evento) return json({ ok: true });
      const { data: ja } = await admin.from("cobranca_eventos").select("resultado").eq("id", id).maybeSingle();
      if (ja?.resultado === "ok") return json({ ok: true, repetido: true });
      let resultado = "ignorado", emp: string | null = null;
      const ref = ev?.payment?.id ? String(ev.payment.id) : null;
      try {
        if (evento.startsWith("PAYMENT_") && ref) {
          if (evento === "PAYMENT_DELETED") {
            await admin.from("faturas").update({ status: "cancelado", situacao_provedor: "DELETED" }).eq("cobranca_ref", ref).neq("status", "pago");
            resultado = "ok";
          } else {
            const r = await processarCobranca(ref);
            emp = (r as any).empresa ?? null;
            resultado = r.ok ? "ok" : `ignorado: ${(r as any).motivo}`;
          }
        }
      } catch (err) { resultado = `erro: ${(err as Error).message}`.slice(0, 300); console.error(err); }
      await admin.from("cobranca_eventos").upsert({ id, evento, cobranca_ref: ref, empresa_id: emp, resultado, recebido_em: new Date().toISOString() });
      // Sempre 200: falha pontual é corrigida pela sincronização diária (e não trava a fila do Asaas)
      return json({ ok: true });
    }

    if (req.method !== "POST") throw new Erro(405, "Método não permitido");
    const body = await req.json().catch(() => ({}));

    // ---------- Sincronização diária ----------
    if (body.acao === "cron") {
      if (!cfg || !iguais(req.headers.get("x-cron-token") || "", cfg.cron_token)) throw new Erro(401, "Não autorizado");
      if (!cfg.ativo || !cfg.api_key) return json({ ok: true, desligado: true });
      return json({ ok: true, lojas: await sincronizarTodas() });
    }

    const quem = await usuario();

    // ---------- Lojista confere o pagamento ----------
    if (body.acao === "conferir") {
      if (!UUID.test(String(body.fatura_id))) throw new Erro(400, "Fatura inválida");
      const { data: f } = await admin.from("faturas").select("id, empresa_id, cobranca_ref, status").eq("id", body.fatura_id).maybeSingle();
      if (!f) throw new Erro(404, "Fatura não encontrada");
      const dono = quem.perfil?.ativo && quem.perfil.empresa_id === f.empresa_id && ["admin", "gerente"].includes(quem.perfil.papel);
      if (!dono && !quem.superusuario) throw new Erro(403, "Sem permissão");
      if (!f.cobranca_ref) return json({ status: f.status, manual: true });
      await processarCobranca(f.cobranca_ref);
      const { data: depois } = await admin.from("faturas").select("status, pago_em").eq("id", f.id).single();
      return json({ status: depois?.status, pago_em: depois?.pago_em });
    }

    // ---------- Superusuário ----------
    if (!quem.superusuario) throw new Erro(403, "Acesso restrito");
    if (body.acao === "testar") {
      const r = await asaas("GET", "/customers?limit=1");
      return json({ ok: true, ambiente: cfg!.ambiente, clientes: r?.totalCount ?? null });
    }
    if (!cfg?.ativo) throw new Erro(400, "Ligue a cobrança automática antes de sincronizar");
    if (body.acao === "sincronizar") {
      if (!UUID.test(String(body.empresa_id))) throw new Erro(400, "Loja inválida");
      return json(await sincronizarLoja(body.empresa_id));
    }
    if (body.acao === "sincronizar_todas") return json({ lojas: await sincronizarTodas() });
    throw new Erro(400, "Ação inválida");
  } catch (e) {
    const status = e instanceof Erro ? e.status : 500;
    if (!(e instanceof Erro)) console.error(e);
    return json({ error: e instanceof Erro ? e.message : "Erro inesperado" }, status);
  }
});
