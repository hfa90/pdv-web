// Cobrança PIX automática via Mercado Pago (opcional por loja).
// Sem token do Mercado Pago configurado, o sistema usa o PIX estático (chave da loja) e a
// confirmação é manual. Com token, o QR é gerado aqui e o pagamento é confirmado sozinho.
//
// Ações:
//   pix_criar  { token }            → cliente do delivery gera a cobrança do pedido (público)
//   pix_criar  { valor, descricao } → caixa do PDV gera uma cobrança (precisa estar logado)
//   pix_status { token } | { payment_id } → consulta e, se aprovado, marca o pedido como pago
//   webhook (?acao=webhook&e=<empresa>) → aviso do Mercado Pago
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

async function mp(token: string, method: string, path: string, body?: unknown, idem?: string) {
  const res = await fetch(MP + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      ...(idem ? { "X-Idempotency-Key": idem } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Erro(502, dados?.message ? `Mercado Pago: ${dados.message}` : "Falha ao falar com o Mercado Pago");
  return dados;
}

const resumo = (p: any) => ({
  id: String(p.id), status: p.status,
  qr_code: p.point_of_interaction?.transaction_data?.qr_code ?? null,
  qr_code_base64: p.point_of_interaction?.transaction_data?.qr_code_base64 ?? null,
  expira_em: p.date_of_expiration ?? null,
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const tokenDaLoja = async (empresa_id: string) => {
    const { data } = await admin.from("integracoes_pagamento").select("mp_access_token").eq("empresa_id", empresa_id).maybeSingle();
    return data?.mp_access_token as string | undefined;
  };
  const marcarPago = async (vendaId: string, empresaId: string) => {
    await admin.from("vendas").update({ pagamento_status: "pago", pago_em: new Date().toISOString(), alterado_em: new Date().toISOString() })
      .eq("id", vendaId).eq("empresa_id", empresaId).eq("status", "aberta");
  };

  try {
    // ---------- Aviso do Mercado Pago ----------
    if (url.searchParams.get("acao") === "webhook") {
      const empresa = url.searchParams.get("e") || "";
      const corpo = await req.json().catch(() => ({}));
      const id = corpo?.data?.id || url.searchParams.get("data.id") || url.searchParams.get("id");
      const tipo = corpo?.type || url.searchParams.get("type") || url.searchParams.get("topic");
      if (!empresa || !id || (tipo && tipo !== "payment")) return json({ ok: true });
      const tk = await tokenDaLoja(empresa);
      if (!tk) return json({ ok: true });
      // Nunca confia no corpo do aviso: consulta o pagamento direto no Mercado Pago
      const p = await mp(tk, "GET", `/v1/payments/${encodeURIComponent(String(id))}`);
      const ref = String(p.external_reference || "");
      if (p.status === "approved" && ref.startsWith("v:")) await marcarPago(ref.slice(2), empresa);
      return json({ ok: true });
    }

    if (req.method !== "POST") throw new Erro(405, "Método não permitido");
    const body = await req.json().catch(() => ({}));
    const urlAviso = (emp: string) => `${Deno.env.get("SUPABASE_URL")}/functions/v1/pagamentos?acao=webhook&e=${emp}`;

    // ---------- Pedido do delivery (cliente, sem login) ----------
    if (body.token) {
      if (!/^[0-9a-f-]{36}$/i.test(String(body.token))) throw new Erro(400, "Pedido inválido");
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

    // ---------- PDV (caixa logado) ----------
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
    const tk = await tokenDaLoja(perfil.empresa_id);
    if (!tk) throw new Erro(400, "Cobrança automática não configurada");

    if (body.acao === "pix_criar") {
      const valor = Math.round(Number(body.valor) * 100) / 100;
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
