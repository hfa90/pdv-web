// Tela de venda (frente de caixa). Pensada para teclado, leitor de código de barras e toque.
//
// Atalhos: F2 buscar · F4 quantidade · F6 desconto · F8 salvar pedido · F9 receber · Del remover item · Esc limpar
// Leitor: "3*789..." multiplica a quantidade; etiquetas de balança (EAN-13 iniciado em 2) são lidas automaticamente.
import { sb, q, rpc, fn, todos } from "../api.js";
import { estado, eh, atualizarCaixa } from "../estado.js";
import { raw, debounce, html, render, $, $$, dinheiro, qtd as fmtQtd, lerNumero, toast, erro, modal, confirmar, pedirTexto, ocupado, docValido, somenteDigitos, formatarDoc, hora, rotuloMesa } from "../ui.js";
import { icone } from "../icons.js";
import { configImpressora, imprimir, imprimirVenda, layoutVenda, nomeForma } from "../impressao/cupom.js";
import { payloadPix, qrSvg, qrPronto, txidVenda } from "../../../assets/pix.js";
import { balancaAtiva, configBalanca, lerEtiquetaBalanca, aoMudar as aoMudarBalanca } from "../balanca.js";
import { pesar } from "../pesagem.js";
import {
  novoId, estaOnline, ehErroDeRede, marcarRede, comTempo, salvarCatalogo, lerCatalogo, enfileirarVenda, aoEnviarVenda,
  agendarRascunho, descartarRascunho, aoMudarRascunho, rascunhosDeOutros, assumirRascunho,
} from "../contingencia.js";

const FRACIONADOS = ["KG", "G", "L", "ML", "M"];
const FORMAS = [
  ["dinheiro", "Dinheiro", "dinheiro"], ["pix", "PIX", "pix"], ["debito", "Débito", "cartao"],
  ["credito", "Crédito", "cartao"], ["vale_refeicao", "Vale-refeição", "vale"], ["crediario", "Crediário", "crediario"],
];
const r2 = (n) => Math.round(n * 100) / 100;

const CANAL = { mesa: "Mesa", delivery: "Delivery", retirada: "Retirada", balcao: "Balcão" };

