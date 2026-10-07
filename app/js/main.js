// Ponto de entrada: autenticação, roteamento por hash e layout.
import { sb } from "./api.js";
import { estado, carregarContexto, limparEstado, pode, rotaInicial, ROTAS, PAPEIS, atualizarConta, diasDeTeste, tituloRota, aprovaCozinha } from "./estado.js";
import { linkWhatsApp, MARCA } from "./config.js";
import { html, render, $, $$, iniciais, carregando, erro, confirmar } from "./ui.js";
import { icone } from "./icons.js";
import { telaLogin, telaOnboarding, telaNovaSenha } from "./paginas/login.js";
import { iniciarContingencia, ehErroDeRede, limparContextoLocal } from "./contingencia.js";

// Diagnóstico: os arquivos principais carregaram (o vigia da abertura para de esperar)
window.lisDiag?.marcar("modulos");

// Service worker: guarda os arquivos do sistema para abrir e vender sem internet
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("./sw.js").then(async (reg) => {
    await navigator.serviceWorker.ready;
    // Guarda também as bibliotecas que esta página já baixou (Supabase, QR Code, fontes)
    const urls = performance.getEntriesByType("resource").map((r) => r.name)
      .filter((u) => /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com)\//.test(u));
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ tipo: "guardar", urls });
  }).catch(() => {});
}

// Carregamento sob demanda: cada tela só baixa quando é aberta.
const PAGINAS = {
  painel: () => import("./paginas/painel.js"),
  pdv: () => import("./paginas/pdv.js"),
  mesas: () => import("./paginas/mesas.js"),
  cozinha: () => import("./paginas/cozinha.js"),
  garcons: () => import("./paginas/garcons.js"),
  delivery: () => import("./paginas/delivery.js"),
  caixa: () => import("./paginas/caixa.js"),
  vendas: () => import("./paginas/vendas.js"),
  produtos: () => import("./paginas/produtos.js"),
  estoque: () => import("./paginas/estoque.js"),
  clientes: () => import("./paginas/clientes.js"),
  relatorios: () => import("./paginas/relatorios.js"),
  usuarios: () => import("./paginas/usuarios.js"),
  etiquetas: () => import("./paginas/etiquetas.js"),
  conta: () => import("./paginas/conta.js"),
  configuracoes: () => import("./paginas/configuracoes.js"),
  plataforma: () => import("./paginas/plataforma.js"),
  fiado: () => import("./paginas/fiado.js"),
  promocoes: () => import("./paginas/promocoes.js"),
  compras: () => import("./paginas/compras.js"),
  validade: () => import("./paginas/validade.js"),
  financeiro: () => import("./paginas/financeiro.js"),
  alertas: () => import("./paginas/alertas.js"),
  diagnostico: () => import("./paginas/diagnostico.js"),
};

const app = document.getElementById("app");
let limparPagina = null;
let modoRecuperacao = false;

const CHAVE_MENU = "lis-menu";
const modoMenu = () => { try { return localStorage.getItem(CHAVE_MENU) || "auto"; } catch { return "auto"; } };

function montarShell() {
  const p = estado.perfil;
  const nomeLoja = estado.empresa?.nome_fantasia || estado.empresa?.razao_social || "";
  const modo = modoMenu();
  render(app, html`
    <div class="shell menu-${modo}">
      <aside class="sidebar ${modo === "auto" ? "recolhida" : ""}" id="sidebar">
        <div class="brand">
          <div class="brand-mark">${iniciais(nomeLoja).slice(0, 1)}</div>
          <div><div class="brand-name">${nomeLoja}</div><div class="brand-sub">Ponto de venda</div></div>
          <button class="btn ghost icon-btn btn-fixar" id="btn-fixar" title="${modo === "auto" ? "Manter menu aberto" : "Recolher menu automaticamente"}" aria-label="Fixar ou recolher o menu">${icone("recolher")}</button>
        </div>
        <nav class="nav" aria-label="Menu principal">
          ${Object.entries(ROTAS).filter(([r]) => pode(r)).map(([r, def]) =>
            html`<a href="#/${r}" data-rota="${r}" title="${tituloRota(r)}">${icone(def.icone)}<span>${tituloRota(r)}</span></a>`)}
        </nav>
        <div class="sidebar-foot">
          <div id="aviso-conta"></div>
          <button class="btn ghost block btn-tema" id="btn-tema" style="justify-content:flex-start" title="Alternar tema claro/escuro">
            <span id="ic-tema">${icone(window.lisTema?.atual() === "escuro" ? "lua" : "sol", 'width="18" height="18"')}</span>
            <span class="tema-rotulo">Tema escuro</span><span class="tema-switch" aria-hidden="true"></span></button>
          <div class="user-chip" title="${p.nome}">
            <div class="avatar">${iniciais(p.nome)}</div>
            <div class="grow small"><div style="font-weight:600">${p.nome}</div><div class="muted">${PAPEIS[p.papel].nome}</div></div>
          </div>
          <button class="btn ghost block btn-sair" id="btn-sair" style="justify-content:flex-start" title="Sair">${icone("sair", 'width="18" height="18"')} <span class="sair-rotulo">Sair</span></button>
        </div>
      </aside>
      <div class="main">
        <div class="topbar-mobile">
          <button class="btn ghost icon-btn" id="btn-menu" aria-label="Abrir menu">${icone("menu", 'width="22" height="22"')}</button>
          <strong>${nomeLoja}</strong>
          <span class="grow"></span><span id="aviso-conta-mob"></span>
        </div>
        <main id="conteudo"></main>
      </div>
    </div>`);
  $("#btn-sair").onclick = sair;
  $("#btn-menu").onclick = () => $("#sidebar").classList.toggle("aberta");
  $("#btn-tema").onclick = () => window.lisTema?.alternar();
  ligarMenuRecolhivel();
  desenharAvisoConta();
  iniciarContingencia();
  // Diagnóstico: manda os erros deste aparelho para o suporte ver de longe
  import("./diagnostico/envio.js").then((m) => m.iniciarEnvio()).catch(() => {});
  import("./cozinha.js").then((m) => m.iniciarCozinha()).catch(() => {});
  if (pode("delivery")) import("./avisos.js").then((m) => m.iniciarAvisos()).catch(() => {});
  // Pedidos do garçom aguardando aprovação: aviso em qualquer tela para quem aprova
  if (pode("cozinha") && aprovaCozinha()) import("./aprovacoes.js").then((m) => m.iniciarAprovacoes()).catch(() => {});
  // Contas fechadas pelo garçom no app entram no caixa principal: aviso para quem está no caixa
  if (pode("mesas") && aprovaCozinha()) import("./recebimentos.js").then((m) => m.iniciarRecebimentos()).catch(() => {});
}

