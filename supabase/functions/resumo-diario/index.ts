// Resumo do dia por e-mail para o dono.
//
// Ações:
//   { acao: "cron" }   → chamada de hora em hora pelo agendamento (pg_cron). Envia o resumo das lojas
//                        cujo horário chegou e que ainda não receberam o do dia. Seguro chamar várias vezes.
//   { acao: "teste" }  → admin/gerente logado: envia agora o resumo de hoje para os e-mails cadastrados.
//   { acao: "status" } → admin/gerente: diz se o envio de e-mail está configurado no servidor.
//
// Envio pelo Resend (https://resend.com). Configure os segredos da função:
//   RESEND_API_KEY  = chave da API do Resend
//   RESEND_FROM     = remetente, ex.: "Lis PDV <resumo@seudominio.com.br>" (domínio verificado no Resend)
import { createClient } from "npm:@supabase/supabase-js@2";
import { autenticar, cors, exigirPapel, HttpError, json } from "../_shared/auth.ts";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const din = (n: unknown) => BRL.format(Number(n) || 0);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const FORMAS: Record<string, string> = { dinheiro: "Dinheiro", credito: "Crédito", debito: "Débito", pix: "PIX", vale_refeicao: "Vale-refeição", crediario: "Fiado", outros: "Outros" };
const dataBR = (d: string) => d.split("-").reverse().join("/");

// deno-lint-ignore no-explicit-any
type Dados = Record<string, any>;

function variacao(atual: number, antes: number) {
  if (!antes) return atual ? "sem vendas no mesmo dia da semana passada" : "";
  const p = ((atual - antes) / antes) * 100;
  const cor = p >= 0 ? "#1B7F3B" : "#B42318";
  return `<span style="color:${cor};font-weight:600">${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(1).replace(".", ",")}%</span> vs. mesmo dia da semana passada (${din(antes)})`;
}

function secao(titulo: string, corpo: string) {
  return `<tr><td style="padding:18px 24px 6px"><div style="font-size:13px;font-weight:700;color:#5E6B67;text-transform:uppercase;letter-spacing:.04em">${titulo}</div></td></tr>
    <tr><td style="padding:0 24px 10px;font-size:14px;color:#18211F;line-height:1.5">${corpo}</td></tr>`;
}
const linha = (a: string, b: string, cor = "#18211F") =>
  `<tr><td style="padding:4px 0;border-bottom:1px solid #EEF1EF">${a}</td><td style="padding:4px 0;border-bottom:1px solid #EEF1EF;text-align:right;color:${cor};white-space:nowrap">${b}</td></tr>`;
const tabela = (linhas: string) => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">${linhas}</table>`;

