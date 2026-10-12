// QR Code na mesa: o cliente aponta a câmera e, sem app nem cadastro, vê a conta ao vivo,
// chama o garçom, pede a conta, faz pedidos (o garçom confirma antes de irem para a cozinha)
// e paga por PIX, inteiro ou dividido.  Acesso: /mesa/?t=<código da mesa>
// O banco só devolve a conta desta mesa, sem dados de cliente (migração 025).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../assets/config.js";
import { html, render, raw, dinheiro, urlSegura } from "../app/js/ui.js";
import { payloadPix, qrSvg, qrPronto } from "../assets/pix.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const app = document.getElementById("app");
const token = (new URLSearchParams(location.search).get("t") || "").trim().toLowerCase();
const $ = (s, r = document) => r.querySelector(s);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const semAcento = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };
const ler = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };
const CH_CARRINHO = `mesa-carrinho-${token}`;
const minutos = (d) => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
const ha = (d) => { const m = minutos(d); return m < 1 ? "agora" : m === 1 ? "há 1 min" : `há ${m} min`; };
const qtdTxt = (n, un) => (["KG", "L", "G", "ML", "M"].includes(un) && n % 1 ? String(n).replace(".", ",") : String(Math.round(n)));

let d = null;                     // mesa_publica
let cardapio = null;              // mesa_cardapio (carregado ao pedir)
let carrinho = ler(CH_CARRINHO, []); // [{ id, quantidade, observacao }]
let relogio = null, ocupadoAgora = false;

const ETAPA = {
  aguardando: ["Aguardando confirmação", "e-aguardando"], novo: ["Na fila da cozinha", "e-novo"], preparando: ["Preparando", "e-preparando"],
  pronto: ["Pronto, já vem", "e-pronto"], entregue: ["Servido", "e-entregue"], recusado: ["Não aceito", "e-recusado"],
};

// ---------- Utilidades de tela ----------
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
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Sem conexão. Verifique a internet e tente de novo.";
  return m;
};
function folha(conteudo, { onPronto, classe = "" } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "folha " + classe;
    document.body.appendChild(dlg);
    render(dlg, html`<div class="folha-alca" aria-hidden="true"></div><button class="folha-x" data-fechar aria-label="Fechar">✕</button><div class="folha-corpo">${conteudo}</div>`);
    let valor;
    const fechar = (v) => { valor = v; dlg.close(); };
    dlg.addEventListener("close", () => { dlg.remove(); resolve(valor); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest("[data-fechar]")) fechar(); });
    dlg.showModal();
    onPronto?.(dlg, fechar);
  });
}
async function ocupado(botao, acao) {
  if (ocupadoAgora) return;
  ocupadoAgora = true;
  const txt = botao?.innerHTML;
  if (botao) { botao.disabled = true; botao.innerHTML = '<span class="girando" style="width:20px;height:20px;border-width:2px;display:inline-block;vertical-align:middle"></span>'; }
  try { return await acao(); }
  finally { ocupadoAgora = false; if (botao) { botao.disabled = false; botao.innerHTML = txt; } }
}
async function chamarRpc(nome, params) {
  const { data, error } = await sb.rpc(nome, params);
  if (error) throw error;
  return data;
}

// ---------- Início ----------
async function iniciar() {
  if (!/^[0-9a-f-]{36}$/.test(token)) return telaErro("QR Code incompleto", "Aponte a câmera de novo para o QR da mesa ou chame o garçom.");
  try { await carregar(); }
  catch (e) {
    return telaErro("Não encontramos esta mesa", /inválido|desativado/i.test(e.message) ? "Este QR Code não está mais ativo. Chame o garçom." : msgErro(e));
  }
  relogio = setInterval(() => { if (!document.hidden) carregar().catch(() => {}); }, 6000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) carregar().catch(() => {}); });
}

async function carregar() {
  const novo = await chamarRpc("mesa_publica", { p_token: token });
  const antes = d;
  d = novo;
  document.title = `${d.mesa.nome} · ${d.loja.nome}`;
  avisarMudancas(antes, d);
  desenhar();
}

