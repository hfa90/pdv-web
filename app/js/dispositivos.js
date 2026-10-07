// =====================================================================
// Acesso vinculado ao aparelho
// ---------------------------------------------------------------------
// Cada usuário só usa o sistema nos aparelhos liberados para ele (limite por
// nível, definido pelo fornecedor em Plataforma › Lojas › Aparelhos).
// - Ao entrar, o sistema apresenta o código do aparelho; o servidor vincula
//   (se houver vaga) e devolve uma chave secreta, guardada aqui no navegador.
// - api.js manda código + chave em toda chamada ao banco; o servidor confere em
//   toda venda e movimento de caixa (supabase/migrations/018_dispositivos.sql).
// - A loja troca aparelhos em Usuários › Aparelhos (limite de trocas por mês).
// Atendente/garçom é livre por padrão (usa vários celulares).
// =====================================================================
import { sb, rpc, chaveDoAparelho } from "./api.js";
import { obterDispositivo } from "../../assets/dispositivo.js";
import { aparelhoNome } from "./contingencia.js";
import { html, render, $, $$, toast, erro, dataHora, pedirTexto, confirmar, modal, raw } from "./ui.js";
import { icone } from "./icons.js";

const NIVEIS = { admin: "Administrador", gerente: "Gerente", caixa: "Caixa", cozinha: "Cozinha", atendente: "Atendente / garçom" };
const EVENTOS = {
  vinculado: ["ok", "Aparelho vinculado"], recusado: ["danger", "Tentou usar em aparelho não liberado"],
  conflito: ["danger", "Código do aparelho copiado para outro"], uso_simultaneo: ["danger", "Mesma chave usada em dois lugares ao mesmo tempo"],
  outro_navegador: ["warn", "Navegador/tela diferente do vinculado"], chave_renovada: ["", "Chave renovada (mesmo aparelho)"],
  desvinculado: ["warn", "Aparelho desvinculado"], renomeado: ["", "Aparelho renomeado"], config: ["info", "Limites alterados pelo suporte"],
};

// ---------- Chave do aparelho (localStorage + cookie: um restaura o outro) ----------
function gravarChave(uid, tk) {
  try { localStorage.setItem("lis-disp-tk-" + uid, tk); } catch { /* ignora */ }
  document.cookie = `lis-disp-tk-${uid.slice(0, 8)}=${tk}; max-age=${400 * 86400}; path=/; samesite=lax; secure`;
}