window.addEventListener("tema", (e) => {
  const alvo = document.getElementById("ic-tema");
  if (alvo) render(alvo, icone(e.detail === "escuro" ? "lua" : "sol", 'width="18" height="18"'));
});

/** Menu lateral: no modo automático abre ao passar o mouse e recolhe ao sair. */
function ligarMenuRecolhivel() {
  const shell = $(".shell"), side = $("#sidebar");
  let t = null;
  const abrir = () => { clearTimeout(t); t = setTimeout(() => side.classList.remove("recolhida"), 70); };
  const fechar = (porMouse) => { clearTimeout(t); t = setTimeout(() => {
    if (side.matches(":hover")) return;
    if (!porMouse && side.contains(document.activeElement)) return;
    side.classList.add("recolhida");
    if (porMouse && side.contains(document.activeElement)) document.activeElement.blur();
  }, 260); };
  const auto = () => shell.classList.contains("menu-auto");
  side.addEventListener("mouseenter", () => auto() && abrir());
  side.addEventListener("mouseleave", () => auto() && fechar(true));
  side.addEventListener("focusin", () => auto() && abrir());
  side.addEventListener("focusout", (e) => { if (auto() && !side.contains(e.relatedTarget)) fechar(false); });
  side.addEventListener("click", (e) => { if (auto() && e.target.closest(".nav a")) { clearTimeout(t); side.classList.add("recolhida"); document.activeElement?.blur?.(); } });
  $("#btn-fixar").onclick = () => {
    const novo = auto() ? "fixo" : "auto";
    try { localStorage.setItem(CHAVE_MENU, novo); } catch { /* sem armazenamento */ }
    shell.classList.toggle("menu-auto", novo === "auto");
    shell.classList.toggle("menu-fixo", novo === "fixo");
    side.classList.toggle("recolhida", novo === "auto" && !side.matches(":hover"));
    $("#btn-fixar").title = novo === "auto" ? "Manter menu aberto" : "Recolher menu automaticamente";
    window.dispatchEvent(new Event("resize"));
  };
}

/** Cartão no menu lateral com a situação do teste grátis ou do bloqueio. */
function desenharAvisoConta() {
  const c = estado.conta;
  const alvo = $("#aviso-conta"), mob = $("#aviso-conta-mob");
  if (!alvo) return;
  if (!c || c.status === "ativo") { render(alvo, ""); if (mob) render(mob, ""); return; }
  const ponto = html`<div class="aviso-mini ${c.bloqueio ? "bloq" : ""}" title="${c.bloqueio || "Teste grátis em andamento"}"></div>`;
  const dias = diasDeTeste();
  const zap = linkWhatsApp(`Olá! Estou testando o sistema na loja ${estado.empresa?.nome_fantasia || ""} e quero contratar.`);
  const gestor = ["admin", "gerente"].includes(estado.perfil?.papel);
  if (c.bloqueio) {
    render(alvo, html`${ponto}<div class="aviso-conta bloqueado"><strong>Vendas pausadas</strong><span>${c.bloqueio}</span>
      ${gestor ? html`<a class="btn sm primary block" href="#/conta">Ver planos</a>` : ""}
      ${gestor && zap ? html`<a class="btn sm block" href="${zap}" target="_blank" rel="noopener">${icone("whatsapp", 'width="16" height="16"')} Contratar</a>` : ""}</div>`);
    if (mob) render(mob, html`<span class="badge danger">Teste encerrado</span>`);
    return;
  }
  render(alvo, html`${ponto}<div class="aviso-conta"><strong>Teste grátis</strong>
    <span>${dias === 0 ? "Termina hoje" : dias === 1 ? "Falta 1 dia" : `Faltam ${dias} dias`} · ${c.vendas_teste} de 200 vendas</span>
    <div class="barra"><div style="width:${Math.min(100, ((7 - (dias ?? 7)) / 7) * 100)}%"></div></div>
    ${gestor ? html`<a class="btn sm block" href="#/conta">Ver planos</a>` : ""}</div>`);
  if (mob) render(mob, html`<span class="badge warn">Teste · ${dias}d</span>`);
}