/** Avisos curtos quando o garçom responde (pedido confirmado/recusado, pagamento). */
function avisarMudancas(a, b) {
  if (!a) return;
  const st = new Map((a.chamados || []).map((c) => [c.id, c.status]));
  for (const c of b.chamados || []) {
    const s0 = st.get(c.id);
    if (!s0 || s0 === c.status || c.tipo !== "pedido") continue;
    if (c.status === "atendido") { aviso("O garçom confirmou seu pedido ✓", "ok"); navigator.vibrate?.(60); }
    if (c.status === "recusado") { aviso(`Pedido não aceito${c.motivo ? ": " + c.motivo : ""}`, "erro"); navigator.vibrate?.([100, 60, 100]); }
  }
  if (a.conta && !b.conta) aviso("Conta fechada. Obrigado pela visita!", "ok");
}

function telaErro(titulo, texto) {
  clearInterval(relogio);
  render(app, html`<div class="tela-erro"><div class="erro-ic">🍽️</div><h1>${titulo}</h1><p>${texto}</p></div>`);
}

// ---------- Tela principal ----------
function desenhar() {
  const c = d.conta;
  const pend = (t) => (d.chamados || []).find((x) => x.tipo === t && x.status === "pendente");
  const pessoas = Math.max(1, Number(c?.pessoas) || 1);
  const itensCarrinho = carrinho.reduce((a, i) => a + i.quantidade, 0);
  const podePagar = c && d.pode_pagar && (d.pix_automatico || d.pix) && Number(c.falta) > 0.009;

  render(app, html`
    <header class="topo mesa-topo">
      <div class="topo-in">
        <div class="loja-marca">${String(d.loja.nome || "?").trim().charAt(0).toUpperCase()}</div>
        <div class="grow"><p class="mesa-loja">${d.loja.nome}</p><h1>${d.mesa.nome}</h1>
          <div class="loja-info">${c ? html`<span class="estado aberto">Conta aberta</span>${c.pessoas ? html`<span>${c.pessoas} ${c.pessoas === 1 ? "pessoa" : "pessoas"}</span>` : ""}${c.garcom ? html`<span>Garçom: ${c.garcom}</span>` : ""}`
            : html`<span>Mesa livre · chame o garçom para abrir</span>`}</div></div>
      </div>
    </header>

    <main class="conteudo mesa-conteudo">
      ${situacoes()}

      <div class="mesa-acoes">
        <button class="acao ${pend("garcom") ? "feito" : ""}" data-a="garcom"><span class="acao-ic">🔔</span><strong>${pend("garcom") ? "Garçom chamado" : "Chamar garçom"}</strong><small>${pend("garcom") ? ha(pend("garcom").criado_em) : "ele vem até a mesa"}</small></button>
        ${d.pode_pedir ? html`<button class="acao" data-a="pedir"><span class="acao-ic">🍽️</span><strong>Fazer pedido</strong><small>o garçom confirma</small></button>` : ""}
        ${c ? html`<button class="acao ${c.conta_pedida ? "feito" : ""}" data-a="conta"><span class="acao-ic">🧾</span><strong>${c.conta_pedida ? "Conta pedida" : "Pedir a conta"}</strong><small>${c.conta_pedida ? "o garçom já vem" : "fechar com o garçom"}</small></button>` : ""}
        ${podePagar ? html`<button class="acao destaque-acao" data-a="pagar"><span class="acao-ic">💠</span><strong>Pagar com PIX</strong><small>inteiro ou dividido</small></button>` : ""}
      </div>

      ${c ? html`<section class="cartao conta">
        <h2>Sua conta</h2>
        ${c.itens.length ? html`<ul class="conta-itens">${c.itens.map((i) => {
          const et = ETAPA[i.etapa];
          return html`<li><span class="ci-q">${qtdTxt(Number(i.quantidade), i.unidade)}×</span>
            <span class="grow"><span>${i.descricao}</span>${i.observacao ? html`<span class="obs">${i.observacao}</span>` : ""}${et ? html`<span class="etapa ${et[1]}">${et[0]}</span>` : ""}</span>
            <span class="ci-v">${dinheiro(i.total)}</span></li>`;
        })}</ul>` : html`<p class="muted">Ainda não há itens na conta.</p>`}
        <div class="resumo">
          ${Number(c.desconto) || Number(c.taxa_servico) || Number(c.couvert) ? html`<div class="linha"><span>Consumo</span><span>${dinheiro(c.subtotal)}</span></div>` : ""}
          ${Number(c.desconto) ? html`<div class="linha"><span>Desconto</span><span>−${dinheiro(c.desconto)}</span></div>` : ""}
          ${Number(c.taxa_servico) ? html`<div class="linha"><span>Serviço (${String(Number(c.servico_pct)).replace(".", ",")}%) · opcional</span><span>${dinheiro(c.taxa_servico)}</span></div>` : ""}
          ${Number(c.couvert) ? html`<div class="linha"><span>Couvert</span><span>${dinheiro(c.couvert)}</span></div>` : ""}
          <div class="linha total"><strong>Total</strong><strong>${dinheiro(c.total)}</strong></div>
          ${pessoas > 1 ? html`<div class="linha muted"><span>Por pessoa (${pessoas})</span><span>${dinheiro(Number(c.total) / pessoas)}</span></div>` : ""}
          ${Number(c.pago) > 0 ? html`<div class="linha pago-linha"><span>Pago pelo QR</span><span>−${dinheiro(c.pago)}</span></div>
            <div class="linha total"><strong>${Number(c.falta) > 0.009 ? "Falta pagar" : "Tudo pago ✓"}</strong><strong>${dinheiro(c.falta)}</strong></div>` : ""}
        </div>
        <p class="pequeno muted">A conta se atualiza sozinha. A taxa de serviço é opcional: se não quiser, avise o garçom.</p>
      </section>` : html`<section class="cartao centro mesa-livre">
        <div class="erro-ic">👋</div><h2>Bem-vindo!</h2>
        <p class="muted">${d.pode_pedir ? "Você já pode olhar o cardápio e fazer o pedido. O garçom confirma e abre a sua mesa." : "Chame o garçom para abrir a sua mesa."}</p></section>`}

      <p class="pequeno muted centro mesa-rodape">Esta página mostra só a conta desta mesa. Pagamento e pedidos são conferidos pela equipe.</p>
    </main>
    ${itensCarrinho ? html`<div class="barra-sacola"><button class="btn-sacola" data-a="revisar"><span class="contador">${itensCarrinho}</span><span>Ver meu pedido</span><span>${dinheiro(totalCarrinho())}</span></button></div>` : ""}`);
}

