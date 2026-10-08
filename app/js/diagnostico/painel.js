// =====================================================================
// Painel de diagnóstico (visual e interativo)
// ---------------------------------------------------------------------
//  Agora        → check-up do aparelho e do servidor, com semáforo geral
//  Problemas    → erros agrupados por causa, cada um com a solução
//  Linha do tempo → tudo o que aconteceu, com a trilha de cliques antes
//  Lojas        → (fornecedor/gerente) erros enviados pelos aparelhos
// Cada problema abre um cartão didático: o que aconteceu, por quê,
// o que o operador faz, o que o técnico faz, botões que resolvem,
// trecho do código e detalhes técnicos.
// Não depende do resto do sistema para abrir (usa CSS e HTML próprios).
// =====================================================================
import { diagnosticar, AREAS, GRAVIDADES, PROBLEMAS } from "./catalogo.js";
import { rodarChecagens, resumoGeral, LISTA } from "./checagens.js";
import { CSS } from "./estilo.js";
import { testarVelocidade, historico, REQUISITOS } from "./velocidade.js";

const D = () => window.lisDiag;
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const hora = (t) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dataHora = (t) => new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
function relativo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "agora há pouco";
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dia(s)`;
}

// ---------- Ícones (traço simples, herdam a cor) ----------
const P = {
  internet: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a14.5 14.5 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/>',
  servidor: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  login: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  permissao: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  banco: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  regra: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
  dados: '<path d="M4 6h16M4 12h10M4 18h7"/><path d="M17 15l4 4M21 15l-4 4"/>',
  fiscal: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  pagamento: '<path d="M12 2l4 4-4 4-4-4zM12 14l4 4-4 4-4-4zM2 12l4-4 4 4-4 4zM14 12l4-4 4 4-4 4z"/>',
  impressora: '<path d="M7 9V3h10v6M7 17H4v-7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v7h-3"/><rect x="7" y="14" width="10" height="7"/>',
  balanca: '<path d="M12 4v16M5 20h14M5 8h14M5 8l-3 7a3 3 0 0 0 6 0zM19 8l-3 7a3 3 0 0 0 6 0z"/>',
  offline: '<path d="M2 2l20 20M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4.5-2.6M14.5 10a10 10 0 0 1 4.5 2.5"/><circle cx="12" cy="19.5" r="1"/>',
  aparelho: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  atualizacao: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
  codigo: '<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  fechar: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  baixar: '<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>',
  copiar: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  voltar: '<path d="M15 5l-7 7 7 7"/>',
  seta: '<path d="M9 5l7 7-7 7"/>',
  lojas: '<path d="M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6"/>',
  clique: '<path d="M9 9l11 4-5 2-2 5z"/><path d="M5 3v3M3 5h3M5 12l-2 1"/>',
  tela: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 8h18"/>',
  alerta: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5h.01"/>',
  ok: '<path d="M5 12l5 5L20 7"/>',
  ajuda: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13.5" width="4" height="6.5" rx="1.5"/><rect x="17.5" y="13.5" width="4" height="6.5" rx="1.5"/>',
};
const ic = (n, t = 18) => `<svg class="dg-ic" width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || P.alerta}</svg>`;

const STATUS = {
  ok: { nome: "OK", cls: "ok" }, aviso: { nome: "Atenção", cls: "aviso" }, erro: { nome: "Problema", cls: "erro" },
  info: { nome: "Info", cls: "info" }, pulado: { nome: "Não testado", cls: "info" }, rodando: { nome: "Testando…", cls: "rodando" },
};
const corGrav = (g) => ({ critica: "erro", alta: "erro", media: "aviso", baixa: "info", info: "info" })[g] || "info";

// ---------- Estado do painel ----------
let raiz = null, corpo = null, aba = "agora", checks = null, rodando = false, filtros = { grav: "todas", area: "todas", busca: "", trilha: false };
let remoto = null, ouvinte = null;

export function abrirPainel({ eventoId = null, motivo = null, alvo = null } = {}) {
  injetarCss();
  if (raiz?.isConnected) { if (eventoId) abrirEvento(eventoId); else raiz.scrollIntoView?.(); return () => fecharPainel(); }
  raiz = document.createElement("div");
  raiz.className = "diag-raiz" + (alvo ? " dg-embutido" : " dg-sobre");
  raiz.setAttribute("role", alvo ? "region" : "dialog");
  raiz.setAttribute("aria-label", "Diagnóstico do sistema");
  if (alvo) { alvo.innerHTML = ""; alvo.appendChild(raiz); } else document.body.appendChild(raiz);
  D()?.marcarVistos();
  D()?.passo("Abriu o diagnóstico", "sistema");
  desenharMoldura(motivo, !!alvo);
  aba = "agora";
  desenharAba();
  testar();
  if (eventoId) abrirEvento(eventoId);
  if (!alvo) {
    const tecla = (e) => { if (e.key === "Escape" && !raiz.querySelector(".dg-cartao-fundo")) fecharPainel(); };
    document.addEventListener("keydown", tecla);
    raiz._tecla = tecla;
  }
  ouvinte = D()?.ouvir(() => { if (aba !== "agora") desenharAba(); else desenharHeroi(); });
  return () => fecharPainel();
}

export function fecharPainel() {
  if (!raiz) return;
  if (raiz._tecla) document.removeEventListener("keydown", raiz._tecla);
  ouvinte?.(); ouvinte = null;
  if (raiz.classList.contains("dg-sobre")) raiz.remove();
  raiz = null;
}

function injetarCss() {
  if (document.getElementById("diag-css")) return;
  const s = document.createElement("style");
  s.id = "diag-css"; s.textContent = CSS;
  document.head.appendChild(s);
}

function ctxTexto() {
  const c = D()?.contexto() || {};
  return [c.loja, c.usuario && `${c.usuario}${c.papel ? " (" + c.papel + ")" : ""}`, c.aparelho, `v${D()?.versao || "?"}`].filter(Boolean).join(" · ");
}

function desenharMoldura(motivo, embutido) {
  raiz.innerHTML = `
    <div class="dg-janela">
      <header class="dg-topo">
        <div class="dg-titulo">
          <div class="dg-logo">${ic("regra", 22)}</div>
          <div><h1>Diagnóstico</h1><p class="dg-sub">${esc(ctxTexto())}</p></div>
        </div>
        <div class="dg-acoes-topo">
          <button class="dg-btn" data-a="testar">${ic("play", 16)}<span>Testar tudo</span></button>
          <button class="dg-btn" data-a="resumo" title="Copiar um resumo para colar no WhatsApp">${ic("copiar", 16)}<span>Copiar resumo</span></button>
          <button class="dg-btn" data-a="ajuda" title="Abrir um chamado: você recebe um código para falar com o suporte">${ic("ajuda", 16)}<span>Pedir ajuda</span></button>
          <button class="dg-btn dg-pri" data-a="relatorio" title="Arquivo completo para enviar ao suporte">${ic("baixar", 16)}<span>Gerar relatório</span></button>
          ${embutido ? "" : `<button class="dg-btn dg-icone" data-a="fechar" aria-label="Fechar">${ic("fechar", 18)}</button>`}
        </div>
      </header>
      ${motivo === "inicio" ? `<div class="dg-faixa erro">${ic("alerta")}<div><strong>O sistema não abriu sozinho.</strong> Este painel abriu automaticamente para mostrar o motivo. Veja abaixo o que está vermelho.</div></div>` : ""}
      ${motivo === "travado" ? `<div class="dg-faixa aviso">${ic("alerta")}<div><strong>O sistema está demorando para carregar.</strong> Veja abaixo se é internet, servidor ou login.</div></div>` : ""}
      <section class="dg-heroi" id="dg-heroi"></section>
      <nav class="dg-abas" role="tablist">
        <button role="tab" data-aba="agora">Check-up agora</button>
        <button role="tab" data-aba="problemas">Problemas <span class="dg-cont" id="dg-cont-p"></span></button>
        <button role="tab" data-aba="velocidade">Velocidade da internet</button>
        <button role="tab" data-aba="tempo">Linha do tempo</button>
        <button role="tab" data-aba="lojas" id="dg-aba-lojas" hidden>Lojas (remoto)</button>
        <button role="tab" data-aba="manual">Guia de problemas</button>
      </nav>
      <main class="dg-corpo" id="dg-corpo"></main>
      <div class="dg-avisos" id="dg-avisos" aria-live="polite"></div>
    </div>`;
  corpo = raiz.querySelector("#dg-corpo");
  raiz.querySelectorAll("[data-aba]").forEach((b) => (b.onclick = () => { aba = b.dataset.aba; desenharAba(); }));
  raiz.querySelector(".dg-topo").addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "fechar") fecharPainel();
    if (a === "testar") { aba = "agora"; desenharAba(); testar(); }
    if (a === "resumo") copiarResumo();
    if (a === "relatorio") gerarRelatorio();
    if (a === "ajuda") import("../suporte.js").then((m) => m.pedirAjuda({ app: location.pathname.includes("/garcom") ? "garcom" : "pdv" }))
      .catch(() => aviso("Não foi possível abrir o pedido de ajuda agora. Chame o suporte pelo WhatsApp.", "erro"));
  });
  if (!embutido) raiz.addEventListener("click", (e) => { if (e.target === raiz) fecharPainel(); });
  // A aba remota aparece para o fornecedor e para gerente/admin (com a migração 017)
  import("../estado.js").then(({ estado }) => {
    if (estado?.adminPlataforma || ["admin", "gerente"].includes(estado?.perfil?.papel)) raiz?.querySelector("#dg-aba-lojas")?.removeAttribute("hidden");
  }).catch(() => {});
}

function aviso(msg, tipo = "") {
  const box = raiz?.querySelector("#dg-avisos");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "dg-aviso " + tipo; el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------- Herói: o semáforo geral ----------
function problemasAgrupados(horas = 24) {
  const evs = (D()?.eventos() || []).filter((e) => e.tipo !== "info" && Date.now() - e.em < horas * 3600e3);
  const grupos = new Map();
  for (const ev of evs) {
    const d = diagnosticar(ev);
    const g = grupos.get(d.id) || { d, eventos: [], vezes: 0, ultimo: 0 };
    g.eventos.push(ev); g.vezes += ev.vezes || 1; g.ultimo = Math.max(g.ultimo, ev.ultimo_em || ev.em);
    if ((GRAVIDADES[d.gravidade]?.peso || 0) > (GRAVIDADES[g.d.gravidade]?.peso || 0)) g.d = d;
    grupos.set(d.id, g);
  }
  return [...grupos.values()].sort((a, b) => (GRAVIDADES[b.d.gravidade].peso - GRAVIDADES[a.d.gravidade].peso) || (b.ultimo - a.ultimo));
}

function desenharHeroi() {
  const el = raiz?.querySelector("#dg-heroi");
  if (!el) return;
  const grupos = problemasAgrupados(2);
  const graves = grupos.filter((g) => ["critica", "alta"].includes(g.d.gravidade));
  const cont = problemasAgrupados(24).filter((g) => g.d.gravidade !== "info").length;
  const c = raiz.querySelector("#dg-cont-p"); if (c) c.textContent = cont || "";
  const rs = checks && resumoGeral(checks);
  const checksErro = (checks || []).filter((x) => x.status === "erro");
  let status = "ok", titulo = "Tudo funcionando", texto = "Nenhum problema encontrado no check-up nem nas últimas 2 horas.", principal = null;
  if (rodando && !checks?.some((x) => x.status !== "rodando")) { status = "rodando"; titulo = "Fazendo o check-up…"; texto = "Testando internet, servidor, login, banco, impressora e balança."; }
  if (rs?.aviso || grupos.length) { status = "aviso"; titulo = "Funcionando, com pontos de atenção"; texto = `${rs?.aviso || 0} aviso(s) no check-up · ${grupos.length} tipo(s) de problema nas últimas 2 h.`; }
  if (checksErro.length || graves.length) {
    status = "erro";
    const ch = checksErro.find((x) => x.problema);
    principal = graves[0] ? { tipo: "grupo", g: graves[0] } : ch ? { tipo: "check", c: ch } : null;
    titulo = principal?.tipo === "grupo" ? principal.g.d.titulo : principal?.tipo === "check" ? `${ch.titulo}: ${ch.valor}` : `${checksErro[0].titulo}: ${checksErro[0].valor}`;
    texto = principal?.tipo === "grupo" ? `${principal.g.vezes}× · último ${relativo(principal.g.ultimo)} · ${AREAS[principal.g.d.area]?.nome || ""}` : (checksErro[0]?.detalhe || "").split("\n")[0];
  }
  el.className = "dg-heroi " + status;
  el.innerHTML = `
    <div class="dg-semaforo" aria-hidden="true"><span class="r"></span><span class="a"></span><span class="v"></span></div>
    <div class="dg-heroi-txt">
      <div class="dg-heroi-rot">${status === "erro" ? "Causa mais provável agora" : status === "aviso" ? "Situação" : status === "rodando" ? "Aguarde" : "Situação"}</div>
      <h2>${esc(titulo)}</h2>
      <p>${esc(texto)}</p>
      ${rs ? `<div class="dg-placar"><span class="ok">${rs.ok} ok</span><span class="aviso">${rs.aviso} atenção</span><span class="erro">${rs.erro} problema(s)</span></div>` : ""}
    </div>
    ${principal ? `<button class="dg-btn dg-pri dg-grande" id="dg-ver-principal">Como resolver ${ic("seta", 16)}</button>` : ""}`;
  el.querySelector("#dg-ver-principal")?.addEventListener("click", () => {
    if (principal.tipo === "grupo") abrirCartao(principal.g.eventos[principal.g.eventos.length - 1], principal.g);
    else abrirProblema(principal.c.problema, principal.c);
  });
}

// ---------- Abas ----------
function desenharAba() {
  if (!raiz) return;
  raiz.querySelectorAll("[data-aba]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.aba === aba)));
  desenharHeroi();
  ({ agora: abaAgora, velocidade: abaVelocidade, problemas: abaProblemas, tempo: abaTempo, lojas: abaLojas, manual: abaManual })[aba]();
}

async function testar() {
  if (rodando) return;
  rodando = true;
  try {
    checks = await rodarChecagens((res) => { checks = res; if (aba === "agora") abaAgora(); desenharHeroi(); });
  } finally { rodando = false; }
  if (raiz) { desenharHeroi(); if (aba === "agora") abaAgora(); }
  const erros = checks.filter((x) => x.status === "erro");
  D()?.registrar({ tipo: "info", origem: "sistema", mensagem: `Check-up: ${erros.length ? erros.map((x) => x.titulo + " (" + x.valor + ")").join(", ") : "tudo ok"}`, tecnico: { checagens: checks.map(({ id, status, valor }) => ({ id, status, valor })) } });
}

function abaAgora() {
  const res = checks || LISTA.map((x) => ({ ...x, status: "rodando" }));
  const grupos = [...new Set(res.map((x) => x.grupo))];
  corpo.innerHTML = `<p class="dg-intro">Cada cartão é um teste feito agora neste aparelho. <strong>Verde</strong> está bom, <strong>amarelo</strong> merece atenção e <strong>vermelho</strong> é a causa provável do problema — toque nele para ver como resolver.</p>
    <div class="dg-grade">${grupos.map((g) => `
      <div class="dg-grupo"><h3>${esc(g)}</h3>
        ${res.filter((x) => x.grupo === g).map((x) => `
          <button class="dg-check ${STATUS[x.status]?.cls || ""} ${x.problema ? "clicavel" : ""}" data-check="${x.id}" ${x.problema ? "" : "tabindex='-1'"}>
            <span class="dg-luz" aria-label="${STATUS[x.status]?.nome || ""}"></span>
            <span class="dg-check-txt">
              <span class="dg-check-tit">${esc(x.titulo)}</span>
              <span class="dg-check-val">${esc(x.valor || STATUS[x.status]?.nome || "")}</span>
              ${x.detalhe ? `<span class="dg-check-det">${esc(x.detalhe)}</span>` : ""}
              ${x.barra != null ? `<span class="dg-barra"><span style="width:${Math.min(100, x.barra)}%"></span></span>` : ""}
            </span>
            ${x.problema && x.status !== "ok" ? `<span class="dg-check-ir">Resolver ${ic("seta", 14)}</span>` : ""}
          </button>`).join("")}
      </div>`).join("")}</div>`;
  corpo.querySelectorAll(".dg-check.clicavel").forEach((b) => (b.onclick = () => {
    const c = res.find((x) => x.id === b.dataset.check);
    if (c?.problema && c.status !== "ok") abrirProblema(c.problema, c);
  }));
}

function abaProblemas() {
  const grupos = problemasAgrupados(24 * 7).filter((g) => g.d.gravidade !== "info");
  if (!grupos.length) { corpo.innerHTML = vazio("Nenhum problema registrado neste aparelho nos últimos 7 dias.", "ok"); return; }
  corpo.innerHTML = `<p class="dg-intro">Erros dos últimos 7 dias <strong>agrupados pela causa</strong>. O número mostra quantas vezes aconteceu.</p>
    <div class="dg-lista">${grupos.map((g, i) => `
      <button class="dg-prob" data-i="${i}">
        <span class="dg-prob-ic" style="--c:${AREAS[g.d.area]?.cor || "#64748B"}">${ic(g.d.area, 22)}</span>
        <span class="dg-prob-txt">
          <span class="dg-prob-tit">${esc(g.d.titulo)}</span>
          <span class="dg-prob-sub">${esc(AREAS[g.d.area]?.nome || "")} · último ${relativo(g.ultimo)} · “${esc(g.eventos[g.eventos.length - 1].mensagem.slice(0, 90))}”</span>
        </span>
        <span class="dg-selo ${corGrav(g.d.gravidade)}">${GRAVIDADES[g.d.gravidade]?.nome}</span>
        <span class="dg-vezes">${g.vezes}×</span>
        ${ic("seta", 16)}
      </button>`).join("")}</div>`;
  corpo.querySelectorAll(".dg-prob").forEach((b) => (b.onclick = () => { const g = grupos[+b.dataset.i]; abrirCartao(g.eventos[g.eventos.length - 1], g); }));
}

function abaTempo() {
  const evs = (D()?.eventos() || []).slice().reverse();
  const tri = filtros.trilha ? (D()?.trilha() || []).map((t) => ({ ...t, _trilha: true })) : [];
  let itens = [...evs.map((e) => ({ ...e, _d: diagnosticar(e) })), ...tri].sort((a, b) => b.em - a.em);
  itens = itens.filter((x) => {
    if (x._trilha) return !filtros.busca || x.texto.toLowerCase().includes(filtros.busca);
    if (filtros.grav !== "todas" && (filtros.grav === "graves" ? !["critica", "alta"].includes(x._d.gravidade) : x._d.gravidade !== filtros.grav)) return false;
    if (filtros.area !== "todas" && x._d.area !== filtros.area) return false;
    if (filtros.busca && !(`${x.mensagem} ${x._d.titulo}`.toLowerCase().includes(filtros.busca))) return false;
    return true;
  }).slice(0, 400);
  const areasUsadas = [...new Set(evs.map((e) => diagnosticar(e).area))];
  corpo.innerHTML = `
    <div class="dg-filtros">
      <div class="dg-chips">${[["todas", "Tudo"], ["graves", "Só graves"], ["media", "Médios"], ["baixa", "Avisos"], ["info", "Info"]].map(([v, n]) => `<button class="dg-chip ${filtros.grav === v ? "on" : ""}" data-grav="${v}">${n}</button>`).join("")}</div>
      <select class="dg-input" id="dg-f-area"><option value="todas">Todas as áreas</option>${areasUsadas.map((a) => `<option value="${a}" ${filtros.area === a ? "selected" : ""}>${esc(AREAS[a]?.nome || a)}</option>`).join("")}</select>
      <input class="dg-input" id="dg-f-busca" type="search" placeholder="Buscar…" value="${esc(filtros.busca)}">
      <label class="dg-chk"><input type="checkbox" id="dg-f-trilha" ${filtros.trilha ? "checked" : ""}> Mostrar cliques e telas</label>
      <button class="dg-btn dg-peq" id="dg-limpar" title="Apaga o histórico do diagnóstico deste aparelho (não mexe em vendas)">Limpar histórico</button>
    </div>
    ${itens.length ? `<ol class="dg-tempo">${itens.map((x, i) => {
      const dia = new Date(x.em).toLocaleDateString("pt-BR");
      const diaAnt = i ? new Date(itens[i - 1].em).toLocaleDateString("pt-BR") : null;
      const sep = dia !== diaAnt ? `<li class="dg-dia">${dia === new Date().toLocaleDateString("pt-BR") ? "Hoje" : dia}</li>` : "";
      if (x._trilha) return sep + `<li class="dg-t-passo"><span class="dg-t-hora">${hora(x.em)}</span><span class="dg-t-pino"></span><span>${ic(x.tipo === "tela" ? "tela" : x.tipo === "rede" ? "internet" : "clique", 14)} ${esc(x.texto)}${x.vezes > 1 ? ` <em>×${x.vezes}</em>` : ""}</span></li>`;
      return sep + `<li class="dg-t-ev ${corGrav(x._d.gravidade)}"><span class="dg-t-hora">${hora(x.em)}</span><span class="dg-t-pino"></span>
        <button class="dg-t-cart" data-id="${x.id}">
          <span class="dg-t-tit">${ic(x._d.area, 16)} ${esc(x._d.titulo)} ${x.vezes > 1 ? `<span class="dg-vezes">${x.vezes}×</span>` : ""} ${x.mostrado ? `<span class="dg-tag">viu na tela</span>` : ""}</span>
          <span class="dg-t-msg">${esc(x.mensagem)}</span>
          <span class="dg-t-meta">${esc(x.contexto?.rota || "")} · ${esc(x.origem)}${x.contexto?.online === false ? " · sem internet" : ""}</span>
        </button></li>`;
    }).join("")}</ol>` : vazio("Nada registrado com esses filtros.")}`;
  corpo.querySelectorAll("[data-grav]").forEach((b) => (b.onclick = () => { filtros.grav = b.dataset.grav; abaTempo(); }));
  corpo.querySelector("#dg-f-area").onchange = (e) => { filtros.area = e.target.value; abaTempo(); };
  const busca = corpo.querySelector("#dg-f-busca");
  busca.oninput = () => { clearTimeout(busca._t); busca._t = setTimeout(() => { filtros.busca = busca.value.toLowerCase().trim(); abaTempo(); corpo.querySelector("#dg-f-busca")?.focus(); }, 250); };
  corpo.querySelector("#dg-f-trilha").onchange = (e) => { filtros.trilha = e.target.checked; abaTempo(); };
  corpo.querySelector("#dg-limpar").onclick = () => { if (confirm("Apagar o histórico de diagnóstico deste aparelho? (vendas e configurações não são afetadas)")) { D()?.limparTudo(); abaTempo(); desenharHeroi(); } };
  corpo.querySelectorAll(".dg-t-cart").forEach((b) => (b.onclick = () => abrirEvento(b.dataset.id)));
}

async function abaLojas() {
  corpo.innerHTML = `<p class="dg-intro">Erros que os aparelhos das lojas enviaram ao servidor. Você vê o problema <strong>antes de ir até o cliente</strong>.</p>
    <div class="dg-filtros"><select class="dg-input" id="dg-horas">${[[24, "Últimas 24 h"], [72, "Últimos 3 dias"], [168, "Últimos 7 dias"]].map(([v, n]) => `<option value="${v}" ${(remoto?.horas || 24) === v ? "selected" : ""}>${n}</option>`).join("")}</select>
    <button class="dg-btn dg-peq" id="dg-rec">Atualizar</button></div><div id="dg-remoto">${carregandoHtml()}</div>`;
  corpo.querySelector("#dg-horas").onchange = (e) => { remoto = { horas: +e.target.value }; abaLojas(); };
  corpo.querySelector("#dg-rec").onclick = () => abaLojas();
  const alvo = corpo.querySelector("#dg-remoto");
  try {
    const { sb } = await import("../api.js");
    const horas = remoto?.horas || 24;
    const { data, error } = await sb.rpc("diagnostico_recentes", { p_horas: horas });
    if (error) throw error;
    remoto = { horas, dados: (data || []).map(paraEvento) };
    desenharRemoto(alvo);
  } catch (e) {
    alvo.innerHTML = vazio(/diagnostico_recentes|PGRST202|schema cache/.test(e.message || "") ? "Rode supabase/migrations/017_diagnostico.sql no Supabase para receber os erros das lojas." : `Não foi possível carregar: ${e.message}`, "aviso");
  }
}

function paraEvento(x) {
  return { id: "r" + x.id, em: new Date(x.ocorrido_em).getTime(), ultimo_em: new Date(x.ocorrido_em).getTime(), vezes: x.vezes || 1, tipo: "erro", origem: x.origem || "?",
    mensagem: x.mensagem, gravidade: x.gravidade, tecnico: x.tecnico || {}, trilha: x.trilha || [], versao: x.versao_app,
    contexto: { loja: x.loja, usuario: x.usuario, aparelho: x.aparelho_nome, rota: x.rota, navegador: x.navegador }, remoto: true };
}

function desenharRemoto(alvo) {
  const evs = remoto.dados;
  if (!evs.length) { alvo.innerHTML = vazio("Nenhum erro enviado pelas lojas neste período. 🎉", "ok"); return; }
  const porLoja = new Map();
  for (const ev of evs) { const k = ev.contexto.loja || "Sem loja"; (porLoja.get(k) || porLoja.set(k, []).get(k)).push(ev); }
  alvo.innerHTML = [...porLoja.entries()].sort((a, b) => b[1].length - a[1].length).map(([loja, lista], li) => {
    const grupos = new Map();
    lista.forEach((ev) => { const d = diagnosticar(ev); const g = grupos.get(d.id) || { d, eventos: [], vezes: 0, ultimo: 0 }; g.eventos.push(ev); g.vezes += ev.vezes; g.ultimo = Math.max(g.ultimo, ev.em); grupos.set(d.id, g); });
    const gs = [...grupos.values()].sort((a, b) => GRAVIDADES[b.d.gravidade].peso - GRAVIDADES[a.d.gravidade].peso || b.ultimo - a.ultimo);
    const pior = gs[0]?.d.gravidade;
    return `<details class="dg-loja" ${li < 3 ? "open" : ""}><summary><span class="dg-luz ${corGrav(pior)}"></span><strong>${esc(loja)}</strong><span class="dg-loja-meta">${gs.length} tipo(s) · ${lista.reduce((s, e) => s + e.vezes, 0)} ocorrência(s) · último ${relativo(Math.max(...lista.map((e) => e.em)))}</span></summary>
      <div class="dg-lista">${gs.map((g, gi) => `<button class="dg-prob" data-l="${li}" data-g="${gi}">
        <span class="dg-prob-ic" style="--c:${AREAS[g.d.area]?.cor || "#64748B"}">${ic(g.d.area, 20)}</span>
        <span class="dg-prob-txt"><span class="dg-prob-tit">${esc(g.d.titulo)}</span><span class="dg-prob-sub">${esc([...new Set(g.eventos.map((e) => e.contexto.aparelho).filter(Boolean))].join(", "))} · ${relativo(g.ultimo)}</span></span>
        <span class="dg-selo ${corGrav(g.d.gravidade)}">${GRAVIDADES[g.d.gravidade]?.nome}</span><span class="dg-vezes">${g.vezes}×</span></button>`).join("")}</div></details>`;
  }).join("");
  const lojas = [...porLoja.entries()].sort((a, b) => b[1].length - a[1].length);
  alvo.querySelectorAll(".dg-prob").forEach((b) => (b.onclick = () => {
    const lista = lojas[+b.dataset.l][1];
    const grupos = new Map();
    lista.forEach((ev) => { const d = diagnosticar(ev); const g = grupos.get(d.id) || { d, eventos: [], vezes: 0, ultimo: 0 }; g.eventos.push(ev); g.vezes += ev.vezes; g.ultimo = Math.max(g.ultimo, ev.em); grupos.set(d.id, g); });
    const g = [...grupos.values()].sort((a, b) => GRAVIDADES[b.d.gravidade].peso - GRAVIDADES[a.d.gravidade].peso || b.ultimo - a.ultimo)[+b.dataset.g];
    abrirCartao(g.eventos[0], g);
  }));
}

function abaManual() {
  const porArea = {};
  PROBLEMAS.forEach((p) => (porArea[p.area] ||= []).push(p));
  corpo.innerHTML = `<p class="dg-intro">Todos os problemas que o sistema sabe reconhecer, com a solução. Use para treinar a equipe ou consultar quando ligarem.</p>
    <input class="dg-input dg-largo" id="dg-m-busca" type="search" placeholder="Ex.: impressora, PIX, caixa fechado, lento…">
    <div id="dg-m-lista">${Object.entries(porArea).map(([a, ps]) => `<div class="dg-m-area" data-area="${a}"><h3 style="--c:${AREAS[a]?.cor}">${ic(a, 18)} ${esc(AREAS[a]?.nome || a)}</h3>
      <div class="dg-m-itens">${ps.map((p) => `<button class="dg-m-item" data-p="${p.id}" data-busca="${esc((p.titulo + " " + AREAS[a]?.nome + " " + (typeof p.explicacao === "string" ? p.explicacao : "")).toLowerCase())}">
        <span class="dg-selo ${corGrav(p.gravidade)}">${GRAVIDADES[p.gravidade]?.nome}</span>${esc(p.titulo)}</button>`).join("")}</div></div>`).join("")}</div>`;
  corpo.querySelectorAll(".dg-m-item").forEach((b) => (b.onclick = () => abrirProblema(b.dataset.p)));
  corpo.querySelector("#dg-m-busca").oninput = (e) => {
    const t = e.target.value.toLowerCase().trim();
    corpo.querySelectorAll(".dg-m-item").forEach((b) => (b.hidden = t && !b.dataset.busca.includes(t)));
    corpo.querySelectorAll(".dg-m-area").forEach((s) => (s.hidden = ![...s.querySelectorAll(".dg-m-item")].some((b) => !b.hidden)));
  };
}

// ---------- Velocidade da internet ----------
let vel = { rodando: false, fase: null, valor: null, fracao: 0, res: null };
const FASES = { ping: "Medindo resposta", download: "Medindo download", upload: "Medindo upload", servidor: "Testando o servidor do sistema", fim: "Pronto" };
// Escala do medidor (Mbps), não linear como os medidores de velocidade conhecidos
const MARCAS = [0, 1, 5, 10, 20, 50, 100, 250, 500];
function anguloMbps(v) {
  if (!(v > 0)) return 0;
  for (let i = 1; i < MARCAS.length; i++) if (v <= MARCAS[i]) return ((i - 1) + (v - MARCAS[i - 1]) / (MARCAS[i] - MARCAS[i - 1])) / (MARCAS.length - 1);
  return 1;
}
const ponto = (f, r) => { const a = Math.PI * (1 - f); return [120 + r * Math.cos(a), 120 - r * Math.sin(a)]; };
function arco(f0, f1, r) {
  const [x0, y0] = ponto(f0, r), [x1, y1] = ponto(f1, r);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
function medidorSvg() {
  return `<svg viewBox="0 0 240 140" class="dg-medidor" aria-hidden="true">
    <path d="${arco(0, 1, 96)}" class="dg-m-fundo"/>
    <path d="${arco(0, 0.001, 96)}" class="dg-m-valor" id="dg-m-arco"/>
    ${MARCAS.map((m, i) => { const [x, y] = ponto(i / (MARCAS.length - 1), 74); return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" class="dg-m-marca">${m}</text>`; }).join("")}
    <line x1="120" y1="120" x2="120" y2="40" class="dg-m-ponteiro" id="dg-m-ponteiro" style="transform:rotate(-90deg)"/>
    <circle cx="120" cy="120" r="7" class="dg-m-centro"/>
  </svg>`;
}
const fmt = (v, u, casas = 0) => (v == null ? "—" : `${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas })}<small>${u}</small>`);
const corMetrica = (v, bom, ruim, menorMelhor = true) => (v == null ? "" : menorMelhor ? (v <= bom ? "ok" : v <= ruim ? "aviso" : "erro") : (v >= bom ? "ok" : v >= ruim ? "aviso" : "erro"));

function abaVelocidade() {
  const r = vel.res, i = r?.internet || {}, s = r?.servidor || {}, v = r?.veredito;
  const h = historico();
  const R = REQUISITOS;
  const barra = (ms, max) => `<span class="dg-cmp-barra"><span style="width:${ms == null ? 0 : Math.max(3, Math.min(100, (ms / max) * 100))}%"></span></span>`;
  const maxPing = Math.max(300, i.ping || 0, s.ping || 0);
  corpo.innerHTML = `<p class="dg-intro">Mede a internet da loja contra um servidor neutro e depois o servidor do sistema. Assim fica claro se a lentidão é <strong>da internet</strong> ou <strong>do sistema</strong>. Usa cerca de 30 a 80 MB de dados.</p>
    <div class="dg-vel">
      <section class="dg-vel-medidor">
        ${medidorSvg()}
        <div class="dg-m-leitura"><span id="dg-m-num">${vel.rodando ? "…" : i.download ?? "0"}</span><small id="dg-m-un">Mbps</small></div>
        <div class="dg-m-fase" id="dg-m-fase">${vel.rodando ? FASES[vel.fase] || "Preparando" : r ? "Download medido" : "Pronto para testar"}</div>
        <div class="dg-m-prog"><span id="dg-m-prog" style="width:${vel.rodando ? Math.round(vel.fracao * 100) : r ? 100 : 0}%"></span></div>
        <button class="dg-btn dg-pri dg-grande" id="dg-vel-ir" ${vel.rodando ? "disabled" : ""}>${vel.rodando ? `<span class="dg-giro"></span> Testando…` : `${ic("play", 16)} ${r ? "Testar de novo" : "Iniciar teste"}`}</button>
      </section>
      <section class="dg-vel-num">
        <div class="dg-metrica ${corMetrica(i.download, R.download * 5, R.download, false)}"><span>Download</span><b>${fmt(i.download, " Mbps", 1)}</b><em>mínimo ${R.download} Mbps</em></div>
        <div class="dg-metrica ${corMetrica(i.upload, R.upload * 5, R.upload, false)}"><span>Upload</span><b>${fmt(i.upload, " Mbps", 1)}</b><em>mínimo ${R.upload} Mbps</em></div>
        <div class="dg-metrica ${corMetrica(i.ping, R.ping / 2, R.ping * 1.5)}"><span>Resposta (ping)</span><b>${fmt(i.ping, " ms")}</b><em>ideal até ${R.ping} ms</em></div>
        <div class="dg-metrica ${corMetrica(i.jitter, R.jitter / 2, R.jitter * 2)}"><span>Variação (jitter)</span><b>${fmt(i.jitter, " ms")}</b><em>estável até ${R.jitter} ms</em></div>
        <div class="dg-metrica ${corMetrica(i.perda, 0, R.perda)}"><span>Perda</span><b>${fmt(i.perda, "%")}</b><em>ideal 0%</em></div>
        <div class="dg-metrica ${corMetrica(s.ping, R.ping, 600)}"><span>Servidor do sistema</span><b>${s.ok === false ? "sem resposta" : fmt(s.ping, " ms")}</b><em>${s.perda ? s.perda + "% perdidos" : "Supabase"}</em></div>
      </section>
    </div>
    ${r ? `<section class="dg-cmp">
        <h3>${ic("internet", 18)} Internet × sistema (tempo de resposta)</h3>
        <div class="dg-cmp-linha"><span>Internet (servidor neutro)</span>${barra(i.ping, maxPing)}<b>${i.ping ?? "—"} ms</b></div>
        <div class="dg-cmp-linha sist"><span>Servidor do sistema</span>${barra(s.ping, maxPing)}<b>${s.ok === false ? "sem resposta" : (s.ping ?? "—") + " ms"}</b></div>
      </section>
      <section class="dg-veredito ${v.tipo}">
        <div class="dg-ver-ic">${ic(v.tipo === "ok" ? "ok" : v.culpa === "internet" ? "internet" : "servidor", 26)}</div>
        <div><div class="dg-heroi-rot">${v.culpa === "internet" ? "Não é o sistema" : v.culpa === "sistema" ? "É do lado do sistema" : "Conclusão"}</div>
          <h2>${esc(v.titulo)}</h2><p>${esc(v.texto)}</p>
          ${v.dicas?.length ? `<ol>${v.dicas.map((d) => `<li>${esc(d)}</li>`).join("")}</ol>` : ""}
          ${r.avisos?.length ? `<p class="dg-nota">${r.avisos.map(esc).join(" ")}</p>` : ""}</div>
      </section>` : ""}
    ${h.length ? `<section class="dg-sec"><h3>${ic("tela", 18)} Testes anteriores neste aparelho</h3>
      <div class="dg-hist">${h.map((x) => `<div class="dg-hist-l"><span>${dataHora(x.em)}</span><span>↓ <b>${x.internet.download ?? "—"}</b> Mbps</span><span>↑ <b>${x.internet.upload ?? "—"}</b> Mbps</span><span><b>${x.internet.ping ?? "—"}</b> ms</span><span>sistema <b>${x.servidor.ping ?? "—"}</b> ms</span><span class="dg-selo ${{ "tudo-ok": "ok-s", "internet-ruim": "erro", "sem-internet": "erro" }[x.codigo] || "aviso"}">${esc(x.titulo)}</span></div>`).join("")}</div></section>` : ""}`;
  corpo.querySelector("#dg-vel-ir").onclick = rodarVelocidade;
  atualizarMedidor(vel.rodando ? vel.valor : i.download);
}

function atualizarMedidor(mbps) {
  const f = vel.fase === "ping" || vel.fase === "servidor" ? 0 : anguloMbps(mbps || 0);
  const a = raiz?.querySelector("#dg-m-arco"), p = raiz?.querySelector("#dg-m-ponteiro");
  if (a) a.setAttribute("d", arco(0, Math.max(0.001, f), 96));
  if (p) p.style.transform = `rotate(${-90 + f * 180}deg)`;
}

async function rodarVelocidade() {
  if (vel.rodando) return;
  vel = { rodando: true, fase: "ping", valor: 0, fracao: 0, res: vel.res };
  if (aba === "velocidade") abaVelocidade();
  const total = { ping: [0, 0.1], download: [0.1, 0.55], upload: [0.55, 0.9], servidor: [0.9, 1], fim: [1, 1] };
  try {
    vel.res = await testarVelocidade(({ fase, valor, fracao }) => {
      vel.fase = fase; vel.valor = fase === "download" || fase === "upload" ? valor : vel.valor;
      const [a, b] = total[fase] || [0, 1];
      vel.fracao = a + (b - a) * Math.min(1, fracao || 0);
      if (aba !== "velocidade" || !raiz) return;
      const num = raiz.querySelector("#dg-m-num"), un = raiz.querySelector("#dg-m-un"), fs = raiz.querySelector("#dg-m-fase"), pr = raiz.querySelector("#dg-m-prog");
      const emMs = fase === "ping" || fase === "servidor";
      if (num) num.textContent = valor == null || fase === "fim" ? "…" : emMs ? Math.round(valor) : valor >= 10 ? Math.round(valor) : valor.toFixed(1);
      if (un) un.textContent = emMs ? "ms" : "Mbps";
      if (fs) fs.textContent = FASES[fase] || "";
      if (pr) pr.style.width = Math.round(vel.fracao * 100) + "%";
      atualizarMedidor(vel.valor);
    });
  } catch (e) { aviso("O teste falhou: " + e.message, "erro"); }
  vel.rodando = false;
  if (raiz && aba === "velocidade") abaVelocidade();
  desenharHeroi();
}

const vazio = (t, tipo = "") => `<div class="dg-vazio ${tipo}">${ic(tipo === "ok" ? "ok" : "alerta", 28)}<p>${esc(t)}</p></div>`;
const carregandoHtml = () => `<div class="dg-vazio"><span class="dg-giro"></span><p>Carregando…</p></div>`;

// ---------- Cartão do problema ----------
function abrirEvento(id) {
  const ev = (D()?.eventos() || []).find((x) => x.id === id);
  if (!ev) return;
  ev.visto = true; D()?.atualizar(ev);
  const g = problemasAgrupados(24 * 7).find((x) => x.eventos.some((e) => e.id === id));
  abrirCartao(ev, g);
}

/** Abre a explicação de um problema do catálogo a partir de uma checagem (sem evento real). */
function abrirProblema(problemaId, check = null) {
  const base = PROBLEMAS.find((p) => p.id === problemaId);
  if (!base) return;
  const ev = { id: "c-" + problemaId, em: Date.now(), tipo: "erro", origem: check ? "checagem" : "guia", mensagem: check ? `${check.titulo}: ${check.valor}` : base.titulo,
    tecnico: check ? { checagem: check.id, detalhe: check.detalhe, ...(check.extra || {}), ...(check.extra?.edge ? { funcao_edge: check.extra.edge } : {}) } : {}, trilha: [], contexto: {} };
  abrirCartao(ev, null, resolverBase(base, ev), !check);
}
function resolverBase(base, ev) {
  const d = diagnosticar(ev);
  if (d.id === base.id) return d;
  // força o problema escolhido mesmo que a mensagem não "case" com ele
  const p = d.pistas || {};
  const r = (v) => (typeof v === "function" ? v(ev, p) : v);
  return { id: base.id, area: base.area, gravidade: base.gravidade, titulo: base.titulo, explicacao: r(base.explicacao), impacto: r(base.impacto),
    causas: r(base.causas) || [], operador: r(base.operador) || [], tecnico: r(base.tecnico) || [], acoes: base.acoes || [], sql: base.sql || null, onde: base.onde || [], pistas: p };
}

function abrirCartao(ev, grupo = null, dForcado = null, soGuia = false) {
  const d = dForcado || diagnosticar(ev);
  const area = AREAS[d.area] || { nome: d.area, cor: "#64748B" };
  const fundo = document.createElement("div");
  fundo.className = "dg-cartao-fundo";
  const local = ev.tecnico?.local;
  const outras = grupo?.eventos?.length > 1 ? grupo.eventos.slice().reverse() : null;
  fundo.innerHTML = `
    <article class="dg-cartao" role="dialog" aria-label="${esc(d.titulo)}" style="--c:${area.cor}">
      <header class="dg-c-topo">
        <button class="dg-btn dg-icone" data-x aria-label="Voltar">${ic("voltar", 18)}</button>
        <span class="dg-c-ic">${ic(d.area, 26)}</span>
        <div class="dg-c-tit">
          <div class="dg-c-chips"><span class="dg-area">${esc(area.nome)}</span><span class="dg-selo ${corGrav(d.gravidade)}" title="${esc(GRAVIDADES[d.gravidade]?.desc || "")}">${esc(GRAVIDADES[d.gravidade]?.nome || "")} · ${esc(GRAVIDADES[d.gravidade]?.desc || "")}</span></div>
          <h2>${esc(d.titulo)}</h2>
          ${soGuia ? "" : `<p class="dg-c-quando">${ev.origem === "checagem" ? "Encontrado no check-up agora" : `${dataHora(ev.em)} · ${relativo(ev.ultimo_em || ev.em)}${grupo ? ` · ${grupo.vezes}× no total` : ev.vezes > 1 ? ` · ${ev.vezes}×` : ""}`}${ev.contexto?.loja ? " · " + esc(ev.contexto.loja) : ""}${ev.contexto?.aparelho ? " · " + esc(ev.contexto.aparelho) : ""}</p>`}
        </div>
      </header>
      <div class="dg-c-corpo">
        ${soGuia ? "" : `<div class="dg-msg"><span>Mensagem que apareceu</span><q>${esc(ev.mensagem)}</q></div>`}

        <section class="dg-sec dg-sec-oque"><h3>${ic("alerta", 18)} O que aconteceu</h3><p>${esc(d.explicacao)}</p>
          ${d.impacto ? `<p class="dg-impacto"><strong>O que para:</strong> ${esc(d.impacto)}</p>` : ""}</section>

        ${d.causas?.length ? `<section class="dg-sec"><h3>${ic("regra", 18)} Por que costuma acontecer</h3><ol class="dg-causas">${d.causas.map((c, i) => `<li><span class="dg-prob-barra" style="--p:${Math.max(25, 100 - i * 22)}%"></span>${esc(c)}</li>`).join("")}</ol><p class="dg-nota">Da causa mais comum para a menos comum.</p></section>` : ""}

        <div class="dg-duas">
          ${d.operador?.length ? `<section class="dg-sec dg-passos op"><h3>${ic("aparelho", 18)} O que o operador faz agora</h3>
            <ol>${d.operador.map((p, i) => `<li><label><input type="checkbox" data-passo="op${i}"><span>${esc(p)}</span></label></li>`).join("")}</ol></section>` : ""}
          ${d.tecnico?.length ? `<section class="dg-sec dg-passos tec"><h3>${ic("codigo", 18)} Para o suporte (você)</h3>
            <ol>${d.tecnico.map((p, i) => `<li><label><input type="checkbox" data-passo="tc${i}"><span>${formatarPasso(p)}</span></label></li>`).join("")}</ol></section>` : ""}
        </div>

        ${d.sql ? `<section class="dg-sec"><h3>${ic("banco", 18)} Comando pronto (SQL Editor do Supabase)</h3><pre class="dg-code">${esc(d.sql)}</pre></section>` : ""}

        ${d.acoes?.length ? `<section class="dg-sec dg-resolver"><h3>${ic("ok", 18)} Resolver com um clique</h3><div class="dg-acoes">${d.acoes.map((a) => botaoAcao(a)).join("")}</div></section>` : ""}

        ${local ? `<section class="dg-sec"><h3>${ic("codigo", 18)} Onde no código</h3><p class="dg-arquivo"><code>${esc(local.arquivo)}</code> linha <strong>${local.linha}</strong>, coluna ${local.coluna}</p><div id="dg-trecho">${carregandoHtml()}</div></section>`
          : d.onde?.length ? `<section class="dg-sec"><h3>${ic("codigo", 18)} Onde olhar no projeto</h3><p>${d.onde.map((o) => `<code>${esc(o)}</code>`).join(" ")}</p></section>` : ""}

        ${ev.trilha?.length ? `<section class="dg-sec"><h3>${ic("clique", 18)} O que aconteceu antes (passo a passo)</h3>
          <ol class="dg-filme">${ev.trilha.map((t) => `<li class="${t.tipo}"><span class="dg-t-hora">${hora(t.em)}</span><span class="dg-t-pino"></span><span>${esc(t.texto)}${t.vezes > 1 ? ` <em>×${t.vezes}</em>` : ""}</span></li>`).join("")}
          <li class="erro final"><span class="dg-t-hora">${hora(ev.em)}</span><span class="dg-t-pino"></span><span><strong>Erro:</strong> ${esc(ev.mensagem)}</span></li></ol></section>` : ""}

        ${outras ? `<section class="dg-sec"><h3>${ic("tela", 18)} Outras vezes que aconteceu</h3><ul class="dg-outras">${outras.slice(0, 12).map((o) => `<li><span>${dataHora(o.em)}</span> ${esc(o.contexto?.rota || "")} ${o.vezes > 1 ? `<em>${o.vezes}×</em>` : ""} <span class="dg-muted">${esc(o.mensagem.slice(0, 80))}</span></li>`).join("")}</ul></section>` : ""}

        ${soGuia ? "" : `<details class="dg-sec dg-tec"><summary>${ic("codigo", 16)} Detalhes técnicos</summary>
          <pre class="dg-code">${esc(JSON.stringify({ id: ev.id, problema: d.id, origem: ev.origem, mensagem: ev.mensagem, tecnico: ev.tecnico, contexto: ev.contexto, versao: ev.versao, pistas: d.pistas }, null, 2))}</pre>
          <button class="dg-btn dg-peq" data-copiar-json>${ic("copiar", 14)} Copiar</button></details>`}
      </div>
    </article>`;
  raiz.appendChild(fundo);
  const fechar = () => { fundo.remove(); document.removeEventListener("keydown", tecla, true); };
  const tecla = (e) => { if (e.key === "Escape") { e.stopPropagation(); fechar(); } };
  document.addEventListener("keydown", tecla, true);
  fundo.addEventListener("click", (e) => { if (e.target === fundo || e.target.closest("[data-x]")) fechar(); });
  fundo.querySelectorAll("[data-acao]").forEach((b) => (b.onclick = () => executarAcao(b.dataset.acao, { d, ev, fechar, botao: b })));
  fundo.querySelector("[data-copiar-json]")?.addEventListener("click", () => copiar(fundo.querySelector(".dg-tec pre").textContent, "Detalhes copiados"));
  // marca os passos já feitos (só nesta abertura)
  fundo.querySelectorAll("[data-passo]").forEach((c) => (c.onchange = () => c.closest("li").classList.toggle("feito", c.checked)));
  if (local) mostrarTrecho(fundo.querySelector("#dg-trecho"), local);
  fundo.querySelector(".dg-cartao").focus?.();
  D()?.passo(`Diagnóstico: abriu “${d.titulo}”`, "sistema");
}

function formatarPasso(p) {
  // `código` e comandos ficam em destaque
  return esc(p).replace(/(supabase functions deploy [\w-]+(?: --no-verify-jwt)?|supabase\/[\w./-]+|app\/js\/[\w./-]+|garcom\/[\w./-]+|notify pgrst[^.]*|--kiosk-printing)/g, "<code>$1</code>");
}

async function mostrarTrecho(alvo, local) {
  try {
    const url = local.url || new URL("../../" + local.arquivo.replace(/^app\//, ""), import.meta.url).href;
    const txt = await (await fetch(url, { cache: "no-store" })).text();
    const linhas = txt.split("\n");
    const ini = Math.max(0, local.linha - 5), fim = Math.min(linhas.length, local.linha + 4);
    alvo.innerHTML = `<pre class="dg-trecho">${linhas.slice(ini, fim).map((l, i) => {
      const n = ini + i + 1;
      const corte = l.length > 180 ? l.slice(Math.max(0, local.coluna - 90), Math.max(0, local.coluna - 90) + 180) + "…" : l;
      return `<span class="${n === local.linha ? "alvo" : ""}"><b>${n}</b>${esc(corte)}</span>`;
    }).join("")}</pre>`;
  } catch { alvo.innerHTML = `<p class="dg-nota">Não foi possível mostrar o trecho (arquivo indisponível offline).</p>`; }
}

// ---------- Ações que resolvem ----------
const ACOES = {
  testar: "Testar tudo de novo", recarregar: "Recarregar o sistema", "limpar-cache": "Limpar cache e recarregar", "abrir-fila": "Ver vendas pendentes",
  "renovar-sessao": "Renovar sessão", "liberar-espaco": "Liberar espaço", "copiar-sql": "Copiar comando SQL", "ir-config": "Abrir Configurações", "ir-caixa": "Abrir o Caixa",
};
const botaoAcao = (a) => `<button class="dg-btn ${["limpar-cache", "liberar-espaco"].includes(a) ? "" : "dg-pri"}" data-acao="${a}">${esc(ACOES[a] || a)}</button>`;

async function executarAcao(a, { d, fechar, botao }) {
  D()?.passo(`Diagnóstico: ação ${a}`, "sistema");
  const orig = botao.innerHTML;
  botao.disabled = true; botao.innerHTML = `<span class="dg-giro"></span>`;
  try {
    if (a === "testar") { fechar(); aba = "agora"; desenharAba(); await testar(); return; }
    if (a === "recarregar") { location.reload(); return; }
    if (a === "limpar-cache") {
      if (!confirm("Limpar a cópia guardada do sistema e recarregar?\n\nVendas pendentes, login e configurações NÃO são apagados.")) return;
      const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.all(regs.map((r) => r.unregister()));
      const ks = await caches?.keys?.() || [];
      await Promise.all(ks.map((k) => caches.delete(k)));
      location.reload(); return;
    }
    if (a === "abrir-fila") {
      fecharPainel();
      const m = await import("../contingencia.js");
      await m.abrirPainelFila(); return;
    }
    if (a === "renovar-sessao") {
      const { sb } = await import("../api.js");
      const { error } = await sb.auth.refreshSession();
      if (error) throw error;
      aviso("Sessão renovada", "ok"); return;
    }
    if (a === "liberar-espaco") {
      let atual = null; try { atual = (await import("../estado.js")).estado?.empresa?.id; } catch { /* ignora */ }
      let livre = 0;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith("lis-catalogo-") && (!atual || k !== "lis-catalogo-" + atual)) { livre += (localStorage.getItem(k) || "").length * 2; localStorage.removeItem(k); }
      }
      const evs = D()?.eventos() || [];
      if (evs.length > 60) { const antes = JSON.stringify(evs).length; localStorage.setItem("lis-diag-eventos", JSON.stringify(evs.slice(-60))); livre += (antes - JSON.stringify(evs.slice(-60)).length) * 2; }
      aviso(`Liberado ${Math.round(livre / 1024)} KB (a fila de vendas não foi tocada)`, "ok"); return;
    }
    if (a === "copiar-sql") { await copiar(d.sql, "SQL copiado — cole no SQL Editor do Supabase"); return; }
    if (a === "ir-config") { fecharPainel(); location.hash = "#/configuracoes"; return; }
    if (a === "ir-caixa") { fecharPainel(); location.hash = "#/caixa"; return; }
  } catch (e) {
    aviso(`Não deu certo: ${e.message || e}`, "erro");
  } finally { if (botao.isConnected) { botao.disabled = false; botao.innerHTML = orig; } }
}

async function copiar(texto, msg = "Copiado") {
  try { await navigator.clipboard.writeText(texto); aviso(msg, "ok"); }
  catch {
    const t = document.createElement("textarea"); t.value = texto; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); aviso(msg, "ok"); } catch { aviso("Não foi possível copiar", "erro"); }
    t.remove();
  }
}

// ---------- Resumo e relatório ----------
const EMO = { ok: "🟢", aviso: "🟡", erro: "🔴", info: "⚪", pulado: "⚪", rodando: "⏳" };

function textoResumo() {
  const c = D()?.contexto() || {};
  const gs = problemasAgrupados(24).filter((g) => g.d.gravidade !== "info");
  const rs = checks ? resumoGeral(checks) : null;
  const l = [];
  l.push(`*Diagnóstico Lis PDV* — ${new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`);
  l.push(`Loja: ${c.loja || "—"} · Usuário: ${c.usuario || "—"}${c.papel ? " (" + c.papel + ")" : ""}`);
  l.push(`Aparelho: ${c.aparelho || "—"} · versão ${D()?.versao}`);
  if (rs) l.push(`Check-up: ${EMO[rs.status]} ${rs.ok} ok · ${rs.aviso} atenção · ${rs.erro} problema(s)`);
  (checks || []).filter((x) => ["erro", "aviso"].includes(x.status)).forEach((x) => l.push(`${EMO[x.status]} ${x.titulo}: ${x.valor}`));
  l.push("");
  l.push(gs.length ? "*Problemas nas últimas 24 h:*" : "Nenhum problema nas últimas 24 h.");
  gs.slice(0, 8).forEach((g) => l.push(`• ${g.d.titulo} — ${g.vezes}× (último ${hora(g.ultimo)}): “${g.eventos[g.eventos.length - 1].mensagem.slice(0, 100)}”`));
  return l.join("\n");
}

async function copiarResumo() { await copiar(textoResumo(), "Resumo copiado — cole no WhatsApp"); }

async function gerarRelatorio() {
  if (!checks || rodando) { aviso("Terminando o check-up…"); while (rodando) await new Promise((r) => setTimeout(r, 200)); }
  const { montarRelatorio } = await import("./relatorio.js");
  const c = D()?.contexto() || {};
  const html = montarRelatorio({ checks, eventos: D()?.eventos() || [], trilha: D()?.trilha() || [], contexto: c, versao: D()?.versao, resumo: textoResumo(), velocidade: vel.res || historico()[0] || null });
  const nome = `diagnostico-${String(c.loja || "pdv").normalize("NFD").replace(/[^\w]+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.html`;
  const arq = new File([html], nome, { type: "text/html" });
  // Celular/tablet: compartilha direto (WhatsApp, e-mail…). Computador: baixa o arquivo.
  if (navigator.canShare?.({ files: [arq] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [arq], title: "Diagnóstico do PDV", text: textoResumo() }); return; } catch { /* cancelou: baixa */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(arq); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  aviso("Relatório baixado. Envie o arquivo ao suporte (WhatsApp/e-mail).", "ok");
}

// ---------- Para a rota #/diagnostico ----------
export function montarNaPagina(alvo) { return abrirPainel({ alvo }); }
