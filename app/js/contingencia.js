// Contingência: o caixa continua vendendo sem internet, nada se perde se a energia
// cair, e a venda em andamento pode continuar em outro aparelho.
//
// Como funciona
// - Cada venda nasce com um id_local (UUID). O servidor nunca registra o mesmo id_local
//   duas vezes, então reenviar é sempre seguro (sem venda duplicada nem cobrança em dobro).
// - O cupom em andamento (itens + pagamentos já recebidos) é gravado no navegador a
//   cada alteração (sobrevive a queda de energia/bateria) e, com internet, também no
//   servidor como "rascunho", para outro aparelho poder continuar a venda.
// - Sem internet, a venda concluída vai para uma fila neste aparelho e é enviada
//   sozinha quando a conexão voltar, com a data/hora real da venda.
// - Contexto da sessão (loja, usuário, caixa) e catálogo de produtos ficam em cópia
//   local para o sistema abrir e vender mesmo sem conexão.
import { sb, rpc, fn } from "./api.js";
import { estado, eh } from "./estado.js";
import { html, render, modal, confirmar, toast, dinheiro, dataHora } from "./ui.js";
import { obterDispositivo } from "../../assets/dispositivo.js";

// ---------- Armazenamento local seguro ----------
const ler = (k, padrao = null) => { try { const v = localStorage.getItem(k); return v == null ? padrao : JSON.parse(v); } catch { return padrao; } };
const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const apagar = (k) => { try { localStorage.removeItem(k); } catch { /* ignora */ } };

export function novoId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- Aparelho ----------
export const aparelhoId = () => obterDispositivo();
export function aparelhoNome() {
  let t = null;
  try { t = localStorage.getItem("pdv-terminal"); } catch { /* ignora */ }
  if (t) return t;
  const ua = navigator.userAgent;
  const tipo = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? "Tablet"
    : /Mobi|iPhone|Android/i.test(ua) ? "Celular" : "Computador";
  const so = /Windows/i.test(ua) ? "Windows" : /Android/i.test(ua) ? "Android" : /iPhone|iPad|Mac OS/i.test(ua) ? (/(iPhone|iPad)/i.test(ua) ? "iOS" : "Mac") : /Linux/i.test(ua) ? "Linux" : "";
  return `${tipo}${so ? " " + so : ""} · ${aparelhoId().slice(0, 4).toUpperCase()}`;
}

// ---------- Conexão ----------
let semRede = !navigator.onLine;
export const estaOnline = () => !semRede && navigator.onLine;

/** Falha de rede (sem internet, servidor fora, tempo esgotado) — não é erro de regra de negócio. */
export function ehErroDeRede(e) {
  if (!navigator.onLine) return true;
  const m = String(e?.message || e || "");
  return /Failed to fetch|NetworkError|Load failed|Sem conexão|network ?error|timed? ?out|tempo esgotado|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|AuthRetryableFetchError|FunctionsFetchError|Failed to send a request/i.test(m);
}
export function marcarRede(ok) {
  const antes = semRede;
  semRede = !ok;
  if (antes !== semRede) avisar();
  if (ok && antes) sincronizarTudo();
}

/** Executa com tempo máximo (internet "pendurada" não pode travar o caixa). */
export function comTempo(promessa, ms = 12000) {
  let t;
  return Promise.race([promessa, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("Sem conexão: tempo esgotado")), ms); })]).finally(() => clearTimeout(t));
}

// ---------- Contexto da sessão em cache ----------
const chaveCtx = "lis-ctx";
export function salvarContextoLocal() {
  if (!estado.usuario || !estado.perfil) return;
  gravar(chaveCtx, {
    salvo_em: Date.now(), usuario: { id: estado.usuario.id, email: estado.usuario.email },
    perfil: estado.perfil, empresa: estado.empresa, fiscal: estado.fiscal ? { ...estado.fiscal } : null,
    caixa: estado.caixa, conta: estado.conta, adminPlataforma: estado.adminPlataforma,
  });
}
export function lerContextoLocal(userId) {
  const c = ler(chaveCtx);
  if (!c || (userId && c.usuario?.id !== userId)) return null;
  return c;
}
export const limparContextoLocal = () => apagar(chaveCtx);