export default async function pdv(el, params = []) {
  const chaveCarrinho = "pdv-carrinho-" + estado.perfil.id;
  const podeReceber = !eh("atendente");

  let produtos = [], categorias = [], porBarras = new Map(), porCodigo = new Map();
  let filtroCat = "todos", busca = "";
  let venda = carregarCarrinho();
  let sel = venda.itens.length - 1;

  // id_local: identidade da venda desde o primeiro item (evita duplicar ao reenviar e permite
  // continuar em outro aparelho). pagamentos: o que o cliente já pagou, guardado a cada lançamento.
  function novaVenda() { return { id_local: novoId(), venda_id: null, numero: null, alterado_em: null, canal: null, pre_pago: 0, identificador: "", cliente: null, cpf: "", desconto: 0, acrescimo: 0, observacao: "", itens: [], pagamentos: [] }; }
  // Cobrança PIX automática (Mercado Pago) ligada nesta loja?
  let pixAuto = false;
  if (!eh("atendente")) rpc("mercado_pago_status").then((v) => (pixAuto = !!v)).catch(() => {});
  function carregarCarrinho() {
    try {
      const v = JSON.parse(localStorage.getItem(chaveCarrinho));
      if (v?.itens) { v.id_local ||= novoId(); v.pagamentos ||= []; return v; }
    } catch { /* vazio */ }
    return novaVenda();
  }
  // Gravado a cada alteração: se a energia cair ou a bateria acabar, a venda volta igual
  // ao religar. Com internet, vai também para o servidor (outro aparelho pode continuar).
  function salvarCarrinho(pagamentoNovo = false) {
    try { localStorage.setItem(chaveCarrinho, JSON.stringify(venda)); } catch { /* sem armazenamento */ }
    const temAlgo = venda.itens.length || venda.pagamentos?.length;
    if (temAlgo) { venda.rascunho = true; agendarRascunho(venda, total(), pagamentoNovo); }
    else if (venda.rascunho) { venda.rascunho = false; descartarRascunho(venda.id_local); }
  }
  const jaPago = () => r2((venda.pagamentos || []).reduce((a, p) => a + p.valor, 0));

  const subtotal = () => r2(venda.itens.reduce((a, i) => a + r2(i.quantidade * i.preco), 0));
  const total = () => r2(subtotal() - venda.desconto + venda.acrescimo);

  // ---------- Estrutura ----------
  render(el, html`
    <div class="pdv">
      <section class="pdv-produtos">
        <div class="pdv-top">
          <label class="pdv-busca">${icone("busca")}
            <input class="input" id="busca" placeholder="Buscar produto ou passar o código de barras" autocomplete="off" aria-label="Buscar produto"></label>
          <button class="balanca-chip" id="chip-bal" hidden title="Balança">${icone("balanca", 'width="16" height="16"')}<span class="pt"></span><span id="chip-bal-txt">Balança</span></button>
          <button class="btn lg" id="btn-pedidos" title="Pedidos e comandas abertos">${icone("comanda", 'width="20" height="20"')}<span id="n-pedidos">Pedidos</span></button>
        </div>
        <div id="aviso-caixa"></div>
        <div id="aviso-rasc"></div>
        <div class="chips" id="chips" role="tablist" aria-label="Categorias"></div>
        <div class="grid-produtos" id="grid" aria-label="Produtos"></div>
      </section>
      <section class="cupom-col">
        <div class="cupom">
          <div class="cupom-head">
            <div><div style="font-weight:650" id="titulo-venda">Venda</div><div class="ident" id="sub-venda"></div></div>
            <div class="row" style="gap:.35rem">
              <button class="btn sm" id="btn-ident" title="Mesa, comanda ou senha">Mesa</button>
              <button class="btn sm" id="btn-cliente" title="Cliente ou CPF na nota">CPF</button>
            </div>
          </div>
          <div class="cupom-itens" id="itens"></div>
          <div class="cupom-rodape">
            <div class="linha-valor"><span>Subtotal</span><span id="v-sub"></span></div>
            <div class="linha-valor" id="l-desc"><span>Desconto</span><span id="v-desc"></span></div>
            <div class="linha-valor" id="l-acr"><span>Acréscimo</span><span id="v-acr"></span></div>
            <div class="total"><span class="total-label">Total</span><span class="total-valor" id="v-total"></span></div>
            <div class="linha-valor ja-pago" id="l-pago" hidden><span>Já pago</span><span id="v-pago"></span></div>
            <div class="cupom-acoes">
              <button class="btn" id="btn-desc">Desconto <span class="kbd">F6</span></button>
              <button class="btn" id="btn-salvar">${eh("atendente") ? "Enviar pedido" : "Salvar pedido"} <span class="kbd">F8</span></button>
              ${podeReceber ? html`<button class="btn primary lg" id="btn-receber">Receber <span class="kbd">F9</span></button>` : ""}
            </div>
          </div>
        </div>
      </section>
    </div>`);

  const inpBusca = $("#busca", el);

  // ---------- Dados ----------
  async function carregarProdutos() {
    try {
      [categorias, produtos] = await comTempo(Promise.all([
        q(sb.from("categorias").select("*").eq("ativo", true).order("ordem").order("nome")),
        todos(() => sb.from("produtos").select("id,nome,codigo,codigo_barras,preco_venda,unidade,categoria_id,favorito,controla_estoque,estoque_atual").eq("ativo", true).order("nome")),
      ]), 20000);
      salvarCatalogo(categorias, produtos);
    } catch (e) {
      // Sem internet: usa a lista de produtos guardada neste aparelho
      const c = lerCatalogo();
      if (!ehErroDeRede(e) || !c) throw e;
      marcarRede(false);
      [categorias, produtos] = [c.categorias || [], c.produtos || []];
      toast(`Sem internet: usando os produtos salvos neste aparelho (${new Date(c.salvo_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })})`);
    }
    porBarras = new Map(produtos.filter((p) => p.codigo_barras).map((p) => [p.codigo_barras, p]));
    porCodigo = new Map(produtos.filter((p) => p.codigo).map((p) => [String(p.codigo).replace(/^0+/, "").toLowerCase(), p]));
    if (filtroCat === "todos" && produtos.some((p) => p.favorito)) filtroCat = "fav";
    desenharChips(); desenharGrade();
  }

  async function contarPedidos() {
    if (!estaOnline()) return;
    try {
      const { count } = await comTempo(sb.from("vendas").select("id", { count: "exact", head: true }).eq("status", "aberta"), 10000);
      $("#n-pedidos", el).textContent = count ? `Pedidos (${count})` : "Pedidos";
    } catch { /* sem rede */ }
  }

  function desenharAvisoCaixa() {
    const alvo = $("#aviso-caixa", el);
    if (!podeReceber || estado.caixa) return render(alvo, "");
    render(alvo, html`<div class="alerta warn row" style="justify-content:space-between">
      <span>O caixa está fechado. Abra para receber pagamentos.</span>
      <button class="btn sm" id="abrir-cx">Abrir caixa</button></div>`);
    $("#abrir-cx", el).onclick = abrirCaixaRapido;
  }

  async function abrirCaixaRapido() {
    const v = await pedirTexto({ titulo: "Abrir caixa", rotulo: "Fundo de troco (R$)", tipo: "text", valor: "0,00", ok: "Abrir caixa", dica: "Valor em dinheiro que já está na gaveta." });
    if (v == null) return;
    const valor = lerNumero(v);
    if (!(valor >= 0)) return toast("Valor inválido", "erro");
    try { await rpc("abrir_caixa", { p_valor: valor, p_terminal: localStorage.getItem("pdv-terminal") || null }); await atualizarCaixa(); toast("Caixa aberto", "ok"); desenharAvisoCaixa(); }
    catch (e) { erro(ehErroDeRede(e) ? new Error("Sem internet: abrir o caixa precisa de conexão. Depois de aberto, ele funciona mesmo offline.") : e); }
  }

  // ---------- Catálogo ----------
  function desenharChips() {
    const chips = [];
    if (produtos.some((p) => p.favorito)) chips.push(["fav", "Favoritos", null]);
    chips.push(["todos", "Todos", null]);
    categorias.forEach((c) => chips.push([c.id, c.nome, c.cor]));
    render($("#chips", el), html`${chips.map(([id, nome, cor]) =>
      html`<button class="chip ${filtroCat === id ? "ativo" : ""}" data-cat="${id}" role="tab" aria-selected="${filtroCat === id}">
        ${cor ? html`<span class="dot" style="background:${cor}"></span>` : ""}${nome}</button>`)}`);
    $$("#chips .chip", el).forEach((b) => (b.onclick = () => { filtroCat = b.dataset.cat; desenharChips(); desenharGrade(); }));
  }

  function filtrados() {
    const t = busca.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    let lista = produtos;
    if (t) {
      lista = lista.filter((p) => p.nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(t)
        || p.codigo?.toLowerCase() === t || p.codigo_barras === t);
    } else if (filtroCat === "fav") lista = lista.filter((p) => p.favorito);
    else if (filtroCat !== "todos") lista = lista.filter((p) => p.categoria_id === filtroCat);
    return lista.slice(0, 300);
  }

  function desenharGrade() {
    const cor = Object.fromEntries(categorias.map((c) => [c.id, c.cor]));
    const lista = filtrados();
    if (!produtos.length) {
      return render($("#grid", el), html`<div class="empty" style="grid-column:1/-1">
        ${icone("produtos", 'width="40" height="40"')}<p>Nenhum produto cadastrado ainda.</p>
        ${eh("admin", "gerente") ? html`<a class="btn primary" href="#/produtos">Cadastrar produtos</a>` : html`<p class="small">Peça ao gerente para cadastrar.</p>`}</div>`);
    }
    if (!lista.length) return render($("#grid", el), html`<div class="empty" style="grid-column:1/-1"><p>Nenhum produto encontrado para “${busca}”.</p></div>`);
    render($("#grid", el), html`${lista.map((p) => html`
      <button class="prod ${p.controla_estoque && p.estoque_atual <= 0 ? "sem-estoque" : ""}" data-id="${p.id}" style="--cat:${cor[p.categoria_id] || "var(--line-strong)"}">
        <span class="prod-nome">${p.nome}</span>
        <span class="prod-preco">${dinheiro(p.preco_venda)}${p.unidade !== "UN" ? html` <small>/${p.unidade.toLowerCase()}</small>` : ""}</span>
      </button>`)}`);
    $$("#grid .prod", el).forEach((b) => (b.onclick = () => adicionarProduto(produtos.find((p) => p.id === b.dataset.id))));
  }

  // ---------- Carrinho ----------
  async function adicionarProduto(p, quantidade = null) {
    if (!p) return;
    if (quantidade == null) {
      if (FRACIONADOS.includes(p.unidade) && ["KG", "G"].includes(p.unidade) && balancaAtiva()) {
        const r = await pesar(p);
        if (r === undefined) return focarBusca();
        if (r !== "manual") quantidade = r;
      }
      if (quantidade == null && FRACIONADOS.includes(p.unidade)) {
        const v = await pedirTexto({ titulo: p.nome, rotulo: `Quantidade (${p.unidade.toLowerCase()})`, valor: "", ok: "Adicionar", dica: `${dinheiro(p.preco_venda)} por ${p.unidade.toLowerCase()}. Ex.: 0,350` });
        if (v == null) return focarBusca();
        quantidade = lerNumero(v);
      } else if (quantidade == null) quantidade = 1;
    }
    if (!(quantidade > 0)) { toast("Quantidade inválida", "erro"); return focarBusca(); }
    if (!FRACIONADOS.includes(p.unidade)) quantidade = Math.round(quantidade);
    const existente = !FRACIONADOS.includes(p.unidade) && venda.itens.findIndex((i) => i.produto_id === p.id && !i.observacao);
    if (existente !== false && existente >= 0) {
      venda.itens[existente].quantidade += quantidade; sel = existente;
    } else {
      venda.itens.push({ produto_id: p.id, nome: p.nome, unidade: p.unidade, preco: Number(p.preco_venda), quantidade: Math.round(quantidade * 1000) / 1000, observacao: "" });
      sel = venda.itens.length - 1;
    }
    atualizarCupom(true);
    focarBusca();
  }

  function atualizarCupom(rolar = false) {
    salvarCarrinho();
    const titulo = venda.numero ? `Pedido nº ${venda.numero}` : "Nova venda";
    $("#titulo-venda", el).textContent = titulo;
    const sub = [rotuloMesa(venda.identificador), venda.cliente?.nome, venda.cpf && `CPF/CNPJ ${formatarDoc(venda.cpf)}`].filter(Boolean).join(" · ");
    $("#sub-venda", el).textContent = sub || `${venda.itens.length} ${venda.itens.length === 1 ? "item" : "itens"}`;
    $("#btn-ident", el).textContent = venda.identificador ? rotuloMesa(venda.identificador) : "Mesa";
    $("#btn-cliente", el).textContent = venda.cliente || venda.cpf ? "Cliente ✓" : "CPF";

    const box = $("#itens", el);
    if (!venda.itens.length) {
      render(box, html`<div class="cupom-vazio">${icone("cesta")}<strong>Cupom vazio</strong>
        <span class="small">Toque em um produto ou passe o código de barras.</span></div>`);
    } else {
      render(box, html`${venda.itens.map((i, idx) => html`
        <div class="item ${idx === sel ? "sel" : ""}" data-i="${idx}">
          <div><div class="item-nome">${i.nome}</div>
            <div class="item-det">${fmtQtd(i.quantidade, i.unidade)} ${i.unidade.toLowerCase()} × ${dinheiro(i.preco)}${i.observacao ? html` · ${i.observacao}` : ""}</div></div>
          <div class="item-total">${dinheiro(r2(i.quantidade * i.preco))}</div>
          ${idx === sel ? html`<div class="item-acoes">
            <div class="qtd"><button data-a="menos" aria-label="Diminuir">−</button>
              <input data-a="qtd" value="${fmtQtd(i.quantidade, i.unidade)}" inputmode="decimal" aria-label="Quantidade">
              <button data-a="mais" aria-label="Aumentar">+</button></div>
            <button class="btn sm ghost" data-a="obs">Observação</button>
            <span class="grow"></span>
            <button class="btn sm ghost icon-btn" data-a="rem" aria-label="Remover item" style="color:var(--danger)">${icone("lixo", 'width="18" height="18"')}</button>
          </div>` : ""}
        </div>`)}`);
      $$(".item", box).forEach((linha) => {
        const idx = Number(linha.dataset.i);
        linha.addEventListener("click", (e) => {
          const a = e.target.closest("[data-a]")?.dataset.a;
          if (!a) { if (sel !== idx) { sel = idx; atualizarCupom(); } return; }
          const it = venda.itens[idx];
          const passo = FRACIONADOS.includes(it.unidade) ? 0.1 : 1;
          if (a === "mais") it.quantidade = r2(it.quantidade + passo);
          if (a === "menos") { if (it.quantidade - passo <= 0) return removerItem(idx); it.quantidade = r2(it.quantidade - passo); }
          if (a === "rem") return removerItem(idx);
          if (a === "obs") return editarObs(idx);
          if (a !== "qtd") atualizarCupom();
        });
        const inp = linha.querySelector('[data-a="qtd"]');
        if (inp) inp.addEventListener("change", () => {
          const n = lerNumero(inp.value); const it = venda.itens[idx];
          if (!(n > 0)) { inp.value = fmtQtd(it.quantidade, it.unidade); return toast("Quantidade inválida", "erro"); }
          it.quantidade = FRACIONADOS.includes(it.unidade) ? Math.round(n * 1000) / 1000 : Math.round(n);
          atualizarCupom();
        });
      });
      if (rolar) box.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
    }
    $("#v-sub", el).textContent = dinheiro(subtotal());
    $("#v-desc", el).textContent = "−" + dinheiro(venda.desconto);
    $("#v-acr", el).textContent = dinheiro(venda.acrescimo);
    $("#l-desc", el).hidden = !venda.desconto;
    $("#l-acr", el).hidden = !venda.acrescimo;
    $("#v-total", el).textContent = dinheiro(total());
    const pg = jaPago();
    $("#l-pago", el).hidden = !pg;
    $("#v-pago", el).textContent = `${dinheiro(pg)} · falta ${dinheiro(Math.max(0, r2(total() - pg)))}`;
  }

  function removerItem(idx) {
    venda.itens.splice(idx, 1);
    sel = Math.min(sel, venda.itens.length - 1);
    if (venda.desconto > subtotal()) venda.desconto = 0;
    atualizarCupom();
    focarBusca();
  }

  async function editarObs(idx) {
    const it = venda.itens[idx];
    const v = await pedirTexto({ titulo: it.nome, rotulo: "Observação (vai para o pedido)", valor: it.observacao, ok: "Salvar", dica: "Ex.: sem cebola, ponto da carne, para viagem." });
    if (v == null) return;
    it.observacao = v.slice(0, 200);
    atualizarCupom();
  }

  async function alterarQuantidade() {
    const it = venda.itens[sel];
    if (!it) return;
    const v = await pedirTexto({ titulo: it.nome, rotulo: `Quantidade (${it.unidade.toLowerCase()})`, valor: fmtQtd(it.quantidade, it.unidade), ok: "Alterar" });
    if (v == null) return focarBusca();
    const n = lerNumero(v);
    if (!(n > 0)) return toast("Quantidade inválida", "erro");
    it.quantidade = FRACIONADOS.includes(it.unidade) ? Math.round(n * 1000) / 1000 : Math.round(n);
    atualizarCupom(); focarBusca();
  }

  async function aplicarDesconto() {
    if (!venda.itens.length) return;
    const limite = eh("caixa", "atendente") ? Number(estado.empresa.desconto_maximo_caixa) : 100;
    const res = await modal({
      titulo: "Desconto e acréscimo",
      corpo: html`<form class="stack" id="f-desc">
        <div class="grid-2">
          <label class="field"><span>Desconto</span><input class="input lg" name="desc" value="${venda.desconto ? String(venda.desconto).replace(".", ",") : ""}" inputmode="decimal" placeholder="0,00" autofocus></label>
          <label class="field"><span>Tipo</span><select class="input lg" name="tipo"><option value="r">R$</option><option value="p">%</option></select></label>
        </div>
        <label class="field"><span>Acréscimo / taxa de serviço (R$)</span><input class="input" name="acr" value="${venda.acrescimo ? String(venda.acrescimo).replace(".", ",") : ""}" inputmode="decimal" placeholder="0,00"></label>
        <div class="row wrap"><button type="button" class="btn sm" data-taxa="10">Taxa de serviço 10%</button><button type="button" class="btn sm" data-taxa="0">Sem taxa</button></div>
        ${limite < 100 ? html`<p class="hint">Seu limite de desconto é ${limite}% do subtotal. Acima disso, peça a um gerente.</p>` : ""}
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-desc">Aplicar</button>`,
      onPronto: (d, fechar) => {
        const f = d.querySelector("form");
        d.querySelectorAll("[data-taxa]").forEach((b) => (b.onclick = () => { f.acr.value = String(r2(subtotal() * Number(b.dataset.taxa) / 100)).replace(".", ","); }));
        f.onsubmit = (e) => {
          e.preventDefault();
          let desc = lerNumero(f.desc.value); const acr = lerNumero(f.acr.value);
          if (f.tipo.value === "p") desc = r2(subtotal() * desc / 100);
          if (!(desc >= 0) || !(acr >= 0)) return toast("Valor inválido", "erro");
          if (desc > subtotal()) return toast("Desconto maior que o subtotal", "erro");
          if (desc / subtotal() * 100 > limite + 1e-9) return toast(`Desconto acima do seu limite (${limite}%)`, "erro");
          fechar({ desc: r2(desc), acr: r2(acr) });
        };
      },
    });
    if (res) { venda.desconto = res.desc; venda.acrescimo = res.acr; atualizarCupom(); }
    focarBusca();
  }

  async function definirIdentificador() {
    const v = await pedirTexto({ titulo: "Mesa, comanda ou senha", rotulo: "Identificação", valor: venda.identificador, ok: "Salvar", dica: "Ex.: 12, Balcão 3, João." });
    if (v == null) return focarBusca();
    venda.identificador = v.slice(0, 30); atualizarCupom(); focarBusca();
  }

  async function definirCliente() {
    const res = await modal({
      titulo: "Cliente / CPF na nota",
      corpo: html`<div class="stack">
        <label class="field"><span>CPF ou CNPJ na nota</span><input class="input lg" id="cpf" value="${formatarDoc(venda.cpf)}" inputmode="numeric" autofocus></label>
        <label class="field"><span>Ou busque um cliente cadastrado</span><input class="input" id="bc" placeholder="Nome, CPF ou telefone"></label>
        <div id="res-cli" class="stack" style="gap:.35rem"></div>
        ${venda.cliente ? html`<div class="pag-linha"><span>${venda.cliente.nome}</span><button class="btn sm ghost" id="tirar">Remover</button></div>` : ""}
      </div>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" id="ok-cli">Confirmar</button>`,
      onPronto: (d, fechar) => {
        let cliente = venda.cliente;
        const buscar = async () => {
          const t = d.querySelector("#bc").value.trim();
          if (t.length < 2) return render(d.querySelector("#res-cli"), "");
          const dig = somenteDigitos(t);
          let qy = sb.from("clientes").select("id,nome,cpf_cnpj,telefone").eq("ativo", true).limit(8);
          qy = dig.length >= 3 ? qy.or(`cpf_cnpj.ilike.%${dig}%,telefone.ilike.%${dig}%`) : qy.ilike("nome", `%${t.replace(/[%,()]/g, "")}%`);
          const lista = await q(qy);
          render(d.querySelector("#res-cli"), lista.length ? html`${lista.map((c) => html`<button class="btn" style="justify-content:space-between" data-c="${c.id}"><span>${c.nome}</span><span class="muted small">${formatarDoc(c.cpf_cnpj)}</span></button>`)}` : html`<p class="muted small">Nenhum cliente encontrado.</p>`);
          d.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => {
            cliente = lista.find((c) => c.id === b.dataset.c);
            d.querySelector("#cpf").value = formatarDoc(cliente.cpf_cnpj);
            fechar({ cliente, cpf: somenteDigitos(cliente.cpf_cnpj) });
          }));
        };
        let t; d.querySelector("#bc").oninput = () => { clearTimeout(t); t = setTimeout(() => buscar().catch(erro), 250); };
        d.querySelector("#tirar")?.addEventListener("click", () => fechar({ cliente: null, cpf: "" }));
        const ok = () => {
          const cpf = somenteDigitos(d.querySelector("#cpf").value);
          if (cpf && !docValido(cpf)) return toast("CPF/CNPJ inválido", "erro");
          fechar({ cliente, cpf });
        };
        d.querySelector("#ok-cli").onclick = ok;
        d.querySelector("#cpf").onkeydown = (e) => { if (e.key === "Enter") ok(); };
      },
    });
    if (res) { venda.cliente = res.cliente; venda.cpf = res.cpf; atualizarCupom(); }
    focarBusca();
  }

  async function limpar(perguntar = true) {
    if (perguntar && venda.itens.length && !(await confirmar("Descartar os itens deste cupom?", { titulo: "Limpar cupom", ok: "Descartar", perigo: true }))) return focarBusca();
    if (perguntar && venda.pagamentos?.length && !(await confirmar(`Este cupom já tem ${dinheiro(jaPago())} recebidos. Descartar mesmo assim? Devolva o valor ao cliente.`, { titulo: "Pagamento já recebido", ok: "Descartar", perigo: true }))) return focarBusca();
    venda = novaVenda(); sel = -1; atualizarCupom(); focarBusca();
  }

  const payload = (finalizar, pagamentos = []) => ({
    venda_id: venda.venda_id, finalizar,
    itens: venda.itens.map((i) => ({ produto_id: i.produto_id, quantidade: i.quantidade, observacao: i.observacao || null })),
    pagamentos, desconto: venda.desconto, acrescimo: venda.acrescimo,
    cliente_id: venda.cliente?.id || null, cpf_cnpj: venda.cpf || null,
    identificador: venda.identificador || null, observacao: venda.observacao || null,
    ...(venda.venda_id && venda.alterado_em ? { alterado_em: venda.alterado_em } : {}),
  });

  // ---------- Pedidos / comandas ----------
  async function salvarPedido() {
    if (!venda.itens.length) return toast("Adicione itens ao pedido", "erro");
    if (!venda.identificador) { await definirIdentificador(); if (!venda.identificador) return; }
    try {
      const r = await ocupado($("#btn-salvar", el), () => rpc("registrar_venda", { p: payload(false) }));
      toast(`Pedido nº ${r.numero} salvo · ${rotuloMesa(venda.identificador)}`, "ok");
      if (configImpressora().viaPedido) imprimirVenda(r.id).catch(erro);
      limpar(false); contarPedidos();
    } catch (e) {
      erro(e);
      if (/outro aparelho/.test(e.message) && venda.venda_id) { const id = venda.venda_id; venda.itens = []; await carregarPedido(id).catch(erro); }
    }
  }

  async function abrirPedidos() {
    if (!estaOnline()) return toast("Sem internet: pedidos, comandas e vendas de outros aparelhos aparecem quando a conexão voltar", "erro");
    const rascs = podeReceber ? await rascunhosDeOutros().catch(() => []) : [];
    const lista = await q(sb.from("vendas").select("id,numero,identificador,canal,total,created_at,status_pedido,pagamento_status,cliente_nome,operador:perfis!vendas_operador_id_fkey(nome)")
      .eq("status", "aberta").order("created_at"));
    await modal({
      titulo: "Pedidos e comandas abertos",
      corpo: html`${rascs.length ? html`<h3 class="small muted" style="margin:0 0 .4rem">Vendas em andamento em outros aparelhos</h3>
        <div class="table-wrap" style="margin-bottom:1rem"><table class="table"><thead><tr><th>Aparelho</th><th>Operador</th><th>Itens</th><th class="r">Total</th><th class="r">Já pago</th><th>Atualizada</th></tr></thead>
        <tbody>${rascs.map((r) => html`<tr class="click" data-rasc="${r.id}"><td><strong>${r.aparelho_nome || "—"}</strong></td><td>${r.operador_nome || ""}</td><td>${r.itens}</td>
          <td class="r">${dinheiro(r.total)}</td><td class="r">${dinheiro(r.pago)}</td><td>${hora(r.atualizado_em)}</td></tr>`)}</tbody></table></div>
        <h3 class="small muted" style="margin:0 0 .4rem">Pedidos e comandas</h3>` : ""}${lista.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Mesa/comanda</th><th>Pedido</th><th>Desde</th><th>Atendente</th><th class="r">Total</th></tr></thead>
        <tbody>${lista.map((v) => html`<tr class="click" data-id="${v.id}"><td><strong>${rotuloMesa(v.identificador) || "—"}</strong>
          ${v.canal && v.canal !== "balcao" ? html` <span class="badge canal-${v.canal}">${CANAL[v.canal]}</span>` : ""}${v.pagamento_status === "pago" ? html` <span class="badge ok">pago</span>` : ""}</td>
          <td>nº ${v.numero}</td><td>${hora(v.created_at)}</td><td>${v.operador?.nome || v.cliente_nome || ""}</td><td class="r">${dinheiro(v.total)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Nenhum pedido aberto.</p><p class="small">Use “Salvar pedido” para guardar uma mesa ou comanda e continuar depois.</p></div>`}`,
      largo: true,
      onPronto: (d, fechar) => {
        d.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => fechar(tr.dataset.id)));
        d.querySelectorAll("tr[data-rasc]").forEach((tr) => (tr.onclick = () => fechar({ rasc: tr.dataset.rasc })));
      },
    }).then(async (id) => { if (id?.rasc) await continuarAqui(id.rasc); else if (id) await carregarPedido(id); });
    focarBusca();
  }

  async function carregarPedido(id) {
    if (venda.itens.length && !venda.venda_id && !(await confirmar("O cupom atual tem itens que não foram salvos. Substituir pelo pedido?", { ok: "Substituir" }))) return;
    const v = await q(sb.from("vendas").select("*, cliente:clientes(id,nome,cpf_cnpj), itens:venda_itens(*)").eq("id", id).single());
    const mapa = new Map(produtos.map((p) => [p.id, p]));
    if (v.status !== "aberta") { toast(`Este pedido já está ${v.status}`, "erro"); return; }
    if (venda.rascunho && venda.id_local) descartarRascunho(venda.id_local);
    venda = {
      id_local: novoId(), pagamentos: [],
      venda_id: v.id, numero: v.numero, alterado_em: v.alterado_em, canal: v.canal,
      pre_pago: v.pagamento_status === "pago" ? Number(v.total) : 0,
      identificador: v.identificador || "", cliente: v.cliente, cpf: v.cpf_cnpj_consumidor || "",
      desconto: Number(v.desconto) - v.itens.filter((i) => !i.removido).reduce((a, i) => a + Number(i.desconto), 0),
      acrescimo: Number(v.acrescimo), observacao: v.observacao || "",
      itens: v.itens.filter((i) => !i.removido).sort((a, b) => a.item - b.item).map((i) => ({
        produto_id: i.produto_id, nome: i.descricao, unidade: i.unidade,
        preco: Number(mapa.get(i.produto_id)?.preco_venda ?? i.preco_unitario), quantidade: Number(i.quantidade), observacao: i.observacao || "",
      })),
    };
    sel = venda.itens.length - 1;
    atualizarCupom();
    if (venda.pre_pago) toast("Este pedido já foi pago por PIX no cardápio digital", "ok");
  }

  // ---------- Pagamento ----------
  async function receber() {
    if (!podeReceber) return;
    if (!venda.itens.length) return toast("Adicione itens antes de receber", "erro");
    if (!estado.caixa) { await atualizarCaixa(); if (!estado.caixa) { desenharAvisoCaixa(); return toast("Abra o caixa para receber", "erro"); } }
    const fiscalAtivo = !!estado.fiscal?.habilitado;
    const cfg = configImpressora();
    const t = total();
    // Pagamentos ficam na própria venda: sobrevivem a fechar esta janela, queda de energia
    // e troca de aparelho (o que o cliente já pagou nunca se perde).
    venda.pagamentos ||= [];
    const pagamentos = venda.pagamentos;
    let forma = "dinheiro";
    // Pedido do delivery já pago online: entra como PIX recebido
    if (venda.pre_pago && !pagamentos.some((p) => p.pre)) pagamentos.push({ forma: "pix", valor: Math.min(t, r2(venda.pre_pago)), pre: true });
    const e = estado.empresa;
    const temChave = !!(e.pix_chave && e.pix_tipo);
    await qrPronto(1500);
    let pararPix = () => {};

    const resultado = await modal({
      titulo: "Receber pagamento",
      largo: true,
      corpo: html`<div class="stack-lg">
        <div class="total" style="padding:0"><span class="total-label">Total a pagar</span><span class="total-valor">${dinheiro(t)}</span></div>
        <div class="formas" id="formas">${FORMAS.map(([id, nome, ic]) => html`<button type="button" class="forma ${id === forma ? "ativo" : ""}" data-f="${id}">${icone(ic)}${nome}</button>`)}</div>
        <form class="row" id="f-pag" style="align-items:flex-end">
          <label class="field grow"><span>Valor recebido</span><input class="input lg" name="valor" inputmode="decimal" autocomplete="off" autofocus></label>
          <button class="btn lg">Adicionar</button>
        </form>
        <div class="atalhos-valor" id="atalhos"></div>
        <div class="pix-area" id="pix-area" hidden></div>
        <div class="pag-lista" id="pags"></div>
        <div class="pag-resumo" id="resumo"></div>
        <div class="grid-2">
          <label class="check"><input type="checkbox" id="imp" ${cfg.autoImprimir ? "checked" : ""}> Imprimir cupom</label>
          ${fiscalAtivo ? html`<label class="check"><input type="checkbox" id="nfce" ${estado.fiscal.emitir_automatico ? "checked" : ""}> Emitir NFC-e</label>` : ""}
        </div>
      </div>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary lg" id="concluir" disabled>Concluir venda</button>`,
      onPronto: (d, fechar) => {
        const f = d.querySelector("#f-pag");
        const areaPix = d.querySelector("#pix-area");
        let cobranca = null; // { id, valor } — cobrança automática em andamento
        let timerPix = null;
        pararPix = () => { clearTimeout(timerPix); timerPix = null; cobranca = null; };
        const pago = () => r2(pagamentos.reduce((a, p) => a + p.valor, 0));
        const falta = () => Math.max(0, r2(t - pago()));
        // ----- PIX: QR Code com o valor -----
        const valorPix = () => { const v = lerNumero(f.valor.value); return v > 0 ? Math.min(r2(v), falta()) : falta(); };
        const desenharPix = async () => {
          if (forma !== "pix" || falta() <= 0) { areaPix.hidden = true; pararPix(); return; }
          areaPix.hidden = false;
          const valor = valorPix();
          if (pixAuto) {
            if (cobranca?.valor === valor) return;
            pararPix();
            render(areaPix, html`<div class="pix-carregando"><span class="spinner"></span> Gerando cobrança PIX de ${dinheiro(valor)}…</div>`);
            try {
              const c = await fn("pagamentos", { acao: "pix_criar", valor, descricao: `Venda ${venda.numero || ""} ${estado.empresa.nome_fantasia || ""}`.trim() });
              if (forma !== "pix" || !d.open) return;
              cobranca = { id: c.id, valor };
              mostrarQr(c.qr_code, valor, true);
              const verificar = async () => {
                if (!cobranca || cobranca.id !== c.id || !d.open) return;
                try {
                  const st = await fn("pagamentos", { acao: "pix_status", payment_id: c.id });
                  if (st.status === "approved") {
                    pararPix(); adicionar(valor, "pix");
                    toast(`PIX de ${dinheiro(valor)} confirmado`, "ok"); return;
                  }
                  if (["rejected", "cancelled", "expired"].includes(st.status)) { pararPix(); desenharPix(); return; }
                } catch { /* tenta de novo */ }
                timerPix = setTimeout(verificar, 3000);
              };
              timerPix = setTimeout(verificar, 3000);
            } catch (err) {
              render(areaPix, html`<div class="alerta warn">Não foi possível gerar a cobrança automática (${err.message}).${temChave ? " Usando a chave PIX da loja." : ""}</div><div id="pix-alt"></div>`);
              cobranca = { id: null, valor };
              if (temChave) mostrarQr(codigoEstatico(valor), valor, false, areaPix.querySelector("#pix-alt"));
            }
            return;
          }
          if (!temChave) {
            render(areaPix, html`<div class="alerta info">Para mostrar o QR Code do PIX, cadastre a chave da loja em
              ${eh("admin", "gerente") ? html`<a href="#/configuracoes/pix" data-fechar>Configurações › PIX</a>` : "Configurações › PIX (peça ao gerente)"}.
              Você ainda pode lançar o PIX recebido em “Adicionar”.</div>`);
            return;
          }
          try { mostrarQr(codigoEstatico(valor), valor, false); }
          catch (err) { render(areaPix, html`<div class="alerta warn">${err.message}</div>`); }
        };
        const codigoEstatico = (valor) => payloadPix({ tipo: e.pix_tipo, chave: e.pix_chave, nome: e.pix_nome || e.nome_fantasia || e.razao_social, cidade: e.pix_cidade || e.municipio, valor, txid: txidVenda("PDV", venda.numero) });
        const mostrarQr = (codigo, valor, auto, alvo = areaPix) => {
          const bloco = html`<div class="qr-box">${raw(qrSvg(codigo, 210))}</div>
            <div class="stack grow" style="gap:.5rem;min-width:200px">
              <div><div class="muted small">PIX para ${e.pix_nome || e.nome_fantasia || "a loja"}</div><div class="pix-valor">${dinheiro(valor)}</div></div>
              <div class="pix-status ${auto ? "auto" : ""}">${auto ? html`<span class="pulso"></span> Aguardando pagamento · confirma sozinho` : "Mostre o QR ao cliente e confira o crédito no app do banco."}</div>
              <div class="row wrap" style="gap:.4rem">
                <button type="button" class="btn sm" data-pix="copiar">Copiar código</button>
                <button type="button" class="btn sm" data-pix="imprimir">${icone("imprimir", 'width="16" height="16"')} Imprimir QR</button>
              </div>
              <button type="button" class="btn ${auto ? "" : "primary"}" data-pix="ok">${auto ? "Confirmar manualmente" : "PIX recebido"} · ${dinheiro(valor)}</button>
            </div>`;
          render(alvo, html`<div class="row wrap pix-linha">${bloco}</div>`);
          alvo.querySelector('[data-pix="copiar"]').onclick = () => navigator.clipboard?.writeText(codigo).then(() => toast("Código PIX copiado", "ok"), () => toast("Não foi possível copiar", "erro"));
          alvo.querySelector('[data-pix="imprimir"]').onclick = () => imprimir([
            { t: "texto", s: estado.empresa.nome_fantasia || estado.empresa.razao_social, align: "centro", bold: true },
            { t: "texto", s: "PAGUE COM PIX", align: "centro", bold: true, grande: true },
            { t: "texto", s: dinheiro(valor), align: "centro", bold: true, grande: true },
            { t: "qr", s: codigo }, { t: "texto", s: "Abra o app do banco e leia o QR Code", align: "centro" },
          ]).catch(erro);
          alvo.querySelector('[data-pix="ok"]').onclick = () => { pararPix(); adicionar(valor, "pix"); };
        };
        const desenharPixDepois = debounce(desenharPix, 500);

        const atualizar = () => {
          d.querySelectorAll(".forma").forEach((b) => b.classList.toggle("ativo", b.dataset.f === forma));
          f.valor.value = falta() ? String(falta().toFixed(2)).replace(".", ",") : "";
          const notas = forma === "dinheiro" && falta() ? [...new Set([falta(), ...[5, 10, 20, 50, 100, 200].filter((n) => n > falta())].slice(0, 5))] : [];
          render(d.querySelector("#atalhos"), html`${notas.map((n) => html`<button type="button" class="btn sm" data-v="${n}">${dinheiro(n)}</button>`)}`);
          d.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => adicionar(Number(b.dataset.v))));
          render(d.querySelector("#pags"), html`${pagamentos.map((p, i) => html`<div class="pag-linha"><span>${nomeForma(p.forma)}</span>
            <span class="row" style="gap:.5rem"><strong>${dinheiro(p.valor)}</strong><button type="button" class="btn sm ghost icon-btn" data-rem="${i}" aria-label="Remover">✕</button></span></div>`)}`);
          d.querySelectorAll("[data-rem]").forEach((b) => (b.onclick = () => { pagamentos.splice(Number(b.dataset.rem), 1); atualizarCupom(); salvarCarrinho(true); atualizar(); }));
          const troco = Math.max(0, r2(pago() - t));
          render(d.querySelector("#resumo"), html`<div><span class="small">Pago</span><b>${dinheiro(pago())}</b></div>
            <div class="${falta() ? "falta" : ""}"><span class="small">Falta</span><b>${dinheiro(falta())}</b></div>
            <div class="${troco ? "troco" : ""}"><span class="small">Troco</span><b>${dinheiro(troco)}</b></div>`);
          d.querySelector("#concluir").disabled = falta() > 0;
          if (falta() > 0) f.valor.select(); else d.querySelector("#concluir").focus();
          desenharPix();
        };
        const adicionar = (valor, fm = forma) => {
          if (!(valor > 0)) return toast("Informe o valor", "erro");
          if (fm !== "dinheiro" && valor > falta() + 1e-9) return toast("Só pagamento em dinheiro pode gerar troco", "erro");
          const ex = pagamentos.find((p) => p.forma === fm);
          if (ex) ex.valor = r2(ex.valor + valor); else pagamentos.push({ forma: fm, valor: r2(valor) });
          atualizarCupom(); salvarCarrinho(true);
          if (fm === "pix" && forma === "pix" && falta() > 0) forma = "dinheiro";
          atualizar();
        };
        f.valor.addEventListener("input", () => { if (forma === "pix") desenharPixDepois(); });
        d.querySelectorAll(".forma").forEach((b) => (b.onclick = () => { forma = b.dataset.f; atualizar(); }));
        f.onsubmit = (e) => { e.preventDefault(); if (!f.valor.value && falta() === 0) return d.querySelector("#concluir").click(); adicionar(lerNumero(f.valor.value)); };
        d.querySelector("#concluir").onclick = () => fechar({
          pagamentos: pagamentos.map((p) => ({ forma: p.forma, valor: p.valor })),
          imprimir: d.querySelector("#imp").checked, nfce: d.querySelector("#nfce")?.checked,
        });
        d.addEventListener("keydown", (e) => {
          const n = Number(e.key);
          if (e.altKey && n >= 1 && n <= FORMAS.length) { forma = FORMAS[n - 1][0]; atualizar(); e.preventDefault(); }
        });
        atualizar();
      },
    });
    pararPix();
    if (!resultado) return focarBusca();
    await concluir(resultado);
  }

  async function concluir({ pagamentos, imprimir: deveImprimir, nfce }) {
    const totalCliente = total();
    const p = {
      ...payload(true, pagamentos), id_local: venda.id_local, total_cliente: totalCliente,
      sessao_id: estado.caixa?.id || null, realizada_em: new Date().toISOString(),
    };
    let r;
    if (!estaOnline()) return concluirOffline(p, pagamentos, deveImprimir, nfce);
    try { r = await comTempo(rpc("registrar_venda", { p }), 15000); marcarRede(true); }
    catch (e) {
      // Caiu a internet (ou demorou demais): a venda vai para a fila e é enviada depois.
      // Se o servidor chegou a gravar, o reenvio com o mesmo id_local não duplica.
      if (ehErroDeRede(e)) return concluirOffline(p, pagamentos, deveImprimir, nfce);
      erro(e);
      if (/outro aparelho/.test(e.message) && venda.venda_id) { const id = venda.venda_id; venda.itens = []; await carregarPedido(id).catch(erro); }
      return;
    }
    if (r.ja_registrada) toast(`Esta venda já estava registrada (nº ${r.numero}). Nada foi lançado em dobro.`, "ok");

    limpar(false); contarPedidos();
    // Atualiza estoque local para refletir a venda
    carregarProdutos().catch(() => {});

    let doc = null;
    if (nfce) {
      try {
        doc = await fn("fiscal", { acao: "emitir", venda_id: r.id, modelo: "65" });
        if (doc.status === "autorizado") toast(`NFC-e nº ${doc.numero} autorizada`, "ok");
        else toast(`NFC-e não autorizada: ${doc.mensagem || doc.status}. Você pode reenviar em Vendas.`, "erro");
      } catch (e) { toast("NFC-e não emitida: " + e.message, "erro"); }
    }
    if (deveImprimir) imprimirVenda(r.id).catch((e) => toast("Impressão: " + e.message, "erro"));

    await modal({
      titulo: `Venda nº ${r.numero} concluída`,
      corpo: html`<div class="stack" style="text-align:center">
        <p class="muted">Total ${dinheiro(r.total)}</p>
        ${Number(r.troco) > 0 ? html`<div><div class="muted">Troco</div><div class="total-valor" style="font-size:3rem">${dinheiro(r.troco)}</div></div>` : html`<div class="total-valor" style="font-size:2rem">Pago</div>`}
      </div>`,
      rodape: html`${!deveImprimir ? html`<button class="btn" id="imp-agora">${icone("imprimir", 'width="18" height="18"')} Imprimir</button>` : ""}
        <button class="btn primary lg" data-fechar autofocus>Nova venda</button>`,
      onPronto: (d) => { d.querySelector("#imp-agora")?.addEventListener("click", () => imprimirVenda(r.id).catch(erro)); d.querySelector("[data-fechar].primary").focus(); },
    });
    focarBusca();
  }

  /** Sem internet: guarda a venda na fila, imprime o comprovante e libera o caixa. */
  async function concluirOffline(p, pagamentos, deveImprimir, nfce) {
    marcarRede(false);
    const totalCliente = total();
    const pago = r2(pagamentos.reduce((a, x) => a + x.valor, 0));
    const troco = Math.max(0, r2(pago - totalCliente));
    const numeroLocal = "OFF-" + venda.id_local.slice(0, 6).toUpperCase();
    const vendaLocal = {
      status: "finalizada", numero: numeroLocal, finalizada_em: p.realizada_em, operador: { nome: estado.perfil.nome },
      itens: venda.itens.map((i, idx) => ({ item: idx + 1, descricao: i.nome, unidade: i.unidade, quantidade: i.quantidade, preco_unitario: i.preco, desconto: 0, total: r2(i.quantidade * i.preco), observacao: i.observacao })),
      subtotal: subtotal(), desconto: venda.desconto, acrescimo: venda.acrescimo, total: totalCliente,
      pagamentos: pagamentos.map((x) => ({ forma: x.forma, valor: x.valor })), troco,
      cpf_cnpj_consumidor: venda.cpf || null, cliente: venda.cliente, identificador: venda.identificador, observacao: venda.observacao,
    };
    enfileirarVenda({ id_local: venda.id_local, payload: { ...p, offline: true }, total: totalCliente, troco, nfce: !!nfce, numero_local: numeroLocal, venda_local: vendaLocal });
    descartarRascunho(venda.id_local); // o servidor também apaga o rascunho quando a venda chegar
    venda.rascunho = false;
    limpar(false);
    if (deveImprimir) {
      imprimir([...layoutVenda(vendaLocal, null), { t: "espaco" },
        { t: "texto", s: "VENDA EM CONTINGENCIA (SEM INTERNET)", align: "centro", bold: true },
        { t: "texto", s: "Registrada neste caixa e enviada ao sistema quando a conexao voltar.", align: "centro" }])
        .catch((e) => toast("Impressão: " + e.message, "erro"));
    }
    await modal({
      titulo: "Venda salva sem internet",
      corpo: html`<div class="stack" style="text-align:center">
        <p class="muted">Total ${dinheiro(totalCliente)} · nº provisório ${numeroLocal}</p>
        ${troco > 0 ? html`<div><div class="muted">Troco</div><div class="total-valor" style="font-size:3rem">${dinheiro(troco)}</div></div>` : html`<div class="total-valor" style="font-size:2rem">Pago</div>`}
        <div class="alerta warn" style="text-align:left">A venda ficou guardada neste aparelho e será enviada sozinha quando a internet voltar (com a data e hora de agora).${nfce ? " A NFC-e será emitida no envio." : ""} Não limpe os dados do navegador até lá.</div>
      </div>`,
      rodape: html`<button class="btn primary lg" data-fechar autofocus>Nova venda</button>`,
    });
    focarBusca();
  }

  // ---------- Venda em andamento em outro aparelho ----------
  async function verRascunhosDeOutros() {
    const alvo = $("#aviso-rasc", el);
    if (!alvo || !estaOnline() || venda.itens.length || !podeReceber) { if (alvo) render(alvo, ""); return; }
    const lista = (await rascunhosDeOutros().catch(() => [])).filter((r) => Date.now() - new Date(r.atualizado_em) < 12 * 3600e3);
    if (!lista.length || venda.itens.length) return render(alvo, "");
    const r = lista.find((x) => x.operador_id === estado.perfil.id) || lista[0];
    render(alvo, html`<div class="alerta info row wrap" style="justify-content:space-between;gap:.5rem">
      <span><strong>Venda em andamento em outro aparelho</strong> · ${r.aparelho_nome || "aparelho"} · ${r.operador_nome || ""}<br>
        <span class="small">${r.itens} ${r.itens === 1 ? "item" : "itens"} · ${dinheiro(r.total)}${Number(r.pago) ? ` · já pago ${dinheiro(r.pago)}` : ""} · ${hora(r.atualizado_em)}</span></span>
      <span class="row" style="gap:.4rem">${lista.length > 1 ? html`<button class="btn sm ghost" id="rasc-todos">Ver ${lista.length}</button>` : ""}
        <button class="btn sm primary" id="rasc-continuar">Continuar aqui</button></span></div>`);
    $("#rasc-continuar", el).onclick = () => continuarAqui(r.id);
    $("#rasc-todos", el)?.addEventListener("click", () => abrirPedidos().catch(erro));
  }

  async function continuarAqui(id) {
    if (venda.itens.length && !(await confirmar("O cupom atual será substituído pela venda do outro aparelho.", { titulo: "Continuar venda aqui", ok: "Substituir" }))) return;
    try {
      const dados = await assumirRascunho(id);
      const antigo = venda;
      venda = { ...novaVenda(), ...dados, id_local: id, pagamentos: dados.pagamentos || [] };
      delete venda.total; delete venda.salvo_em; delete venda.aparelho_nome;
      if (antigo.rascunho && antigo.id_local !== id) descartarRascunho(antigo.id_local);
      sel = venda.itens.length - 1;
      atualizarCupom(true);
      render($("#aviso-rasc", el), "");
      toast(`Venda trazida para este aparelho${jaPago() ? ` · já pago ${dinheiro(jaPago())}` : ""}`, "ok");
      focarBusca();
    } catch (e) { erro(e); verRascunhosDeOutros(); }
  }

  // O servidor avisa quando outro aparelho assumiu (ou concluiu) a venda que está aqui
  aoMudarRascunho(async (r) => {
    if (r.id_local !== venda.id_local) return;
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    venda = novaVenda(); sel = -1; atualizarCupom();
    await modal({
      titulo: r.situacao === "finalizada" ? "Venda já concluída" : "Venda continuada em outro aparelho",
      corpo: html`<p>${r.situacao === "finalizada" ? `Esta venda já foi concluída (nº ${r.numero}) em outro aparelho.` : `Esta venda foi assumida por ${r.aparelho_nome || "outro aparelho"}${r.operador_nome ? ` (${r.operador_nome})` : ""}.`}
        Este aparelho começou um cupom novo.</p>`,
      rodape: html`<button class="btn primary" data-fechar autofocus>Entendi</button>`,
    });
    focarBusca();
  });

  // ---------- Leitor de código de barras ----------
  function processarEntrada(texto) {
    let t = texto.trim(); if (!t) return false;
    let mult = null;
    const m = t.match(/^(\d+(?:[.,]\d+)?)\s*[*xX]\s*(.+)$/);
    if (m) { mult = lerNumero(m[1]); t = m[2].trim(); }

    const p = porBarras.get(t) || porCodigo.get(t.replace(/^0+/, "").toLowerCase());
    if (p) { adicionarProduto(p, mult ?? (FRACIONADOS.includes(p.unidade) ? null : 1)); return true; }

    // Etiqueta de balança: 2 CCCCC VVVVV D (EAN-13). C = código do produto, V = preço total (centavos) ou peso (gramas)
    const etq = lerEtiquetaBalanca(t);
    if (etq) {
      const prod = porCodigo.get(etq.codigo.toLowerCase());
      if (prod) {
        let quant;
        if (etq.peso != null) quant = prod.unidade === "G" ? Math.round(etq.peso * 1000) : etq.peso;
        else quant = FRACIONADOS.includes(prod.unidade) && prod.preco_venda > 0 ? Math.round((etq.preco / prod.preco_venda) * 1000) / 1000 : 1;
        if (quant > 0) { adicionarProduto(prod, quant); return true; }
      }
    }
    if (/^\d{8,14}$/.test(t)) { toast(`Código ${t} não cadastrado`, "erro"); inpBusca.select(); return true; }
    return false;
  }

  function focarBusca() { if (!document.querySelector("dialog[open]")) inpBusca.focus(); }

  inpBusca.addEventListener("input", () => { busca = inpBusca.value; desenharGrade(); });
  inpBusca.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (processarEntrada(inpBusca.value)) { inpBusca.value = ""; busca = ""; desenharGrade(); return; }
    const lista = filtrados();
    if (lista.length === 1) { adicionarProduto(lista[0]); inpBusca.value = ""; busca = ""; desenharGrade(); }
  });

  // ---------- Atalhos ----------
  const teclas = (e) => {
    if (document.querySelector("dialog[open]")) return;
    const mapa = { F2: focarBusca, F4: alterarQuantidade, F6: aplicarDesconto, F8: salvarPedido, F9: receber, F10: receber };
    if (mapa[e.key]) { e.preventDefault(); mapa[e.key](); return; }
    if (e.key === "Escape") { e.preventDefault(); limpar(); return; }
    const noCampo = e.target.matches("input, textarea, select") && e.target !== inpBusca;
    if (noCampo) return;
    if (e.key === "Delete" && sel >= 0) { e.preventDefault(); removerItem(sel); }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && venda.itens.length && !inpBusca.value) {
      e.preventDefault();
      sel = Math.max(0, Math.min(venda.itens.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
      atualizarCupom(true);
    }
  };
  document.addEventListener("keydown", teclas);

  $("#btn-pedidos", el).onclick = () => abrirPedidos().catch(erro);
  $("#btn-ident", el).onclick = definirIdentificador;
  $("#btn-cliente", el).onclick = definirCliente;
  $("#btn-desc", el).onclick = aplicarDesconto;
  $("#btn-salvar", el).onclick = salvarPedido;
  $("#btn-receber", el)?.addEventListener("click", receber);

  // Itens do cupom guardados num pedido podem ter sido finalizados em outro terminal
  if (venda.venda_id && estaOnline()) {
    try {
      const { data, error } = await comTempo(sb.from("vendas").select("status").eq("id", venda.venda_id).maybeSingle(), 8000);
      if (!error && data?.status !== "aberta") venda = novaVenda();
    } catch { /* sem rede: mantém o cupom */ }
  }
  // Venda recuperada depois de queda de energia / fechar o navegador
  if (venda.itens.length || venda.pagamentos?.length) {
    setTimeout(() => toast(`Venda em andamento recuperada: ${venda.itens.length} ${venda.itens.length === 1 ? "item" : "itens"}${jaPago() ? ` · já pago ${dinheiro(jaPago())}` : ""}`, "ok"), 300);
  }

  // Indicador da balança na barra do PDV
  const chipBal = $("#chip-bal", el);
  const desenharBalanca = (st) => {
    const c = configBalanca();
    chipBal.hidden = !c.ativa;
    if (!c.ativa) return;
    const on = c.protocolo === "simulador" || !!st?.conectada;
    chipBal.classList.toggle("on", on);
    $("#chip-bal-txt", el).textContent = c.protocolo === "simulador" ? "Simulador" : on ? (st?.ultimo?.peso != null ? `${st.ultimo.peso.toFixed(3).replace(".", ",")} kg` : "Balança") : "Balança desligada";
  };
  chipBal.onclick = () => { location.hash = "#/configuracoes/balanca"; };
  const tirarBal = aoMudarBalanca(desenharBalanca);
  const recarregarBal = () => desenharBalanca(null);
  window.addEventListener("pdv-balanca", recarregarBal);
  desenharBalanca(null);

  atualizarCupom();
  desenharAvisoCaixa();
  try { await carregarProdutos(); contarPedidos(); } catch (e) { erro(e); }
  verRascunhosDeOutros();
  const tirarEnvio = aoEnviarVenda(({ item, resposta }) => {
    toast(resposta.ja_registrada ? `Venda ${item.numero_local} já estava no sistema (nº ${resposta.numero}). Nada em dobro.` : `Venda feita sem internet enviada: ${item.numero_local} → nº ${resposta.numero}${Number(resposta.ajuste) ? ` (ajuste de preço ${dinheiro(resposta.ajuste)})` : ""}`, "ok");
    carregarProdutos().catch(() => {}); contarPedidos();
  });
  const aoVoltarRede = (e) => { if (e.detail?.online) { verRascunhosDeOutros(); contarPedidos(); } };
  window.addEventListener("contingencia", aoVoltarRede);
  // Vindo da tela de Mesas ou Delivery: #/pdv/<id do pedido>
  if (/^[0-9a-f-]{36}$/i.test(params[0] || "")) {
    history.replaceState(null, "", "#/pdv");
    if (venda.venda_id !== params[0]) { if (venda.venda_id) venda = novaVenda(); await carregarPedido(params[0]).catch(erro); }
  }
  focarBusca();

  return () => {
    document.removeEventListener("keydown", teclas); tirarBal(); window.removeEventListener("pdv-balanca", recarregarBal);
    tirarEnvio(); window.removeEventListener("contingencia", aoVoltarRede); aoMudarRascunho(null);
  };
}

// Exposto para a tela de Vendas reimprimir pedidos
export { layoutVenda, imprimir };