/** Resumo estável do aparelho (sem a versão do navegador, que muda a cada atualização). */
export async function impressaoEstavel() {
  const p = [navigator.platform, navigator.language, screen.width + "x" + screen.height + "x" + screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency, navigator.deviceMemory,
    /Edg\//.test(navigator.userAgent) ? "edge" : /Chrome\//.test(navigator.userAgent) ? "chrome" : /Firefox\//.test(navigator.userAgent) ? "firefox" : "outro"];
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) p.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch { /* sem webgl */ }
  const txt = p.join("|");
  if (crypto?.subtle) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }
  let h = 0x811c9dc5; for (let i = 0; i < txt.length; i++) { h ^= txt.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

export const codigoCurto = () => obterDispositivo().slice(0, 6).toUpperCase();

/**
 * Pergunta ao servidor se este aparelho pode ser usado por este usuário.
 * status: livre | liberado | vinculado | limite | conflito  (null sem a migração 018)
 */
export async function verificarDispositivo(uid) {
  const ap = obterDispositivo();
  const ua = navigator.userAgent;
  const { data, error } = await sb.rpc("dispositivo_verificar", {
    p_aparelho: ap, p_token: chaveDoAparelho(uid), p_nome: aparelhoNome(), p_impressao: await impressaoEstavel(),
    p_info: { navegador: (ua.match(/(Edg|OPR|Chrome|Firefox|Safari)\/\d+/) || [""])[0], so: (ua.match(/Windows NT [\d.]+|Android [\d.]+|iPhone OS [\d_]+|Mac OS X [\d_]+|Linux/) || [""])[0],
      tela: `${screen.width}x${screen.height}` },
  });
  if (error) {
    if (/dispositivo_verificar|PGRST202|schema cache|Could not find/i.test(error.message + error.code)) return { status: "livre", sem_migracao: true };
    throw new Error(error.message);
  }
  if (data?.token) gravarChave(uid, data.token);
  if (["limite", "conflito"].includes(data?.status)) {
    window.lisDiag?.registrar({ tipo: "erro", origem: "tela", gravidade: "alta", mensagem: `Aparelho não autorizado (${data.status}) para este usuário`,
      tecnico: { status: data.status, limite: data.limite, usados: data.usados, aparelho: codigoCurto() } });
  }
  return { ...data, aparelho: codigoCurto() };
}

// ---------- Tela de bloqueio ----------
/** Mostrada no lugar do sistema quando o aparelho não está liberado. */
export function telaAparelhoBloqueado(app, info, { tentar, sair, gestor = false }) {
  const conflito = info.status === "conflito";
  const restam = Math.max(0, (info.trocas_mes ?? 3) - (info.trocas ?? 0));
  render(app, html`<div class="page" style="max-width:620px;margin:6vh auto">
    <div class="panel panel-pad stack" style="gap:1rem">
      <div class="row" style="gap:.9rem;align-items:flex-start">
        <div style="display:grid;place-items:center;width:56px;height:56px;border-radius:16px;background:var(--danger-soft);color:var(--danger);flex:none">${icone("escudo", 'width="28" height="28"')}</div>
        <div><h1 style="font-size:1.35rem;margin:0 0 .25rem">Este aparelho não está liberado para o seu acesso</h1>
          <p class="muted" style="margin:0">${conflito
            ? "O código deste aparelho já está vinculado, mas a chave não confere. Isso acontece quando o acesso é copiado para outro computador."
            : `Seu usuário pode ser usado em ${info.limite} ${info.limite === 1 ? "aparelho" : "aparelhos"}, e ${info.limite === 1 ? "ele já está vinculado" : "todos já estão em uso"}.`}</p></div>
      </div>
      ${info.aparelhos?.length ? html`<div><strong class="small">Aparelhos liberados para você</strong>
        <ul class="stack" style="list-style:none;padding:0;margin:.5rem 0 0;gap:.4rem">${info.aparelhos.map((a) => html`<li class="row" style="justify-content:space-between;padding:.6rem .8rem;border:1px solid var(--line);border-radius:var(--r-md)">
          <span>${icone("caixa", 'width="16" height="16" style="vertical-align:-3px"')} <strong>${a.nome}</strong> <span class="muted small">· último uso ${a.ultimo_uso ? dataHora(a.ultimo_uso) : "—"}</span></span>
          ${gestor ? html`<button class="btn sm" data-trocar="${a.id}" data-nome="${a.nome}">Usar este no lugar</button>` : ""}</li>`)}</ul></div>` : ""}
      <div class="alerta info"><strong>O que fazer</strong>
        <ol style="margin:.4rem 0 0;padding-left:1.2rem">
          <li>Use o sistema no aparelho liberado.</li>
          <li>Se o aparelho foi trocado (quebrou, formatou), o administrador da loja libera em <b>Usuários › Aparelhos</b>${restam != null ? ` (${restam} ${restam === 1 ? "troca restante" : "trocas restantes"} neste mês)` : ""}.</li>
          <li>Precisa de mais aparelhos? Fale com o suporte para aumentar o limite do plano.</li>
        </ol></div>
      <p class="small muted" style="margin:0">Código deste aparelho: <strong style="letter-spacing:.12em">${info.aparelho || codigoCurto()}</strong> · ${aparelhoNome()}</p>
      <div class="row" style="gap:.5rem;flex-wrap:wrap"><button class="btn primary" id="ap-tentar">Tentar de novo</button><button class="btn" id="ap-sair">Sair</button>
        <button class="btn ghost" id="ap-diag">Diagnóstico</button></div>
    </div></div>`);
  $("#ap-tentar").onclick = tentar;
  $("#ap-sair").onclick = sair;
  $("#ap-diag").onclick = () => window.lisDiag?.abrir();
  $$("[data-trocar]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmar(`Desvincular “${b.dataset.nome}” e liberar ESTE aparelho no lugar? Conta como 1 troca do mês (restam ${restam}).`, { titulo: "Trocar aparelho", ok: "Trocar" }))) return;
    try { await rpc("dispositivo_desvincular", { p_id: b.dataset.trocar, p_motivo: "Troca feita pelo próprio usuário na tela de bloqueio" }); tentar(); }
    catch (e) { erro(e); }
  }));
}

