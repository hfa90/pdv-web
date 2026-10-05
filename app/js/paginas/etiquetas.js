// Gerador interativo de código de barras e QR Code, com etiquetas prontas para imprimir.
// Barras: JsBarcode (EAN-13, EAN-8, Code 128, ITF-14). QR: qrcode-generator, desenhado aqui em SVG
// para permitir cor e estilo dos pontos.
import { sb, q, todos } from "../api.js";
import { estado } from "../estado.js";
import { html, render, raw, $, $$, dinheiro, toast, erro, lerNumero, debounce, somenteDigitos } from "../ui.js";
import { icone } from "../icons.js";
import { payloadPix, qrPronto } from "../../../assets/pix.js";
import { linkCardapio } from "../links.js";

const TIPOS = [
  ["ean13", "EAN-13", "Padrão de mercado"], ["ean8", "EAN-8", "Embalagem pequena"],
  ["code128", "Code 128", "Letras e números"], ["itf14", "ITF-14", "Caixa de fardo"],
  ["qr", "QR Code", "Link, PIX, Wi-Fi"], ["ambos", "Barras + QR", "Os dois juntos"],
];
const TAMANHOS = {
  "50x30": { nome: "50 × 30 mm (térmica)", w: 50, h: 30 }, "40x25": { nome: "40 × 25 mm (térmica)", w: 40, h: 25 },
  "60x40": { nome: "60 × 40 mm (térmica)", w: 60, h: 40 }, "100x50": { nome: "100 × 50 mm (gôndola)", w: 100, h: 50 },
  "a4": { nome: "Folha A4 · Pimaco 6180 (30 por folha)", w: 66.7, h: 25.4, folha: true },
};
const QR_MODOS = [["texto", "Texto ou link"], ["produto", "Dados do produto"], ["pix", "PIX da loja"], ["whatsapp", "WhatsApp"], ["wifi", "Wi-Fi"], ["cardapio", "Cardápio digital"]];
const CORES = ["#111111", "#136F63", "#1E40AF", "#7C3AED", "#B42318", "#B45309"];

// ---------- Dígitos verificadores ----------
export function digitoGtin(base) {
  const d = String(base).split("").reverse().map(Number);
  const s = d.reduce((a, n, i) => a + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (s % 10)) % 10;
}
const gerarInterno = (tam) => {
  const corpo = tam === 8 ? "2" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0")
    : "29" + String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 1e4)).padStart(4, "0");
  return corpo + digitoGtin(corpo);
};
function validar(tipo, v) {
  const d = somenteDigitos(v);
  if (tipo === "ean13") return d.length === 13 && d === v && digitoGtin(d.slice(0, 12)) === Number(d[12]) ? null
    : d.length === 12 && d === v ? `Faltou o dígito verificador: ${d}${digitoGtin(d)}` : "EAN-13 precisa de 13 números com dígito verificador válido";
  if (tipo === "ean8") return d.length === 8 && d === v && digitoGtin(d.slice(0, 7)) === Number(d[7]) ? null
    : d.length === 7 && d === v ? `Faltou o dígito verificador: ${d}${digitoGtin(d)}` : "EAN-8 precisa de 8 números com dígito verificador válido";
  if (tipo === "itf14") return d.length === 14 && d === v && digitoGtin(d.slice(0, 13)) === Number(d[13]) ? null : "ITF-14 precisa de 14 números com dígito verificador válido";
  if (tipo === "code128") return v && /^[\x20-\x7e]{1,40}$/.test(v) ? null : "Use até 40 letras, números ou símbolos sem acento";
  return null;
}

// ---------- QR em SVG com cor e estilo ----------
function qrSvgEstilo(texto, { cor = "#111", estilo = "quadrado", tamanho = 160 } = {}) {
  if (!window.qrcode || !texto) return "";
  const qr = window.qrcode(0, texto.length > 120 ? "M" : "Q");
  qr.addData(unescape(encodeURIComponent(texto)));
  try { qr.make(); } catch { return ""; }
  const n = qr.getModuleCount(), m = 2, tot = n + m * 2;
  const olho = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  let p = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c) || (estilo !== "quadrado" && olho(r, c))) continue;
    p += estilo === "redondo" ? `<circle cx="${c + m + .5}" cy="${r + m + .5}" r=".46"/>` : `<rect x="${c + m}" y="${r + m}" width="1.02" height="1.02"/>`;
  }
  if (estilo !== "quadrado") {
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      p += `<rect x="${c + m + .5}" y="${r + m + .5}" width="6" height="6" rx="1.6" fill="none" stroke="${cor}" stroke-width="1"/>`;
      p += `<rect x="${c + m + 2}" y="${r + m + 2}" width="3" height="3" rx=".8"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tot} ${tot}" width="${tamanho}" height="${tamanho}" shape-rendering="${estilo === "quadrado" ? "crispEdges" : "geometricPrecision"}"><rect width="${tot}" height="${tot}" fill="#fff"/><g fill="${cor}">${p}</g></svg>`;
}

