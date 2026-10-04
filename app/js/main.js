// Ponto de entrada: autenticação, roteamento por hash e layout.
import { sb } from "./api.js";
import { estado, carregarContexto, limparEstado, pode, rotaInicial, ROTAS, PAPEIS, atualizarConta, diasDeTeste } from "./estado.js";
import { linkWhatsApp, MARCA } from "./config.js";
import { html, render, $, $$, iniciais, carregando, erro } from "./ui.js";
import { icone } from "./icons.js";
import { telaLogin, telaOnboarding, telaNovaSenha } from "./paginas/login.js";

// Carregamento sob demanda: cada tela só baixa quando é aberta.
const PAGINAS = {
  painel: () => import("./paginas/painel.js"),
  pdv: () => import("./paginas/pdv.js"),
  mesas: () => import("./paginas/mesas.js"),
  delivery: () => import("./paginas/delivery.js"),
  caixa: () => import("./paginas/caixa.js"),
  vendas: () => import("./paginas/vendas.js"),
  produtos: () => import("./paginas/produtos.js"),
  estoque: () => import("./paginas/estoque.js"),
  clientes: () => import("./paginas/clientes.js"),
  relatorios: () => import("./paginas/relatorios.js"),
  usuarios: () => import("./paginas/usuarios.js"),
  configuracoes: () => import("./paginas/configuracoes.js"),
  plataforma: () => import("./paginas/plataforma.js"),
};

const app = document.getElementById("app");
let limparPagina = null;
let modoRecuperacao = false;

function montarShell() {
  const p = estado.perfil;
  const nomeLoja = estado.empresa?.nome_fantasia || estado.empresa?.razao_social || "";
  render(app, html`
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark">${iniciais(nomeLoja).slice(0, 1)}</div>
          <div><div class="brand-name">${nomeLoja}</div><div class="brand-sub">Ponto de venda</div></div>
        </div>
        <nav class="nav" aria-label="Menu principal">
          ${Object.entries(ROTAS).filter(([r]) => pode(r)).map(([r, def]) =>
            html`<a href="#/${r}" data-rota="${r}">${icone(def.icone)}<span>${def.titulo}</span></a>`)}
        </nav>
        <div class="sidebar-foot">
          <div id="aviso-conta"></div>
          <div class="user-chip">
            <div class="avatar">${iniciais(p.nome)}</div>
            <div class="grow small"><div style="font-weight:600">${p.nome}</div><div class="muted">${PAPEIS[p.papel].nome}</div></div>
          </div>
          <button class="btn ghost block" id="btn-sair" style="justify-content:flex-start">${icone("sair", 'width="18" height="18"')} Sair</button>
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
  desenharAvisoConta();
  import("./cozinha.js").then((m) => m.iniciarCozinha()).catch(() => {});
  if (pode("delivery")) import("./avisos.js").then((m) => m.iniciarAvisos()).catch(() => {});
}

/** Cartão no menu lateral com a situação do teste grátis ou do bloqueio. */
function desenharAvisoConta() {
  const c = estado.conta;
  const alvo = $("#aviso-conta"), mob = $("#aviso-conta-mob");
  if (!alvo) return;
  if (!c || c.status === "ativo") { render(alvo, ""); if (mob) render(mob, ""); return; }
  const dias = diasDeTeste();
  const zap = linkWhatsApp(`Olá! Estou testando o sistema na loja ${estado.empresa?.nome_fantasia || ""} e quero contratar.`);
  const gestor = ["admin", "gerente"].includes(estado.perfil?.papel);
  if (c.bloqueio) {
    render(alvo, html`<div class="aviso-conta bloqueado"><strong>Vendas pausadas</strong><span>${c.bloqueio}</span>
      ${gestor ? html`<a class="btn sm primary block" href="../#planos" target="_blank" rel="noopener">Ver planos</a>` : ""}
      ${gestor && zap ? html`<a class="btn sm block" href="${zap}" target="_blank" rel="noopener">${icone("whatsapp", 'width="16" height="16"')} Contratar</a>` : ""}</div>`);
    if (mob) render(mob, html`<span class="badge danger">Teste encerrado</span>`);
    return;
  }
  render(alvo, html`<div class="aviso-conta"><strong>Teste grátis</strong>
    <span>${dias === 0 ? "Termina hoje" : dias === 1 ? "Falta 1 dia" : `Faltam ${dias} dias`} · ${c.vendas_teste} de 200 vendas</span>
    <div class="barra"><div style="width:${Math.min(100, ((7 - (dias ?? 7)) / 7) * 100)}%"></div></div>
    ${gestor ? html`<a class="btn sm block" href="../#planos" target="_blank" rel="noopener">Ver planos</a>` : ""}</div>`);
  if (mob) render(mob, html`<span class="badge warn">Teste · ${dias}d</span>`);
}

async function navegar() {
  if (!estado.perfil) return;
  const [rota, ...params] = location.hash.replace(/^#\/?/, "").split("/");
  if (!rota || !PAGINAS[rota] || !pode(rota)) { location.hash = "#/" + rotaInicial(); return; }

  if (!$("#conteudo")) montarShell();
  $$(".nav a").forEach((a) => a.classList.toggle("ativo", a.dataset.rota === rota));
  $("#sidebar")?.classList.remove("aberta");
  document.title = `${ROTAS[rota].titulo} · ${MARCA}`;

  atualizarConta().then(desenharAvisoConta).catch(() => {});
  try { limparPagina?.(); } catch { /* ignora */ }
  limparPagina = null;
  const alvo = $("#conteudo");
  render(alvo, carregando());
  try {
    const mod = await PAGINAS[rota]();
    limparPagina = (await mod.default(alvo, params)) || null;
  } catch (e) {
    console.error(e);
    render(alvo, html`<div class="page"><div class="alerta">${e.message}</div></div>`);
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
    erro(e);
    await sb.auth.signOut();
    limparEstado();
    telaLogin(app, iniciar);
  }
}

async function sair() {
  sb.removeAllChannels?.();
  await sb.auth.signOut();
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
