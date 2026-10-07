// =====================================================================
// Caixa-preta do sistema (diagnóstico)
// ---------------------------------------------------------------------
// Grava tudo o que dá errado no aparelho, com o "filme" do que a pessoa
// fez antes (trilha), para o suporte entender o problema em segundos.
//
// - Carregado ANTES de main.js e sem importar nada (nem o Supabase): assim
//   registra até as falhas que impedem o sistema de abrir.
// - Fica em window.lisDiag. Os outros módulos usam window.lisDiag?.registrar(...)
//   (com "?." para nunca quebrar se este arquivo não carregar).
// - Abre o painel: Ctrl+Shift+D (ou Ctrl+Alt+D), 5 toques rápidos na logo,
//   menu Diagnóstico, ou o botão "Entender" nos avisos de erro.
// - Nada de senha, token ou número de cartão é gravado (ver limpar()).
// =====================================================================

export const VERSAO_APP = "2026.10.07.2";

const CHAVE = "lis-diag-eventos";
const CHAVE_TRILHA = "lis-diag-trilha";
const MAX_EVENTOS = 300;
const MAX_TRILHA = 80;
const TRILHA_NO_EVENTO = 15;

const ler = (k, padrao) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : padrao; } catch { return padrao; } };
function gravar(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch {
    // Armazenamento cheio: a caixa-preta encolhe para nunca disputar espaço com a fila de vendas
    if (k === CHAVE && Array.isArray(v) && v.length > 40) return gravar(k, v.slice(-40));
    return false;
  }
}

let eventos = ler(CHAVE, []);
let trilha = ler(CHAVE_TRILHA, []);
const marcas = {};
const ouvintes = new Set();
let contexto = () => ({});
const inicioPagina = Date.now();

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- Limpeza de dados sensíveis ----------
const SENSIVEL = /senha|password|pass|token|secret|segredo|apikey|api_key|authorization|cartao|card|cvv|pin|refresh|access|csc|certificado/i;
const PESSOAL = /cpf|cnpj|documento|email|telefone|celular|whatsapp|endereco|rua|cep/i;

/** Copia o objeto tirando segredos e encurtando textos longos (máx. ~3 KB). */
export function limpar(v, prof = 0) {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…" : v;
  if (prof > 4) return "…";
  if (Array.isArray(v)) return v.slice(0, 12).map((x) => limpar(x, prof + 1)).concat(v.length > 12 ? [`(+${v.length - 12})`] : []);
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) {
      o[k] = SENSIVEL.test(k) ? "•••" : PESSOAL.test(k) && typeof x === "string" && x ? x.slice(0, 3) + "•••" : limpar(x, prof + 1);
    }
    return o;
  }
  return String(v);
}