function barrasSvg(tipo, valor, { altura = 40, largura = 2, texto = true, cor = "#111" } = {}) {
  if (!window.JsBarcode || !valor) return "";
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  let ok = true;
  try {
    window.JsBarcode(el, valor, { format: { ean13: "EAN13", ean8: "EAN8", code128: "CODE128", itf14: "ITF14" }[tipo],
      height: altura, width: largura, displayValue: texto, fontSize: 14, textMargin: 1, margin: 4,
      background: "#ffffff", lineColor: cor, font: "monospace", flat: tipo !== "ean13" && tipo !== "ean8", valid: (v) => { ok = v; } });
  } catch { ok = false; }
  if (!ok) return "";
  el.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return el.outerHTML;
}
const esperarBarras = (t = 5000) => new Promise((res) => { const i = Date.now(); (function v() { if (window.JsBarcode) return res(true); if (Date.now() - i > t) return res(false); setTimeout(v, 60); })(); });

export default async function etiquetas(el) {
  const e = estado.empresa;
  const st = {
    produto: null, tipo: "ean13", valor: "", qrModo: "produto", qrTexto: "", zap: e.telefone || "", zapMsg: "", wifiNome: "", wifiSenha: "", pixValor: "",
    tamanho: "50x30", nome: true, preco: true, textoCod: true, altura: 38, largura: 2, corQr: "#111111", estilo: "quadrado", copias: 1, titulo: "",
  };
  const fila = [];
  let produtos = [];

  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Códigos e etiquetas</h1>
      <p>Gere código de barras e QR Code, veja na hora e imprima etiquetas para gôndola, balcão e produtos.</p></div>
      <div class="acoes"><button class="btn" id="b-fila" disabled>${icone("imprimir", 'width="18" height="18"')} <span>Imprimir fila (<span id="n-fila">0</span>)</span></button></div></div>
    <div class="gerador">
      <div class="stack-lg">
        <div class="panel panel-pad stack">
          <h2>1. O que vai na etiqueta</h2>
          <label class="field" style="position:relative"><span>Produto do cadastro (opcional)</span>
            <input class="input" id="busca-prod" placeholder="Buscar por nome, código ou código de barras…" autocomplete="off">
            <div id="res-prod" class="panel" style="position:absolute;top:100%;left:0;right:0;z-index:20;max-height:260px;overflow:auto;margin-top:4px" hidden></div></label>
          <div id="prod-sel"></div>
          <label class="field"><span>Título da etiqueta</span><input class="input" id="i-titulo" placeholder="Ex.: Pão de queijo" maxlength="60"></label>
        </div>

        <div class="panel panel-pad stack">
          <h2>2. Tipo de código</h2>
          <div class="tipo-cod">${TIPOS.map(([k, n, d]) => html`<label><input type="radio" name="tipo" value="${k}" ${k === st.tipo ? "checked" : ""}><span>${n}<small>${d}</small></span></label>`)}</div>
          <div id="campo-barras" class="stack">
            <label class="field"><span>Número do código de barras</span>
              <div class="row"><input class="input" id="i-valor" inputmode="numeric" maxlength="40" placeholder="789…">
                <button type="button" class="btn" id="b-gerar" title="Cria um código interno válido (começa com 2, uso só na sua loja)">Gerar interno</button></div></label>
            <p class="hint" id="msg-valor">Digite ou passe o leitor. Para produtos sem código de fábrica, use “Gerar interno”.</p>
            <div id="salvar-prod"></div>
          </div>
          <div id="campo-qr" class="stack" hidden>
            <label class="field"><span>Conteúdo do QR Code</span><select class="input" id="qr-modo">${QR_MODOS.map(([k, n]) => html`<option value="${k}">${n}</option>`)}</select></label>
            <div id="qr-campos" class="stack"></div>
          </div>
        </div>

        <div class="panel panel-pad stack">
          <h2>3. Aparência</h2>
          <div class="grid-2">
            <label class="field"><span>Tamanho da etiqueta</span><select class="input" id="i-tam">${Object.entries(TAMANHOS).map(([k, t]) => html`<option value="${k}">${t.nome}</option>`)}</select></label>
            <label class="field"><span>Cópias</span><input class="input" id="i-copias" type="number" min="1" max="500" value="1"></label>
          </div>
          <div class="grid-2">
            <label class="check"><input type="checkbox" id="c-nome" checked> Mostrar nome</label>
            <label class="check"><input type="checkbox" id="c-preco" checked> Mostrar preço</label>
            <label class="check"><input type="checkbox" id="c-texto" checked> Números abaixo das barras</label>
          </div>
          <div class="grid-2">
            <label class="field"><span>Altura das barras <b class="range-val" id="v-alt">38</b></span><input type="range" id="r-alt" min="20" max="90" value="38"></label>
            <label class="field"><span>Espessura das barras <b class="range-val" id="v-larg">2</b></span><input type="range" id="r-larg" min="1" max="4" step="1" value="2"></label>
          </div>
          <div class="grid-2" id="aparencia-qr">
            <div class="field"><span>Cor do QR Code</span><div class="cor-qr">${CORES.map((c) => html`<button type="button" data-cor="${c}" style="background:${c}" class="${c === st.corQr ? "ativo" : ""}" aria-label="Cor ${c}"></button>`)}</div></div>
            <label class="field"><span>Estilo dos pontos</span><select class="input" id="i-estilo"><option value="quadrado">Quadrado (clássico)</option><option value="redondo">Redondo (moderno)</option></select></label>
          </div>
        </div>
      </div>

      <div class="prev-wrap">
        <div class="prev-palco"><div id="preview"></div></div>
        <div id="msg-prev" class="hint" style="text-align:center"></div>
        <div class="row wrap" style="justify-content:center">
          <button class="btn primary" id="b-imprimir">${icone("imprimir", 'width="18" height="18"')} Imprimir</button>
          <button class="btn" id="b-add">${icone("mais", 'width="18" height="18"')} Adicionar à fila</button>
          <button class="btn" id="b-png">${icone("baixar", 'width="18" height="18"')} PNG</button>
          <button class="btn" id="b-svg">${icone("baixar", 'width="18" height="18"')} SVG</button>
        </div>
        <div class="panel panel-pad stack" id="painel-fila" hidden><h3>Fila de impressão</h3><div class="lista-etq" id="lista-fila"></div></div>
      </div>
    </div></div>`);

  await Promise.all([qrPronto(), esperarBarras()]);
  if (!window.JsBarcode) toast("Não foi possível carregar o gerador de barras. Verifique a internet.", "erro");

  // ---------- Conteúdo do QR ----------
  function payloadQr() {
    const p = st.produto;
    switch (st.qrModo) {
      case "produto": return p ? [p.nome, dinheiro(p.preco_venda) + (p.unidade !== "UN" ? `/${p.unidade.toLowerCase()}` : ""), p.codigo_barras || p.codigo].filter(Boolean).join("\n") : st.titulo;
      case "pix": {
        if (!e.pix_chave) return "";
        const v = lerNumero(st.pixValor);
        try { return payloadPix({ tipo: e.pix_tipo, chave: e.pix_chave, nome: e.pix_nome || e.nome_fantasia || e.razao_social, cidade: e.pix_cidade || e.municipio, valor: v > 0 ? v : null }); }
        catch { return ""; }
      }
      case "whatsapp": { const d = somenteDigitos(st.zap); return d ? `https://wa.me/${d.length <= 11 ? "55" + d : d}${st.zapMsg ? `?text=${encodeURIComponent(st.zapMsg)}` : ""}` : ""; }
      case "wifi": return st.wifiNome ? `WIFI:T:${st.wifiSenha ? "WPA" : "nopass"};S:${st.wifiNome.replace(/([\\;,:"])/g, "\\$1")};P:${st.wifiSenha.replace(/([\\;,:"])/g, "\\$1")};;` : "";
      case "cardapio": return e.slug ? linkCardapio(e.slug) : "";
      default: return st.qrTexto;
    }
  }
  function camposQr() {
    const alvo = $("#qr-campos", el);
    const m = st.qrModo;
    render(alvo, m === "texto" ? html`<label class="field"><span>Texto ou link</span><textarea class="input" id="q-texto" rows="2" placeholder="https://…">${st.qrTexto}</textarea></label>`
      : m === "pix" ? (e.pix_chave ? html`<label class="field"><span>Valor (opcional)</span><input class="input" id="q-pix" inputmode="decimal" placeholder="Em branco: o cliente digita" value="${st.pixValor}"></label><p class="hint">Chave cadastrada em Configurações › PIX.</p>`
        : html`<div class="alerta warn">Cadastre a chave PIX em <a href="#/configuracoes/pix">Configurações › PIX</a>.</div>`)
      : m === "whatsapp" ? html`<div class="grid-2"><label class="field"><span>Número com DDD</span><input class="input" id="q-zap" value="${st.zap}" inputmode="tel"></label>
          <label class="field"><span>Mensagem pronta</span><input class="input" id="q-zapmsg" value="${st.zapMsg}" placeholder="Olá! Quero fazer um pedido"></label></div>`
      : m === "wifi" ? html`<div class="grid-2"><label class="field"><span>Nome da rede</span><input class="input" id="q-wifi" value="${st.wifiNome}"></label>
          <label class="field"><span>Senha</span><input class="input" id="q-wsenha" value="${st.wifiSenha}"></label></div>`
      : m === "cardapio" ? (e.slug ? html`<p class="small">Link: <code>${linkCardapio(e.slug)}</code></p>` : html`<div class="alerta warn">Ative o cardápio digital em Configurações › Delivery.</div>`)
      : html`<p class="hint">Usa o nome, o preço e o código do produto escolhido.</p>`);
    const liga = (id, k) => { const i = $(id, alvo); if (i) i.oninput = () => { st[k] = i.value; desenhar(); }; };
    liga("#q-texto", "qrTexto"); liga("#q-pix", "pixValor"); liga("#q-zap", "zap"); liga("#q-zapmsg", "zapMsg"); liga("#q-wifi", "wifiNome"); liga("#q-wsenha", "wifiSenha");
  }

  // ---------- Etiqueta ----------
  function montarEtiqueta(dados = st, escala = 1) {
    const t = TAMANHOS[dados.tamanho];
    const usaBarras = dados.tipo !== "qr", usaQr = dados.tipo === "qr" || dados.tipo === "ambos";
    const tipoBarras = dados.tipo === "ambos" ? (somenteDigitos(dados.valor).length === 13 && dados.valor === somenteDigitos(dados.valor) ? "ean13" : "code128") : dados.tipo;
    const barras = usaBarras ? barrasSvg(tipoBarras, dados.valor, { altura: dados.altura, largura: dados.largura, texto: dados.textoCod }) : "";
    const qrTam = Math.round(Math.min(t.h - (dados.nome ? 9 : 4) - (dados.preco && dados.tipo === "qr" ? 6 : 0), dados.tipo === "ambos" ? t.w * .38 : t.w - 6) * 3.78);
    const qr = usaQr ? qrSvgEstilo(dados.qr, { cor: dados.corQr, estilo: dados.estilo, tamanho: Math.max(40, qrTam) }) : "";
    const prod = dados.produto;
    const preco = prod ? html`${dinheiro(prod.preco_venda)}${prod.unidade !== "UN" ? html`<small>/${prod.unidade.toLowerCase()}</small>` : ""}` : "";
    const nome = dados.titulo || prod?.nome || "";
    const codigo = dados.tipo === "ambos"
      ? html`<div class="e-linha">${raw(barras)}${raw(qr)}</div>`
      : raw(barras || qr);
    return {
      ok: (!usaBarras || !!barras) && (!usaQr || !!qr),
      html: html`<div class="etiqueta" style="width:${t.w}mm;height:${t.h}mm;${escala !== 1 ? `zoom:${escala};` : ""}">
        ${dados.nome && nome ? html`<div class="e-nome">${nome}</div>` : ""}
        ${codigo}
        ${dados.preco && preco ? html`<div class="e-preco">${preco}</div>` : ""}
      </div>`,
      barras, qr,
    };
  }

  function desenhar() {
    st.qr = payloadQr();
    const usaBarras = st.tipo !== "qr";
    const aviso = usaBarras ? validar(st.tipo === "ambos" ? "code128" : st.tipo, st.valor) : null;
    $("#msg-valor", el).textContent = usaBarras && st.valor ? (aviso || "Código válido ✓") : "Digite ou passe o leitor. Para produtos sem código de fábrica, use “Gerar interno”.";
    $("#msg-valor", el).style.color = usaBarras && st.valor ? (aviso ? "var(--danger)" : "var(--ok)") : "";
    const r = montarEtiqueta(st, st.tamanho === "100x50" ? 1.6 : 2.4);
    render($("#preview", el), r.html);
    const falta = usaBarras && !st.valor ? "Informe o número do código de barras" : (st.tipo === "qr" || st.tipo === "ambos") && !st.qr ? "Preencha o conteúdo do QR Code" : !r.ok ? "Código inválido para este tipo" : "";
    $("#msg-prev", el).textContent = falta || `${TAMANHOS[st.tamanho].nome} · ${st.copias} ${st.copias > 1 ? "cópias" : "cópia"}`;
    $("#msg-prev", el).style.color = falta ? "var(--danger)" : "";
    ["#b-imprimir", "#b-add", "#b-png", "#b-svg"].forEach((s) => ($(s, el).disabled = !!falta));
    // Salvar código no produto
    const p = st.produto;
    const podeSalvar = p && usaBarras && st.tipo !== "code128" && !aviso && st.valor && st.valor !== p.codigo_barras && st.valor.length <= 14;
    render($("#salvar-prod", el), podeSalvar ? html`<button type="button" class="btn sm" id="b-salvar-cod">${icone("check", 'width="16" height="16"')} Salvar ${st.valor} no cadastro de ${p.nome}</button>` : "");
    $("#b-salvar-cod", el)?.addEventListener("click", salvarNoProduto);
    $("#campo-barras", el).hidden = st.tipo === "qr";
    $("#campo-qr", el).hidden = !(st.tipo === "qr" || st.tipo === "ambos");
    $("#aparencia-qr", el).hidden = !(st.tipo === "qr" || st.tipo === "ambos");
  }

  async function salvarNoProduto() {
    try {
      await q(sb.from("produtos").update({ codigo_barras: st.valor }).eq("id", st.produto.id));
      st.produto.codigo_barras = st.valor;
      toast("Código salvo no produto. Já pode passar no leitor do PDV.", "ok");
      desenhar(); mostrarProduto();
    } catch (x) { erro(x); }
  }

  // ---------- Produto ----------
  function mostrarProduto() {
    const p = st.produto;
    render($("#prod-sel", el), p ? html`<div class="pend info"><div class="p-ic">${icone("produtos")}</div>
      <div class="grow"><strong>${p.nome}</strong><small>${dinheiro(p.preco_venda)}${p.unidade !== "UN" ? `/${p.unidade.toLowerCase()}` : ""} · ${p.codigo_barras ? `EAN ${p.codigo_barras}` : "sem código de barras"}${p.codigo ? ` · cód. ${p.codigo}` : ""}</small></div>
      <button class="btn sm ghost" id="b-limpar-prod">Trocar</button></div>` : "");
    $("#b-limpar-prod", el)?.addEventListener("click", () => { st.produto = null; $("#busca-prod", el).value = ""; mostrarProduto(); desenhar(); $("#busca-prod", el).focus(); });
  }
  function escolher(p) {
    st.produto = p; st.titulo = ""; $("#i-titulo", el).value = ""; $("#i-titulo", el).placeholder = p.nome;
    if (p.codigo_barras) {
      st.valor = p.codigo_barras;
      const n = p.codigo_barras.length;
      if (st.tipo !== "qr" && st.tipo !== "ambos") st.tipo = n === 8 ? "ean8" : n === 14 ? "itf14" : n === 13 ? "ean13" : "code128";
    } else { st.valor = ""; }
    $$("[name=tipo]", el).forEach((r) => (r.checked = r.value === st.tipo));
    $("#i-valor", el).value = st.valor;
    $("#res-prod", el).hidden = true;
    mostrarProduto(); desenhar();
  }
  const busca = $("#busca-prod", el), res = $("#res-prod", el);
  busca.addEventListener("focus", async () => {
    if (!produtos.length) {
      try { produtos = await todos(() => sb.from("produtos").select("id,nome,codigo,codigo_barras,preco_venda,unidade").eq("ativo", true).order("nome")); } catch (x) { erro(x); }
    }
    filtrar();
  });
  const filtrar = debounce(() => {
    const t = busca.value.trim().toLowerCase();
    const lista = produtos.filter((p) => !t || p.nome.toLowerCase().includes(t) || p.codigo_barras === t || (p.codigo || "").toLowerCase() === t).slice(0, 30);
    res.hidden = document.activeElement !== busca;
    render(res, lista.length ? html`${lista.map((p) => html`<button type="button" class="row" data-id="${p.id}" style="width:100%;border:0;background:none;padding:.55rem .8rem;text-align:left;cursor:pointer;border-bottom:1px solid var(--line)">
        <span class="grow"><strong class="small">${p.nome}</strong><div class="hint">${p.codigo_barras || "sem EAN"}${p.codigo ? ` · cód. ${p.codigo}` : ""}</div></span><span class="small num">${dinheiro(p.preco_venda)}</span></button>`)}`
      : html`<p class="muted small" style="padding:.8rem">Nenhum produto encontrado.</p>`);
    $$("[data-id]", res).forEach((b) => b.addEventListener("mousedown", (ev) => { ev.preventDefault(); escolher(produtos.find((p) => p.id === b.dataset.id)); busca.blur(); }));
  }, 120);
  busca.addEventListener("input", filtrar);
  busca.addEventListener("blur", () => setTimeout(() => (res.hidden = true), 150));

  // ---------- Controles ----------
  $$("[name=tipo]", el).forEach((r) => (r.onchange = () => {
    st.tipo = r.value;
    if (st.tipo === "qr" && st.qrModo === "produto" && !st.produto) st.qrModo = "texto", ($("#qr-modo", el).value = "texto"), camposQr();
    desenhar();
  }));
  $("#i-valor", el).oninput = (ev) => { st.valor = ev.target.value.trim(); desenhar(); };
  $("#i-titulo", el).oninput = (ev) => { st.titulo = ev.target.value; desenhar(); };
  $("#b-gerar", el).onclick = () => {
    if (st.tipo === "code128" || st.tipo === "qr") { st.tipo = "ean13"; $$("[name=tipo]", el).forEach((r) => (r.checked = r.value === "ean13")); }
    st.valor = st.tipo === "itf14" ? (() => { const b = "1" + gerarInterno(13).slice(0, 12); return b + digitoGtin(b); })() : gerarInterno(st.tipo === "ean8" ? 8 : 13);
    $("#i-valor", el).value = st.valor; desenhar();
  };
  $("#qr-modo", el).onchange = (ev) => { st.qrModo = ev.target.value; camposQr(); desenhar(); };
  $("#i-tam", el).onchange = (ev) => { st.tamanho = ev.target.value; desenhar(); };
  $("#i-copias", el).oninput = (ev) => { st.copias = Math.max(1, Math.min(500, Number(ev.target.value) || 1)); desenhar(); };
  $("#c-nome", el).onchange = (ev) => { st.nome = ev.target.checked; desenhar(); };
  $("#c-preco", el).onchange = (ev) => { st.preco = ev.target.checked; desenhar(); };
  $("#c-texto", el).onchange = (ev) => { st.textoCod = ev.target.checked; desenhar(); };
  $("#r-alt", el).oninput = (ev) => { st.altura = Number(ev.target.value); $("#v-alt", el).textContent = st.altura; desenhar(); };
  $("#r-larg", el).oninput = (ev) => { st.largura = Number(ev.target.value); $("#v-larg", el).textContent = st.largura; desenhar(); };
  $("#i-estilo", el).onchange = (ev) => { st.estilo = ev.target.value; desenhar(); };
  $$(".cor-qr button", el).forEach((b) => (b.onclick = () => { st.corQr = b.dataset.cor; $$(".cor-qr button", el).forEach((x) => x.classList.toggle("ativo", x === b)); desenhar(); }));

  // ---------- Saída ----------
  const copia = () => ({ ...st, produto: st.produto ? { ...st.produto } : null });
  function documentoImpressao(itens) {
    const t = TAMANHOS[itens[0].tamanho];
    const paraTexto = (h) => { const d = document.createElement("div"); render(d, h); return d.innerHTML; };
    const corpo = itens.flatMap((it) => { const h = paraTexto(montarEtiqueta(it).html); return Array.from({ length: it.copias }, () => h); }).join("");
    const css = `*{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#111}
      .etiqueta{display:grid;gap:1mm;justify-items:center;align-content:center;text-align:center;padding:2mm;overflow:hidden;page-break-inside:avoid;background:#fff}
      .e-nome{font-weight:700;font-size:${t.h < 30 ? 8 : 10}pt;line-height:1.1;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .e-preco{font-weight:800;font-size:${t.h < 30 ? 11 : 14}pt}.e-preco small{font-size:7pt}
      .e-linha{display:flex;gap:2mm;align-items:center;justify-content:center;width:100%}
      svg{max-width:100%;height:auto;max-height:${t.h - 8}mm;display:block}
      ${t.folha ? `@page{size:A4;margin:12.7mm 7mm}.folha{display:grid;grid-template-columns:repeat(3,${t.w}mm);grid-auto-rows:${t.h}mm;column-gap:2.5mm}`
        : `@page{size:${t.w}mm ${t.h}mm;margin:0}.etiqueta{width:${t.w}mm!important;height:${t.h}mm!important;page-break-after:always;border-radius:0!important;box-shadow:none!important}`}`;
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="folha">${corpo}</div></body></html>`;
  }
  function imprimirItens(itens) {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(f);
    f.onload = () => setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 1500); }, 80);
    f.srcdoc = documentoImpressao(itens);
  }
  $("#b-imprimir", el).onclick = () => imprimirItens([copia()]);
  $("#b-add", el).onclick = () => { fila.push(copia()); desenharFila(); toast("Adicionada à fila", "ok"); };
  $("#b-fila", el).onclick = () => {
    if (!fila.length) return;
    const tam = fila[0].tamanho;
    if (fila.some((f) => f.tamanho !== tam)) return toast("Na fila, todas as etiquetas precisam ter o mesmo tamanho.", "erro");
    imprimirItens(fila);
  };
  function desenharFila() {
    $("#n-fila", el).textContent = fila.reduce((a, f) => a + f.copias, 0);
    $("#b-fila", el).disabled = !fila.length;
    $("#painel-fila", el).hidden = !fila.length;
    render($("#lista-fila", el), html`${fila.map((f, i) => html`<div class="row"><span class="grow">${f.titulo || f.produto?.nome || f.valor || "QR Code"} <span class="muted">· ${TIPOS.find(([k]) => k === f.tipo)[1]} · ${f.copias}×</span></span>
      <button class="btn sm ghost icon-btn" data-rm="${i}" aria-label="Remover">${icone("lixo", 'width="16" height="16"')}</button></div>`)}`);
    $$("[data-rm]", el).forEach((b) => (b.onclick = () => { fila.splice(Number(b.dataset.rm), 1); desenharFila(); }));
  }
  const nomeArquivo = () => (st.titulo || st.produto?.nome || st.valor || "codigo").normalize("NFD").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "codigo";
  function svgDoCodigo() {
    const r = montarEtiqueta(st);
    if (st.tipo === "qr") return r.qr;
    if (st.tipo !== "ambos") return r.barras;
    return r.barras; // barras + QR: baixa as barras (o QR pode ser baixado escolhendo "QR Code")
  }
  const baixar = (href, nome) => { const a = document.createElement("a"); a.href = href; a.download = nome; a.click(); };
  $("#b-svg", el).onclick = () => {
    const svg = svgDoCodigo();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    baixar(url, nomeArquivo() + ".svg"); setTimeout(() => URL.revokeObjectURL(url), 1500);
  };
  $("#b-png", el).onclick = () => {
    const svg = svgDoCodigo();
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const k = 4, c = document.createElement("canvas");
      c.width = (img.width || 300) * k; c.height = (img.height || 150) * k;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      baixar(c.toDataURL("image/png"), nomeArquivo() + ".png"); URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast("Não foi possível gerar a imagem", "erro"); };
    img.src = url;
  };

  camposQr();
  desenhar();
}