function situacoes() {
  const ch = d.chamados || [];
  const linhas = [];
  for (const c of ch) {
    if (c.status === "cancelado") continue;
    if (c.tipo === "pedido") {
      const resumo = (c.itens || []).map((i) => `${i.quantidade}× ${i.nome}`).join(", ");
      if (c.status === "pendente") linhas.push(html`<div class="situacao s-espera"><span>⏳</span><div class="grow"><strong>Pedido com o garçom para confirmar</strong><span>${resumo}</span></div><button class="link" data-cancelar="${c.id}">Cancelar</button></div>`);
      else if (c.status === "atendido" && minutos(c.criado_em) < 30) linhas.push(html`<div class="situacao s-ok"><span>✓</span><div class="grow"><strong>Pedido confirmado</strong><span>${resumo}</span></div></div>`);
      else if (c.status === "recusado" && minutos(c.criado_em) < 30) linhas.push(html`<div class="situacao s-erro"><span>✕</span><div class="grow"><strong>Pedido não aceito${c.motivo ? `: ${c.motivo}` : ""}</strong><span>${resumo}</span></div></div>`);
    }
    if (c.status !== "pendente") continue;
    if (c.tipo === "garcom") linhas.push(html`<div class="situacao s-espera"><span>🔔</span><div class="grow"><strong>Garçom chamado ${ha(c.criado_em)}</strong><span>Ele já foi avisado no celular.</span></div><button class="link" data-cancelar="${c.id}">Cancelar</button></div>`);
    if (c.tipo === "conta") linhas.push(html`<div class="situacao s-espera"><span>🧾</span><div class="grow"><strong>Conta pedida ${ha(c.criado_em)}</strong><span>O garçom já vem até a mesa.</span></div></div>`);
    if (c.tipo === "pix") linhas.push(html`<div class="situacao s-espera"><span>💠</span><div class="grow"><strong>Avisamos o garçom do seu PIX de ${dinheiro(c.valor)}</strong><span>Ele vai conferir o comprovante.</span></div></div>`);
  }
  return linhas.length ? html`<div class="situacoes">${linhas}</div>` : "";
}

