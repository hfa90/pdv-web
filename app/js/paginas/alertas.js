// Alertas: comportamento fora do normal por operador (antifraude) e o resumo do dia (também por e-mail).
import { sb, q, rpc, fn } from "../api.js";
import { estado } from "../estado.js";
import { html, render, $, dinheiro, numero, toast, erro, dataHora, ocupado } from "../ui.js";
import { icone } from "../icons.js";
import { nomeForma } from "../impressao/cupom.js";
import { abas, barraPeriodo, periodoInstantes, hojeISO, somarDias, dataBR } from "../gestao-ui.js";

const NIVEL = { alto: ["danger", "Atenção"], medio: ["warn", "Verificar"], info: ["info", "Informativo"] };
const FUSOS = [["America/Sao_Paulo", "Brasília (SP, RJ, MG, Sul, Nordeste, GO, DF)"], ["America/Manaus", "Amazonas, RR, RO, MT, MS (−1h)"], ["America/Rio_Branco", "Acre (−2h)"], ["America/Noronha", "Fernando de Noronha (+1h)"]];

export default async function alertas(el, params = []) {
  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Alertas</h1><p>O que merece sua atenção na loja, mesmo quando você não está lá.</p></div></div>
    <div id="abas"></div><div id="corpo"></div></div>`);
  const corpo = $("#corpo", el);
  const telas = { antifraude, resumo };
  const inicial = params[0] === "resumo" ? "resumo" : "antifraude";
  abas($("#abas", el), [["antifraude", "Operadores e caixa"], ["resumo", "Resumo do dia (e-mail)"]], (k) => { history.replaceState(null, "", "#/alertas/" + k); telas[k]().catch(erro); }, inicial);
  await telas[inicial]();

  // =================== Antifraude ===================
  async function antifraude() {
    render(corpo, html`<div id="per"></div><div id="af"></div>`);
    barraPeriodo($("#per", corpo), async (per) => {
      const [i, f] = periodoInstantes(per);
      let r; try { r = await rpc("painel_antifraude", { p_ini: i.toISOString(), p_fim: f.toISOString() }); } catch (e) { return erro(e); }
      const ordem = { alto: 0, medio: 1, info: 2 };
      const al = (r.alertas || []).sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
      const pctC = (o) => (o.vendas + o.cancelamentos ? (o.cancelamentos / (o.vendas + o.cancelamentos)) * 100 : 0);
      const pctD = (o) => (o.subtotal ? (o.descontos / o.subtotal) * 100 : 0);
      render($("#af", corpo), html`
        <div class="panel" style="margin-bottom:1rem"><div class="panel-head"><h2>Alertas</h2><span class="muted small">${al.length ? `${al.filter((a) => a.nivel === "alto").length} de atenção` : ""}</span></div>
          ${al.length ? html`<div class="alertas-lista">${al.map((a) => html`<div class="alerta-item ${a.nivel}">
              <span class="badge ${NIVEL[a.nivel][0]}">${NIVEL[a.nivel][1]}</span>
              <div class="grow"><strong>${a.operador || "—"}</strong> · ${a.texto}${a.quando ? html`<div class="small muted">${dataHora(a.quando)}</div>` : ""}</div>
              ${a.valor != null ? html`<strong class="num">${dinheiro(a.valor)}</strong>` : ""}</div>`)}</div>`
          : html`<div class="empty"><p>Nada fora do normal no período. ✅</p></div>`}</div>
        <div class="panel"><div class="panel-head"><h2>Por operador</h2><span class="muted small">média da loja: ${numero(r.media_cancelamento, 1)}% cancelamentos · ${numero(r.media_desconto, 1)}% descontos</span></div>
          ${(r.operadores || []).length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Operador</th><th class="r">Vendas</th><th class="r">Faturamento</th><th class="r">Descontos</th><th class="r">Cancelamentos</th><th class="r">Itens tirados</th><th class="r">Gaveta s/ venda</th><th class="r">Caixa (falta/sobra)</th></tr></thead>
          <tbody>${r.operadores.map((o) => html`<tr><td><strong>${o.operador}</strong></td><td class="r">${o.vendas}</td><td class="r">${dinheiro(o.faturamento)}</td>
            <td class="r"><span class="${pctD(o) > Math.max(2 * r.media_desconto, 3) ? "badge warn" : ""}">${dinheiro(o.descontos)} · ${numero(pctD(o), 1)}%</span></td>
            <td class="r"><span class="${o.cancelamentos >= 3 && pctC(o) > Math.max(2 * r.media_cancelamento, 5) ? "badge warn" : ""}">${o.cancelamentos} · ${dinheiro(o.cancelamentos_valor)}</span></td>
            <td class="r">${o.itens_removidos || "—"}</td><td class="r">${o.gaveta || "—"}</td>
            <td class="r"><span class="${o.caixas_falta >= 2 ? "badge danger" : ""}">${o.caixas ? `${dinheiro(o.caixa_diferenca)} em ${o.caixas} caixa(s)` : "—"}</span></td></tr>`)}</tbody></table></div>`
          : html`<div class="empty"><p>Sem movimento no período.</p></div>`}
          <div class="panel-pad small muted">Os alertas comparam cada pessoa com a média da própria loja. Um alerta não é prova: converse, confira as câmeras e o registro de atividades (Configurações).</div></div>`);
    }, "7d");
  }

  // =================== Resumo do dia ===================
  async function resumo() {
    const cfg = estado.empresa.resumo_config || {};
    render(corpo, html`<div class="two-col resumo-cols">
      <div class="stack-lg">
        <form id="fr" class="panel panel-pad stack">
          <div><h2>Receber por e-mail</h2><p class="muted small">Todo dia, no horário escolhido, chega um e-mail com vendas, lucro, caixas, alertas, estoque baixo, vencimentos e contas.</p></div>
          <label class="check"><input type="checkbox" name="ativo" ${cfg.ativo ? "checked" : ""}> Enviar o resumo diário</label>
          <label class="field"><span>E-mails (até 5, separados por vírgula)</span><input class="input" name="emails" value="${(cfg.emails || [estado.usuario?.email].filter(Boolean)).join(", ")}"></label>
          <div class="grid-2"><label class="field"><span>Horário</span><select class="input" name="hora">${Array.from({ length: 24 }, (_, h) => html`<option value="${h}" ${h === (cfg.hora ?? 22) ? "selected" : ""}>${String(h).padStart(2, "0")}:00${h < 6 ? " (resumo do dia anterior)" : ""}</option>`)}</select></label>
            <label class="field"><span>Fuso horário da loja</span><select class="input" name="fuso">${FUSOS.map(([k, n]) => html`<option value="${k}" ${k === estado.empresa.fuso ? "selected" : ""}>${n}</option>`)}</select></label></div>
          <div id="st"></div>
          <div class="row wrap"><button class="btn primary">Salvar</button><button type="button" class="btn" id="teste">Enviar um teste agora</button></div>
        </form>
      </div>
      <div class="panel"><div class="panel-head"><h2>Prévia</h2><input class="input" type="date" id="dia" value="${hojeISO()}" max="${hojeISO()}" style="max-width:170px"></div><div id="prev" class="panel-pad"></div></div>
    </div>`);
    const f = $("#fr", corpo);
    fn("resumo-diario", { acao: "status" }).then((s) => {
      if (!s.configurado) render($("#st", corpo), html`<div class="alerta warn">O envio de e-mails ainda não foi ligado no servidor. A prévia funciona; para enviar, o responsável pelo sistema precisa configurar a chave do provedor de e-mail (RESEND_API_KEY).</div>`);
    }).catch(() => render($("#st", corpo), html`<div class="alerta warn">Não consegui verificar o serviço de e-mail agora.</div>`));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const emails = f.emails.value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      try {
        await rpc("salvar_resumo_config", { p: { ativo: f.ativo.checked, emails, hora: Number(f.hora.value), fuso: f.fuso.value, app_url: location.origin + location.pathname } });
        estado.empresa = await q(sb.from("empresas").select("*").eq("id", estado.empresa.id).single());
        toast(f.ativo.checked ? `Pronto! O resumo chega todo dia às ${String(f.hora.value).padStart(2, "0")}:00` : "Resumo diário desligado", "ok");
      } catch (err) { erro(err); }
    };
    $("#teste", corpo).onclick = (ev) => ocupado(ev.currentTarget, async () => {
      try { const r = await fn("resumo-diario", { acao: "teste" }); toast(`E-mail de teste enviado para ${r.para.join(", ")}`, "ok"); } catch (err) { erro(err); }
    });
    const prev = async () => {
      render($("#prev", corpo), html`<div class="loading"><div class="spinner"></div></div>`);
      try { render($("#prev", corpo), previa(await rpc("resumo_do_dia", { p_dia: $("#dia", corpo).value }))); } catch (e) { erro(e); }
    };
    $("#dia", corpo).onchange = prev;
    await prev();
  }
}