export function montarEmail(d: Dados, link: string) {
  const alertas = (d.alertas || []) as Dados[];
  const altos = alertas.filter((a) => a.nivel === "alto");
  const caixasDif = (d.caixas || []).filter((c: Dados) => c.diferenca != null && Math.abs(Number(c.diferenca)) >= 1);
  const partes: string[] = [];

  partes.push(`<tr><td style="padding:24px 24px 8px">
    <div style="font-size:13px;color:#5E6B67">${esc(d.loja)} · ${dataBR(d.dia)}</div>
    <div style="font-size:30px;font-weight:700;color:#18211F;margin-top:4px">${din(d.faturamento)}</div>
    <div style="font-size:14px;color:#5E6B67;margin-top:2px">${d.vendas} vendas · ticket médio ${din(d.ticket)}</div>
    <div style="font-size:13px;margin-top:6px">${variacao(Number(d.faturamento), Number(d.faturamento_semana_passada))}</div>
  </td></tr>`);

  if (altos.length || caixasDif.length) {
    partes.push(secao("⚠️ Pontos de atenção", tabela(
      altos.map((a) => linha(`${esc(a.operador || "")}: ${esc(a.texto)}`, a.valor != null ? din(a.valor) : "", "#B42318")).join("") +
      caixasDif.map((c: Dados) => linha(`Caixa de ${esc(c.operador)}`, `${Number(c.diferenca) < 0 ? "falta" : "sobra"} ${din(Math.abs(c.diferenca))}`, Number(c.diferenca) < 0 ? "#B42318" : "#8A5300")).join(""))));
  }

  partes.push(secao("Resultado do dia", tabela(
    linha("Lucro bruto estimado", din(d.lucro_bruto), "#1B7F3B") +
    linha("Descontos e promoções", din(d.descontos)) +
    linha("Cancelamentos", `${d.cancelamentos} · ${din(d.cancelamentos_valor)}`) +
    (Number(d.perdas) ? linha("Perdas registradas", din(d.perdas), "#B42318") : "") +
    (d.itens_sem_custo ? linha(`<span style="color:#8A5300">${d.itens_sem_custo} item(ns) sem custo cadastrado</span>`, "") : ""))));

  if ((d.por_forma || []).length) partes.push(secao("Por forma de pagamento", tabela((d.por_forma as Dados[]).map((f) => linha(FORMAS[f.forma] || f.forma, din(f.valor))).join(""))));
  if ((d.top_produtos || []).length) partes.push(secao("Mais vendidos", tabela((d.top_produtos as Dados[]).map((p) => linha(esc(p.produto), din(p.total))).join(""))));
  if ((d.contas_vencendo || []).length) partes.push(secao("Contas vencendo", tabela((d.contas_vencendo as Dados[]).map((c) => linha(`${esc(c.descricao)} · ${dataBR(c.vencimento)}`, din(c.valor))).join(""))));
  if ((d.vencendo || []).length) partes.push(secao("Produtos vencendo em até 7 dias", tabela((d.vencendo as Dados[]).map((v) => linha(esc(v.produto), `${dataBR(v.validade)} · ${Number(v.saldo).toLocaleString("pt-BR")} ${String(v.unidade).toLowerCase()}`)).join(""))));
  if ((d.estoque_baixo || []).length) partes.push(secao(`Estoque baixo (${d.estoque_baixo_total})`, tabela((d.estoque_baixo as Dados[]).map((p) => linha(esc(p.produto), `${Number(p.estoque).toLocaleString("pt-BR")} (mín. ${Number(p.minimo).toLocaleString("pt-BR")})`)).join(""))));
  if (Number(d.fiado_aberto) > 0) partes.push(secao("Fiado", tabela(linha("Total a receber dos clientes", din(d.fiado_aberto)))));
  const outros = alertas.filter((a) => a.nivel !== "alto");
  if (outros.length) partes.push(secao("Outros avisos", tabela(outros.map((a) => linha(`${esc(a.operador || "")}: ${esc(a.texto)}`, a.valor != null ? din(a.valor) : "")).join(""))));

  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F2F4F3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F3;padding:16px 0"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
    <tr><td style="background:#136F63;color:#fff;padding:14px 24px;font-weight:700">Resumo do dia</td></tr>
    ${partes.join("")}
    <tr><td style="padding:16px 24px 24px">${link ? `<a href="${esc(link)}" style="display:inline-block;background:#136F63;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:600">Abrir o sistema</a>` : ""}
      <div style="font-size:12px;color:#5E6B67;margin-top:14px">Você recebe este e-mail porque está cadastrado no resumo diário da loja (Alertas › Resumo do dia).</div></td></tr>
  </table></td></tr></table></body></html>`;
}

async function enviar(para: string[], assunto: string, htmlCorpo: string) {
  const chave = Deno.env.get("RESEND_API_KEY");
  if (!chave) throw new HttpError(503, "Envio de e-mail não configurado no servidor (falta RESEND_API_KEY)");
  const de = Deno.env.get("RESEND_FROM") || "Lis PDV <onboarding@resend.dev>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: de, to: para, subject: assunto, html: htmlCorpo }),
  });
  if (!r.ok) throw new HttpError(502, `Falha ao enviar e-mail: ${(await r.text()).slice(0, 300)}`);
}

const assunto = (d: Dados) => `${d.loja}: ${din(d.faturamento)} em ${d.vendas} vendas · ${dataBR(d.dia)}${(d.alertas || []).some((a: Dados) => a.nivel === "alto") ? " ⚠️" : ""}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") throw new HttpError(405, "Método não permitido");
    const body = await req.json().catch(() => ({}));
    const linkPadrao = Deno.env.get("APP_URL") || "";

    if (body.acao === "cron") {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
      const { data: pend, error } = await admin.rpc("resumos_pendentes");
      if (error) throw new HttpError(500, error.message);
      const res = [];
      for (const p of (pend || []) as Dados[]) {
        try {
          await enviar(p.emails, assunto(p.dados), montarEmail(p.dados, p.app_url || linkPadrao));
          await admin.rpc("resumo_marcar_enviado", { p_emp: p.empresa_id, p_dia: p.dia });
          res.push({ empresa: p.empresa_id, ok: true });
        } catch (e) { res.push({ empresa: p.empresa_id, ok: false, erro: (e as Error).message }); }
      }
      return json({ enviados: res.filter((r) => r.ok).length, resultados: res });
    }

    const { admin, perfil } = await autenticar(req);
    exigirPapel(perfil, ["admin", "gerente"]);
    if (body.acao === "status") return json({ configurado: !!Deno.env.get("RESEND_API_KEY") });
    if (body.acao === "teste") {
      const { data, error } = await admin.rpc("resumo_teste_dados", { p_emp: perfil.empresa_id });
      if (error) throw new HttpError(500, error.message);
      const emails = (data?.emails || []) as string[];
      if (!emails.length) throw new HttpError(400, "Cadastre ao menos um e-mail e salve antes de testar");
      await enviar(emails, "[Teste] " + assunto(data.dados), montarEmail(data.dados, data.app_url || linkPadrao));
      return json({ ok: true, para: emails });
    }
    throw new HttpError(400, "Ação inválida");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
});