// ---------- Ações ----------
app.addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const a = b.dataset.a;
  try {
    if (a === "garcom") {
      if (b.classList.contains("feito")) return aviso("O garçom já foi chamado e está a caminho");
      await ocupado(b, () => chamarRpc("mesa_chamar", { p_token: token, p_tipo: "garcom" }));
      aviso("Garçom chamado. Ele já foi avisado ✓", "ok"); navigator.vibrate?.(40);
      return carregar();
    }
    if (a === "conta") {
      if (b.classList.contains("feito")) return aviso("A conta já foi pedida. O garçom já vem");
      await ocupado(b, () => chamarRpc("mesa_chamar", { p_token: token, p_tipo: "conta" }));
      aviso("Conta pedida ✓", "ok");
      return carregar();
    }
    if (a === "pedir") return abrirCardapio();
    if (a === "revisar") return revisarPedido();
    if (a === "pagar") return pagar();
    if (b.dataset.cancelar) {
      await ocupado(b, () => chamarRpc("mesa_cliente_cancelar", { p_token: token, p_chamado: b.dataset.cancelar }));
      aviso("Cancelado");
      return carregar();
    }
  } catch (err) { aviso(msgErro(err), "erro"); carregar().catch(() => {}); }
});

// ---------- Pedir ----------
const produtoPor = (id) => cardapio?.produtos.find((p) => p.id === id);
const totalCarrinho = () => r2(carrinho.reduce((a, i) => a + i.quantidade * Number(produtoPor(i.id)?.preco || i.preco || 0), 0));
const salvarCarrinho = () => guardar(CH_CARRINHO, carrinho);

async function abrirCardapio() {
  if (!cardapio) {
    try { cardapio = await chamarRpc("mesa_cardapio", { p_token: token }); }
    catch (e) { return aviso(msgErro(e), "erro"); }
    carrinho = carrinho.filter((i) => produtoPor(i.id)).map((i) => ({ ...i, preco: produtoPor(i.id).preco }));
    salvarCarrinho();
  }
  if (!cardapio.produtos.length) return aviso("O cardápio ainda não está disponível. Chame o garçom.", "erro");
  let cat = null, busca = "";
  await folha(html`<h2>Cardápio</h2>
    <div class="busca"><span aria-hidden="true">🔎</span><input id="m-busca" type="search" placeholder="Buscar no cardápio" autocomplete="off" enterkeyhint="search"></div>
    <div class="cats" id="m-cats"></div>
    <div class="itens" id="m-itens"></div>
    <div id="m-barra"></div>`, {
    classe: "alta",
    onPronto: (dlg, fechar) => {
      const desenharCats = () => render(dlg.querySelector("#m-cats"), html`<a href="#" data-c="" class="${cat ? "" : "ativo"}">Tudo</a>${cardapio.categorias.map((k) => html`<a href="#" data-c="${k.id}" class="${cat === k.id ? "ativo" : ""}">${k.nome}</a>`)}`);
      const desenharItens = () => {
        const t = semAcento(busca.trim());
        let lista = cardapio.produtos;
        if (t) lista = lista.filter((p) => semAcento(p.nome + " " + (p.descricao || "")).includes(t));
        else if (cat) lista = lista.filter((p) => p.categoria_id === cat);
        render(dlg.querySelector("#m-itens"), lista.length ? html`${lista.slice(0, 150).map((p) => {
          const n = carrinho.find((i) => i.id === p.id)?.quantidade || 0;
          return html`<div class="item item-mesa ${n ? "no-carrinho" : ""}">
            ${p.imagem ? html`<img src="${urlSegura(p.imagem)}" alt="" loading="lazy">` : ""}
            <div class="item-txt"><strong>${p.nome}</strong>${p.descricao ? html`<span class="item-desc">${p.descricao}</span>` : ""}<span class="item-preco">${dinheiro(p.preco)}</span></div>
            ${n ? html`<div class="passo pequeno"><button data-menos="${p.id}" aria-label="Menos">−</button><span>${n}</span><button data-mais="${p.id}" aria-label="Mais">+</button></div>`
              : html`<button class="item-add" data-mais="${p.id}" aria-label="Adicionar ${p.nome}">+</button>`}
          </div>`;
        })}` : html`<p class="vazio">Nada encontrado.</p>`);
        const n = carrinho.reduce((a, i) => a + i.quantidade, 0);
        render(dlg.querySelector("#m-barra"), n ? html`<button class="btn-pri barra-fixa" data-revisar>Revisar pedido (${n}) · ${dinheiro(totalCarrinho())}</button>` : "");
      };
      dlg.addEventListener("click", (e) => {
        const c = e.target.closest("[data-c]");
        if (c) { e.preventDefault(); cat = c.dataset.c || null; desenharCats(); desenharItens(); return; }
        const mais = e.target.closest("[data-mais]"), menos = e.target.closest("[data-menos]");
        if (mais || menos) {
          const id = (mais || menos).dataset.mais || (menos || mais).dataset.menos;
          const it = carrinho.find((i) => i.id === id);
          if (mais) { if (it) it.quantidade = Math.min(20, it.quantidade + 1); else carrinho.push({ id, quantidade: 1, observacao: "", preco: produtoPor(id).preco }); navigator.vibrate?.(15); }
          if (menos && it) { it.quantidade -= 1; if (it.quantidade <= 0) carrinho = carrinho.filter((x) => x !== it); }
          salvarCarrinho(); desenharItens(); return;
        }
        if (e.target.closest("[data-revisar]")) { fechar("revisar"); }
      });
      const inp = dlg.querySelector("#m-busca");
      inp.oninput = () => { busca = inp.value; desenharItens(); };
      desenharCats(); desenharItens();
    },
  }).then((r) => { desenhar(); if (r === "revisar") revisarPedido(); });
}

