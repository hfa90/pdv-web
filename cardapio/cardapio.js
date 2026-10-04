// Cardápio digital público: o cliente monta o pedido, paga por PIX e acompanha o preparo e a entrega ao vivo.
// Acesso: /cardapio/?loja=<endereço-da-loja>   ·   acompanhamento: &pedido=<código>
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../assets/config.js";
import { html, render, raw, dinheiro, debounce, urlSegura } from "../app/js/ui.js";
import { payloadPix, qrSvg, qrPronto, txidVenda } from "../assets/pix.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
const slug = (params.get("loja") || "").trim().toLowerCase();
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const r2 = (n) => Math.round(n * 100) / 100;
const semAcento = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };
const ler = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };
const CH_SACOLA = `cardapio-sacola-${slug}`, CH_CLIENTE = "cardapio-cliente", CH_PEDIDOS = `cardapio-pedidos-${slug}`;

let dados = null;             // { loja, categorias, produtos }
let sacola = ler(CH_SACOLA, []); // [{ id, quantidade, observacao }]
let catAtiva = null, busca = "";

function aviso(msg, tipo = "") {
  const el = document.createElement("div");
  el.className = "aviso " + tipo; el.textContent = msg;
  const dlg = [...document.querySelectorAll("dialog[open]")].pop();
  let box = $("#avisos");
  if (dlg) { box = dlg.querySelector(":scope > .avisos"); if (!box) { box = document.createElement("div"); box.className = "avisos"; dlg.appendChild(box); } }
  box.appendChild(el);
  setTimeout(() => el.remove(), tipo === "erro" ? 6000 : 3500);
}
const msgErro = (e) => {
  const m = e?.message || String(e);
  if (/Failed to fetch|NetworkError/i.test(m)) return "Sem conexão. Verifique a internet e tente de novo.";
  return m;
};

// ---------- Folha inferior (bottom sheet) ----------
function folha(conteudo, { onPronto, classe = "" } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "folha " + classe;
    document.body.appendChild(d);
    render(d, html`<div class="folha-alca" aria-hidden="true"></div><button class="folha-x" data-fechar aria-label="Fechar">✕</button><div class="folha-corpo">${conteudo}</div>`);
    let valor;
    const fechar = (v) => { valor = v; d.close(); };
    d.addEventListener("close", () => { d.remove(); resolve(valor); });
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-fechar]")) fechar(); });
    d.showModal();
    onPronto?.(d, fechar);
  });
}

// ---------- Início ----------
async function iniciar() {
  if (!slug) return telaErro("Endereço incompleto", "Abra o link do cardápio que a loja enviou.");
  try {
    const { data, error } = await sb.rpc("cardapio_publico", { p_slug: slug });
    if (error) throw error;
    dados = data;
  } catch (e) {
    return telaErro("Cardápio indisponível", /não encontrado|indispon/i.test(e.message) ? "Este cardápio não existe ou está desativado no momento." : msgErro(e));
  }
  document.title = `${dados.loja.nome} · Cardápio`;
  const mapa = new Map(dados.produtos.map((p) => [p.id, p]));
  sacola = sacola.filter((i) => mapa.has(i.id));
  const token = params.get("pedido");
  if (token) return telaPedido(token);
  telaCardapio();
}

function telaErro(titulo, texto) {
  render(app, html`<div class="tela-erro"><div class="erro-ic">🍽️</div><h1>${titulo}</h1><p>${texto}</p></div>`);
}

