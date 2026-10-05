// Compras: entrada de mercadoria pelo XML da NF-e, sugestão de compra, curva ABC,
// produtos parados e fornecedores.
import { sb, q, rpc, todos } from "../api.js";
import { estado } from "../estado.js";
import { html, render, $, $$, dinheiro, numero, qtd as fmtQtd, lerNumero, toast, erro, modal, confirmar, dataHora, somenteDigitos, formatarDoc, debounce, ocupado } from "../ui.js";
import { icone } from "../icons.js";
import { abas, barraPeriodo, periodoInstantes, baixarCSV, numCSV, linkZap, dataBR, lerArquivoTexto } from "../gestao-ui.js";

const r2 = (n) => Math.round(n * 100) / 100;
const UNID_LOJA = ["UN", "KG", "G", "L", "ML", "CX", "PCT", "DZ", "FD", "M"];

// ---------- Leitura do XML da NF-e ----------
const txt = (el, tag) => el?.getElementsByTagName(tag)?.[0]?.textContent?.trim() ?? "";
const num = (el, tag) => Number(txt(el, tag) || 0);

export function lerNFe(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Arquivo XML inválido");
  const inf = doc.getElementsByTagName("infNFe")[0];
  if (!inf) throw new Error("Este XML não é de uma NF-e (modelo 55)");
  const chave = (txt(doc, "chNFe") || (inf.getAttribute("Id") || "").replace(/\D/g, "")).slice(-44);
  const ide = inf.getElementsByTagName("ide")[0];
  const emit = inf.getElementsByTagName("emit")[0];
  const dest = inf.getElementsByTagName("dest")[0];
  const itens = [...inf.getElementsByTagName("det")].map((det, k) => {
    const p = det.getElementsByTagName("prod")[0];
    const imp = det.getElementsByTagName("imposto")[0];
    const qCom = num(p, "qCom") || 1;
    const vProd = num(p, "vProd");
    const extras = num(p, "vFrete") + num(p, "vSeg") + num(p, "vOutro") - num(p, "vDesc");
    const vIPI = imp ? [...imp.getElementsByTagName("IPI")].reduce((a, x) => a + num(x, "vIPI"), 0) : 0;
    const vST = imp ? num(imp, "vICMSST") + num(imp, "vFCPST") : 0;
    const totalItem = vProd + extras + vIPI + vST;
    const rastro = p.getElementsByTagName("rastro")[0];
    const gtin = (x) => (/^\d{8,14}$/.test(x) ? x : "");
    return {
      k, codigo: txt(p, "cProd"), descricao: txt(p, "xProd"), ean: gtin(txt(p, "cEAN")) || gtin(txt(p, "cEANTrib")),
      ncm: txt(p, "NCM"), unidade: txt(p, "uCom").toUpperCase(), quantidade: qCom, valor_unitario: num(p, "vUnCom"),
      total: r2(totalItem), custo_unitario: Math.round((totalItem / qCom) * 10000) / 10000,
      impostos: r2(vIPI + vST), lote: rastro ? txt(rastro, "nLote") : "", validade: rastro ? txt(rastro, "dVal").slice(0, 10) : "",
    };
  });
  const duplicatas = [...inf.getElementsByTagName("dup")].map((d) => ({ numero: txt(d, "nDup"), vencimento: txt(d, "dVenc"), valor: num(d, "vDup") }));
  return {
    chave, numero: txt(ide, "nNF"), serie: txt(ide, "serie"), emitida_em: txt(ide, "dhEmi") || txt(ide, "dEmi"),
    valor_total: num(inf.getElementsByTagName("ICMSTot")[0], "vNF"),
    fornecedor: { cnpj: txt(emit, "CNPJ") || txt(emit, "CPF"), nome: txt(emit, "xFant") || txt(emit, "xNome"), telefone: txt(emit, "fone") },
    destinatario: txt(dest, "CNPJ") || txt(dest, "CPF"),
    itens, duplicatas,
  };
}

/** Arredonda para cima terminando em ,90 (preço "de prateleira"). */
const precoBonito = (v) => { if (!(v > 0)) return 0; let p = Math.ceil(v * 10) / 10 - 0.01; if (p < v) p += 0.1; return r2(p); };
const tituloCase = (s) => String(s || "").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()).slice(0, 120);

