// Validade e perdas: lotes vencendo, cadastro de lotes e registro/relatório de perdas.
import { sb, q, rpc, todos } from "../api.js";
import { eh } from "../estado.js";
import { html, render, $, $$, dinheiro, numero, qtd as fmtQtd, lerNumero, toast, erro, modal, confirmar, dataHora } from "../ui.js";
import { abas, barraPeriodo, hojeISO, dataBR, baixarCSV, numCSV } from "../gestao-ui.js";
import { barras } from "./relatorios.js";

export const MOTIVOS_PERDA = [["vencido", "Vencido"], ["avariado", "Avariado / estragado"], ["quebra", "Quebra / caiu"], ["sobra", "Sobra do dia (não vendeu)"], ["consumo", "Consumo interno"], ["furto", "Furto"], ["outro", "Outro"]];
const nomeMotivo = (m) => MOTIVOS_PERDA.find(([k]) => k === m)?.[1] || m;

export default async function validade(el, params = []) {
  const gestor = eh("admin", "gerente");
  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Validade e perdas</h1><p>Venda antes de vencer e saiba quanto se perde por mês.</p></div></div>
    <div id="abas"></div><div id="corpo"></div></div>`);
  const corpo = $("#corpo", el);
  let produtos = await todos(() => sb.from("produtos").select("id,nome,unidade,codigo,codigo_barras,preco_custo,preco_venda,controla_estoque,estoque_atual").eq("ativo", true).order("nome"));
  const rotulo = (p) => `${p.nome}${p.codigo_barras ? " · " + p.codigo_barras : p.codigo ? " · cód " + p.codigo : ""}`;
  const porRotulo = new Map(produtos.map((p) => [rotulo(p), p]));
  const datalist = html`<datalist id="dl-val">${produtos.map((p) => html`<option value="${rotulo(p)}"></option>`)}</datalist>`;

  const telas = { vencendo, lotes, perdas };
  const lista = [["vencendo", "Vencendo"], gestor && ["lotes", "Lotes e validades"], ["perdas", "Perdas"]].filter(Boolean);
  const inicial = lista.some(([k]) => k === params[0]) ? params[0] : "vencendo";
  abas($("#abas", el), lista, (k) => { history.replaceState(null, "", "#/validade/" + k); telas[k]().catch(erro); }, inicial);
  await telas[inicial]();

  // =================== Vencendo ===================
  async function vencendo() {
    render(corpo, html`<div class="toolbar"><div class="chips" id="d">${[[7, "7 dias"], [15, "15 dias"], [30, "30 dias"], [60, "60 dias"]].map(([d, n]) => html`<button class="chip ${d === 15 ? "ativo" : ""}" data-d="${d}">${n}</button>`)}</div>
      <span class="grow"></span>${gestor ? html`<a class="btn" href="#/validade/lotes">Cadastrar lote</a>` : ""}</div><div id="v"></div>`);
    let dias = 15;
    $$("[data-d]", corpo).forEach((b) => (b.onclick = () => { dias = Number(b.dataset.d); $$("[data-d]", corpo).forEach((x) => x.classList.toggle("ativo", x === b)); carregar().catch(erro); }));
    async function carregar() {
      const l = await rpc("validade_painel", { p_dias: dias });
      const venc = l.filter((x) => x.dias < 0), logo = l.filter((x) => x.dias >= 0 && x.dias <= 3), depois = l.filter((x) => x.dias > 3);
      const risco = l.reduce((a, x) => a + Number(x.valor), 0);
      const tab = (titulo, itens, cls) => itens.length ? html`<div class="panel" style="margin-bottom:1rem"><div class="panel-head"><h2>${titulo}</h2><span class="badge ${cls}">${itens.length}</span></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Produto</th><th>Lote</th><th>Validade</th><th class="r">Quantidade</th><th class="r">Valor (custo)</th><th></th></tr></thead>
        <tbody>${itens.map((x) => html`<tr><td><strong>${x.produto}</strong></td><td>${x.lote || "—"}</td>
          <td><span class="badge ${cls}">${dataBR(x.validade)} · ${x.dias < 0 ? `venceu há ${-x.dias} d` : x.dias === 0 ? "vence hoje" : `${x.dias} d`}</span></td>
          <td class="r">${fmtQtd(x.saldo, x.unidade)} ${String(x.unidade).toLowerCase()}</td><td class="r">${dinheiro(x.valor)}</td>
          <td class="r"><div class="row" style="gap:.3rem;justify-content:flex-end">${x.dias >= 0 && gestor ? html`<a class="btn sm" href="#/promocoes/nova/${x.produto_id}">Promoção</a>` : ""}
            <button class="btn sm ${x.dias < 0 ? "primary" : "ghost"}" data-baixa="${x.id}">Baixar como perda</button></div></td></tr>`)}</tbody></table></div></div>` : "";
      render($("#v", corpo), l.length ? html`<div class="kpis"><div class="panel kpi"><div class="k-label">Lotes no período</div><div class="k-valor">${l.length}</div><div class="k-sub">${venc.length} já vencido(s)</div></div>
        <div class="panel kpi"><div class="k-label">Valor em risco (custo)</div><div class="k-valor">${dinheiro(risco)}</div></div></div>
        ${tab("Vencidos: retire da prateleira", venc, "danger")}${tab("Vencem em até 3 dias: faça promoção", logo, "warn")}${tab(`Vencem em até ${dias} dias`, depois, "")}`
        : html`<div class="panel"><div class="empty"><p>Nenhum lote vencendo nos próximos ${dias} dias.</p><p class="small">Os lotes entram sozinhos quando a nota do fornecedor traz a validade, ou cadastre em "Lotes e validades".</p></div></div>`);
      $$("[data-baixa]", corpo).forEach((b) => (b.onclick = async () => {
        const x = l.find((y) => y.id === b.dataset.baixa);
        if (!(await confirmar(`Registrar perda de ${fmtQtd(x.saldo, x.unidade)} ${String(x.unidade).toLowerCase()} de ${x.produto} (${dinheiro(x.valor)})? O estoque será baixado.`, { titulo: "Baixar lote", ok: "Registrar perda", perigo: true }))) return;
        try { await rpc("registrar_perda", { p_produto: x.produto_id, p_quantidade: x.saldo, p_motivo: x.dias < 0 ? "vencido" : "avariado", p_obs: `Lote ${x.lote || ""} val. ${dataBR(x.validade)}`, p_lote: x.id }); toast("Perda registrada", "ok"); carregar(); } catch (e) { erro(e); }
      }));
    }
    await carregar();
  }

  // =================== Lotes ===================
  async function lotes() {
    render(corpo, html`${datalist}<div class="two-col">
      <form id="fl" class="panel panel-pad stack"><h2>Cadastrar lote</h2>
        <label class="field"><span>Produto</span><input class="input" list="dl-val" name="p" placeholder="Digite para buscar" required></label>
        <div class="grid-2"><label class="field"><span>Validade</span><input class="input" type="date" name="v" min="${hojeISO()}" required></label>
          <label class="field"><span>Quantidade</span><input class="input" name="q" inputmode="decimal" required></label></div>
        <label class="field"><span>Lote (opcional)</span><input class="input" name="l"></label>
        <label class="check"><input type="checkbox" name="e"> Dar entrada no estoque também (mercadoria que acabou de chegar)</label>
        <p class="small muted">Deixe desmarcado se a mercadoria já entrou no estoque (por nota ou entrada manual). As vendas consomem primeiro o lote que vence antes.</p>
        <button class="btn primary">Salvar lote</button></form>
      <div class="panel"><div class="panel-head"><h2>Lotes ativos</h2></div><div id="la"></div></div></div>`);
    const f = $("#fl", corpo);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const p = porRotulo.get(f.p.value);
      if (!p) return toast("Escolha o produto da lista", "erro");
      try {
        await rpc("registrar_lote", { p_produto: p.id, p_lote: f.l.value.trim() || null, p_validade: f.v.value, p_quantidade: lerNumero(f.q.value), p_entrada: f.e.checked });
        toast("Lote salvo", "ok"); f.reset(); listar();
      } catch (err) { erro(err); }
    };
    async function listar() {
      const l = await q(sb.from("lotes").select("*, produto:produtos(nome,unidade)").eq("status", "ativo").order("validade").limit(300));
      render($("#la", corpo), l.length ? html`<div class="table-wrap" style="max-height:520px"><table class="table"><thead><tr><th>Produto</th><th>Validade</th><th class="r">Saldo</th></tr></thead>
        <tbody>${l.map((x) => html`<tr><td>${x.produto?.nome}${x.lote ? html`<div class="small muted">lote ${x.lote}</div>` : ""}</td><td>${dataBR(x.validade)}</td>
          <td class="r">${fmtQtd(x.saldo, x.produto?.unidade)} de ${fmtQtd(x.quantidade, x.produto?.unidade)}</td></tr>`)}</tbody></table></div>` : html`<div class="empty"><p>Nenhum lote ativo.</p></div>`);
    }
    await listar();
  }

  // =================== Perdas ===================
  async function perdas() {
    render(corpo, html`${datalist}<div class="stack-lg">
      <form id="fp" class="panel panel-pad stack"><h2>Registrar perda</h2>
        <div class="grid-3"><label class="field span-2"><span>Produto</span><input class="input" list="dl-val" name="p" placeholder="Digite para buscar" required></label>
          <label class="field"><span>Quantidade</span><input class="input" name="q" inputmode="decimal" required></label>
          <label class="field"><span>Motivo</span><select class="input" name="m">${MOTIVOS_PERDA.map(([k, n]) => html`<option value="${k}">${n}</option>`)}</select></label>
          <label class="field span-2"><span>Observação</span><input class="input" name="o" placeholder="Ex.: pão francês que sobrou às 20h"></label></div>
        <div><button class="btn primary">Registrar</button></div></form>
      ${gestor ? html`<div id="per"></div><div id="rel"></div>` : ""}</div>`);
    const f = $("#fp", corpo);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const p = porRotulo.get(f.p.value);
      if (!p) return toast("Escolha o produto da lista", "erro");
      try {
        const r = await rpc("registrar_perda", { p_produto: p.id, p_quantidade: lerNumero(f.q.value), p_motivo: f.m.value, p_obs: f.o.value.trim() || null });
        toast(`Perda registrada: ${dinheiro(r.valor)}`, "ok"); f.reset(); if (gestor) per.atual && carregar(per.atual());
      } catch (err) { erro(err); }
    };
    if (!gestor) return;
    let ultimo = null;
    async function carregar([ini, fim]) {
      let r; try { r = await rpc("perdas_resumo", { p_ini: ini, p_fim: fim }); } catch (e) { return erro(e); }
      ultimo = r;
      render($("#rel", corpo), html`<div class="kpis"><div class="panel kpi"><div class="k-label">Perdido no período</div><div class="k-valor" style="color:var(--danger)">${dinheiro(r.total)}</div><div class="k-sub">${r.registros} registro(s), a preço de custo</div></div></div>
        <div class="two-col"><div class="panel"><div class="panel-head"><h2>Por motivo</h2></div><div class="panel-pad">${barras(r.por_motivo, (i) => nomeMotivo(i.motivo), (i) => Number(i.valor))}</div></div>
          <div class="panel"><div class="panel-head"><h2>Produtos que mais se perdem</h2></div><div class="panel-pad">${barras(r.por_produto, (i) => `${i.produto} (${numero(i.quantidade, i.quantidade % 1 ? 3 : 0)} ${String(i.unidade).toLowerCase()})`, (i) => Number(i.valor))}</div></div></div>
        <div class="panel" style="margin-top:1rem"><div class="panel-head"><h2>Registros</h2><button class="btn sm" id="csv">CSV</button></div>
          ${r.lista.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Quando</th><th>Produto</th><th class="r">Qtd</th><th>Motivo</th><th class="r">Valor</th></tr></thead>
          <tbody>${r.lista.map((x) => html`<tr><td class="small">${dataHora(x.quando)}</td><td>${x.produto}${x.obs ? html`<div class="small muted">${x.obs}</div>` : ""}</td>
            <td class="r">${fmtQtd(x.quantidade, x.unidade)} ${String(x.unidade).toLowerCase()}</td><td>${nomeMotivo(x.motivo)}</td><td class="r">${dinheiro(x.valor)}</td></tr>`)}</tbody></table></div>`
          : html`<div class="empty"><p>Nenhuma perda registrada no período.</p></div>`}</div>`);
      $("#csv", corpo)?.addEventListener("click", () => baixarCSV("perdas.csv", [["Quando", "Produto", "Quantidade", "Motivo", "Valor", "Obs"], ...ultimo.lista.map((x) => [dataHora(x.quando), x.produto, numCSV(x.quantidade), nomeMotivo(x.motivo), numCSV(x.valor), x.obs || ""])]));
    }
    const per = barraPeriodo($("#per", corpo), carregar, "mes");
  }
}