/** Id do usuário da sessão gravada pelo Supabase (funciona sem rede, mesmo com o token vencido). */
export function usuarioDaSessaoLocal() {
  const s = ler("pdv-auth");
  return s?.user?.id || s?.currentSession?.user?.id || null;
}

// ---------- Catálogo em cache ----------
const chaveCat = (emp) => "lis-catalogo-" + emp;
export function salvarCatalogo(categorias, produtos) {
  if (!estado.empresa) return;
  if (!gravar(chaveCat(estado.empresa.id), { salvo_em: Date.now(), categorias, produtos })) {
    // Muitos produtos: guarda só o essencial para vender
    gravar(chaveCat(estado.empresa.id), { salvo_em: Date.now(), categorias, produtos: produtos.map(({ id, nome, codigo, codigo_barras, preco_venda, unidade, categoria_id, favorito }) => ({ id, nome, codigo, codigo_barras, preco_venda, unidade, categoria_id, favorito })) });
  }
}
export const lerCatalogo = () => (estado.empresa ? ler(chaveCat(estado.empresa.id)) : null);

// ---------- Fila de vendas feitas sem internet ----------
const chaveFila = () => "lis-fila-vendas-" + (estado.empresa?.id || "x");
export const fila = () => ler(chaveFila(), []);
const salvarFila = (f) => { gravar(chaveFila(), f); avisar(); };

/**
 * Guarda a venda concluída para enviar depois.
 * item: { id_local, payload, total, troco, nfce, imprimir, venda_local }
 */
export function enfileirarVenda(item) {
  const f = fila().filter((x) => x.id_local !== item.id_local);
  f.push({ ...item, criado_em: new Date().toISOString(), tentativas: 0, erro: null, operador_id: estado.perfil?.id });
  salvarFila(f);
}

let sincronizando = null;
const ouvintesVenda = new Set();
/** Recebe avisos de vendas da fila que chegaram ao servidor: fn({ item, resposta }). */
export const aoEnviarVenda = (f) => { ouvintesVenda.add(f); return () => ouvintesVenda.delete(f); };

/** Envia a fila. Seguro chamar várias vezes (uma execução por vez). */
export function sincronizarFila() {
  if (sincronizando) return sincronizando;
  sincronizando = (async () => {
    let enviadas = 0;
    const meu = estado.perfil?.id;
    for (const item of fila()) {
      if (!navigator.onLine) break;
      if (item.operador_id && meu && item.operador_id !== meu) continue; // cada operador envia as suas
      if (item.erro && (item.tentativas || 0) >= 3) continue;             // espera conferência ("Enviar agora")
      try {
        await comTempo(sb.auth.getSession(), 8000); // renova o token se venceu enquanto estava sem rede
        const r = await comTempo(rpc("registrar_venda", { p: item.payload }), 20000);
        marcarRede(true);
        salvarFila(fila().filter((x) => x.id_local !== item.id_local));
        enviadas++;
        if (item.nfce) fn("fiscal", { acao: "emitir", venda_id: r.id, modelo: "65" }).catch(() => {});
        ouvintesVenda.forEach((f) => { try { f({ item, resposta: r }); } catch { /* ignora */ } });
      } catch (e) {
        if (ehErroDeRede(e)) { marcarRede(false); break; }
        // Erro de regra (ex.: preço mudou demais): fica na fila com a mensagem para o gerente ver
        const f = fila(); const x = f.find((v) => v.id_local === item.id_local);
        if (x) { x.tentativas = (x.tentativas || 0) + 1; x.erro = e.message; salvarFila(f); }
      }
    }
    return enviadas;
  })().finally(() => { sincronizando = null; avisar(); });
  return sincronizando;
}

/** Remove da fila (só gerente, depois de conferir). */
export function descartarDaFila(idLocal) { salvarFila(fila().filter((x) => x.id_local !== idLocal)); }