// ---------- Onde no código? ----------
/** Tira da pilha (stack) o primeiro arquivo do próprio sistema: { arquivo, linha, coluna }. */
export function localNoCodigo(stack) {
  const linhas = String(stack || "").split("\n");
  for (const l of linhas) {
    const m = l.match(/((?:https?:\/\/[^/\s]+|file:\/\/)[^\s()]*?\/((?:app|garcom|assets|cardapio|js)\/[^\s():?#]+))(?:\?[^\s():]*)?:(\d+):(\d+)/);
    if (m && !/diagnostico\/registro\.js|js\/api\.js/.test(m[2])) return { arquivo: m[2], url: m[1], linha: Number(m[3]), coluna: Number(m[4]) };
  }
  return null;
}

function rotaAtual() { return (location.hash || "#/").slice(0, 60); }

function ctx() {
  let c = {};
  try { c = contexto() || {}; } catch { /* ignora */ }
  return { ...c, online: navigator.onLine, rota: rotaAtual(), visivel: !document.hidden };
}

// ---------- Trilha: o "filme" do que aconteceu antes ----------
/** Registra um passo da pessoa (clique, tela, tecla, rede). Leve e sem dados pessoais. */
export function passo(texto, tipo = "acao") {
  const t = { em: Date.now(), tipo, texto: String(texto).slice(0, 90) };
  const ult = trilha[trilha.length - 1];
  if (ult && ult.texto === t.texto && t.em - ult.em < 1500) { ult.vezes = (ult.vezes || 1) + 1; ult.em = t.em; }
  else trilha.push(t);
  if (trilha.length > MAX_TRILHA) trilha = trilha.slice(-MAX_TRILHA);
  agendarGravacao();
}

let timerGravar = null;
function agendarGravacao() {
  clearTimeout(timerGravar);
  timerGravar = setTimeout(() => { gravar(CHAVE_TRILHA, trilha); }, 400);
}

// ---------- Eventos ----------
/**
 * Registra um evento.
 * tipo: "erro" (algo falhou), "aviso" (regra/atenção), "info" (para contexto)
 * origem: js | promessa | recurso | banco | funcao | rede | tela | impressora | balanca | fila | armazenamento | seguranca | inicio | console
 * tecnico: { codigo, detalhes, dica, stack, alvo, metodo, status, ms, ... }
 */
export function registrar({ tipo = "erro", origem = "js", mensagem = "", tecnico = {}, gravidade } = {}) {
  const msg = String(mensagem || "Erro sem mensagem").slice(0, 500);
  const chave = origem + "|" + msg;
  const agora = Date.now();
  // Mesmo erro repetido (ex.: tentando enviar sem internet a cada 20 s): só conta mais uma vez
  const ult = eventos.slice(-10).reverse().find((x) => x.chave === chave && agora - x.ultimo_em < 120000);
  if (ult) {
    ult.vezes = (ult.vezes || 1) + 1; ult.ultimo_em = agora; ult.enviado = false;
    gravar(CHAVE, eventos); avisarOuvintes(ult);
    return ult;
  }
  const tec = limpar(tecnico || {}) || {};
  if (tecnico?.stack && !tec.local) tec.local = localNoCodigo(tecnico.stack);
  if (!tec.local && tecnico?.arquivo && tecnico?.linha) tec.local = localNoCodigo(`${tecnico.arquivo}:${tecnico.linha}:${tecnico.coluna || 0}`);
  const ev = {
    id: id(), em: agora, ultimo_em: agora, vezes: 1, chave,
    tipo, origem, mensagem: msg, gravidade: gravidade || null,
    tecnico: tec, contexto: ctx(),
    trilha: trilha.slice(-TRILHA_NO_EVENTO),
    versao: VERSAO_APP, enviado: false, visto: false,
  };
  eventos.push(ev);
  if (eventos.length > MAX_EVENTOS) eventos = eventos.slice(-MAX_EVENTOS);
  gravar(CHAVE, eventos);
  if (tipo !== "info") passo(`⚠ ${msg}`, "erro");
  avisarOuvintes(ev);
  classificar(ev);
  return ev;
}

function avisarOuvintes(ev) { ouvintes.forEach((f) => { try { f(ev); } catch { /* ignora */ } }); }

/** Usa o catálogo (carregado só quando precisa) para saber a gravidade e mostrar o alerta flutuante. */
function classificar(ev) {
  if (ev.tipo === "info") return;
  import("./catalogo.js").then(({ diagnosticar }) => {
    const d = diagnosticar(ev);
    ev.problema = d.id; ev.gravidade = ev.gravidade || d.gravidade; ev.area = d.area;
    // O que só apareceu no console não dispara alarme
    if (ev.origem === "console" && ["critica", "alta"].includes(ev.gravidade)) ev.gravidade = "media";
    gravar(CHAVE, eventos);
    if (["critica", "alta"].includes(ev.gravidade)) mostrarPilula();
    avisarOuvintes(ev);
  }).catch(() => {});
}

/** Converte qualquer coisa lançada (Error, string, objeto do Supabase) em { mensagem, tecnico }. */
export function deErro(e) {
  if (!e) return { mensagem: "Erro desconhecido", tecnico: {} };
  if (typeof e === "string") return { mensagem: e, tecnico: {} };
  const tecnico = { ...(e.tecnico || {}) };
  if (e.name && e.name !== "Error") tecnico.tipo = e.name;
  if (e.code) tecnico.codigo = tecnico.codigo || e.code;
  if (e.details) tecnico.detalhes = e.details;
  if (e.hint) tecnico.dica = e.hint;
  if (e.stack) tecnico.stack = String(e.stack).split("\n").slice(0, 8).join("\n");
  return { mensagem: e.message || String(e), tecnico };
}

/**
 * Chamado quando um erro é MOSTRADO para a pessoa (toast). Se ele já foi registrado
 * (ex.: pela camada do banco), só marca; senão registra agora. Devolve o id do evento.
 */
export function mostrado(e, origem = "tela") {
  if (e?.diagId) { const ev = eventos.find((x) => x.id === e.diagId); if (ev) { ev.mostrado = true; gravar(CHAVE, eventos); } return e.diagId; }
  const { mensagem, tecnico } = deErro(e);
  const ev = registrar({ tipo: "aviso", origem, mensagem, tecnico });
  ev.mostrado = true;
  if (e && typeof e === "object") { try { e.diagId = ev.id; } catch { /* ignora */ } }
  return ev.id;
}

// ---------- Captura automática ----------
function instalarCapturas() {
  // Erros de JavaScript e arquivos que não carregaram (fase de captura pega <script>/<link>)
  window.addEventListener("error", (e) => {
    const alvo = e.target;
    if (alvo && alvo !== window && alvo.tagName) {
      if (!/^(SCRIPT|LINK)$/.test(alvo.tagName)) return; // fotos de produto que faltam não são problema do sistema
      const url = alvo.src || alvo.href || "";
      registrar({ tipo: "erro", origem: "recurso", mensagem: `Arquivo não carregou: ${url.replace(location.origin, "")}`, tecnico: { alvo: url, elemento: alvo.tagName.toLowerCase() } });
      return;
    }
    if (/ResizeObserver loop/.test(e.message || "")) return; // aviso inofensivo do navegador
    const err = e.error;
    registrar({ tipo: "erro", origem: "js", mensagem: e.message || err?.message || "Erro de JavaScript",
      tecnico: { ...deErro(err).tecnico, arquivo: e.filename, linha: e.lineno, coluna: e.colno } });
  }, true);

  window.addEventListener("unhandledrejection", (e) => {
    const { mensagem, tecnico } = deErro(e.reason);
    // Pessoa fechou a janela de escolher impressora/balança: não é erro
    const cancelou = /No (port|device) selected|user cancel|AbortError|The user aborted/i.test(mensagem);
    if (e.reason?.diagId) return; // já registrado na origem
    registrar({ tipo: cancelou ? "info" : "erro", origem: "promessa", mensagem, tecnico });
  });

  // Bloqueio pela política de segurança (CSP): endereço fora da lista permitida
  document.addEventListener("securitypolicyviolation", (e) => {
    registrar({ tipo: "erro", origem: "seguranca", mensagem: `Bloqueado pela segurança da página: ${e.blockedURI || "conteúdo"} (${e.violatedDirective})`,
      tecnico: { bloqueado: e.blockedURI, diretiva: e.violatedDirective, arquivo: e.sourceFile, linha: e.lineNumber } });
  });

  // console.error do próprio sistema também entra (como aviso)
  const ce = console.error.bind(console);
  console.error = (...a) => {
    ce(...a);
    try {
      const e = a.find((x) => x instanceof Error);
      if (e?.diagId) return;
      const { mensagem, tecnico } = e ? deErro(e) : { mensagem: a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" "), tecnico: {} };
      registrar({ tipo: "aviso", origem: "console", mensagem, tecnico });
    } catch { /* nunca quebra o console */ }
  };

  // ---------- Trilha ----------
  document.addEventListener("click", (e) => {
    const el = e.target.closest?.("button, a, [role=button], [data-rota], .mesa, label.check, summary");
    if (!el || el.closest(".diag-raiz")) return;
    const rotulo = (el.getAttribute("aria-label") || el.title || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50);
    if (rotulo) passo(`Clicou em “${rotulo}”`);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (/^F\d{1,2}$/.test(e.key) || e.key === "Escape" || (e.key === "Delete" && !/INPUT|TEXTAREA/.test(e.target.tagName))) passo(`Tecla ${e.key}`);
    // Atalho do painel
    if ((e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) || (e.ctrlKey && e.altKey && (e.key === "d" || e.key === "D"))) {
      e.preventDefault(); abrir();
    }
  }, true);
  document.addEventListener("submit", (e) => passo(`Enviou formulário ${e.target.id ? "#" + e.target.id : ""}`.trim()), true);
  window.addEventListener("hashchange", () => passo(`Foi para ${rotaAtual()}`, "tela"));
  window.addEventListener("online", () => passo("Navegador diz: internet voltou", "rede"));
  window.addEventListener("offline", () => passo("Navegador diz: internet caiu", "rede"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) passo("Voltou para o sistema", "tela"); });

  // 5 toques rápidos na logo/marca abrem o painel (bom para celular e tablet)
  let toques = [];
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest?.(".brand-mark, .brand, .g-login-card img, .g-top .avatar")) return;
    const agora = Date.now();
    toques = toques.filter((t) => agora - t < 2500); toques.push(agora);
    if (toques.length >= 5) { toques = []; abrir(); }
  });
}