async function revisarPedido() {
  if (!cardapio) { try { cardapio = await chamarRpc("mesa_cardapio", { p_token: token }); } catch (e) { return aviso(msgErro(e), "erro"); } }
  carrinho = carrinho.filter((i) => produtoPor(i.id));
  salvarCarrinho();
  if (!carrinho.length) { desenhar(); return aviso("Seu pedido está vazio"); }
  const enviado = await folha(html`<h2>Seu pedido</h2><div id="m-rev" class="sacola-lista"></div>
    <div class="resumo"><div class="linha total"><strong>Total estimado</strong><strong id="m-tot"></strong></div></div>
    <p class="alerta">${d.conta ? "O garçom confirma o pedido e ele entra na sua conta." : "O garçom confirma o pedido e abre a sua mesa."} Você acompanha aqui na página.</p>
    <button class="btn-pri" id="m-enviar">Enviar para o garçom</button>
    <button class="btn-sec" data-fechar>Continuar escolhendo</button>`, {
    onPronto: (dlg, fechar) => {
      const box = dlg.querySelector("#m-rev");
      const desenharRev = () => {
        if (!carrinho.length) return fechar(false);
        render(box, html`${carrinho.map((i) => { const p = produtoPor(i.id); return html`<div class="sacola-item rev-item">
          <div class="grow"><strong>${p.nome}</strong><span class="muted pequeno">${dinheiro(p.preco)} cada</span>
            <input class="rev-obs" data-obs="${i.id}" maxlength="100" placeholder="Observação (ex.: sem cebola)" value="${i.observacao || ""}"></div>
          <div class="passo pequeno"><button data-menos="${i.id}" aria-label="Menos">−</button><span>${i.quantidade}</span><button data-mais="${i.id}" aria-label="Mais">+</button></div></div>`; })}`);
        dlg.querySelector("#m-tot").textContent = dinheiro(totalCarrinho());
      };
      box.addEventListener("click", (e) => {
        const mais = e.target.closest("[data-mais]"), menos = e.target.closest("[data-menos]");
        if (!mais && !menos) return;
        const it = carrinho.find((x) => x.id === (mais?.dataset.mais || menos?.dataset.menos));
        if (mais) it.quantidade = Math.min(20, it.quantidade + 1);
        if (menos) { it.quantidade -= 1; if (it.quantidade <= 0) carrinho = carrinho.filter((x) => x !== it); }
        salvarCarrinho(); desenharRev();
      });
      box.addEventListener("input", (e) => {
        const it = carrinho.find((x) => x.id === e.target.dataset.obs);
        if (it) { it.observacao = e.target.value.slice(0, 100); salvarCarrinho(); }
      });
      dlg.querySelector("#m-enviar").onclick = async (ev) => {
        try {
          await ocupado(ev.currentTarget, () => chamarRpc("mesa_cliente_pedir", {
            p_token: token, p_itens: carrinho.map((i) => ({ produto_id: i.id, quantidade: i.quantidade, observacao: i.observacao || null })),
          }));
          carrinho = []; salvarCarrinho();
          fechar(true);
        } catch (err) { aviso(msgErro(err), "erro"); }
      };
      desenharRev();
    },
  });
  if (enviado) { aviso("Pedido enviado. O garçom vai confirmar ✓", "ok"); navigator.vibrate?.(50); }
  await carregar().catch(() => {});
}

