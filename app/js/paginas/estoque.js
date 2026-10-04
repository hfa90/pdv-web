// Estoque: entradas, saídas, ajustes de inventário e histórico de movimentações.
import { sb, q, rpc, todos } from "../api.js";
import { html, render, $, $$, dinheiro, dataHora, qtd as fmtQtd, lerNumero, toast, erro, modal, debounce } from "../ui.js";

const TIPOS = { entrada: ["ok", "Entrada"], saida: ["warn", "Saída"], ajuste: ["info", "Ajuste"], venda: ["", "Venda"], cancelamento: ["", "Cancelamento"] };

export default async function estoque(el) {
  let produtos = [];
  let filtro = "baixo", busca = "";

  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Estoque</h1><p>Registre compras, perdas e contagens. Vendas dão baixa automaticamente.</p></div></div>
    <div class="kpis" id="kpis"></div>
    <div class="tabs"><button data-f="baixo" class="ativo">Abaixo do mínimo</button><button data-f="todos">Todos</button><button data-f="mov">Movimentações</button></div>
    <div class="toolbar" id="tb"><input class="input" id="busca" placeholder="Buscar produto"></div>
    <div class="panel" id="lista"></div></div>`);

  $$(".tabs button", el).forEach((b) => (b.onclick = () => { filtro = b.dataset.f; $$(".tabs button", el).forEach((x) => x.classList.toggle("ativo", x === b)); desenhar(); }));
  $("#busca", el).oninput = debounce((e) => { busca = e.target.value.trim().toLowerCase(); desenhar(); }, 200);

  async function carregar() {
    produtos = await todos(() => sb.from("produtos").select("id,nome,unidade,estoque_atual,estoque_minimo,preco_custo,preco_venda,controla_estoque,ativo").eq("controla_estoque", true).eq("ativo", true).order("nome"));
    const baixo = produtos.filter((p) => p.estoque_atual <= p.estoque_minimo).length;
    const zerado = produtos.filter((p) => p.estoque_atual <= 0).length;
    const valor = produtos.reduce((a, p) => a + Math.max(0, p.estoque_atual) * Number(p.preco_custo || 0), 0);
    render($("#kpis", el), html`
      <div class="panel kpi"><div class="k-label">Produtos controlados</div><div class="k-valor">${produtos.length}</div></div>
      <div class="panel kpi"><div class="k-label">Abaixo do mínimo</div><div class="k-valor">${baixo}</div><div class="k-sub">${zerado} zerados ou negativos</div></div>
      <div class="panel kpi"><div class="k-label">Valor em estoque (custo)</div><div class="k-valor">${dinheiro(valor)}</div></div>`);
  }

  async function desenhar() {
    $("#tb", el).hidden = filtro === "mov";
    if (filtro === "mov") return desenharMov();
    const itens = produtos.filter((p) => (filtro === "todos" || p.estoque_atual <= p.estoque_minimo) && (!busca || p.nome.toLowerCase().includes(busca)));
    render($("#lista", el), itens.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Produto</th><th class="r">Atual</th><th class="r">Mínimo</th><th class="r">Custo</th><th></th></tr></thead>
      <tbody>${itens.map((p) => html`<tr>
        <td><strong>${p.nome}</strong></td>
        <td class="r"><span class="badge ${p.estoque_atual <= 0 ? "danger" : p.estoque_atual <= p.estoque_minimo ? "warn" : ""}">${fmtQtd(p.estoque_atual, p.unidade)} ${p.unidade.toLowerCase()}</span></td>
        <td class="r">${fmtQtd(p.estoque_minimo, p.unidade)}</td><td class="r">${p.preco_custo > 0 ? dinheiro(p.preco_custo) : "—"}</td>
        <td class="r"><div class="row" style="justify-content:flex-end;gap:.35rem">
          <button class="btn sm" data-t="entrada" data-id="${p.id}">Entrada</button><button class="btn sm" data-t="saida" data-id="${p.id}">Saída</button>
          <button class="btn sm" data-t="ajuste" data-id="${p.id}">Contagem</button><button class="btn sm ghost" data-h="${p.id}">Histórico</button></div></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>${filtro === "baixo" ? "Nenhum produto abaixo do estoque mínimo." : "Nenhum produto com controle de estoque."}</p></div>`);
    $$("[data-t]", el).forEach((b) => (b.onclick = () => movimentar(produtos.find((p) => p.id === b.dataset.id), b.dataset.t)));
    $$("[data-h]", el).forEach((b) => (b.onclick = () => historico(produtos.find((p) => p.id === b.dataset.h))));
  }

  async function desenharMov(produtoId = null) {
    let qy = sb.from("estoque_movimentos").select("*, produto:produtos(nome,unidade), usuario:perfis(nome)").order("created_at", { ascending: false }).limit(200);
    if (produtoId) qy = qy.eq("produto_id", produtoId);
    const movs = await q(qy);
    return tabelaMov(movs, $("#lista", el));
  }

  function tabelaMov(movs, alvo) {
    render(alvo, movs.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Data</th><th>Produto</th><th>Tipo</th><th class="r">Quantidade</th><th class="r">Saldo</th><th>Motivo</th><th>Usuário</th></tr></thead>
      <tbody>${movs.map((m) => html`<tr><td class="small">${dataHora(m.created_at)}</td><td>${m.produto?.nome || ""}</td>
        <td><span class="badge ${TIPOS[m.tipo][0]}">${TIPOS[m.tipo][1]}</span></td>
        <td class="r num" style="color:${m.quantidade < 0 ? "var(--danger)" : "var(--ok)"}">${m.quantidade > 0 ? "+" : ""}${fmtQtd(m.quantidade, m.produto?.unidade)}</td>
        <td class="r">${fmtQtd(m.saldo_posterior, m.produto?.unidade)}</td><td class="small">${m.motivo || ""}</td><td class="small">${m.usuario?.nome || ""}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma movimentação.</p></div>`);
  }

  async function historico(p) {
    const movs = await q(sb.from("estoque_movimentos").select("*, produto:produtos(nome,unidade), usuario:perfis(nome)").eq("produto_id", p.id).order("created_at", { ascending: false }).limit(100));
    await modal({ titulo: `Histórico · ${p.nome}`, largo: true, corpo: html`<div id="h"></div>`, onPronto: (d) => tabelaMov(movs, d.querySelector("#h")) });
  }

  async function movimentar(p, tipo) {
    const titulos = { entrada: "Entrada de mercadoria", saida: "Saída (perda, consumo, avaria)", ajuste: "Contagem de inventário" };
    const res = await modal({
      titulo: titulos[tipo],
      corpo: html`<form id="f-est" class="stack">
        <p><strong>${p.nome}</strong> · estoque atual ${fmtQtd(p.estoque_atual, p.unidade)} ${p.unidade.toLowerCase()}</p>
        <label class="field"><span>${tipo === "ajuste" ? "Quantidade contada" : "Quantidade"} (${p.unidade.toLowerCase()})</span><input class="input lg" name="q" inputmode="decimal" autofocus></label>
        <label class="field"><span>Motivo / documento</span><input class="input" name="m" placeholder="${tipo === "entrada" ? "Ex.: NF 1234 do fornecedor" : tipo === "saida" ? "Ex.: vencido, quebra" : "Ex.: inventário mensal"}"></label></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-est">Registrar</button>`,
      onPronto: (d, f) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); f({ q: lerNumero(e.target.q.value), m: e.target.m.value.trim() }); }; },
    });
    if (!res) return;
    if (!(res.q >= 0) || (tipo !== "ajuste" && res.q === 0)) return toast("Quantidade inválida", "erro");
    try {
      const novo = await rpc("ajustar_estoque", { p_produto_id: p.id, p_tipo: tipo, p_quantidade: res.q, p_motivo: res.m || null });
      toast(`Estoque de ${p.nome}: ${fmtQtd(novo, p.unidade)}`, "ok");
      await carregar(); desenhar();
    } catch (e) { erro(e); }
  }

  await carregar();
  desenhar();
}