// ---------- Vigia da inicialização ----------
// Se o sistema não abrir (arquivo/biblioteca não carregou, travou esperando o servidor),
// mostra o painel sozinho em vez de deixar a tela girando para sempre.
function vigiarInicio() {
  const travado = () => {
    const app = document.getElementById("app");
    return app && app.children.length === 1 && app.firstElementChild.classList.contains("loading");
  };
  setTimeout(() => {
    if (marcas.modulos) return;
    registrar({ tipo: "erro", origem: "inicio", gravidade: "critica", mensagem: "O sistema não iniciou: os arquivos principais não carregaram",
      tecnico: { segundos: 15, recursos_com_falha: eventos.filter((e) => e.origem === "recurso" && e.em >= inicioPagina).map((e) => e.tecnico.alvo) } });
    abrir(null, { motivo: "inicio" });
  }, 15000);
  setTimeout(() => {
    if (!marcas.modulos || !travado()) return;
    registrar({ tipo: "erro", origem: "inicio", gravidade: "alta", mensagem: "O sistema abriu mas travou carregando (mais de 40 s esperando o servidor)",
      tecnico: { segundos: 40, online: navigator.onLine } });
    abrir(null, { motivo: "travado" });
  }, 40000);
}

// ---------- Alerta flutuante ----------
let pilula = null;
function mostrarPilula() {
  if (document.querySelector(".diag-raiz")) return;
  const pend = eventos.filter((e) => !e.visto && ["critica", "alta"].includes(e.gravidade) && Date.now() - e.em < 6 * 3600e3).length;
  if (!pend) { pilula?.remove(); pilula = null; return; }
  if (!pilula) {
    pilula = document.createElement("button");
    pilula.type = "button";
    pilula.className = "diag-pilula";
    pilula.setAttribute("aria-live", "polite");
    pilula.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9998;display:flex;align-items:center;gap:.45rem;padding:.45rem .8rem .45rem .55rem;border-radius:999px;border:0;background:#B42318;color:#fff;font:600 13px/1.2 Onest,system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer";
    pilula.onclick = () => abrir();
    document.body.appendChild(pilula);
  }
  pilula.innerHTML = `<span style="display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#fff;color:#B42318;font-weight:800">!</span>${pend} ${pend === 1 ? "problema" : "problemas"} · ver diagnóstico`;
}

