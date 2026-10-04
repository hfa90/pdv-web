// App do garçom (PWA): mesas, pedidos e conta no celular ou tablet.
// Usa o mesmo banco, os mesmos usuários e as mesmas regras do sistema do caixa.
import { sb } from "../app/js/api.js";
import { estado, carregarContexto, limparEstado, PAPEIS } from "../app/js/estado.js";
import { html, render, $, $$, dinheiro, toast, erro, ocupado, iniciais, carregando, debounce, confirmar } from "../app/js/ui.js";
import { icone } from "../app/js/icons.js";
import { desenharDetalhe, situacao, tempo, minutos, NOME_SITUACAO, reenviarPendente } from "../app/js/mesa-detalhe.js";
import { MARCA } from "../app/js/config.js";

const app = document.getElementById("app");
let canal = null, relogio = null, instalar = null;
let mesas = [], area = "todas", filtro = "todas", aberta = null;

// ---------- Instalação (PWA) ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); instalar = e; $("#btn-instalar")?.removeAttribute("hidden"); });
const ehIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
const instalado = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;

// ---------- Login ----------
function telaLogin() {
  render(app, html`<div class="g-login">
    <div class="g-login-card">
      <img src="icones/icone-192.png" alt="" width="72" height="72">
      <h1>App do garçom</h1>
      <p class="muted">Entre com o usuário que o gerente criou para você.</p>
      <form id="f-login" class="stack">
        <label class="field"><span>E-mail</span><input class="input lg" name="email" type="email" autocomplete="username" required autofocus></label>
        <label class="field"><span>Senha</span><input class="input lg" name="senha" type="password" autocomplete="current-password" required></label>
        <button class="btn primary lg block">Entrar</button>
      </form>
      <p class="small muted" style="margin-top:1rem">${MARCA}</p>
    </div></div>`);
  $("#f-login").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await ocupado(f.querySelector("button"), async () => {
      const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.senha.value });
      if (error) return toast(/Invalid login/i.test(error.message) ? "E-mail ou senha incorretos" : error.message, "erro");
      iniciar();
    });
  };
}

function telaAviso(titulo, texto) {
  render(app, html`<div class="g-login"><div class="g-login-card"><img src="icones/icone-192.png" alt="" width="64" height="64">
    <h1>${titulo}</h1><p class="muted">${texto}</p><button class="btn block" id="sair">Sair</button></div></div>`);
  $("#sair").onclick = sair;
}

// ---------- Tela principal ----------
function montar() {
  const p = estado.perfil;
  render(app, html`<div class="g-shell">
    <header class="g-top">
      <div class="avatar">${iniciais(p.nome)}</div>
      <div class="grow g-top-txt"><strong>${estado.empresa.nome_fantasia || estado.empresa.razao_social}</strong><span>${p.nome.split(" ")[0]} · ${PAPEIS[p.papel].nome}</span></div>
      <button class="btn sm" id="btn-instalar" ${instalar || (ehIOS && !instalado()) ? "" : "hidden"}>Instalar</button>
      <button class="btn ghost icon-btn" id="btn-sair" aria-label="Sair">${icone("sair", 'width="20" height="20"')}</button>
    </header>
    <div class="g-offline" id="offline" hidden>Sem internet. Os pedidos serão enviados quando a conexão voltar.</div>
    <div class="g-resumo" id="resumo"></div>
    <div class="g-filtros">
      <div class="seg" id="filtros">
        <button data-f="todas">Todas</button><button data-f="ocupadas">Ocupadas</button><button data-f="livres">Livres</button><button data-f="minhas">Minhas</button>
      </div>
    </div>
    <div class="chips g-areas" id="areas"></div>
    <main class="g-mesas" id="mesas"></main>
    <section class="g-detalhe" id="detalhe" hidden></section>
  </div>`);
  $("#btn-sair").onclick = async () => { if (await confirmar("Sair do app?", { ok: "Sair" })) sair(); };
  $("#btn-instalar").onclick = async () => {
    if (instalar) { instalar.prompt(); await instalar.userChoice; instalar = null; $("#btn-instalar").hidden = true; return; }
    toast("No iPhone: toque em Compartilhar e depois em “Adicionar à Tela de Início”.");
  };
  $$("#filtros button").forEach((b) => (b.onclick = () => { filtro = b.dataset.f; desenhar(); }));
  const rede = () => { $("#offline").hidden = navigator.onLine; if (navigator.onLine) { recarregar(); reenviarPendente().catch(erro); } };
  window.addEventListener("online", rede); window.addEventListener("offline", rede); rede();
}

async function recarregar() {
  try {
    const { data, error } = await sb.rpc("mesas_painel");
    if (error) throw error;
    mesas = data || [];
    desenhar();
    if (aberta && !document.querySelector("dialog[open]")) {
      const m = mesas.find((x) => x.id === aberta);
      if (m) desenharDetalhe($("#detalhe"), m, opcoes()).catch(() => {});
    }
  } catch (e) { if (navigator.onLine) erro(e); }
}
const recarregarDepois = debounce(recarregar, 350);