// ---------- Cardápio ----------
function telaCardapio() {
  const { loja, categorias, produtos } = dados;
  const c = loja.config || {};
  const destaques = produtos.filter((p) => p.destaque).slice(0, 10);
  const meus = ler(CH_PEDIDOS, []).filter((p) => Date.now() - p.em < 24 * 3600e3);
  render(app, html`
    <header class="topo">
      <div class="topo-in">
        <div class="loja-marca">${loja.nome.trim().slice(0, 1).toUpperCase()}</div>
        <div class="grow">
          <h1>${loja.nome}</h1>
          <div class="loja-info">
            <span class="estado ${loja.aberto ? "aberto" : "fechado"}">${loja.aberto ? "Aberto agora" : "Fechado"}</span>
            ${c.tempo_estimado ? html`<span>⏱ ${c.tempo_estimado}</span>` : ""}
            ${c.entrega !== false ? html`<span>🛵 ${Number(c.taxa_entrega) ? dinheiro(c.taxa_entrega) : "Entrega grátis"}</span>` : ""}
            ${Number(c.pedido_minimo) ? html`<span>Mínimo ${dinheiro(c.pedido_minimo)}</span>` : ""}
          </div>
        </div>
      </div>
      ${c.mensagem ? html`<p class="recado">${c.mensagem}</p>` : ""}
      ${c.horario ? html`<p class="horario">Horário: ${c.horario}</p>` : ""}
      ${!loja.aberto ? html`<p class="fechado-aviso">A loja não está recebendo pedidos agora. Você pode olhar o cardápio à vontade.</p>` : ""}
      ${meus.length ? html`<a class="meus" href="?loja=${encodeURIComponent(slug)}&pedido=${meus[meus.length - 1].token}">Acompanhar meu pedido nº ${meus[meus.length - 1].numero} →</a>` : ""}
    </header>
    <div class="barra-cats" id="barra">
      <label class="busca"><span aria-hidden="true">🔎</span><input id="busca" type="search" placeholder="Buscar no cardápio" autocomplete="off" enterkeyhint="search"></label>
      <nav class="cats" id="cats">${categorias.map((ct) => html`<a href="#cat-${ct.id}" data-cat="${ct.id}">${ct.nome}</a>`)}
        ${produtos.some((p) => !p.categoria_id) ? html`<a href="#cat-outros" data-cat="outros">Outros</a>` : ""}</nav>
    </div>
    <main class="conteudo" id="conteudo">
      ${destaques.length ? html`<section class="secao"><h2>Destaques</h2><div class="destaques">${destaques.map((p) => html`
        <button class="destaque" data-p="${p.id}">${p.imagem ? html`<img src="${urlSegura(p.imagem)}" alt="" loading="lazy">` : html`<div class="sem-foto">${p.nome.slice(0, 1)}</div>`}
          <span class="d-nome">${p.nome}</span><span class="d-preco">${dinheiro(p.preco)}</span></button>`)}</div></section>` : ""}
      ${categorias.map((ct) => secao(ct.id, ct.nome, produtos.filter((p) => p.categoria_id === ct.id)))}
      ${secao("outros", "Outros", produtos.filter((p) => !p.categoria_id || !categorias.some((ct) => ct.id === p.categoria_id)))}
      <div id="sem-resultado" class="vazio" hidden>Nada encontrado para essa busca.</div>
      <footer class="rodape">
        ${loja.logradouro ? html`<p>📍 ${[loja.logradouro, loja.numero, loja.bairro, loja.cidade].filter(Boolean).join(", ")}</p>` : ""}
        ${loja.telefone ? html`<p><a href="${zapLoja(loja.telefone, "Olá! Vim pelo cardápio digital.")}" target="_blank" rel="noopener">💬 Falar com a loja</a></p>` : ""}
        <p class="feito">Pedidos sem taxa para a loja · cardápio digital</p>
      </footer>
    </main>
    <div class="barra-sacola" id="barra-sacola" hidden></div>`);

  $$("[data-p]").forEach((b) => (b.onclick = () => abrirProduto(b.dataset.p)));
  const inp = $("#busca");
  inp.oninput = debounce(() => { busca = inp.value; filtrar(); }, 150);
  $$("#cats a").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    const alvo = document.getElementById("cat-" + a.dataset.cat);
    if (alvo) window.scrollTo({ top: alvo.getBoundingClientRect().top + scrollY - $("#barra").offsetHeight - 8, behavior: "smooth" });
  }));
  // Destaca a categoria visível
  const obs = new IntersectionObserver((ents) => {
    ents.forEach((en) => { if (en.isIntersecting) marcarCat(en.target.dataset.cat); });
  }, { rootMargin: "-40% 0px -55% 0px" });
  $$(".secao[data-cat]").forEach((s) => obs.observe(s));
  atualizarBarra();
}