/** O mesmo conteúdo do e-mail, para ver no sistema. */
export function previa(d) {
  const ant = Number(d.faturamento_semana_passada), atual = Number(d.faturamento);
  const varia = ant ? ((atual - ant) / ant) * 100 : null;
  const altos = (d.alertas || []).filter((a) => a.nivel === "alto");
  const caixasDif = (d.caixas || []).filter((c) => c.diferenca != null && Math.abs(c.diferenca) >= 1);
  const lista = (titulo, itens, fmt) => (itens?.length ? html`<h3 class="resumo-h">${titulo}</h3><div class="resumo-lista">${itens.map(fmt)}</div>` : "");
  const lin = (a, b, cls = "") => html`<div class="resumo-linha"><span>${a}</span><strong class="${cls}">${b}</strong></div>`;
  return html`<div class="resumo-prev">
    <div class="muted small">${d.loja} · ${dataBR(d.dia)}</div>
    <div class="resumo-total">${dinheiro(atual)}</div>
    <div class="muted">${d.vendas} vendas · ticket médio ${dinheiro(d.ticket)}</div>
    ${varia != null ? html`<div class="small" style="margin-top:.3rem;color:${varia >= 0 ? "var(--ok)" : "var(--danger)"}">${varia >= 0 ? "▲" : "▼"} ${numero(Math.abs(varia), 1)}% vs. mesmo dia da semana passada (${dinheiro(ant)})</div>` : ""}
    ${altos.length || caixasDif.length ? html`<h3 class="resumo-h">⚠️ Pontos de atenção</h3><div class="resumo-lista">${altos.map((a) => lin(`${a.operador || ""}: ${a.texto}`, a.valor != null ? dinheiro(a.valor) : "", "txt-danger"))}
      ${caixasDif.map((c) => lin(`Caixa de ${c.operador}`, `${c.diferenca < 0 ? "falta" : "sobra"} ${dinheiro(Math.abs(c.diferenca))}`, c.diferenca < 0 ? "txt-danger" : ""))}</div>` : ""}
    <h3 class="resumo-h">Resultado do dia</h3><div class="resumo-lista">
      ${lin("Lucro bruto estimado", dinheiro(d.lucro_bruto), "txt-ok")}${lin("Descontos e promoções", dinheiro(d.descontos))}
      ${lin("Cancelamentos", `${d.cancelamentos} · ${dinheiro(d.cancelamentos_valor)}`)}${Number(d.perdas) ? lin("Perdas", dinheiro(d.perdas), "txt-danger") : ""}</div>
    ${lista("Por forma de pagamento", d.por_forma, (f) => lin(nomeForma(f.forma), dinheiro(f.valor)))}
    ${lista("Mais vendidos", d.top_produtos, (p) => lin(p.produto, dinheiro(p.total)))}
    ${lista("Contas vencendo", d.contas_vencendo, (c) => lin(`${c.descricao} · ${dataBR(c.vencimento)}`, dinheiro(c.valor)))}
    ${lista("Vencendo em até 7 dias", d.vencendo, (v) => lin(v.produto, `${dataBR(v.validade)} · ${numero(v.saldo, v.saldo % 1 ? 3 : 0)} ${String(v.unidade).toLowerCase()}`))}
    ${lista(`Estoque baixo (${d.estoque_baixo_total})`, d.estoque_baixo, (p) => lin(p.produto, `${numero(p.estoque, p.estoque % 1 ? 3 : 0)} (mín. ${numero(p.minimo)})`))}
    ${Number(d.fiado_aberto) > 0 ? html`<h3 class="resumo-h">Fiado</h3><div class="resumo-lista">${lin("A receber dos clientes", dinheiro(d.fiado_aberto))}</div>` : ""}
    ${lista("Outros avisos", (d.alertas || []).filter((a) => a.nivel !== "alto"), (a) => lin(`${a.operador || ""}: ${a.texto}`, a.valor != null ? dinheiro(a.valor) : ""))}
  </div>`;
}
