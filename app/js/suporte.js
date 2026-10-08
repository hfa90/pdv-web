// Superusuário e equipe de suporte (migração 020):
// - faixa do modo suporte (dentro da loja de um cliente), entrar e sair da loja;
// - avisos da plataforma para as lojas;
// - "Pedir ajuda": chamado com código de 6 números (funciona até sem login);
// - aviso na hora para a equipe quando alguém abre um chamado.
import { sb, rpc } from "./api.js";
import { estado } from "./estado.js";
import { html, render, modal, toast, erro, confirmar, dataHora } from "./ui.js";
import { icone } from "./icons.js";

const lerLS = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const gravarLS = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };

// =====================================================================
// Modo suporte
// =====================================================================
const MODOS = {
  leitura: { nome: "Somente leitura", desc: "Vê tudo como administrador. O banco recusa qualquer alteração." },
  total: { nome: "Acesso total", desc: "Age como administrador da loja: configura, cadastra, redefine senhas e corrige dados." },
};

function restante(fim) {
  const s = Math.max(0, Math.round((new Date(fim) - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`;
}

let relogioFaixa = null;
/** Faixa fixa no topo enquanto o superusuário/suporte está dentro da loja de um cliente. */
export function desenharFaixaSuporte(alvo) {
  clearInterval(relogioFaixa);
  const s = estado.suporte;
  if (!alvo) return;
  if (!s) { render(alvo, ""); alvo.hidden = true; return; }
  alvo.hidden = false;
  const desenhar = () => {
    if (new Date(s.expira_em) <= Date.now()) {
      clearInterval(relogioFaixa);
      toast("O tempo do acesso de suporte terminou.", "erro");
      setTimeout(() => { location.hash = "#/suporte"; location.reload(); }, 1200);
      return;
    }
    const pouco = new Date(s.expira_em) - Date.now() < 10 * 60e3;
    render(alvo, html`<div class="faixa-suporte ${s.modo}">
      <span class="fs-ic">${icone("headset", 'width="18" height="18"')}</span>
      <span class="fs-txt"><strong>Modo suporte</strong> · ${s.loja}
        <span class="fs-motivo" title="${s.motivo}">· ${s.motivo}</span></span>
      <span class="grow"></span>
      <div class="fs-modos" role="group" aria-label="Modo de acesso">
        <button data-m="leitura" class="${s.modo === "leitura" ? "ativo" : ""}" title="${MODOS.leitura.desc}">${icone("olho", 'width="15" height="15"')} Leitura</button>
        <button data-m="total" class="${s.modo === "total" ? "ativo" : ""}" title="${MODOS.total.desc}">${icone("editar", 'width="15" height="15"')} Total</button>
      </div>
      <span class="fs-tempo ${pouco ? "pouco" : ""}" title="Termina ${dataHora(s.expira_em)}">${icone("relogio", 'width="15" height="15"')} ${restante(s.expira_em)}</span>
      <button class="fs-btn" data-a="mais" title="Mais 30 minutos">+30 min</button>
      <button class="fs-btn sair" data-a="sair">${icone("sair", 'width="15" height="15"')} Sair da loja</button>
    </div>`);
    alvo.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => trocarModo(b.dataset.m)));
    alvo.querySelector('[data-a="mais"]').onclick = async () => {
      try { Object.assign(s, await rpc("suporte_estender", { p_minutos: 30 })); toast("Mais 30 minutos de acesso", "ok"); desenhar(); } catch (e) { erro(e); }
    };
    alvo.querySelector('[data-a="sair"]').onclick = () => sairDaLoja();
  };
  desenhar();
  relogioFaixa = setInterval(desenhar, 30000);
}

async function trocarModo(modo) {
  if (estado.suporte?.modo === modo) return;
  if (modo === "total" && !(await confirmar(`No acesso total você age como administrador da loja ${estado.suporte.loja}. Tudo o que fizer fica no registro de atividades dela, marcado como suporte.`, { titulo: "Liberar acesso total?", ok: "Liberar" }))) return;
  try {
    estado.suporte = await rpc("suporte_modo", { p_modo: modo });
    toast(modo === "total" ? "Acesso total liberado" : "Voltou para somente leitura", "ok");
    desenharFaixaSuporte(document.getElementById("faixa-suporte"));
  } catch (e) { erro(e); }
}

/** Janela para entrar numa loja: modo, tempo e motivo (o motivo fica registrado para a loja). */
export async function entrarNaLoja(loja, { chamado = null } = {}) {
  const r = await modal({
    titulo: `Entrar em ${loja.loja}`,
    corpo: html`<form id="f-entrar" class="stack">
      <p class="muted small">Você vai usar o sistema desta loja como administrador. A entrada, o motivo e a saída ficam no registro de atividades dela.</p>
      <div class="opcoes-modo">${Object.entries(MODOS).map(([k, m]) => html`<label class="opcao-modo">
        <input type="radio" name="modo" value="${k}" ${k === "leitura" ? "checked" : ""}>
        <span><strong>${m.nome}</strong><small>${m.desc}</small></span></label>`)}</div>
      <label class="field"><span>Motivo</span><input class="input" name="motivo" required minlength="5" maxlength="300"
        value="${chamado ? `Chamado ${chamado.codigo}${chamado.mensagem ? ": " + chamado.mensagem.slice(0, 120) : ""}` : ""}" placeholder="Ex.: cliente não consegue imprimir o cupom" autofocus></label>
      <label class="field"><span>Por quanto tempo</span><select class="input" name="minutos">
        ${[[15, "15 minutos"], [30, "30 minutos"], [60, "1 hora"], [120, "2 horas"], [240, "4 horas"], [480, "8 horas"]].map(([v, n]) => html`<option value="${v}" ${v === 60 ? "selected" : ""}>${n}</option>`)}</select></label>
    </form>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-entrar">${icone("entrar", 'width="18" height="18"')} Entrar na loja</button>`,
    onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const f = e.target; fechar({ modo: f.modo.value, motivo: f.motivo.value.trim(), minutos: Number(f.minutos.value) }); }; },
  });
  if (!r) return;
  try {
    await rpc("suporte_entrar", { p_empresa: loja.id, p_modo: r.modo, p_motivo: r.motivo, p_minutos: r.minutos, p_chamado: chamado?.id || null });
    location.hash = "#/painel";
    location.reload();
  } catch (e) { erro(e); }
}