// ---------- Rascunho da venda em andamento (para outro aparelho continuar) ----------
const chavePendRasc = () => "lis-rascunho-pendente-" + (estado.perfil?.id || "x");
let timerRasc = null;
let ultimoRasc = null;
let ouvinteRasc = null;
/** fn(resposta) quando o servidor diz que a venda foi assumida/concluída em outro aparelho. */
export const aoMudarRascunho = (f) => { ouvinteRasc = f; };

function dadosRascunho(venda, total) {
  return { ...venda, total, salvo_em: new Date().toISOString(), aparelho_nome: aparelhoNome() };
}

/** Agenda o envio do rascunho (com espera curta para juntar várias alterações). */
export function agendarRascunho(venda, total, imediato = false) {
  if (!venda?.id_local) return;
  ultimoRasc = dadosRascunho(venda, total);
  gravar(chavePendRasc(), ultimoRasc);
  clearTimeout(timerRasc);
  timerRasc = setTimeout(enviarRascunho, imediato ? 0 : 1200);
}

async function enviarRascunho() {
  const d = ultimoRasc || ler(chavePendRasc());
  if (!d || !navigator.onLine || !estado.perfil) return;
  try {
    const r = await comTempo(rpc("salvar_rascunho", { p_id: d.id_local, p_aparelho: aparelhoId(), p_aparelho_nome: aparelhoNome(), p_dados: d }), 10000);
    marcarRede(true);
    if (ultimoRasc === d || !ultimoRasc) { ultimoRasc = null; apagar(chavePendRasc()); }
    if (r && (r.situacao === "assumida" || r.situacao === "finalizada")) ouvinteRasc?.({ ...r, id_local: d.id_local });
  } catch (e) {
    if (ehErroDeRede(e)) marcarRede(false);
    // sem a migração 010 aplicada, a função não existe: ignora em silêncio
  }
}

export async function descartarRascunho(idLocal) {
  if (!idLocal) return;
  if (ultimoRasc?.id_local === idLocal) { ultimoRasc = null; apagar(chavePendRasc()); clearTimeout(timerRasc); }
  if (!navigator.onLine) return;
  try { await comTempo(rpc("descartar_rascunho", { p_id: idLocal, p_aparelho: aparelhoId() }), 8000); } catch { /* ignora */ }
}

/** Vendas em andamento em outros aparelhos desta loja. */
export async function rascunhosDeOutros() {
  const { data, error } = await comTempo(sb.from("vendas_rascunho")
    .select("id,operador_id,operador_nome,aparelho,aparelho_nome,itens,total,pago,atualizado_em")
    .neq("aparelho", aparelhoId()).order("atualizado_em", { ascending: false }).limit(20), 10000);
  if (error) return [];
  return data || [];
}

/** Traz a venda para este aparelho. Devolve o objeto da venda. */
export const assumirRascunho = (id) => rpc("assumir_rascunho", { p_id: id, p_aparelho: aparelhoId(), p_aparelho_nome: aparelhoNome() });

// ---------- Indicador de conexão / fila ----------
let elStatus = null;
function avisar() {
  window.dispatchEvent(new CustomEvent("contingencia", { detail: { online: estaOnline(), pendentes: fila().length } }));
  desenharStatus();
}
function desenharStatus() {
  if (!elStatus) return;
  const n = fila().length;
  const comErro = fila().filter((x) => x.erro).length;
  const on = estaOnline();
  if (on && !n) { elStatus.hidden = true; return; }
  elStatus.hidden = false;
  elStatus.className = "rede-status " + (on ? (comErro ? "erro" : "enviando") : "off");
  elStatus.textContent = !on
    ? `Sem internet · vendendo offline${n ? ` · ${n} ${n === 1 ? "venda aguardando" : "vendas aguardando"} envio` : ""}`
    : comErro ? `${comErro} ${comErro === 1 ? "venda offline precisa" : "vendas offline precisam"} de conferência · toque para ver`
      : `Enviando ${n} ${n === 1 ? "venda feita" : "vendas feitas"} sem internet…`;
  elStatus.title = "Vendas feitas sem internet ficam guardadas neste aparelho e são enviadas sozinhas quando a conexão volta.";
}