export default async function compras(el, params = []) {
  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Compras</h1><p>Entrada de notas, o que comprar, o que mais vende e o que está parado.</p></div></div>
    <div id="abas"></div><div id="corpo"></div></div>`);
  const corpo = $("#corpo", el);
  let produtos = [], categorias = [];
  const carregarProdutos = async () => {
    [produtos, categorias] = await Promise.all([
      todos(() => sb.from("produtos").select("id,nome,codigo,codigo_barras,unidade,preco_venda,preco_custo,controla_estoque,categoria_id").eq("ativo", true).order("nome")),
      q(sb.from("categorias").select("id,nome").eq("ativo", true).order("nome")),
    ]);
  };
  await carregarProdutos();
  const telas = { entrada, sugestao, abc, parados, fornecedores };
  const lista = [["entrada", "Entrada de nota (XML)"], ["sugestao", "Sugestão de compra"], ["abc", "Curva ABC"], ["parados", "Produtos parados"], ["fornecedores", "Fornecedores"]];
  const inicial = lista.some(([k]) => k === params[0]) ? params[0] : "entrada";
  abas($("#abas", el), lista, (k) => { history.replaceState(null, "", "#/compras/" + k); telas[k]().catch(erro); }, inicial);
  await telas[inicial]();

  // =================== Entrada pelo XML ===================
  async function entrada() {
    render(corpo, html`<div class="stack-lg">
      <label class="panel panel-pad drop-xml" id="drop">
        ${icone("nota", 'width="34" height="34"')}
        <div><strong>Escolha ou arraste o XML da nota do fornecedor</strong>
          <div class="muted small">O sistema dá entrada no estoque, atualiza o custo, mostra a margem e lança as parcelas em contas a pagar. O fornecedor costuma mandar o XML por e-mail junto com a nota.</div></div>
        <input type="file" accept=".xml,text/xml,application/xml" id="arq" hidden multiple>
      </label>
      <div id="nota"></div>
      <div class="panel"><div class="panel-head"><h2>Últimas notas lançadas</h2></div><div id="hist"></div></div></div>`);
    const arq = $("#arq", corpo), drop = $("#drop", corpo);
    arq.onchange = () => { const f = arq.files[0]; arq.value = ""; if (f) abrirXML(f); };
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("sobre"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("sobre"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("sobre"); const f = e.dataTransfer.files[0]; if (f) abrirXML(f); });
    historico();
  }

  async function historico() {
    const alvo = $("#hist", corpo); if (!alvo) return;
    const notas = await q(sb.from("notas_entrada").select("*, fornecedor:fornecedores(nome)").order("created_at", { ascending: false }).limit(15));
    render(alvo, notas.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Lançada</th><th>Fornecedor</th><th>Nota</th><th>Emissão</th><th class="r">Itens</th><th class="r">Valor</th></tr></thead>
      <tbody>${notas.map((n) => html`<tr><td class="small">${dataHora(n.created_at)}</td><td>${n.fornecedor?.nome || "—"}</td><td>${n.numero || ""}${n.serie ? "/" + n.serie : ""}</td>
        <td>${dataBR(n.emitida_em)}</td><td class="r">${n.itens}</td><td class="r"><strong>${dinheiro(n.valor_total)}</strong></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma nota lançada ainda.</p></div>`);
  }

  async function abrirXML(arquivo) {
    let nf;
    try { nf = lerNFe(await lerArquivoTexto(arquivo)); } catch (e) { return erro(e); }
    // Fornecedor já conhecido? Traz o "de-para" dos códigos
    const forn = nf.fornecedor.cnpj ? await q(sb.from("fornecedores").select("id").eq("cnpj", somenteDigitos(nf.fornecedor.cnpj)).maybeSingle()) : null;
    const mapa = forn ? new Map((await q(sb.from("produto_fornecedor").select("codigo,produto_id,fator").eq("fornecedor_id", forn.id))).map((m) => [m.codigo, m])) : new Map();
    const jaLancada = nf.chave ? await q(sb.from("notas_entrada").select("created_at").eq("chave", nf.chave).maybeSingle()) : null;
    const porEan = new Map(produtos.filter((p) => p.codigo_barras).map((p) => [p.codigo_barras, p]));
    nf.itens.forEach((it) => {
      const m = mapa.get(it.codigo);
      const p = (m && produtos.find((x) => x.id === m.produto_id)) || (it.ean && porEan.get(it.ean));
      it.acao = p ? "produto" : "criar";
      it.produto_id = p?.id || null;
      it.fator = m?.fator ? Number(m.fator) : 1;
      it.reconhecido = m ? "código do fornecedor" : p ? "código de barras" : "";
      it.atualizar_custo = true; it.novo_preco = "";
      it.novo = { nome: tituloCase(it.descricao), unidade: UNID_LOJA.includes(it.unidade) && !["CX", "FD", "PCT"].includes(it.unidade) ? it.unidade : "UN", preco: "", categoria_id: "" };
    });
    desenharNota(nf, jaLancada);
  }

  function desenharNota(nf, jaLancada) {
    const alvo = $("#nota", corpo);
    const cnpjLoja = somenteDigitos(estado.empresa?.cnpj);
    const outraLoja = cnpjLoja && nf.destinatario && somenteDigitos(nf.destinatario) !== cnpjLoja;
    const nomeProd = (p) => `${p.nome}${p.codigo_barras ? " · " + p.codigo_barras : p.codigo ? " · cód " + p.codigo : ""}`;
    const porNome = new Map(produtos.map((p) => [nomeProd(p), p]));

    const linhaItem = (it) => {
      const p = it.produto_id && produtos.find((x) => x.id === it.produto_id);
      const custoLoja = it.custo_unitario / (it.fator || 1);
      let info = "";
      if (it.acao === "produto" && p) {
        const antigo = Number(p.preco_custo || 0), venda = Number(it.novo_preco ? lerNumero(it.novo_preco) : p.preco_venda);
        const margem = venda > 0 ? ((venda - custoLoja) / venda) * 100 : 0;
        const subiu = antigo > 0 ? ((custoLoja - antigo) / antigo) * 100 : 0;
        const sug = antigo > 0 ? precoBonito(custoLoja * (Number(p.preco_venda) / antigo)) : precoBonito(custoLoja * 1.4);
        info = html`<div class="nf-info">
          <span>Custo ${dinheiro(antigo)} → <strong>${dinheiro(custoLoja)}</strong>${Math.abs(subiu) >= 0.5 ? html` <span class="badge ${subiu > 0 ? "danger" : "ok"}">${subiu > 0 ? "▲" : "▼"} ${numero(Math.abs(subiu), 1)}%</span>` : ""}</span>
          <span>Venda ${dinheiro(venda)} · margem <span class="badge ${margem < 15 ? "danger" : margem < 25 ? "warn" : "ok"}">${numero(margem, 1)}%</span></span>
          ${subiu > 0.5 && sug > Number(p.preco_venda) ? html`<button type="button" class="btn sm" data-sug="${it.k}" data-v="${sug}">Usar ${dinheiro(sug)} (mantém a margem)</button>` : ""}
        </div>`;
      }
      return html`<tr data-k="${it.k}" class="${it.acao === "ignorar" ? "nf-ignorado" : ""}">
        <td><strong>${it.descricao}</strong><div class="muted small">cód ${it.codigo}${it.ean ? " · " + it.ean : ""} · ${fmtQtd(it.quantidade, "UN")} ${it.unidade} × ${dinheiro(it.valor_unitario)}${it.impostos ? html` · impostos ${dinheiro(it.impostos)}` : ""}</div>
          ${it.reconhecido ? html`<span class="badge ok">reconhecido pelo ${it.reconhecido}</span>` : ""}</td>
        <td style="min-width:300px"><div class="stack" style="gap:.35rem">
          <select class="input" data-acao>
            <option value="produto" ${it.acao === "produto" ? "selected" : ""}>Produto cadastrado</option>
            <option value="criar" ${it.acao === "criar" ? "selected" : ""}>Cadastrar produto novo</option>
            <option value="ignorar" ${it.acao === "ignorar" ? "selected" : ""}>Ignorar este item</option></select>
          ${it.acao === "produto" ? html`<input class="input" list="dl-prod" data-prod placeholder="Digite para buscar o produto" value="${p ? nomeProd(p) : ""}">` : ""}
          ${it.acao === "criar" ? html`<input class="input" data-novo="nome" value="${it.novo.nome}" placeholder="Nome">
            <div class="row" style="gap:.35rem"><select class="input" data-novo="unidade">${UNID_LOJA.map((u) => html`<option ${u === it.novo.unidade ? "selected" : ""}>${u}</option>`)}</select>
              <input class="input" data-novo="preco" inputmode="decimal" placeholder="Preço de venda (sug. ${dinheiro(precoBonito(custoLoja * 1.4))})" value="${it.novo.preco}">
              <select class="input" data-novo="categoria_id"><option value="">Categoria</option>${categorias.map((c) => html`<option value="${c.id}" ${c.id === it.novo.categoria_id ? "selected" : ""}>${c.nome}</option>`)}</select></div>` : ""}
          ${info}</div></td>
        <td style="width:110px"><label class="field"><span class="small">Unid. por ${it.unidade || "item"}</span><input class="input" data-fator inputmode="decimal" value="${String(it.fator).replace(".", ",")}" title="Ex.: caixa com 12 → 12"></label>
          <div class="small muted">= ${fmtQtd(it.quantidade * (it.fator || 1), "KG")} no estoque</div></td>
        <td style="width:150px">${it.acao === "produto" ? html`<label class="field"><span class="small">Novo preço de venda</span><input class="input" data-preco inputmode="decimal" placeholder="manter" value="${it.novo_preco}"></label>
          <label class="check small"><input type="checkbox" data-custo ${it.atualizar_custo ? "checked" : ""}> Atualizar custo</label>` : ""}
          <label class="field"><span class="small">Validade (opcional)</span><input class="input" type="date" data-val value="${it.validade}"></label></td>
      </tr>`;
    };

    render(alvo, html`<div class="panel">
      <div class="panel-head"><div><h2>NF-e ${nf.numero}${nf.serie ? "/" + nf.serie : ""} · ${nf.fornecedor.nome}</h2>
        <div class="muted small">${formatarDoc(nf.fornecedor.cnpj)} · emitida em ${dataBR(nf.emitida_em)} · ${nf.itens.length} itens · total ${dinheiro(nf.valor_total)}</div></div></div>
      <div class="panel-pad stack">
        ${jaLancada ? html`<div class="alerta">Esta nota já foi lançada em ${dataHora(jaLancada.created_at)}. Lançar de novo duplicaria o estoque.</div>` : ""}
        ${outraLoja ? html`<div class="alerta warn">Atenção: o destinatário desta nota (${formatarDoc(nf.destinatario)}) não é o CNPJ da sua loja.</div>` : ""}
        <p class="muted small">Itens que você associar agora serão reconhecidos sozinhos nas próximas notas deste fornecedor. "Unid. por" converte caixa/fardo em unidades da loja.</p>
      </div>
      <datalist id="dl-prod">${produtos.map((p) => html`<option value="${nomeProd(p)}"></option>`)}</datalist>
      <div class="table-wrap"><table class="table nf-tabela"><thead><tr><th>Item da nota</th><th>No sistema</th><th>Conversão</th><th>Preço / validade</th></tr></thead>
        <tbody id="nf-itens">${nf.itens.map(linhaItem)}</tbody></table></div>
      <div class="panel-pad stack">
        ${nf.duplicatas.length ? html`<label class="check"><input type="checkbox" id="gerar-contas" checked> Lançar ${nf.duplicatas.length} parcela(s) em contas a pagar:
          ${nf.duplicatas.map((d) => `${dataBR(d.vencimento)} ${dinheiro(d.valor)}`).join(" · ")}</label>`
          : html`<p class="muted small">A nota não tem parcelas (duplicatas). Se for a prazo, lance em Financeiro › Contas a pagar.</p>`}
        <div class="row wrap" style="justify-content:flex-end"><button class="btn" id="nf-cancelar">Cancelar</button><button class="btn primary lg" id="nf-ok">Dar entrada na nota</button></div>
      </div></div>`);

    const tbody = $("#nf-itens", alvo);
    const redesenharLinha = (it) => { const tr = tbody.querySelector(`tr[data-k="${it.k}"]`); const tmp = document.createElement("tbody"); render(tmp, linhaItem(it)); tr.replaceWith(tmp.firstElementChild); };
    tbody.addEventListener("change", (e) => {
      const tr = e.target.closest("tr[data-k]"); if (!tr) return;
      const it = nf.itens[Number(tr.dataset.k)];
      const t = e.target;
      if (t.matches("[data-acao]")) { it.acao = t.value; return redesenharLinha(it); }
      if (t.matches("[data-prod]")) { const p = porNome.get(t.value); it.produto_id = p?.id || null; if (!p && t.value) toast("Escolha um produto da lista", "erro"); return redesenharLinha(it); }
      if (t.matches("[data-fator]")) { it.fator = lerNumero(t.value) > 0 ? lerNumero(t.value) : 1; return redesenharLinha(it); }
      if (t.matches("[data-preco]")) { it.novo_preco = t.value; return redesenharLinha(it); }
      if (t.matches("[data-custo]")) it.atualizar_custo = t.checked;
      if (t.matches("[data-val]")) it.validade = t.value;
      if (t.matches("[data-novo]")) it.novo[t.dataset.novo] = t.value;
    });
    tbody.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sug]"); if (!b) return;
      const it = nf.itens[Number(b.dataset.sug)]; it.novo_preco = String(b.dataset.v).replace(".", ","); redesenharLinha(it);
    });
    $("#nf-cancelar", alvo).onclick = () => render(alvo, "");
    $("#nf-ok", alvo).onclick = (ev) => ocupado(ev.currentTarget, async () => {
      const semProduto = nf.itens.filter((it) => it.acao === "produto" && !it.produto_id);
      if (semProduto.length) return toast(`Escolha o produto de ${semProduto.length} item(ns) ou marque "Ignorar"`, "erro");
      if (jaLancada && !(await confirmar("Esta nota já foi lançada. Lançar de novo?", { perigo: true, ok: "Lançar" }))) return;
      const p = {
        chave: jaLancada ? null : nf.chave, numero: nf.numero, serie: nf.serie, emitida_em: nf.emitida_em || null, valor_total: nf.valor_total,
        fornecedor: nf.fornecedor, duplicatas: nf.duplicatas, gerar_contas: !!$("#gerar-contas", alvo)?.checked,
        itens: nf.itens.filter((it) => it.acao !== "ignorar").map((it) => ({
          codigo: it.codigo, descricao: it.descricao, ean: it.ean, ncm: it.ncm, quantidade: it.quantidade, custo_unitario: it.custo_unitario,
          fator: it.fator, validade: it.validade || null, lote: it.lote || null,
          ...(it.acao === "produto" ? { produto_id: it.produto_id, atualizar_custo: it.atualizar_custo, novo_preco_venda: it.novo_preco ? lerNumero(it.novo_preco) : null }
            : { criar: true, nome: it.novo.nome, unidade_loja: it.novo.unidade, preco_venda: lerNumero(it.novo.preco) || precoBonito((it.custo_unitario / it.fator) * 1.4), categoria_id: it.novo.categoria_id || null }),
        })),
      };
      try {
        const r = await rpc("registrar_entrada_nfe", { p });
        toast(`Nota lançada: ${r.itens} itens no estoque${r.contas ? `, ${r.contas} parcela(s) em contas a pagar` : ""}${r.lotes ? `, ${r.lotes} lote(s) com validade` : ""}`, "ok");
        render(alvo, ""); await carregarProdutos(); historico();
      } catch (e) { erro(e); }
    });
    alvo.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // =================== Sugestão de compra ===================
  async function sugestao() {
    render(corpo, html`<div class="stack-lg">
      <div class="panel panel-pad row wrap" style="gap:1rem;align-items:flex-end">
        <label class="field"><span>Basear nas vendas dos últimos</span><select class="input" id="dias">${[15, 30, 60, 90].map((d) => html`<option value="${d}" ${d === 30 ? "selected" : ""}>${d} dias</option>`)}</select></label>
        <label class="field"><span>Comprar para durar</span><select class="input" id="cob">${[3, 7, 10, 15, 30].map((d) => html`<option value="${d}" ${d === 7 ? "selected" : ""}>${d} dias</option>`)}</select></label>
        <p class="muted small grow">Sugestão = média vendida por dia × dias de cobertura + estoque mínimo − estoque atual. Ajuste as quantidades antes de enviar.</p>
      </div><div id="sug"></div></div>`);
    const carregar = async () => {
      render($("#sug", corpo), html`<div class="loading"><div class="spinner"></div></div>`);
      const itens = await rpc("sugestao_compra", { p_dias: Number($("#dias", corpo).value), p_cobertura: Number($("#cob", corpo).value) });
      const grupos = new Map();
      itens.forEach((i) => { const k = i.fornecedor_id || "-"; if (!grupos.has(k)) grupos.set(k, { nome: i.fornecedor || "Sem fornecedor definido", telefone: i.telefone, itens: [] }); grupos.get(k).itens.push(i); });
      if (!itens.length) return render($("#sug", corpo), html`<div class="panel"><div class="empty"><p>Nada a comprar agora: o estoque cobre o período escolhido.</p><p class="small">Produtos precisam ter "controlar estoque" ligado e vendas recentes.</p></div></div>`);
      render($("#sug", corpo), html`${[...grupos.entries()].map(([k, g]) => html`<div class="panel" style="margin-bottom:1rem" data-g="${k}">
        <div class="panel-head"><h2>${g.nome}</h2><div class="row wrap" style="gap:.4rem">
          <span class="muted small" data-tot></span>
          ${g.telefone ? html`<button class="btn sm" data-zap>${icone("whatsapp", 'width="16" height="16"')} Pedido no WhatsApp</button>` : ""}
          <button class="btn sm" data-copiar>Copiar pedido</button><button class="btn sm ghost" data-csv>CSV</button></div></div>
        <div class="table-wrap"><table class="table"><thead><tr><th></th><th>Produto</th><th class="r">Estoque</th><th class="r">Vende/dia</th><th class="r">Dura</th><th class="r">Comprar</th><th class="r">Custo</th></tr></thead>
        <tbody>${g.itens.map((i) => html`<tr data-id="${i.id}"><td><input type="checkbox" checked data-on></td><td><strong>${i.nome}</strong>${i.fator > 1 ? html`<div class="small muted">fornecedor vende em embalagem de ${numero(i.fator)}</div>` : ""}</td>
          <td class="r"><span class="badge ${i.estoque <= 0 ? "danger" : i.estoque <= i.minimo ? "warn" : ""}">${fmtQtd(i.estoque, i.unidade)}</span></td>
          <td class="r">${fmtQtd(i.media_dia, "KG")}</td><td class="r">${i.cobertura_dias == null ? "—" : `${numero(i.cobertura_dias, 1)} d`}</td>
          <td class="r"><input class="input" style="width:90px;text-align:right" data-q value="${String(i.sugerido).replace(".", ",")}" inputmode="decimal"> <span class="small">${i.unidade.toLowerCase()}</span></td>
          <td class="r" data-v>${dinheiro(i.valor)}</td></tr>`)}</tbody></table></div></div>`)}`);
      $$("[data-g]", corpo).forEach((box) => {
        const g = grupos.get(box.dataset.g);
        const selecionados = () => [...box.querySelectorAll("tr[data-id]")].filter((tr) => tr.querySelector("[data-on]").checked).map((tr) => {
          const i = g.itens.find((x) => x.id === tr.dataset.id); return { ...i, qtd: lerNumero(tr.querySelector("[data-q]").value) || 0 };
        }).filter((i) => i.qtd > 0);
        const total = () => { const t = selecionados().reduce((a, i) => a + i.qtd * i.custo, 0); box.querySelector("[data-tot]").textContent = `Estimado ${dinheiro(t)}`; };
        box.addEventListener("input", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr && e.target.matches("[data-q]")) { const i = g.itens.find((x) => x.id === tr.dataset.id); tr.querySelector("[data-v]").textContent = dinheiro(lerNumero(e.target.value) * i.custo); } total(); });
        box.addEventListener("change", total); total();
        const texto = () => {
          const linhas = selecionados().map((i) => i.fator > 1 ? `• ${i.nome}: ${Math.ceil(i.qtd / i.fator)} emb. (${numero(i.qtd)} ${i.unidade.toLowerCase()})` : `• ${i.nome}: ${numero(i.qtd, i.qtd % 1 ? 1 : 0)} ${i.unidade.toLowerCase()}`);
          return `Olá! Pedido de ${estado.empresa.nome_fantasia || estado.empresa.razao_social}:\n\n${linhas.join("\n")}\n\nObrigado!`;
        };
        box.querySelector("[data-zap]")?.addEventListener("click", () => { const l = linkZap(g.telefone, texto()); if (l) window.open(l, "_blank", "noopener"); });
        box.querySelector("[data-copiar]").onclick = () => navigator.clipboard?.writeText(texto()).then(() => toast("Pedido copiado", "ok"));
        box.querySelector("[data-csv]").onclick = () => baixarCSV(`pedido-${g.nome}.csv`, [["Produto", "Quantidade", "Unidade", "Custo unit.", "Total"], ...selecionados().map((i) => [i.nome, numCSV(i.qtd), i.unidade, numCSV(i.custo), numCSV(r2(i.qtd * i.custo))])]);
      });
    };
    $("#dias", corpo).onchange = $("#cob", corpo).onchange = () => carregar().catch(erro);
    await carregar();
  }

  // =================== Curva ABC ===================
  async function abc() {
    render(corpo, html`<div id="per"></div><div class="kpis" id="k"></div><div class="panel" id="t"></div>`);
    let dados = [];
    barraPeriodo($("#per", corpo), async (per) => {
      const [i, f] = periodoInstantes(per);
      try { dados = await rpc("curva_abc", { p_ini: i.toISOString(), p_fim: f.toISOString() }); } catch (e) { return erro(e); }
      const cls = (c) => dados.filter((d) => d.classe === c);
      const soma = (l, k) => l.reduce((a, d) => a + Number(d[k]), 0);
      const tot = soma(dados, "faturamento") || 1;
      render($("#k", corpo), html`${["A", "B", "C"].map((c) => html`<div class="panel kpi"><div class="k-label">Classe ${c} · ${cls(c).length} produtos</div>
        <div class="k-valor">${numero((soma(cls(c), "faturamento") / tot) * 100, 0)}%</div><div class="k-sub">${c === "A" ? "do faturamento. Nunca deixe faltar." : c === "B" ? "do faturamento. Acompanhe." : "do faturamento. Compre pouco."}</div></div>`)}`);
      render($("#t", corpo), dados.length ? html`<div class="panel-head"><h2>Produtos por faturamento</h2><button class="btn sm" id="csv">CSV</button></div><div class="table-wrap"><table class="table"><thead><tr><th>Classe</th><th>Produto</th><th class="r">Qtd</th><th class="r">Faturamento</th><th class="r">Lucro</th><th class="r">%</th><th class="r">% acum.</th></tr></thead>
        <tbody>${dados.map((d) => html`<tr><td><span class="badge ${d.classe === "A" ? "ok" : d.classe === "B" ? "warn" : ""}">${d.classe}</span></td><td>${d.nome}</td><td class="r">${numero(d.quantidade, d.quantidade % 1 ? 3 : 0)}</td>
          <td class="r"><strong>${dinheiro(d.faturamento)}</strong></td><td class="r" style="color:${d.lucro < 0 ? "var(--danger)" : ""}">${dinheiro(d.lucro)}</td><td class="r">${numero(d.participacao, 1)}%</td><td class="r">${numero(d.acumulado, 1)}%</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Sem vendas no período.</p></div>`);
      $("#csv", corpo)?.addEventListener("click", () => baixarCSV("curva-abc.csv", [["Classe", "Produto", "Quantidade", "Faturamento", "Lucro", "%", "% acumulado"], ...dados.map((d) => [d.classe, d.nome, numCSV(d.quantidade), numCSV(d.faturamento), numCSV(d.lucro), numCSV(d.participacao), numCSV(d.acumulado)])]));
    }, "30d");
  }

  // =================== Parados ===================
  async function parados() {
    render(corpo, html`<div class="panel panel-pad row wrap" style="gap:1rem;align-items:flex-end;margin-bottom:1rem">
      <label class="field"><span>Sem vender há mais de</span><select class="input" id="d">${[15, 30, 60, 90, 180].map((d) => html`<option value="${d}" ${d === 30 ? "selected" : ""}>${d} dias</option>`)}</select></label>
      <p class="muted small grow">Dinheiro parado na prateleira. Uma promoção ou um combo ajudam a girar.</p></div><div id="lst"></div>`);
    const carregar = async () => {
      const l = await rpc("produtos_parados", { p_dias: Number($("#d", corpo).value) });
      const tot = l.reduce((a, p) => a + Number(p.valor_parado), 0);
      render($("#lst", corpo), l.length ? html`<div class="kpis"><div class="panel kpi"><div class="k-label">Produtos parados</div><div class="k-valor">${l.length}</div></div>
        <div class="panel kpi"><div class="k-label">Valor parado (custo)</div><div class="k-valor">${dinheiro(tot)}</div></div></div>
        <div class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Produto</th><th class="r">Estoque</th><th class="r">Custo</th><th class="r">Valor parado</th><th>Última venda</th><th></th></tr></thead>
        <tbody>${l.map((p) => html`<tr><td><strong>${p.nome}</strong></td><td class="r">${fmtQtd(p.estoque, p.unidade)} ${p.unidade.toLowerCase()}</td><td class="r">${dinheiro(p.custo)}</td>
          <td class="r"><strong>${dinheiro(p.valor_parado)}</strong></td><td>${p.ultima_venda ? dataHora(p.ultima_venda) : "nunca vendeu"}</td>
          <td class="r"><a class="btn sm" href="#/promocoes/nova/${p.id}">Criar promoção</a></td></tr>`)}</tbody></table></div></div>`
        : html`<div class="panel"><div class="empty"><p>Nenhum produto parado. Ótimo giro!</p></div></div>`);
    };
    $("#d", corpo).onchange = () => carregar().catch(erro);
    await carregar();
  }

  // =================== Fornecedores ===================
  async function fornecedores() {
    const lista = await q(sb.from("fornecedores").select("*").order("nome"));
    render(corpo, html`<div class="toolbar"><input class="input" id="b" placeholder="Buscar fornecedor"><span class="grow"></span><button class="btn primary" id="novo">${icone("mais", 'width="18" height="18"')} Novo fornecedor</button></div>
      <div class="panel" id="l"></div>`);
    const desenhar = (t = "") => {
      const f = lista.filter((x) => !t || x.nome.toLowerCase().includes(t) || (x.cnpj || "").includes(t));
      render($("#l", corpo), f.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Nome</th><th>CNPJ/CPF</th><th>Telefone</th><th>E-mail</th><th></th></tr></thead>
        <tbody>${f.map((x) => html`<tr><td><strong>${x.nome}</strong></td><td>${formatarDoc(x.cnpj)}</td><td>${x.telefone || ""}</td><td>${x.email || ""}</td>
          <td class="r"><button class="btn sm ghost" data-e="${x.id}">Editar</button></td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Nenhum fornecedor. Eles são cadastrados sozinhos ao lançar o XML de uma nota.</p></div>`);
      $$("[data-e]", corpo).forEach((b) => (b.onclick = () => editar(lista.find((x) => x.id === b.dataset.e))));
    };
    $("#b", corpo).oninput = debounce((e) => desenhar(e.target.value.trim().toLowerCase()), 150);
    $("#novo", corpo).onclick = () => editar(null);
    desenhar();
    async function editar(f) {
      const r = await modal({
        titulo: f ? "Editar fornecedor" : "Novo fornecedor",
        corpo: html`<form id="ff" class="stack"><label class="field"><span>Nome</span><input class="input" name="nome" value="${f?.nome || ""}" required autofocus></label>
          <div class="grid-2"><label class="field"><span>CNPJ/CPF</span><input class="input" name="cnpj" value="${formatarDoc(f?.cnpj)}" inputmode="numeric"></label>
          <label class="field"><span>Telefone / WhatsApp</span><input class="input" name="telefone" value="${f?.telefone || ""}" inputmode="tel"></label></div>
          <label class="field"><span>E-mail</span><input class="input" name="email" type="email" value="${f?.email || ""}"></label></form>`,
        rodape: html`${f ? html`<button class="btn danger" id="exc">Excluir</button>` : ""}<span class="grow"></span><button class="btn" data-fechar>Voltar</button><button class="btn primary" form="ff">Salvar</button>`,
        onPronto: (d, fechar) => {
          d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const x = e.target; fechar({ nome: x.nome.value.trim(), cnpj: somenteDigitos(x.cnpj.value) || null, telefone: x.telefone.value.trim() || null, email: x.email.value.trim() || null }); };
          d.querySelector("#exc")?.addEventListener("click", () => fechar({ excluir: true }));
        },
      });
      if (!r) return;
      try {
        if (r.excluir) { if (!(await confirmar(`Excluir ${f.nome}?`, { perigo: true, ok: "Excluir" }))) return; await q(sb.from("fornecedores").delete().eq("id", f.id)); }
        else if (f) await q(sb.from("fornecedores").update(r).eq("id", f.id));
        else await q(sb.from("fornecedores").insert({ ...r, empresa_id: estado.empresa.id }));
        toast("Fornecedor salvo", "ok"); fornecedores().catch(erro);
      } catch (e) { erro(e); }
    }
  }
}