export async function sairDaLoja() {
  try { await rpc("suporte_sair"); } catch (e) { return erro(e); }
  location.hash = "#/suporte";
  location.reload();
}

// =====================================================================
// Avisos da plataforma (manutenção, novidades) no topo do sistema
// =====================================================================
const CHAVE_AVISOS = "lis-avisos-vistos";
const TIPOS_AVISO = { info: "info", novidade: "ok", alerta: "warn", manutencao: "warn" };

export async function iniciarAvisosPlataforma(alvo) {
  if (!alvo) return;
  const desenhar = async () => {
    let lista = [];
    try { const { data, error } = await sb.rpc("avisos_ativos"); if (!error) lista = data || []; } catch { return; }
    const vistos = lerLS(CHAVE_AVISOS) || [];
    const mostrar = lista.filter((a) => a.fixo || !vistos.includes(a.id));
    render(alvo, mostrar.length ? html`${mostrar.map((a) => html`<div class="aviso-plat ${TIPOS_AVISO[a.tipo] || "info"}">
      ${icone(a.tipo === "manutencao" ? "config" : a.tipo === "novidade" ? "estrela" : a.tipo === "alerta" ? "alerta" : "megafone", 'width="18" height="18"')}
      <div class="grow"><strong>${a.titulo}</strong> <span>${a.mensagem}</span>
        ${a.link ? html` <a href="${/^https:\/\//.test(a.link) ? a.link : "#"}" target="_blank" rel="noopener">Saiba mais</a>` : ""}</div>
      ${a.fixo ? "" : html`<button class="btn ghost icon-btn sm" data-dispensar="${a.id}" aria-label="Dispensar aviso">✕</button>`}</div>`)}` : "");
    alvo.querySelectorAll("[data-dispensar]").forEach((b) => (b.onclick = () => {
      gravarLS(CHAVE_AVISOS, [...(lerLS(CHAVE_AVISOS) || []), b.dataset.dispensar].slice(-100)); desenhar();
    }));
  };
  await desenhar();
  setInterval(desenhar, 10 * 60e3);
}

// =====================================================================
// Pedir ajuda (chamado com código)
// =====================================================================
const CHAVE_CHAMADO = "lis-chamado";
const NOME_STATUS = { aguardando: "Aguardando o suporte", em_atendimento: "Em atendimento", resolvido: "Resolvido", cancelado: "Cancelado", expirado: "Expirado" };

function infoAparelho(app) {
  const c = (() => { try { return window.lisDiag?.contexto?.() || {}; } catch { return {}; } })();
  return {
    rota: location.hash || location.pathname, tela: `${screen.width}x${screen.height}`, navegador: navigator.userAgent.slice(0, 200),
    versao: window.lisDiag?.versao, aparelho: c.aparelho, loja_codigo: (() => { try { return localStorage.getItem("garcom-loja") || undefined; } catch { return undefined; } })(),
    online: navigator.onLine, app,
  };
}