function sincronizarTudo() {
  if (!estado.perfil) return;
  sincronizarFila().catch(() => {});
  if (ultimoRasc || ler(chavePendRasc())) enviarRascunho();
}

/** Lista as vendas feitas sem internet que ainda não chegaram ao servidor. */
export async function abrirPainelFila() {
  const desenhar = (d) => {
    const f = fila();
    render(d.querySelector("#fila-corpo"), f.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Venda</th><th>Feita em</th><th class="r">Total</th><th>Situação</th><th></th></tr></thead>
      <tbody>${f.map((x) => html`<tr><td><strong>${x.numero_local || x.id_local.slice(0, 8)}</strong></td><td>${dataHora(x.payload?.realizada_em || x.criado_em)}</td>
        <td class="r">${dinheiro(x.total)}</td><td>${x.erro ? html`<span class="badge danger">${x.erro}</span>` : html`<span class="badge warn">aguardando envio</span>`}</td>
        <td class="r">${eh("admin", "gerente") ? html`<button class="btn sm ghost" data-desc="${x.id_local}">Descartar</button>` : ""}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma venda pendente. Tudo enviado.</p></div>`);
    d.querySelectorAll("[data-desc]").forEach((b) => (b.onclick = async () => {
      if (!(await confirmar("Descartar esta venda da fila? Ela NÃO será lançada no sistema (use só se já foi lançada manualmente).", { titulo: "Descartar venda offline", ok: "Descartar", perigo: true }))) return;
      descartarDaFila(b.dataset.desc); desenhar(d);
    }));
  };
  await modal({
    titulo: "Vendas feitas sem internet", largo: true,
    corpo: html`<div class="stack"><p class="muted small">Ficam guardadas neste aparelho e são enviadas sozinhas quando a internet volta, com a data e hora reais da venda. Reenviar é seguro: a mesma venda nunca é lançada duas vezes.</p><div id="fila-corpo"></div></div>`,
    rodape: html`<button class="btn" data-fechar>Fechar</button><button class="btn primary" id="fila-enviar">Enviar agora</button>`,
    onPronto: (d) => {
      desenhar(d);
      d.querySelector("#fila-enviar").onclick = async () => {
        if (!navigator.onLine) return toast("Ainda sem internet", "erro");
        // limpa a marca de erro para tentar de novo
        const f = fila(); f.forEach((x) => (x.erro = null)); salvarFila(f);
        const n = await sincronizarFila();
        toast(n ? `${n} venda(s) enviada(s)` : fila().length ? "Não foi possível enviar agora" : "Nada pendente", n ? "ok" : "");
        desenhar(d);
      };
    },
  });
}

let iniciado = false;
export function iniciarContingencia() {
  if (!elStatus) {
    elStatus = document.createElement("button");
    elStatus.type = "button";
    elStatus.hidden = true;
    elStatus.setAttribute("aria-live", "polite");
    elStatus.onclick = () => window.dispatchEvent(new Event("abrir-fila"));
    document.body.appendChild(elStatus);
  }
  desenharStatus();
  if (iniciado) { sincronizarTudo(); return; }
  iniciado = true;
  window.addEventListener("abrir-fila", () => abrirPainelFila().catch(() => {}));
  window.addEventListener("online", () => marcarRede(true));
  window.addEventListener("offline", () => marcarRede(false));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sincronizarTudo(); });
  // Rede de segurança: tenta de tempos em tempos enquanto houver algo pendente
  setInterval(() => { if (fila().length || ultimoRasc) sincronizarTudo(); }, 20000);
  // Testa a conexão de verdade (navigator.onLine diz "online" com Wi-Fi sem internet)
  setInterval(async () => {
    if (!fila().length && !semRede) return;
    try { const { error } = await comTempo(sb.from("empresas").select("id", { head: true, count: "exact" }).limit(1), 6000); marcarRede(!error || !ehErroDeRede(error)); }
    catch { marcarRede(false); }
  }, 15000);
  sincronizarTudo();
}