// ---------- Painel ----------
/** Abre o painel de diagnóstico (opcionalmente já no evento `eventoId`). */
export function abrir(eventoId = null, opcoes = {}) {
  pilula?.remove(); pilula = null;
  return import("./painel.js").then((m) => m.abrirPainel({ eventoId, ...opcoes })).catch((e) => {
    // Nem o painel carregou: mostra o mínimo, direto daqui
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;z-index:99999;background:#fff;color:#18211F;padding:24px;font:15px/1.5 system-ui;overflow:auto";
    d.innerHTML = `<h2 style="margin:0 0 8px">Diagnóstico</h2><p><strong>O painel de diagnóstico também não carregou.</strong> Isso quase sempre é <strong>internet</strong> ou <strong>arquivos do sistema desatualizados</strong>.</p>
      <ol><li>Confira se a internet está funcionando (abra outro site).</li><li>Aperte <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> para recarregar sem cache.</li><li>Se continuar, mande uma foto desta tela para o suporte.</li></ol>
      <pre style="white-space:pre-wrap;background:#F2F4F3;padding:12px;border-radius:8px;font-size:12px"></pre><button style="padding:8px 14px">Fechar</button>`;
    d.querySelector("pre").textContent = `${e?.message || e}\n\nÚltimos erros:\n` + eventos.slice(-8).map((x) => `${new Date(x.em).toLocaleTimeString("pt-BR")} [${x.origem}] ${x.mensagem}`).join("\n");
    d.querySelector("button").onclick = () => d.remove();
    document.body.appendChild(d);
  });
}

// ---------- API pública ----------
const api = {
  versao: VERSAO_APP,
  registrar, passo, mostrado, deErro, abrir, limpar, localNoCodigo,
  eventos: () => eventos.slice(),
  trilha: () => trilha.slice(),
  marcar: (nome) => { marcas[nome] = Date.now(); passo(`Sistema: ${nome}`, "sistema"); },
  marcas: () => ({ ...marcas, inicio: inicioPagina }),
  definirContexto: (fn) => { contexto = fn; },
  contexto: ctx,
  ouvir: (fn) => { ouvintes.add(fn); return () => ouvintes.delete(fn); },
  marcarVistos: () => { eventos.forEach((e) => (e.visto = true)); gravar(CHAVE, eventos); pilula?.remove(); pilula = null; },
  atualizar: (ev) => { const i = eventos.findIndex((x) => x.id === ev.id); if (i >= 0) { eventos[i] = ev; gravar(CHAVE, eventos); } },
  pendentesEnvio: () => eventos.filter((e) => !e.enviado && e.tipo !== "info"),
  marcarEnviados: (ids) => { const s = new Set(ids); eventos.forEach((e) => { if (s.has(e.id)) e.enviado = true; }); gravar(CHAVE, eventos); },
  limparTudo: () => { eventos = []; trilha = []; gravar(CHAVE, eventos); gravar(CHAVE_TRILHA, trilha); avisarOuvintes(null); },
};

if (!window.lisDiag) {
  window.lisDiag = api;
  instalarCapturas();
  passo(`Abriu ${location.pathname.replace(/.*\/(\w+)\/?(index\.html)?$/, "$1") || "sistema"}`, "sistema");
  if (document.getElementById("app")) vigiarInicio();
  // Erros graves ainda não vistos de uma sessão anterior (ex.: travou e reiniciaram)
  setTimeout(mostrarPilula, 3000);
}
export default window.lisDiag;