async function navegar() {
  if (!estado.perfil) return;
  const [rota, ...params] = location.hash.replace(/^#\/?/, "").split("/");
  if (!rota || !PAGINAS[rota] || !pode(rota)) { location.hash = "#/" + rotaInicial(); return; }

  if (!$("#conteudo")) montarShell();
  $$(".nav a").forEach((a) => a.classList.toggle("ativo", a.dataset.rota === rota));
  $("#sidebar")?.classList.remove("aberta");
  document.title = `${tituloRota(rota)} · ${MARCA}`;
  window.lisDiag?.passo(`Abriu a tela ${tituloRota(rota)}`, "tela");

  atualizarConta().then(desenharAvisoConta).catch(() => {});
  try { limparPagina?.(); } catch { /* ignora */ }
  limparPagina = null;
  const alvo = $("#conteudo");
  render(alvo, carregando());
  try {
    const mod = await PAGINAS[rota]();
    limparPagina = (await mod.default(alvo, params)) || null;
  } catch (e) {
    const id = window.lisDiag?.registrar({ tipo: "erro", origem: "tela", mensagem: e.message, tecnico: { ...window.lisDiag.deErro(e).tecnico, tela: rota } })?.id;
    render(alvo, html`<div class="page"><div class="alerta">${e.message}</div>
      ${id ? html`<p style="margin-top:1rem"><button class="btn" id="ver-diag">Entender o erro</button> <button class="btn ghost" id="recarregar">Recarregar</button></p>` : ""}</div>`);
    $("#ver-diag")?.addEventListener("click", () => window.lisDiag.abrir(id));
    $("#recarregar")?.addEventListener("click", () => location.reload());
  }
}

async function iniciar() {
  if (modoRecuperacao) return telaNovaSenha(app, iniciar);
  render(app, carregando());
  try {
    const logado = await carregarContexto();
    if (!logado) return telaLogin(app, iniciar);
    if (!estado.perfil) return telaOnboarding(app, iniciar);
    montarShell();
    navegar();
  } catch (e) {
    if (ehErroDeRede(e) || /Sem internet/.test(e.message)) {
      // Sem internet e sem cópia local: não desloga, espera a conexão voltar
      render(app, html`<div class="page" style="max-width:520px;margin:10vh auto;text-align:center">
        <div class="alerta warn">${e.message}</div>
        <p class="muted small" style="margin-top:1rem">Assim que a internet voltar, o sistema abre sozinho.</p>
        <button class="btn primary" id="tentar">Tentar de novo</button> <button class="btn" id="diag">Diagnóstico</button></div>`);
      $("#tentar").onclick = iniciar;
      $("#diag").onclick = () => window.lisDiag?.abrir();
      window.addEventListener("online", iniciar, { once: true });
      return;
    }
    erro(e);
    window.lisDiag?.registrar({ tipo: "erro", origem: "inicio", mensagem: `Falha ao entrar: ${e.message}`, tecnico: window.lisDiag.deErro(e).tecnico });
    await sb.auth.signOut();
    limparEstado();
    telaLogin(app, iniciar);
  }
}

async function sair() {
  const { fila } = await import("./contingencia.js");
  if (fila().length && !(await confirmar(`Há ${fila().length} venda(s) feita(s) sem internet ainda não enviada(s). Elas ficam guardadas neste aparelho e são enviadas quando você entrar de novo com internet.`, { titulo: "Sair com vendas pendentes?", ok: "Sair mesmo assim" }))) return;
  sb.removeAllChannels?.();
  import("./aprovacoes.js").then((m) => m.pararAprovacoes()).catch(() => {});
  import("./recebimentos.js").then((m) => m.pararRecebimentos()).catch(() => {});
  await sb.auth.signOut();
  limparContextoLocal();
  limparEstado();
  location.hash = "";
  iniciar();
}

sb.auth.onAuthStateChange((evento) => {
  if (evento === "PASSWORD_RECOVERY") { modoRecuperacao = true; telaNovaSenha(app, () => { modoRecuperacao = false; iniciar(); }); }
  if (evento === "SIGNED_OUT" && estado.perfil) { limparEstado(); iniciar(); }
});
window.addEventListener("hashchange", navegar);
iniciar();