// ---------- Pagar ----------
async function pagar() {
  const c = d.conta;
  if (!c || !(Number(c.falta) > 0.009)) return aviso("Não há valor a pagar");
  const falta = r2(c.falta);
  let modo = "tudo", partes = Math.max(2, Number(c.pessoas) || 2), outro = "";
  const valorEscolhido = () => modo === "tudo" ? falta : modo === "dividir" ? Math.min(falta, Math.ceil((falta / partes) * 100) / 100) : Math.min(falta, r2(String(outro).replace(/\./g, "").replace(",", ".")));
  await qrPronto().catch(() => {});

  await folha(html`<div id="m-pag"></div>`, {
    onPronto: (dlg, fechar) => {
      const box = dlg.querySelector("#m-pag");
      let timer = null;
      dlg.addEventListener("close", () => clearTimeout(timer));

      const escolher = () => {
        const v = valorEscolhido();
        render(box, html`<h2>Pagar com PIX</h2>
          <div class="resumo"><div class="linha"><span>Total da mesa</span><span>${dinheiro(c.total)}</span></div>
            ${Number(c.pago) ? html`<div class="linha"><span>Já pago pelo QR</span><span>−${dinheiro(c.pago)}</span></div>` : ""}
            <div class="linha total"><strong>Falta pagar</strong><strong>${dinheiro(falta)}</strong></div></div>
          <div class="opcoes tres">
            <label><input type="radio" name="modo" value="tudo" ${modo === "tudo" ? "checked" : ""}><span>Tudo<small>${dinheiro(falta)}</small></span></label>
            <label><input type="radio" name="modo" value="dividir" ${modo === "dividir" ? "checked" : ""}><span>Dividir<small>partes iguais</small></span></label>
            <label><input type="radio" name="modo" value="outro" ${modo === "outro" ? "checked" : ""}><span>Outro valor<small>você escolhe</small></span></label>
          </div>
          ${modo === "dividir" ? html`<div class="prod-acoes" style="justify-content:space-between"><span>Dividir em</span>
            <div class="passo"><button data-p="-" aria-label="Menos">−</button><span>${partes}</span><button data-p="+" aria-label="Mais">+</button></div><span>${dinheiro(v)} cada</span></div>` : ""}
          ${modo === "outro" ? html`<label class="campo">Valor (R$)<input id="m-outro" inputmode="decimal" placeholder="0,00" value="${outro}"></label>` : ""}
          <button class="btn-pri" id="m-ir" ${v >= 0.01 ? "" : "disabled"}>Pagar ${dinheiro(v)} com PIX</button>
          ${!d.pix_automatico ? html`<p class="pequeno muted centro">Depois de pagar, toque em “Já paguei” para o garçom conferir.</p>` : ""}`);
        box.querySelectorAll("[name=modo]").forEach((r) => (r.onchange = () => { modo = r.value; escolher(); if (modo === "outro") box.querySelector("#m-outro")?.focus(); }));
        box.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { partes = Math.max(2, Math.min(20, partes + (b.dataset.p === "+" ? 1 : -1))); escolher(); }));
        const inp = box.querySelector("#m-outro");
        if (inp) inp.oninput = () => { outro = inp.value; const v2 = valorEscolhido(); const bt = box.querySelector("#m-ir"); bt.disabled = !(v2 >= 0.01); bt.textContent = `Pagar ${dinheiro(v2 || 0)} com PIX`; };
        box.querySelector("#m-ir").onclick = (ev) => (d.pix_automatico ? pixAutomatico(ev.currentTarget, valorEscolhido()) : pixChave(valorEscolhido()));
      };

      // PIX com confirmação automática (Mercado Pago): QR da cobrança e confirmação sozinha
      const pixAutomatico = async (botao, valor) => {
        let cob;
        try {
          cob = await ocupado(botao, async () => {
            const { data, error } = await sb.functions.invoke("pagamentos", { body: { acao: "mesa_pix_criar", mesa: token, valor } });
            if (error) { let m = error.message; try { const j = await error.context?.json?.(); m = j?.error || m; } catch { /* ignora */ } throw new Error(m); }
            if (data?.error) throw new Error(data.error);
            return data;
          });
        } catch (err) { return aviso(msgErro(err), "erro"); }
        if (!cob) return;
        mostrarQr(valor, cob.qr_code, cob.qr_code_base64 ? `data:image/png;base64,${cob.qr_code_base64}` : null, true);
        const conferir = async () => {
          try {
            const { data } = await sb.functions.invoke("pagamentos", { body: { acao: "mesa_pix_status", mesa: token, pagamento_id: cob.pagamento_id } });
            if (data?.pago || data?.status === "approved") return concluido(valor, true);
          } catch { /* tenta de novo */ }
          timer = setTimeout(conferir, 4000);
        };
        timer = setTimeout(conferir, 5000);
      };

      // PIX pela chave da loja: o cliente paga e avisa; o garçom confere o comprovante
      const pixChave = (valor) => {
        let codigo;
        try { codigo = payloadPix({ ...d.pix, valor, mensagem: d.mesa.nome }); }
        catch (err) { return aviso(err.message, "erro"); }
        mostrarQr(valor, codigo, null, false);
      };

      const mostrarQr = (valor, codigo, imagem, auto) => {
        render(box, html`<div class="cartao pix">
          <h2>PIX de ${dinheiro(valor)}</h2>
          <div class="pix-qr">${imagem ? html`<img src="${imagem}" alt="QR Code PIX" width="220" height="220">` : raw(qrSvg(codigo, 220))}</div>
          <p class="pequeno muted">No celular: copie o código e cole no app do banco (PIX › Copia e cola).</p>
          <button class="btn-sec" id="m-copiar">Copiar código PIX</button>
          ${auto ? html`<p class="pix-espera"><span class="girando" style="width:18px;height:18px;border-width:2px"></span> Esperando o pagamento… a confirmação é automática.</p>`
            : html`<button class="btn-pri" id="m-paguei">Já paguei · avisar o garçom</button>`}
          <button class="link" id="m-voltar">Voltar</button></div>`);
        box.querySelector("#m-copiar").onclick = () => navigator.clipboard?.writeText(codigo).then(() => aviso("Código copiado ✓", "ok")).catch(() => aviso("Não deu para copiar. Segure no código para copiar.", "erro"));
        box.querySelector("#m-voltar").onclick = () => { clearTimeout(timer); escolher(); };
        box.querySelector("#m-paguei")?.addEventListener("click", async (ev) => {
          try {
            await ocupado(ev.currentTarget, () => chamarRpc("mesa_chamar", { p_token: token, p_tipo: "pix", p_valor: valor }));
            concluido(valor, false);
          } catch (err) { aviso(msgErro(err), "erro"); }
        });
      };

      const concluido = (valor, auto) => {
        clearTimeout(timer);
        navigator.vibrate?.([60, 40, 60]);
        render(box, html`<div class="status st-entregue"><div class="status-ic">✅</div>
          <h1>${auto ? "Pagamento confirmado" : "Garçom avisado"}</h1>
          <p>${auto ? `Recebemos ${dinheiro(valor)}. O garçom já foi avisado.` : `Seu PIX de ${dinheiro(valor)} vai ser conferido pelo garçom.`}</p>
          <button class="btn-pri" data-fechar>Pronto</button></div>`);
        carregar().catch(() => {});
      };

      escolher();
    },
  });
  carregar().catch(() => {});
}

iniciar();