// ---------- Gestão: Usuários › Aparelhos e Plataforma › Lojas › Aparelhos ----------
/** Painel com os aparelhos da loja. `empresa` só para o fornecedor (outra loja). */
export async function painelAparelhos(el, { empresa = null } = {}) {
  const meu = codigoCurto();
  async function carregar() {
    let d;
    try { d = await rpc("dispositivos_listar", { p_empresa: empresa }); }
    catch (e) {
      render(el, /dispositivos_listar|schema cache|Could not find/i.test(e.tecnico?.mensagem_original || e.message)
        ? html`<div class="alerta warn">Para usar o vínculo de aparelhos, rode <code>supabase/migrations/018_dispositivos.sql</code> no Supabase.</div>`
        : html`<div class="alerta danger">${e.message}</div>`);
      return;
    }
    const c = d.config;
    const lim = (p) => Number(c.limites?.[p] ?? 1);
    const restam = Math.max(0, Number(c.trocas_mes) - d.trocas);
    const alertas = d.eventos.filter((e) => ["recusado", "conflito", "uso_simultaneo", "outro_navegador"].includes(e.tipo));
    render(el, html`<div class="stack" style="gap:1rem">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:.75rem">
        <div><h2 style="margin:0">${icone("escudo", 'width="18" height="18" style="vertical-align:-3px"')} Aparelhos autorizados</h2>
          <p class="muted small" style="margin:.2rem 0 0">${c.ativo ? html`Cada usuário só entra nos aparelhos liberados para ele. O primeiro acesso em um aparelho vincula sozinho enquanto houver vaga.` : html`<strong>Vínculo desligado</strong> para esta loja: qualquer aparelho pode ser usado.`}</p></div>
        <div class="row" style="gap:.4rem;flex-wrap:wrap">
          ${c.ativo ? Object.entries(NIVEIS).map(([p, n]) => html`<span class="badge">${n}: ${lim(p) ? lim(p) : "livre"}</span>`) : ""}
          <span class="badge ${restam ? "" : "danger"}">Trocas em 30 dias: ${d.trocas} de ${c.trocas_mes}</span></div>
      </div>
      ${d.plataforma ? html`<form class="panel panel-pad stack" id="ap-cfg" style="gap:.6rem;background:var(--primary-soft)">
        <strong>Configuração do fornecedor (só você vê)</strong>
        <label class="check"><input type="checkbox" name="ativo" ${c.ativo ? "checked" : ""}> Exigir aparelho vinculado nesta loja</label>
        <div class="row" style="gap:.5rem;flex-wrap:wrap">${Object.entries(NIVEIS).map(([p, n]) => html`<label class="field" style="width:130px"><span>${n}</span>
          <input class="input" type="number" min="0" max="50" name="l_${p}" value="${lim(p)}"></label>`)}
          <label class="field" style="width:130px"><span>Trocas por mês</span><input class="input" type="number" min="0" max="50" name="trocas" value="${c.trocas_mes}"></label></div>
        <p class="hint" style="margin:0">0 = sem limite (não vincula). Suas desvinculações não contam nas trocas da loja.</p>
        <div><button class="btn primary sm">Salvar limites</button></div></form>` : ""}
      ${alertas.length ? html`<div class="alerta warn"><strong>${alertas.length} ${alertas.length === 1 ? "aviso" : "avisos"} de uso indevido</strong>
        <ul style="margin:.4rem 0 0;padding-left:1.1rem">${alertas.slice(0, 8).map((e) => html`<li>${dataHora(e.criado_em)} · <strong>${e.usuario || "?"}</strong> · ${EVENTOS[e.tipo]?.[1] || e.tipo}${e.aparelho_nome ? ` (${e.aparelho_nome})` : ""}${e.ip ? html` <span class="muted small">IP ${e.ip}</span>` : ""}</li>`)}</ul></div>` : ""}
      <div class="table-wrap"><table class="table"><thead><tr><th>Usuário</th><th>Aparelhos</th><th class="r">Vagas</th></tr></thead>
        <tbody>${d.usuarios.map((u) => html`<tr>
          <td><strong>${u.nome}</strong>${u.ativo ? "" : html` <span class="badge danger">bloqueado</span>`}<div class="small muted">${NIVEIS[u.papel] || u.papel}</div></td>
          <td>${!u.limite ? html`<span class="muted small">Livre: usa qualquer aparelho</span>`
            : u.aparelhos.length ? html`<div class="stack" style="gap:.35rem">${u.aparelhos.map((a) => html`<div class="row" style="gap:.5rem;flex-wrap:wrap;align-items:center">
                <span>${icone("caixa", 'width="15" height="15" style="vertical-align:-3px"')} <strong>${a.nome}</strong></span>
                ${a.aparelho.toUpperCase() === meu ? html`<span class="badge info">este aparelho</span>` : ""}
                ${a.suspeitas ? html`<span class="badge danger" title="Uso em dois lugares ou chave copiada">${a.suspeitas} suspeita(s)</span>` : ""}
                <span class="small muted">${a.info?.navegador || ""} ${a.info?.so || ""} · código ${a.aparelho.toUpperCase()} · último uso ${a.ultimo_uso ? dataHora(a.ultimo_uso) : "—"}</span>
                <button class="btn sm ghost" data-ren="${a.id}" data-nome="${a.nome}">Renomear</button>
                <button class="btn sm ghost" data-des="${a.id}" data-nome="${a.nome}" data-u="${u.nome}">Desvincular</button></div>`)}</div>`
            : html`<span class="muted small">Nenhum ainda: o próximo acesso vincula</span>`}</td>
          <td class="r">${u.limite ? html`<span class="badge ${u.aparelhos.length >= u.limite ? "warn" : "ok"}">${u.aparelhos.length} de ${u.limite}</span>` : "—"}</td></tr>`)}</tbody></table></div>
      ${d.eventos.length ? html`<details><summary class="small" style="cursor:pointer">Histórico de aparelhos (${d.eventos.length})</summary>
        <div class="table-wrap" style="margin-top:.5rem"><table class="table"><tbody>${d.eventos.map((e) => html`<tr><td class="small">${dataHora(e.criado_em)}</td><td class="small">${e.usuario || ""}</td>
          <td><span class="badge ${EVENTOS[e.tipo]?.[0] || ""}">${EVENTOS[e.tipo]?.[1] || e.tipo}</span></td><td class="small muted">${e.aparelho_nome || ""} ${e.aparelho ? "· " + e.aparelho.toUpperCase() : ""} ${e.ip ? "· IP " + e.ip : ""}</td></tr>`)}</tbody></table></div></details>` : ""}
    </div>`);
    $$("[data-ren]", el).forEach((b) => (b.onclick = async () => {
      const nome = await pedirTexto({ titulo: "Nome do aparelho", rotulo: "Ex.: Caixa 1, Notebook do escritório", valor: b.dataset.nome, minimo: 2 });
      if (!nome) return;
      try { await rpc("dispositivo_renomear", { p_id: b.dataset.ren, p_nome: nome }); toast("Aparelho renomeado", "ok"); carregar(); } catch (e) { erro(e); }
    }));
    $$("[data-des]", el).forEach((b) => (b.onclick = async () => {
      const aviso = d.plataforma ? "(não conta nas trocas da loja)" : `Conta como 1 troca: restam ${restam} nos últimos 30 dias.`;
      if (!(await confirmar(`Desvincular “${b.dataset.nome}” de ${b.dataset.u}? O próximo aparelho em que ${b.dataset.u} entrar fica com a vaga. ${aviso}`, { titulo: "Desvincular aparelho", ok: "Desvincular", perigo: true }))) return;
      try { await rpc("dispositivo_desvincular", { p_id: b.dataset.des, p_motivo: null }); toast("Aparelho desvinculado", "ok"); carregar(); } catch (e) { erro(e); }
    }));
    const f = $("#ap-cfg", el);
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const limites = Object.fromEntries(Object.keys(NIVEIS).map((p) => [p, Number(f["l_" + p].value) || 0]));
      try { await rpc("plataforma_config_dispositivos", { p_empresa: empresa, p_config: { ativo: f.ativo.checked, trocas_mes: Number(f.trocas.value) || 0, limites } }); toast("Limites salvos", "ok"); carregar(); }
      catch (er) { erro(er); }
    };
  }
  await carregar();
}

/** Plataforma: abre o painel de aparelhos de uma loja num modal. */
export function modalAparelhosLoja(loja) {
  return modal({ titulo: `Aparelhos · ${loja.loja}`, largo: true, corpo: html`<div id="ap-loja">${raw('<div class="loading"><div class="spinner"></div></div>')}</div>`,
    onPronto: (d) => painelAparelhos(d.querySelector("#ap-loja"), { empresa: loja.id }) });
}