function desenhar() {
  const alvo = $("#mesas");
  if (!alvo) return;
  const areas = [...new Set(mesas.map((m) => m.area))];
  if (area !== "todas" && !areas.includes(area)) area = "todas";
  render($("#areas"), areas.length > 1 ? html`<button class="chip ${area === "todas" ? "ativo" : ""}" data-a="todas">Todas as áreas</button>${areas.map((a) => html`<button class="chip ${area === a ? "ativo" : ""}" data-a="${a}">${a}</button>`)}` : "");
  $$("#areas [data-a]").forEach((b) => (b.onclick = () => { area = b.dataset.a; desenhar(); }));
  $$("#filtros button").forEach((b) => b.classList.toggle("ativo", b.dataset.f === filtro));

  const livres = mesas.filter((m) => !m.venda_id).length;
  const conta = mesas.filter((m) => m.conta_pedida).length;
  render($("#resumo"), html`<span><span class="dot-sit livre"></span> ${livres} livres</span>
    <span><span class="dot-sit ocupada"></span> ${mesas.length - livres - conta} ocupadas</span>
    <span><span class="dot-sit conta"></span> ${conta} conta</span>`);

  const meuNome = estado.perfil.nome;
  let lista = mesas.filter((m) => area === "todas" || m.area === area);
  if (filtro === "livres") lista = lista.filter((m) => !m.venda_id);
  if (filtro === "ocupadas") lista = lista.filter((m) => m.venda_id);
  if (filtro === "minhas") lista = lista.filter((m) => m.venda_id && m.garcom === meuNome);
  if (!mesas.length) return render(alvo, html`<div class="empty">${icone("mesa", 'width="44" height="44"')}<p>Nenhuma mesa cadastrada.</p><p class="small">O gerente cadastra as mesas no sistema, em Mesas.</p></div>`);
  if (!lista.length) return render(alvo, html`<div class="empty"><p>Nenhuma mesa neste filtro.</p></div>`);
  render(alvo, html`${lista.map((m) => {
    const sit = situacao(m);
    return html`<button class="g-mesa sit-${sit}" data-m="${m.id}">
      <span class="g-num">${m.nome.replace(/^Mesa\s+/i, "")}</span>
      ${sit === "livre" ? html`<span class="g-sub">${m.lugares} lugares</span>`
        : html`<span class="g-total">${dinheiro(m.total)}</span><span class="g-sub ${minutos(m.aberta_em) > 90 ? "demora" : ""}">${tempo(m.aberta_em)}${m.garcom ? " · " + m.garcom.split(" ")[0] : ""}</span>`}
      ${sit === "conta" ? html`<span class="g-tag">conta</span>` : ""}
      <span class="sr-only">${NOME_SITUACAO[sit]}</span></button>`;
  })}`);
  $$(".g-mesa", alvo).forEach((b) => (b.onclick = () => abrir(mesas.find((m) => m.id === b.dataset.m))));
}

const opcoes = () => ({ contexto: "garcom", todas: () => mesas, onMudou: recarregarDepois, onFechar: () => history.back(), onTrocou: (id) => (aberta = id) });

function abrir(m) {
  aberta = m.id;
  const d = $("#detalhe");
  d.hidden = false;
  document.body.classList.add("com-detalhe");
  history.pushState({ mesa: m.id }, "");
  desenharDetalhe(d, m, opcoes()).catch(erro);
}
function fecharDetalhe() {
  aberta = null;
  $("#detalhe").hidden = true;
  document.body.classList.remove("com-detalhe");
  recarregar();
}
window.addEventListener("popstate", () => {
  if (document.querySelector("dialog[open]")) { document.querySelector("dialog[open]").close(); history.pushState({ mesa: aberta }, ""); return; }
  if (aberta) fecharDetalhe();
});

function ligarTempoReal() {
  if (canal) sb.removeChannel(canal);
  const emp = estado.empresa.id;
  canal = sb.channel("garcom-" + emp + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "vendas", filter: `empresa_id=eq.${emp}` }, recarregarDepois)
    .on("postgres_changes", { event: "*", schema: "public", table: "venda_itens", filter: `empresa_id=eq.${emp}` }, recarregarDepois)
    .on("postgres_changes", { event: "*", schema: "public", table: "mesas", filter: `empresa_id=eq.${emp}` }, recarregarDepois)
    .subscribe();
  clearInterval(relogio);
  relogio = setInterval(() => { if (!document.hidden) recarregar(); }, 25000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) recarregar(); });
}

// ---------- Início ----------
async function iniciar() {
  render(app, carregando());
  try {
    const logado = await carregarContexto();
    if (!logado) return telaLogin();
    if (!estado.perfil) return telaAviso("Conta sem loja", "Este usuário ainda não está ligado a uma loja. Use o sistema principal para concluir o cadastro.");
    if (!estado.conta?.garcom) return telaAviso("Exclusivo para restaurantes", "O app do garçom faz parte do plano para restaurantes. Fale com o administrador da loja.");
    montar();
    await recarregar();
    ligarTempoReal();
    reenviarPendente().catch(erro);
  } catch (e) {
    erro(e);
    await sb.auth.signOut();
    limparEstado();
    telaLogin();
  }
}

async function sair() {
  if (canal) sb.removeChannel(canal);
  clearInterval(relogio);
  await sb.auth.signOut();
  limparEstado();
  telaLogin();
}

iniciar();
