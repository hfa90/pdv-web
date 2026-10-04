// Cadastro de produtos e categorias (admin e gerente).
import { sb, q, todos } from "../api.js";
import { estado, eh } from "../estado.js";
import { html, render, $, $$, dinheiro, numero, qtd as fmtQtd, lerNumero, lerForm, toast, erro, modal, confirmar, debounce, ocupado } from "../ui.js";
import { icone } from "../icons.js";

const UNIDADES = [["UN", "Unidade"], ["KG", "Quilo"], ["G", "Grama"], ["L", "Litro"], ["ML", "Mililitro"], ["CX", "Caixa"], ["PCT", "Pacote"], ["DZ", "Dúzia"], ["FD", "Fardo"], ["M", "Metro"]];
const CORES = ["#136F63", "#2563eb", "#b45309", "#db2777", "#ea580c", "#16a34a", "#7c3aed", "#0891b2", "#dc2626", "#64748b"];

export default async function produtos(el) {
  let aba = "produtos";
  let lista = [], categorias = [];
  const f = { busca: "", cat: "", inativos: false };

  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Produtos</h1><p>Preços, códigos e dados fiscais do que você vende.</p></div>
      <div class="row wrap" id="acoes"></div></div>
    <div class="tabs" role="tablist"><button data-aba="produtos" class="ativo">Produtos</button><button data-aba="categorias">Categorias</button></div>
    <div id="corpo"></div></div>`);
  $$(".tabs button", el).forEach((b) => (b.onclick = () => { aba = b.dataset.aba; $$(".tabs button", el).forEach((x) => x.classList.toggle("ativo", x === b)); desenhar(); }));

  async function carregar() {
    [categorias, lista] = await Promise.all([
      q(sb.from("categorias").select("*").order("ordem").order("nome")),
      todos(() => sb.from("produtos").select("*").order("nome")),
    ]);
  }

  function desenhar() { aba === "produtos" ? desenharProdutos() : desenharCategorias(); }

  // ---------- Produtos ----------
  function desenharProdutos() {
    render($("#acoes", el), html`<button class="btn" id="importar">Importar planilha</button><button class="btn primary" id="novo">${icone("mais", 'width="18" height="18"')} Novo produto</button>`);
    $("#novo", el).onclick = () => editar();
    $("#importar", el).onclick = importar;
    const nomeCat = Object.fromEntries(categorias.map((c) => [c.id, c]));
    render($("#corpo", el), html`
      <div class="toolbar">
        <input class="input" id="busca" placeholder="Buscar por nome ou código" value="${f.busca}">
        <select class="input" id="cat" style="max-width:220px"><option value="">Todas as categorias</option>${categorias.map((c) => html`<option value="${c.id}" ${f.cat === c.id ? "selected" : ""}>${c.nome}</option>`)}</select>
        <label class="check"><input type="checkbox" id="inativos" ${f.inativos ? "checked" : ""}> Mostrar inativos</label>
      </div>
      <div class="panel" id="tabela"></div>`);
    const tabela = () => {
      const t = f.busca.toLowerCase();
      const itens = lista.filter((p) => (f.inativos || p.ativo) && (!f.cat || p.categoria_id === f.cat)
        && (!t || p.nome.toLowerCase().includes(t) || p.codigo === f.busca || p.codigo_barras === f.busca));
      render($("#tabela", el), itens.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Produto</th><th>Categoria</th><th>Código</th><th class="r">Custo</th><th class="r">Preço</th><th class="r">Margem</th><th class="r">Estoque</th></tr></thead>
        <tbody>${itens.slice(0, 500).map((p) => { const c = nomeCat[p.categoria_id]; const margem = p.preco_venda > 0 && p.preco_custo > 0 ? ((p.preco_venda - p.preco_custo) / p.preco_venda) * 100 : null; return html`
          <tr class="click" data-id="${p.id}" style="${p.ativo ? "" : "opacity:.55"}">
            <td><strong>${p.nome}</strong>${p.favorito ? html` <span class="badge info">favorito</span>` : ""}${!p.ativo ? html` <span class="badge">inativo</span>` : ""}</td>
            <td>${c ? html`<span class="row" style="gap:.4rem"><span class="dot" style="width:9px;height:9px;border-radius:50%;background:${c.cor}"></span>${c.nome}</span>` : html`<span class="muted">—</span>`}</td>
            <td class="small">${p.codigo || ""}${p.codigo_barras ? html`<div class="muted">${p.codigo_barras}</div>` : ""}</td>
            <td class="r">${p.preco_custo > 0 ? dinheiro(p.preco_custo) : "—"}</td>
            <td class="r"><strong>${dinheiro(p.preco_venda)}</strong><span class="muted small">/${p.unidade.toLowerCase()}</span></td>
            <td class="r">${margem != null ? numero(margem, 0) + "%" : "—"}</td>
            <td class="r">${p.controla_estoque ? html`<span class="badge ${p.estoque_atual <= p.estoque_minimo ? (p.estoque_atual <= 0 ? "danger" : "warn") : ""}">${fmtQtd(p.estoque_atual, p.unidade)}</span>` : html`<span class="muted small">não controla</span>`}</td>
          </tr>`; })}</tbody></table></div>
          ${itens.length > 500 ? html`<p class="muted small panel-pad">Mostrando 500 de ${itens.length}. Use a busca para refinar.</p>` : ""}`
        : html`<div class="empty">${icone("produtos", 'width="40" height="40"')}<p>${lista.length ? "Nenhum produto com esses filtros." : "Cadastre o primeiro produto para começar a vender."}</p>
          ${lista.length ? "" : html`<button class="btn primary" id="novo2">Novo produto</button>`}</div>`);
      $$("tr[data-id]", el).forEach((tr) => (tr.onclick = () => editar(lista.find((p) => p.id === tr.dataset.id))));
      $("#novo2", el)?.addEventListener("click", () => editar());
    };
    $("#busca", el).oninput = debounce((e) => { f.busca = e.target.value.trim(); tabela(); }, 200);
    $("#cat", el).onchange = (e) => { f.cat = e.target.value; tabela(); };
    $("#inativos", el).onchange = (e) => { f.inativos = e.target.checked; tabela(); };
    tabela();
  }

  async function editar(p = null) {
    const novo = !p;
    p = p || { nome: "", unidade: "UN", preco_venda: "", preco_custo: "", controla_estoque: true, estoque_atual: 0, estoque_minimo: 0, ativo: true, favorito: false, cfop: "5102", csosn: "102", origem: 0 };
    const v = (n) => (n === "" || n == null ? "" : String(n).replace(".", ","));
    const res = await modal({
      titulo: novo ? "Novo produto" : "Editar produto", largo: true,
      corpo: html`<form id="f-prod" class="stack-lg">
        <div class="grid-2">
          <label class="field span-2"><span>Nome</span><input class="input" name="nome" value="${p.nome}" required maxlength="120" autofocus></label>
          <label class="field"><span>Categoria</span><select class="input" name="categoria_id"><option value="">Sem categoria</option>${categorias.map((c) => html`<option value="${c.id}" ${p.categoria_id === c.id ? "selected" : ""}>${c.nome}</option>`)}</select></label>
          <label class="field"><span>Unidade de venda</span><select class="input" name="unidade">${UNIDADES.map(([u, n]) => html`<option value="${u}" ${p.unidade === u ? "selected" : ""}>${n} (${u})</option>`)}</select></label>
          <label class="field"><span>Preço de venda (R$)</span><input class="input lg" name="preco_venda" value="${v(p.preco_venda)}" inputmode="decimal" required></label>
          <label class="field"><span>Preço de custo (R$)</span><input class="input lg" name="preco_custo" value="${v(p.preco_custo)}" inputmode="decimal"><span class="hint" id="margem"></span></label>
          <label class="field"><span>Código interno</span><input class="input" name="codigo" value="${p.codigo || ""}" maxlength="30"><span class="hint">Use o código da balança para etiquetas pesadas.</span></label>
          <label class="field"><span>Código de barras (EAN)</span><input class="input" name="codigo_barras" value="${p.codigo_barras || ""}" maxlength="14" inputmode="numeric"></label>
        </div>
        <div class="grid-3">
          <label class="check"><input type="checkbox" name="controla_estoque" ${p.controla_estoque ? "checked" : ""}> Controlar estoque</label>
          <label class="check"><input type="checkbox" name="favorito" ${p.favorito ? "checked" : ""}> Favorito no PDV</label>
          <label class="check"><input type="checkbox" name="ativo" ${p.ativo ? "checked" : ""}> Ativo para venda</label>
        </div>
        <div class="grid-2">
          ${novo ? html`<label class="field"><span>Estoque inicial</span><input class="input" name="estoque_atual" value="0" inputmode="decimal"></label>`
                 : html`<div class="field"><span>Estoque atual</span><div class="input" style="display:flex;align-items:center">${fmtQtd(p.estoque_atual, p.unidade)} <a href="#/estoque" class="small" style="margin-left:auto">Ajustar no Estoque</a></div></div>`}
          <label class="field"><span>Estoque mínimo (alerta)</span><input class="input" name="estoque_minimo" value="${v(p.estoque_minimo)}" inputmode="decimal"></label>
        </div>
        <details ${novo ? "" : "open"}><summary style="cursor:pointer;font-weight:600">Dados fiscais (para NFC-e / NF-e)</summary>
          <div class="grid-3" style="margin-top:.75rem">
            <label class="field"><span>NCM</span><input class="input" name="ncm" value="${p.ncm || ""}" maxlength="10" inputmode="numeric" placeholder="8 dígitos"></label>
            <label class="field"><span>CEST</span><input class="input" name="cest" value="${p.cest || ""}" maxlength="9" inputmode="numeric"></label>
            <label class="field"><span>CFOP</span><input class="input" name="cfop" value="${p.cfop || "5102"}" maxlength="4" inputmode="numeric"></label>
            <label class="field"><span>CSOSN / CST ICMS</span><input class="input" name="csosn" value="${p.csosn || "102"}" maxlength="3" inputmode="numeric"></label>
            <label class="field"><span>Origem</span><select class="input" name="origem">${[[0, "0 – Nacional"], [1, "1 – Estrangeira (importação direta)"], [2, "2 – Estrangeira (mercado interno)"]].map(([o, n]) => html`<option value="${o}" ${Number(p.origem) === o ? "selected" : ""}>${n}</option>`)}</select></label>
          </div>
          <p class="hint" style="margin-top:.5rem">Confirme NCM, CFOP e CSOSN com seu contador. Valores comuns no Simples Nacional: CFOP 5102 e CSOSN 102 (ou 500 para substituição tributária).</p>
        </details>
      </form>`,
      rodape: html`${!novo && eh("admin") ? html`<button class="btn danger" id="excluir">Excluir</button><span class="grow"></span>` : ""}
        <button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-prod">Salvar</button>`,
      onPronto: (d, fechar) => {
        const form = d.querySelector("form");
        const margem = () => {
          const pv = lerNumero(form.preco_venda.value), pc = lerNumero(form.preco_custo.value);
          d.querySelector("#margem").textContent = pv > 0 && pc > 0 ? `Margem de ${numero(((pv - pc) / pv) * 100, 1)}% · lucro ${dinheiro(pv - pc)} por ${form.unidade.value.toLowerCase()}` : "";
        };
        form.preco_venda.oninput = form.preco_custo.oninput = margem; margem();
        form.onsubmit = (e) => {
          e.preventDefault();
          const x = lerForm(form);
          const dados = {
            nome: x.nome, categoria_id: x.categoria_id || null, unidade: x.unidade,
            preco_venda: lerNumero(x.preco_venda), preco_custo: lerNumero(x.preco_custo || 0),
            codigo: x.codigo || null, codigo_barras: x.codigo_barras.replace(/\D/g, "") || null,
            controla_estoque: x.controla_estoque, favorito: x.favorito, ativo: x.ativo,
            estoque_minimo: lerNumero(x.estoque_minimo || 0),
            ncm: x.ncm.replace(/\D/g, "") || null, cest: x.cest.replace(/\D/g, "") || null,
            cfop: x.cfop || "5102", csosn: x.csosn || "102", origem: Number(x.origem),
          };
          if (novo) dados.estoque_atual = lerNumero(x.estoque_atual || 0);
          if (!(dados.preco_venda >= 0) || !(dados.preco_custo >= 0) || Number.isNaN(dados.estoque_minimo)) return toast("Verifique os valores numéricos", "erro");
          if (dados.ncm && dados.ncm.length !== 8) return toast("O NCM deve ter 8 dígitos", "erro");
          fechar({ dados });
        };
        d.querySelector("#excluir")?.addEventListener("click", () => fechar({ excluir: true }));
      },
    });
    if (!res) return;
    try {
      if (res.excluir) {
        if (!(await confirmar(`Excluir “${p.nome}”? Se ele já foi vendido, prefira desmarcar “Ativo para venda”.`, { perigo: true, ok: "Excluir" }))) return;
        await q(sb.from("produtos").delete().eq("id", p.id));
        toast("Produto excluído", "ok");
      } else if (novo) {
        await q(sb.from("produtos").insert({ ...res.dados, empresa_id: estado.empresa.id }));
        toast("Produto cadastrado", "ok");
      } else {
        await q(sb.from("produtos").update(res.dados).eq("id", p.id));
        toast("Produto salvo", "ok");
      }
      await carregar(); desenhar();
    } catch (e) { erro(e); }
  }

  // Importação: CSV com colunas nome;preco;codigo_barras;unidade;categoria;estoque;custo;codigo;ncm
  async function importar() {
    const res = await modal({
      titulo: "Importar produtos", largo: true,
      corpo: html`<div class="stack">
        <p>Envie um arquivo CSV (separado por ponto e vírgula) com a primeira linha de títulos. Colunas aceitas:</p>
        <p class="small muted">nome; preco; codigo_barras; unidade; categoria; estoque; custo; codigo; ncm</p>
        <p class="small muted">Só “nome” e “preco” são obrigatórias. Categorias que não existirem serão criadas. Produtos com o mesmo código de barras são atualizados.</p>
        <input type="file" accept=".csv,text/csv" class="input" id="arq">
        <div id="prev"></div></div>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" id="ok-imp" disabled>Importar</button>`,
      onPronto: (d, fechar) => {
        let linhas = [];
        d.querySelector("#arq").onchange = async (e) => {
          const texto = await e.target.files[0].text();
          const [cab, ...resto] = texto.replace(/\r/g, "").split("\n").filter((l) => l.trim());
          const sep = cab.includes(";") ? ";" : ",";
          const cols = cab.split(sep).map((c) => c.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
          linhas = resto.map((l) => { const v = l.split(sep); return Object.fromEntries(cols.map((c, i) => [c, (v[i] || "").trim()])); }).filter((l) => l.nome);
          render(d.querySelector("#prev"), html`<div class="alerta info">${linhas.length} produtos encontrados. Primeiro: ${linhas[0]?.nome || "—"} · ${linhas[0]?.preco || ""}</div>`);
          d.querySelector("#ok-imp").disabled = !linhas.length;
        };
        d.querySelector("#ok-imp").onclick = () => fechar(linhas);
      },
    });
    if (!res?.length) return;
    try {
      const catPorNome = new Map(categorias.map((c) => [c.nome.toLowerCase(), c.id]));
      const novasCats = [...new Set(res.map((l) => l.categoria).filter((c) => c && !catPorNome.has(c.toLowerCase())))];
      if (novasCats.length) {
        const criadas = await q(sb.from("categorias").insert(novasCats.map((nome, i) => ({ empresa_id: estado.empresa.id, nome, cor: CORES[i % CORES.length], ordem: 100 + i }))).select());
        criadas.forEach((c) => catPorNome.set(c.nome.toLowerCase(), c.id));
      }
      const porBarras = new Map(lista.filter((p) => p.codigo_barras).map((p) => [p.codigo_barras, p]));
      let novos = 0, atualizados = 0, erros = 0;
      const inserir = [];
      for (const l of res) {
        const unidade = (l.unidade || "UN").toUpperCase();
        const dados = {
          nome: l.nome.slice(0, 120), preco_venda: lerNumero(l.preco), preco_custo: lerNumero(l.custo || 0) || 0,
          unidade: UNIDADES.some(([u]) => u === unidade) ? unidade : "UN",
          codigo_barras: (l.codigo_barras || "").replace(/\D/g, "") || null, codigo: l.codigo || null,
          ncm: (l.ncm || "").replace(/\D/g, "") || null, categoria_id: l.categoria ? catPorNome.get(l.categoria.toLowerCase()) : null,
        };
        if (!(dados.preco_venda >= 0)) { erros++; continue; }
        const ex = dados.codigo_barras && porBarras.get(dados.codigo_barras);
        if (ex) { await q(sb.from("produtos").update(dados).eq("id", ex.id)); atualizados++; }
        else inserir.push({ ...dados, empresa_id: estado.empresa.id, estoque_atual: lerNumero(l.estoque || 0) || 0 });
      }
      for (let i = 0; i < inserir.length; i += 500) { await q(sb.from("produtos").insert(inserir.slice(i, i + 500))); novos += Math.min(500, inserir.length - i); }
      toast(`${novos} novos, ${atualizados} atualizados${erros ? `, ${erros} com erro` : ""}`, erros ? "erro" : "ok");
      await carregar(); desenhar();
    } catch (e) { erro(e); }
  }

  // ---------- Categorias ----------
  function desenharCategorias() {
    render($("#acoes", el), html`<button class="btn primary" id="nova-cat">${icone("mais", 'width="18" height="18"')} Nova categoria</button>`);
    $("#nova-cat", el).onclick = () => editarCat();
    const contagem = lista.reduce((m, p) => ((m[p.categoria_id] = (m[p.categoria_id] || 0) + 1), m), {});
    render($("#corpo", el), html`<div class="panel">${categorias.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Categoria</th><th class="r">Ordem no PDV</th><th class="r">Produtos</th><th>Situação</th></tr></thead>
      <tbody>${categorias.map((c) => html`<tr class="click" data-id="${c.id}"><td><span class="row" style="gap:.5rem"><span style="width:12px;height:12px;border-radius:50%;background:${c.cor}"></span><strong>${c.nome}</strong></span></td>
        <td class="r">${c.ordem}</td><td class="r">${contagem[c.id] || 0}</td><td>${c.ativo ? html`<span class="badge ok">Ativa</span>` : html`<span class="badge">Oculta</span>`}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma categoria. Elas organizam os botões do PDV.</p></div>`}</div>`);
    $$("tr[data-id]", el).forEach((tr) => (tr.onclick = () => editarCat(categorias.find((c) => c.id === tr.dataset.id))));
  }

  async function editarCat(c = null) {
    const novo = !c;
    c = c || { nome: "", cor: CORES[categorias.length % CORES.length], ordem: categorias.length + 1, ativo: true };
    const res = await modal({
      titulo: novo ? "Nova categoria" : "Editar categoria",
      corpo: html`<form id="f-cat" class="stack">
        <label class="field"><span>Nome</span><input class="input" name="nome" value="${c.nome}" required maxlength="60" autofocus></label>
        <div class="field"><span>Cor</span><div class="row wrap">${CORES.map((cor) => html`<label style="cursor:pointer"><input type="radio" name="cor" value="${cor}" ${c.cor === cor ? "checked" : ""} style="accent-color:${cor}"> <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:${cor};vertical-align:middle"></span></label>`)}</div></div>
        <label class="field"><span>Ordem no PDV</span><input class="input" name="ordem" type="number" value="${c.ordem}"></label>
        <label class="check"><input type="checkbox" name="ativo" ${c.ativo ? "checked" : ""}> Mostrar no PDV</label></form>`,
      rodape: html`${!novo ? html`<button class="btn danger" id="exc-cat">Excluir</button><span class="grow"></span>` : ""}<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-cat">Salvar</button>`,
      onPronto: (d, fechar) => {
        d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const x = lerForm(e.target); fechar({ dados: { nome: x.nome, cor: e.target.querySelector("[name=cor]:checked")?.value || c.cor, ordem: Number(x.ordem) || 0, ativo: x.ativo } }); };
        d.querySelector("#exc-cat")?.addEventListener("click", () => fechar({ excluir: true }));
      },
    });
    if (!res) return;
    try {
      if (res.excluir) { if (!(await confirmar(`Excluir a categoria “${c.nome}”? Os produtos ficam sem categoria.`, { perigo: true, ok: "Excluir" }))) return; await q(sb.from("categorias").delete().eq("id", c.id)); }
      else if (novo) await q(sb.from("categorias").insert({ ...res.dados, empresa_id: estado.empresa.id }));
      else await q(sb.from("categorias").update(res.dados).eq("id", c.id));
      toast("Categoria salva", "ok");
      await carregar(); desenhar();
    } catch (e) { erro(e); }
  }

  await carregar();
  desenhar();
}