/** Abre a janela "Pedir ajuda". Se já há um chamado aberto neste aparelho, mostra o código dele. */
export async function pedirAjuda({ app = "pdv" } = {}) {
  const aberto = lerLS(CHAMADO_KEY());
  if (aberto) {
    try {
      const { data } = await sb.rpc("chamado_estado", { p_id: aberto.id, p_segredo: aberto.segredo });
      if (data && ["aguardando", "em_atendimento"].includes(data.status)) return mostrarChamado(aberto);
    } catch { /* abre um novo */ }
    gravarLS(CHAMADO_KEY(), null);
  }
  const dados = await modal({
    titulo: "Pedir ajuda ao suporte",
    corpo: html`<form id="f-ajuda" class="stack">
      <p class="muted small">Conte rapidinho o que está acontecendo. Você recebe um código de 6 números para falar com o suporte, e ele já vê os detalhes deste aparelho.</p>
      <label class="field"><span>O que está acontecendo?</span><textarea class="input" name="msg" rows="3" maxlength="1000" required placeholder="Ex.: a impressora parou de imprimir o cupom"></textarea></label>
      <label class="field"><span>WhatsApp ou telefone para retorno (opcional)</span><input class="input" name="contato" inputmode="tel" maxlength="40"></label>
    </form>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-ajuda">${icone("headset", 'width="18" height="18"')} Pedir ajuda</button>`,
    onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); fechar({ msg: e.target.msg.value.trim(), contato: e.target.contato.value.trim() }); }; },
  });
  if (!dados) return;
  try {
    const { data, error } = await sb.rpc("chamado_abrir", { p_app: app, p_mensagem: dados.msg, p_contato: dados.contato || null, p_info: infoAparelho(app) });
    if (error) throw new Error(/chamado_abrir|function/i.test(error.message) ? "O suporte ainda não está disponível neste sistema." : error.message);
    gravarLS(CHAMADO_KEY(), data);
    mostrarChamado(data);
  } catch (e) { erro(e); }
}
const CHAMADO_KEY = () => CHAVE_CHAMADO;

function mostrarChamado(c) {
  let relogio = null;
  modal({
    titulo: "Chamado aberto",
    corpo: html`<div class="chamado-cod">
      <p class="muted">Informe este código ao suporte:</p>
      <div class="cod-grande" aria-label="Código do chamado">${c.codigo.slice(0, 3)} ${c.codigo.slice(3)}</div>
      <p id="ch-status" class="small"><span class="badge warn">${NOME_STATUS.aguardando}</span></p>
      <p class="muted small">Pode fechar esta janela e continuar usando o sistema. Para ver o código de novo, toque em “Pedir ajuda”.</p></div>`,
    rodape: html`<button class="btn ghost" id="ch-cancelar">Cancelar chamado</button><button class="btn primary" data-fechar>Ok</button>`,
    onPronto: (d, fechar) => {
      const atualizar = async () => {
        try {
          const { data } = await sb.rpc("chamado_estado", { p_id: c.id, p_segredo: c.segredo });
          if (!data || !d.isConnected) return;
          const cls = data.status === "em_atendimento" ? "info" : data.status === "resolvido" ? "ok" : data.status === "aguardando" ? "warn" : "";
          render(d.querySelector("#ch-status"), html`<span class="badge ${cls}">${NOME_STATUS[data.status] || data.status}</span>
            ${data.atendido_nome ? html` <span class="muted">com ${data.atendido_nome}</span>` : ""}${data.nota ? html`<span class="d-block muted">${data.nota}</span>` : ""}`);
          if (!["aguardando", "em_atendimento"].includes(data.status)) { gravarLS(CHAMADO_KEY(), null); clearInterval(relogio); }
        } catch { /* sem rede */ }
      };
      atualizar();
      relogio = setInterval(atualizar, 8000);
      d.addEventListener("close", () => clearInterval(relogio));
      d.querySelector("#ch-cancelar").onclick = async () => {
        try { await sb.rpc("chamado_cancelar", { p_id: c.id, p_segredo: c.segredo }); } catch { /* ignora */ }
        gravarLS(CHAMADO_KEY(), null); toast("Chamado cancelado"); fechar();
      };
    },
  });
}

// =====================================================================
// Equipe: aviso na hora quando alguém abre um chamado
// =====================================================================
let canalChamados = null;
export function iniciarAlertaChamados() {
  if (!estado.equipe || canalChamados) return;
  const contar = async () => {
    try {
      const lista = await rpc("chamado_fila", { p_horas: 3 });
      const n = lista.filter((c) => c.status === "aguardando").length;
      const link = document.querySelector('.nav a[data-rota="suporte"]');
      if (!link) return;
      let b = link.querySelector(".nav-badge");
      if (!b) { b = document.createElement("span"); b.className = "nav-badge"; link.appendChild(b); }
      b.textContent = n; b.hidden = !n;
      window.dispatchEvent(new CustomEvent("chamados", { detail: lista }));
    } catch { /* sem a migração */ }
  };
  canalChamados = sb.channel("suporte-chamados-" + Date.now())
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "suporte_chamados" }, async (p) => {
      const c = p.new || {};
      toast(`Novo chamado ${c.codigo}${c.loja_nome ? " · " + c.loja_nome : ""}${c.mensagem ? ": " + c.mensagem.slice(0, 60) : ""}`, "ok");
      try { (await import("./avisos.js")).bipe(2); } catch { /* sem som */ }
      contar();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "suporte_chamados" }, contar)
    .subscribe();
  contar();
}
export function pararAlertaChamados() { if (canalChamados) sb.removeChannel(canalChamados); canalChamados = null; }

export { MODOS, NOME_STATUS };
