// Relatórios de vendas por período.
import { rpc } from "../api.js";
import { html, render, $, $$, dinheiro, numero, data as fmtData, erro } from "../ui.js";
import { nomeForma } from "../impressao/cupom.js";

// ---------- Blocos reutilizados pelo Painel ----------
export function kpis(r) {
  const lucro = r.faturamento - r.custo_estimado;
  return html`<div class="kpis">
    <div class="panel kpi"><div class="k-label">Faturamento</div><div class="k-valor">${dinheiro(r.faturamento)}</div><div class="k-sub">${r.vendas} vendas</div></div>
    <div class="panel kpi"><div class="k-label">Ticket médio</div><div class="k-valor">${dinheiro(r.ticket_medio)}</div><div class="k-sub">Descontos ${dinheiro(r.descontos)}</div></div>
    <div class="panel kpi"><div class="k-label">Lucro bruto estimado</div><div class="k-valor">${r.custo_estimado > 0 ? dinheiro(lucro) : "—"}</div><div class="k-sub">${r.custo_estimado > 0 ? `Margem ${numero((lucro / (r.faturamento || 1)) * 100, 1)}%` : "Cadastre o custo dos produtos"}</div></div>
    <div class="panel kpi"><div class="k-label">Cancelamentos</div><div class="k-valor">${r.canceladas}</div><div class="k-sub">${dinheiro(r.canceladas_valor)}</div></div>
  </div>`;
}

export function colunas(pontos, rotulo) {
  if (!pontos.length) return html`<p class="muted">Sem vendas no período.</p>`;
  const max = Math.max(...pontos.map((p) => Number(p.total)), 1);
  const mostrarRotulo = (i) => pontos.length <= 16 || i % Math.ceil(pontos.length / 12) === 0;
  return html`<div class="chart-cols" role="img" aria-label="Gráfico de vendas">${pontos.map((p) => html`<div class="col" style="height:${Math.max(1, (p.total / max) * 100)}%" title="${rotulo(p)}: ${dinheiro(p.total)} (${p.vendas} vendas)"></div>`)}</div>
    <div class="chart-x">${pontos.map((p, i) => html`<span>${mostrarRotulo(i) ? rotulo(p) : ""}</span>`)}</div>`;
}

export function barras(itens, nome, valor) {
  if (!itens.length) return html`<p class="muted">Sem dados.</p>`;
  const max = Math.max(...itens.map(valor), 1);
  return html`<div class="bars">${itens.map((i) => html`<div class="bar-row"><span title="${nome(i)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${nome(i)}</span>
    <div class="bar-track"><div class="bar-fill" style="width:${(valor(i) / max) * 100}%"></div></div><strong class="num">${dinheiro(valor(i))}</strong></div>`)}</div>`;
}

export function preencherHoras(porHora) {
  const mapa = new Map(porHora.map((h) => [h.hora, h]));
  const horas = porHora.map((h) => h.hora);
  const de = Math.min(7, ...horas), ate = Math.max(20, ...horas);
  return Array.from({ length: ate - de + 1 }, (_, i) => mapa.get(de + i) || { hora: de + i, total: 0, vendas: 0 });
}

function intervalo(chave, de, ate) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const d = (n) => { const x = new Date(hoje); x.setDate(x.getDate() + n); return x; };
  switch (chave) {
    case "hoje": return [hoje, d(1)];
    case "ontem": return [d(-1), hoje];
    case "7d": return [d(-6), d(1)];
    case "30d": return [d(-29), d(1)];
    case "mes": return [new Date(hoje.getFullYear(), hoje.getMonth(), 1), d(1)];
    case "mes_ant": return [new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1), new Date(hoje.getFullYear(), hoje.getMonth(), 1)];
    default: { const a = new Date(de + "T00:00:00"); const b = new Date(ate + "T00:00:00"); b.setDate(b.getDate() + 1); return [a, b]; }
  }
}