function marcarCat(id) {
  if (catAtiva === id) return;
  catAtiva = id;
  $$("#cats a").forEach((a) => a.classList.toggle("ativo", a.dataset.cat === id));
  $(`#cats a[data-cat="${id}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
}

function secao(id, nome, lista) {
  if (!lista.length) return "";
  return html`<section class="secao" id="cat-${id}" data-cat="${id}"><h2>${nome}</h2><div class="itens">${lista.map((p) => html`
    <button class="item" data-p="${p.id}" data-busca="${semAcento(p.nome + " " + (p.descricao || ""))}">
      <div class="item-txt"><strong>${p.nome}</strong>${p.descricao ? html`<span class="item-desc">${p.descricao}</span>` : ""}
        <span class="item-preco">${dinheiro(p.preco)}${p.unidade !== "UN" ? html`<small> /${p.unidade.toLowerCase()}</small>` : ""}</span></div>
      ${p.imagem ? html`<img src="${urlSegura(p.imagem)}" alt="" loading="lazy">` : ""}
      <span class="item-mais" aria-hidden="true">+</span>
    </button>`)}</div></section>`;
}

function filtrar() {
  const t = semAcento(busca.trim());
  let algum = false;
  $$(".secao[data-cat]").forEach((s) => {
    let vis = 0;
    $$(".item", s).forEach((it) => { const ok = !t || it.dataset.busca.includes(t); it.hidden = !ok; if (ok) vis++; });
    s.hidden = !vis; if (vis) algum = true;
  });
  $$(".secao:not([data-cat])").forEach((s) => (s.hidden = !!t));
  $("#sem-resultado").hidden = algum;
}

const produto = (id) => dados.produtos.find((p) => p.id === id);
const totalSacola = () => r2(sacola.reduce((a, i) => a + (produto(i.id)?.preco || 0) * i.quantidade, 0));
const qtdSacola = () => sacola.reduce((a, i) => a + i.quantidade, 0);

function atualizarBarra() {
  guardar(CH_SACOLA, sacola);
  const b = $("#barra-sacola");
  if (!b) return;
  b.hidden = !sacola.length;
  render(b, html`<button class="btn-sacola" id="ver-sacola"><span class="contador">${qtdSacola()}</span><span>Ver sacola</span><strong>${dinheiro(totalSacola())}</strong></button>`);
  $("#ver-sacola").onclick = abrirSacola;
}

async function abrirProduto(id) {
  const p = produto(id);
  if (!p) return;
  let qn = 1;
  await folha(html`
    ${p.imagem ? html`<img class="prod-foto" src="${urlSegura(p.imagem)}" alt="">` : ""}
    <div class="prod-info"><h2>${p.nome}</h2>${p.descricao ? html`<p>${p.descricao}</p>` : ""}<div class="prod-preco">${dinheiro(p.preco)}</div></div>
    <label class="campo"><span>Alguma observação?</span><textarea id="obs" maxlength="140" rows="2" placeholder="Ex.: sem cebola, ponto da carne"></textarea></label>
    <div class="prod-acoes">
      <div class="passo"><button type="button" data-q="-1" aria-label="Menos">−</button><span id="q">1</span><button type="button" data-q="1" aria-label="Mais">+</button></div>
      <button class="btn-pri grow" id="add" ${dados.loja.aberto ? "" : "disabled"}>${dados.loja.aberto ? html`Adicionar · <span id="v">${dinheiro(p.preco)}</span>` : "Loja fechada"}</button>
    </div>`, {
    onPronto: (d, fechar) => {
      $$("[data-q]", d).forEach((b) => (b.onclick = () => {
        qn = Math.max(1, Math.min(99, qn + Number(b.dataset.q)));
        $("#q", d).textContent = qn;
        if ($("#v", d)) $("#v", d).textContent = dinheiro(p.preco * qn);
      }));
      $("#add", d).onclick = () => {
        const obs = $("#obs", d).value.trim().slice(0, 140);
        const ex = sacola.find((i) => i.id === p.id && (i.observacao || "") === obs);
        if (ex) ex.quantidade += qn; else sacola.push({ id: p.id, quantidade: qn, observacao: obs });
        navigator.vibrate?.(15);
        atualizarBarra(); fechar();
        aviso(`${qn}× ${p.nome} na sacola`, "ok");
      };
    },
  });
}

async function abrirSacola() {
  const c = dados.loja.config || {};
  const desenhar = (d) => {
    const total = totalSacola();
    const falta = Math.max(0, r2(Number(c.pedido_minimo || 0) - total));
    render($(".folha-corpo", d), html`<h2>Sua sacola</h2>
      ${sacola.length ? html`<div class="sacola-lista">${sacola.map((i, k) => { const p = produto(i.id); return html`
        <div class="sacola-item"><div class="grow"><strong>${p.nome}</strong>${i.observacao ? html`<span class="obs">${i.observacao}</span>` : ""}<span class="muted">${dinheiro(p.preco * i.quantidade)}</span></div>
          <div class="passo pequeno"><button data-m="${k}" aria-label="Menos">−</button><span>${i.quantidade}</span><button data-p="${k}" aria-label="Mais">+</button></div></div>`; })}</div>
        <div class="linha"><span>Subtotal</span><strong>${dinheiro(total)}</strong></div>
        ${falta ? html`<p class="alerta">Faltam ${dinheiro(falta)} para o pedido mínimo de ${dinheiro(c.pedido_minimo)}.</p>` : ""}
        <button class="btn-pri" id="continuar" ${falta || !dados.loja.aberto ? "disabled" : ""}>${dados.loja.aberto ? "Continuar" : "Loja fechada no momento"}</button>
        <button class="btn-sec" data-fechar>Adicionar mais itens</button>`
      : html`<p class="vazio">Sua sacola está vazia.</p><button class="btn-sec" data-fechar>Ver cardápio</button>`}`);
    $$("[data-m]", d).forEach((b) => (b.onclick = () => { const i = sacola[b.dataset.m]; i.quantidade--; if (i.quantidade <= 0) sacola.splice(b.dataset.m, 1); atualizarBarra(); desenhar(d); }));
    $$("[data-p]", d).forEach((b) => (b.onclick = () => { sacola[b.dataset.p].quantidade++; atualizarBarra(); desenhar(d); }));
    $("#continuar", d)?.addEventListener("click", () => { d.close(); finalizar(); });
  };
  await folha(html``, { onPronto: (d) => desenhar(d) });
}

// ---------- Finalizar pedido ----------
async function finalizar() {
  const { loja } = dados;
  const c = loja.config || {};
  const cli = ler(CH_CLIENTE, {});
  const fazEntrega = c.entrega !== false, fazRetirada = c.retirada !== false;
  const pixOk = !!(loja.pix || loja.pix_automatico);
  let tipo = cli.tipo && ((cli.tipo === "entrega" && fazEntrega) || (cli.tipo === "retirada" && fazRetirada)) ? cli.tipo : fazEntrega ? "entrega" : "retirada";
  let pagamento = pixOk ? "pix" : "dinheiro";
  const e = cli.endereco || {};
  await folha(html`<form id="f-ped" class="checkout" novalidate>
    <h2>Finalizar pedido</h2>
    <div class="grupo">
      <label class="campo"><span>Seu nome</span><input name="nome" value="${cli.nome || ""}" autocomplete="name" required maxlength="80"></label>
      <label class="campo"><span>WhatsApp</span><input name="telefone" value="${cli.telefone || ""}" type="tel" inputmode="tel" autocomplete="tel" placeholder="(00) 00000-0000" required></label>
    </div>
    ${fazEntrega && fazRetirada ? html`<div class="opcoes" role="radiogroup" aria-label="Como receber">
      <label><input type="radio" name="tipo" value="entrega" ${tipo === "entrega" ? "checked" : ""}><span>🛵 Entrega${Number(c.taxa_entrega) ? html`<small>${dinheiro(c.taxa_entrega)}</small>` : html`<small>grátis</small>`}</span></label>
      <label><input type="radio" name="tipo" value="retirada" ${tipo === "retirada" ? "checked" : ""}><span>🏪 Retirar na loja<small>sem taxa</small></span></label>
    </div>` : html`<p class="muted">${fazEntrega ? "🛵 Pedido para entrega" : "🏪 Pedido para retirar na loja"}</p>`}
    <div class="grupo" id="g-end">
      <div class="duas"><label class="campo"><span>CEP</span><input name="cep" value="${e.cep || ""}" inputmode="numeric" autocomplete="postal-code" maxlength="9"></label>
        <label class="campo"><span>Número</span><input name="numero" value="${e.numero || ""}" maxlength="20" required></label></div>
      <label class="campo"><span>Rua</span><input name="logradouro" value="${e.logradouro || ""}" autocomplete="address-line1" maxlength="120" required></label>
      <div class="duas"><label class="campo"><span>Bairro</span><input name="bairro" value="${e.bairro || ""}" maxlength="80" required></label>
        <label class="campo"><span>Complemento</span><input name="complemento" value="${e.complemento || ""}" maxlength="80" placeholder="Apto, bloco"></label></div>
      <input type="hidden" name="cidade" value="${e.cidade || loja.cidade || ""}">
      <label class="campo"><span>Ponto de referência</span><input name="referencia" value="${e.referencia || ""}" maxlength="120"></label>
    </div>
    <div class="grupo" id="g-ret" hidden><p class="muted">Retire em: ${[loja.logradouro, loja.numero, loja.bairro].filter(Boolean).join(", ") || "endereço da loja"}</p></div>
    <h3>Pagamento</h3>
    <div class="opcoes tres" role="radiogroup" aria-label="Pagamento">
      ${pixOk ? html`<label><input type="radio" name="pag" value="pix" checked><span>PIX<small>pague agora</small></span></label>` : ""}
      <label><input type="radio" name="pag" value="dinheiro" ${pixOk ? "" : "checked"}><span>Dinheiro<small>na ${tipo === "entrega" ? "entrega" : "retirada"}</small></span></label>
      <label><input type="radio" name="pag" value="cartao"><span>Cartão<small>maquininha</small></span></label>
    </div>
    <label class="campo" id="g-troco" hidden><span>Troco para quanto? (opcional)</span><input name="troco" inputmode="decimal" placeholder="Ex.: 100"></label>
    <label class="campo"><span>Observação do pedido</span><input name="observacao" maxlength="300" placeholder="Ex.: interfone com defeito, ligar ao chegar"></label>
    <div class="resumo" id="resumo"></div>
    <button class="btn-pri" id="enviar">Fazer pedido</button>
    <p class="muted pequeno">Ao enviar, a loja recebe o pedido na hora e você acompanha cada etapa nesta página.</p>
  </form>`, {
    classe: "alta",
    onPronto: (d, fechar) => {
      const f = $("#f-ped", d);
      const atualizar = () => {
        tipo = f.querySelector("[name=tipo]:checked")?.value || tipo;
        pagamento = f.querySelector("[name=pag]:checked")?.value || pagamento;
        $("#g-end", d).hidden = tipo !== "entrega";
        $("#g-ret", d).hidden = tipo !== "retirada";
        $("#g-troco", d).hidden = pagamento !== "dinheiro";
        const sub = totalSacola(), taxa = tipo === "entrega" ? Number(c.taxa_entrega || 0) : 0;
        render($("#resumo", d), html`<div class="linha"><span>Subtotal</span><span>${dinheiro(sub)}</span></div>
          ${tipo === "entrega" ? html`<div class="linha"><span>Entrega</span><span>${taxa ? dinheiro(taxa) : "Grátis"}</span></div>` : ""}
          <div class="linha total"><span>Total</span><strong>${dinheiro(sub + taxa)}</strong></div>`);
      };
      f.addEventListener("change", atualizar); atualizar();
      f.telefone.addEventListener("input", () => {
        const d2 = f.telefone.value.replace(/\D/g, "").slice(0, 11);
        f.telefone.value = d2.length > 6 ? `(${d2.slice(0, 2)}) ${d2.slice(2, d2.length - 4)}-${d2.slice(-4)}` : d2.length > 2 ? `(${d2.slice(0, 2)}) ${d2.slice(2)}` : d2;
      });
      f.cep.addEventListener("input", async () => {
        const cep = f.cep.value.replace(/\D/g, "");
        if (cep.length !== 8) return;
        try {
          const r = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
          if (!r.erro) { f.logradouro.value = r.logradouro || f.logradouro.value; f.bairro.value = r.bairro || f.bairro.value; f.cidade.value = r.localidade || f.cidade.value; f.numero.focus(); }
        } catch { /* preenchimento manual */ }
      });
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const x = Object.fromEntries(new FormData(f));
        const tel = (x.telefone || "").replace(/\D/g, "");
        if ((x.nome || "").trim().length < 2) return aviso("Informe seu nome", "erro");
        if (tel.length < 10) return aviso("Informe o WhatsApp com DDD", "erro");
        const endereco = { cep: x.cep, logradouro: x.logradouro, numero: x.numero, complemento: x.complemento, bairro: x.bairro, cidade: x.cidade, referencia: x.referencia };
        if (tipo === "entrega" && (!x.logradouro?.trim() || !x.numero?.trim() || !x.bairro?.trim())) return aviso("Preencha rua, número e bairro", "erro");
        const troco = Number(String(x.troco || "").replace(/\./g, "").replace(",", ".")) || null;
        const btn = $("#enviar", d);
        btn.disabled = true; btn.textContent = "Enviando…";
        try {
          const { data, error } = await sb.rpc("criar_pedido_delivery", { p_slug: slug, p: {
            nome: x.nome.trim(), telefone: tel, tipo, endereco: tipo === "entrega" ? endereco : null, pagamento,
            troco_para: pagamento === "dinheiro" ? troco : null, observacao: x.observacao,
            itens: sacola.map((i) => ({ produto_id: i.id, quantidade: i.quantidade, observacao: i.observacao || null })),
          } });
          if (error) throw error;
          guardar(CH_CLIENTE, { nome: x.nome.trim(), telefone: x.telefone, tipo, endereco: tipo === "entrega" ? endereco : cli.endereco });
          const meus = ler(CH_PEDIDOS, []).filter((p) => Date.now() - p.em < 7 * 864e5);
          meus.push({ token: data.token, numero: data.numero, em: Date.now() });
          guardar(CH_PEDIDOS, meus.slice(-10));
          sacola = []; guardar(CH_SACOLA, sacola);
          fechar();
          history.pushState(null, "", `?loja=${encodeURIComponent(slug)}&pedido=${data.token}`);
          telaPedido(data.token, true);
        } catch (err) {
          aviso(msgErro(err), "erro");
          btn.disabled = false; btn.textContent = "Fazer pedido";
        }
      };
    },
  });
}

// ---------- Acompanhar pedido ----------
const ETAPAS_ENTREGA = [["recebido", "Pedido recebido", "A loja já recebeu seu pedido"], ["preparando", "Em preparo", "Seu pedido está sendo preparado"], ["saiu", "Saiu para entrega", "O entregador está a caminho"], ["entregue", "Entregue", "Bom apetite!"]];
const ETAPAS_RETIRADA = [["recebido", "Pedido recebido", "A loja já recebeu seu pedido"], ["preparando", "Em preparo", "Seu pedido está sendo preparado"], ["pronto", "Pronto para retirar", "Pode vir buscar"], ["entregue", "Retirado", "Bom apetite!"]];
const ICONES = { recebido: "🧾", preparando: "👨‍🍳", pronto: "🛍️", saiu: "🛵", entregue: "✅" };
let canalPedido = null, timerPedido = null, timerPix = null, ultimoStatus = null;

async function telaPedido(token, recemCriado = false) {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return telaErro("Pedido não encontrado", "Confira o link do pedido.");
  render(app, html`<div class="carregando"><span class="girando"></span></div>`);
  await qrPronto(3000);
  const carregar = async () => {
    const { data, error } = await sb.rpc("acompanhar_pedido", { p_token: token });
    if (error) throw error;
    return data;
  };
  let p;
  try { p = await carregar(); } catch (e) { return telaErro("Pedido não encontrado", msgErro(e)); }

  const desenhar = () => {
    const etapas = p.tipo === "entrega" ? ETAPAS_ENTREGA : ETAPAS_RETIRADA;
    let idx = etapas.findIndex(([s]) => s === p.status);
    if (p.status === "pronto" && p.tipo === "entrega") idx = 1; // pronto aguardando entregador
    const atual = etapas[Math.max(0, idx)];
    const quando = (s) => (p.historico || []).filter((h) => h.status === s).pop()?.em;
    const hora = (d) => (d ? new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "");
    const pixPendente = p.pagamento === "pix" && p.pagamento_status !== "pago" && !p.cancelado && p.status !== "entregue";
    render(app, html`<div class="pedido">
      <header class="pedido-topo">
        <a class="voltar" href="?loja=${encodeURIComponent(slug)}">← Cardápio</a>
        <span class="muted">Pedido nº ${p.numero}</span>
      </header>
      ${p.cancelado ? html`<section class="status cancelado"><div class="status-ic">✖️</div><h1>Pedido cancelado</h1><p>${p.motivo_cancelamento || "A loja cancelou este pedido."}</p></section>`
        : html`<section class="status st-${atual[0]}">
          <div class="status-ic ${idx < etapas.length - 1 ? "anima" : ""}">${ICONES[p.status === "pronto" && p.tipo === "entrega" ? "preparando" : atual[0]]}</div>
          <h1>${p.status === "pronto" && p.tipo === "entrega" ? "Pronto, aguardando o entregador" : atual[1]}</h1>
          <p>${atual[2]}${p.loja.tempo && idx < 2 ? html` · previsão ${p.loja.tempo}` : ""}</p>
        </section>
        <ol class="linha-tempo">${etapas.map(([s, nome], k) => html`<li class="${k < idx ? "feito" : k === idx ? "agora" : ""}"><span class="bolinha"></span><span class="lt-nome">${nome}</span><span class="lt-hora">${hora(quando(s))}</span></li>`)}</ol>`}
      ${pixPendente ? html`<section class="cartao pix" id="pix"></section>` : ""}
      ${p.pagamento === "pix" && p.pagamento_status === "pago" ? html`<p class="pago">✅ Pagamento PIX confirmado</p>` : ""}
      <section class="cartao">
        <h2>Resumo</h2>
        ${p.itens.map((i) => html`<div class="linha"><span>${Number(i.quantidade)}× ${i.descricao}${i.observacao ? html`<small class="obs">${i.observacao}</small>` : ""}</span><span>${dinheiro(i.total)}</span></div>`)}
        ${Number(p.taxa_entrega) ? html`<div class="linha"><span>Entrega</span><span>${dinheiro(p.taxa_entrega)}</span></div>` : ""}
        <div class="linha total"><span>Total</span><strong>${dinheiro(p.total)}</strong></div>
        <p class="muted pequeno">Pagamento: ${{ pix: "PIX", dinheiro: "Dinheiro", cartao: "Cartão na entrega" }[p.pagamento]}${p.troco_para ? ` · troco para ${dinheiro(p.troco_para)}` : ""}</p>
        ${p.endereco ? html`<p class="muted pequeno">Entrega em: ${[p.endereco.logradouro, p.endereco.numero, p.endereco.bairro].filter(Boolean).join(", ")}</p>` : ""}
      </section>
      ${p.loja.telefone ? html`<a class="btn-sec" href="${zapLoja(p.loja.telefone, `Olá! Sobre o meu pedido nº ${p.numero}.`)}" target="_blank" rel="noopener">💬 Falar com ${p.loja.nome}</a>` : ""}
      <p class="muted pequeno centro">Esta página atualiza sozinha. Pode deixar aberta.</p>
    </div>`);
    if (pixPendente) desenharPix(p, token);
  };
  desenhar();
  if (recemCriado) aviso("Pedido enviado! Acompanhe por aqui.", "ok");
  ultimoStatus = p.status;

  const atualizar = async () => {
    try {
      const novo = await carregar();
      const mudou = novo.status !== p.status || novo.pagamento_status !== p.pagamento_status || novo.cancelado !== p.cancelado || novo.total !== p.total;
      p = novo;
      if (mudou) {
        desenhar();
        if (p.status !== ultimoStatus) { navigator.vibrate?.([30, 60, 30]); ultimoStatus = p.status; }
      }
    } catch { /* tenta de novo */ }
  };
  // Tempo real (aviso do banco) + conferência periódica como reserva
  if (canalPedido) sb.removeChannel(canalPedido);
  canalPedido = sb.channel("pedido-" + token).on("broadcast", { event: "atualizado" }, atualizar).subscribe();
  clearInterval(timerPedido);
  timerPedido = setInterval(() => { if (!document.hidden && !p.cancelado && p.status !== "entregue") atualizar(); }, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) atualizar(); });
}

async function desenharPix(p, token) {
  const alvo = $("#pix");
  if (!alvo) return;
  const loja = p.loja;
  const mostrar = (codigo, auto) => {
    render(alvo, html`<h2>Pague com PIX</h2>
      <div class="pix-valor">${dinheiro(p.total)}</div>
      <div class="pix-qr">${raw(qrSvg(codigo, 240))}</div>
      <button class="btn-pri" id="copiar">Copiar código PIX</button>
      <p class="muted pequeno">${auto ? "Assim que o pagamento cair, esta página confirma sozinha." : "Abra o app do seu banco, escolha PIX › Copia e Cola ou leia o QR. A loja confirma o recebimento."}</p>`);
    $("#copiar").onclick = async () => {
      try { await navigator.clipboard.writeText(codigo); aviso("Código copiado! Cole no app do banco.", "ok"); }
      catch { prompt("Copie o código PIX:", codigo); }
    };
  };
  if (loja.pix_automatico) {
    render(alvo, html`<h2>Pague com PIX</h2><div class="carregando pequeno"><span class="girando"></span></div>`);
    try {
      const { data, error } = await sb.functions.invoke("pagamentos", { body: { acao: "pix_criar", token } });
      if (error || data?.error) throw new Error(data?.error || "Falha ao gerar o PIX");
      if (data.status === "approved") return;
      mostrar(data.qr_code, true);
      clearInterval(timerPix);
      timerPix = setInterval(async () => {
        if (!document.body.contains(alvo)) return clearInterval(timerPix);
        const { data: st } = await sb.functions.invoke("pagamentos", { body: { acao: "pix_status", token } });
        if (st?.status === "approved") { clearInterval(timerPix); aviso("Pagamento confirmado!", "ok"); setTimeout(() => location.reload(), 900); }
      }, 5000);
      return;
    } catch { /* cai para a chave da loja */ }
  }
  if (loja.pix) {
    try { mostrar(payloadPix({ ...loja.pix, valor: Number(p.total), txid: txidVenda("PED", p.numero) }), false); }
    catch { render(alvo, html`<p class="alerta">Não foi possível gerar o PIX. Fale com a loja.</p>`); }
  }
}

function zapLoja(tel, texto) {
  let d = String(tel || "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return d.length >= 12 ? `https://wa.me/${d}?text=${encodeURIComponent(texto)}` : "#";
}

window.addEventListener("popstate", () => location.reload());
iniciar();