export default async function relatorios(el) {
  let periodo = "7d"; let ultimo = null;
  const hoje = new Date().toISOString().slice(0, 10);
  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Relatórios</h1><p>Desempenho de vendas no período escolhido.</p></div>
      <button class="btn" id="csv">Exportar CSV</button></div>
    <div class="toolbar">
      <div class="chips" id="per">${[["hoje", "Hoje"], ["ontem", "Ontem"], ["7d", "7 dias"], ["30d", "30 dias"], ["mes", "Este mês"], ["mes_ant", "Mês passado"], ["custom", "Personalizado"]].map(([k, n]) => html`<button class="chip ${k === periodo ? "ativo" : ""}" data-p="${k}">${n}</button>`)}</div>
      <span id="custom" hidden class="row"><input class="input" type="date" id="de" value="${hoje}"><input class="input" type="date" id="ate" value="${hoje}"></span>
    </div>
    <div id="corpo"></div></div>`);

  async function carregar() {
    const [ini, fim] = intervalo(periodo, $("#de", el).value, $("#ate", el).value);
    render($("#corpo", el), html`<div class="loading"><div class="spinner"></div></div>`);
    try {
      const r = await rpc("relatorio_vendas", { p_inicio: ini.toISOString(), p_fim: fim.toISOString() });
      ultimo = r;
      const dias = periodo === "hoje" || periodo === "ontem";
      render($("#corpo", el), html`
        ${kpis(r.resumo)}
        <div class="panel" style="margin-bottom:1rem"><div class="panel-head"><h2>${dias ? "Vendas por hora" : "Vendas por dia"}</h2></div>
          <div class="panel-pad">${dias ? colunas(preencherHoras(r.por_hora), (p) => `${p.hora}h`) : colunas(r.por_dia, (p) => fmtData(p.dia + "T12:00:00").slice(0, 5))}</div></div>
        <div class="two-col">
          <div class="panel"><div class="panel-head"><h2>Formas de pagamento</h2></div><div class="panel-pad">${barras(r.por_forma, (i) => nomeForma(i.forma), (i) => Number(i.valor))}</div></div>
          <div class="panel"><div class="panel-head"><h2>Por operador</h2></div><div class="panel-pad">${barras(r.por_operador, (i) => i.operador, (i) => Number(i.total))}</div></div>
        </div>
        <div class="panel" style="margin-top:1rem"><div class="panel-head"><h2>Produtos mais vendidos</h2></div>
          ${r.top_produtos.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Produto</th><th class="r">Quantidade</th><th class="r">Total</th></tr></thead>
          <tbody>${r.top_produtos.map((p) => html`<tr><td>${p.produto}</td><td class="r">${numero(p.quantidade, p.quantidade % 1 ? 3 : 0)}</td><td class="r"><strong>${dinheiro(p.total)}</strong></td></tr>`)}</tbody></table></div>`
          : html`<div class="empty"><p>Sem vendas no período.</p></div>`}</div>`);
    } catch (e) { erro(e); render($("#corpo", el), ""); }
  }

  $$("#per .chip", el).forEach((b) => (b.onclick = () => {
    periodo = b.dataset.p; $$("#per .chip", el).forEach((x) => x.classList.toggle("ativo", x === b));
    $("#custom", el).hidden = periodo !== "custom"; carregar();
  }));
  $("#de", el).onchange = $("#ate", el).onchange = carregar;
  $("#csv", el).onclick = () => {
    if (!ultimo) return;
    const linhas = [["Dia", "Vendas", "Total"], ...ultimo.por_dia.map((d) => [d.dia, d.vendas, String(d.total).replace(".", ",")]),
      [], ["Produto", "Quantidade", "Total"], ...ultimo.top_produtos.map((p) => [p.produto, String(p.quantidade).replace(".", ","), String(p.total).replace(".", ",")])];
    const csv = "﻿" + linhas.map((l) => l.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `relatorio-vendas-${periodo}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  await carregar();
}
