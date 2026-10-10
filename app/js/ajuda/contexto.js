// =====================================================================
// Ajuda no lugar certo:
//  - botão "Ajuda" do menu lateral e tecla F1: a ajuda da tela aberta;
//  - apresentação do primeiro acesso, diferente para cada nível;
//  - "Ajuda" ao lado do erro (o aviso vermelho leva à busca com a mensagem).
// =====================================================================
import { estado, pode, papel, ehSuper, tituloRota, ROTAS, PAPEIS } from "../estado.js";
import { html, render, modal, erro } from "../ui.js";
import { icone } from "../icons.js";
import { TELAS, PAPEIS_AJUDA } from "./telas.js";
import { porId, podeVer, sugerir } from "./busca.js";

const rotaAtual = () => location.hash.replace(/^#\/?/, "").split("/")[0] || "";
const perfil = () => ({ papel: papel(), equipe: !!estado.equipe, super: ehSuper() });

/** Ajuda da tela aberta (F1 ou botão Ajuda). */
export function abrirAjudaDaTela(rota = rotaAtual()) {
  if (document.querySelector("dialog.ajuda-tela-modal[open]")) return;
  if (rota === "ajuda") { document.getElementById("q")?.focus(); return; }
  const t = TELAS[rota];
  const d = t ? porId(t.artigo) : null;
  const visivel = d && podeVer(d, perfil());
  import("../paginas/ajuda.js").then((m) => m.registrar("tela", { artigo: t?.artigo || null })).catch(() => {});
  return modal({
    titulo: t ? `Ajuda: ${tituloRota(rota)}` : "Ajuda",
    largo: true,
    corpo: html`<div class="stack ajuda-modal">
      ${t ? html`<p class="ajuda-resumo">${t.desc}</p>` : ""}
      ${visivel && d.passos?.length ? html`<h3>Como usar</h3><ol class="ajuda-passos compacto">${d.passos.map((x) => html`<li>${x}</li>`)}</ol>` : ""}
      ${visivel && d.dicas?.length ? html`<div class="ajuda-caixa dica"><strong>${icone("lampada", 'width="16" height="16"')} Dicas</strong><ul>${d.dicas.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
      <form id="f-ajuda-rapida" class="ajuda-busca mini" autocomplete="off" role="search">
        <span class="ajuda-lupa">${icone("busca", 'width="18" height="18"')}</span>
        <input class="input" name="q" placeholder="Outra dúvida? Escreva aqui do seu jeito" aria-label="Sua dúvida" autofocus maxlength="500">
        <button class="btn primary">Buscar</button>
      </form>
      <div id="ajuda-rapida-sug" class="ajuda-resultados mini"></div>
    </div>`,
    rodape: html`${estado.equipe ? "" : html`<button class="btn" id="aj-suporte">${icone("headset", 'width="18" height="18"')} Falar com o suporte</button>`}
      ${visivel ? html`<a class="btn" href="#/ajuda/a/${d.id}" data-ir>Ver explicação completa</a>` : ""}
      <a class="btn primary" href="#/ajuda" data-ir>${icone("ajuda", 'width="18" height="18"')} Central de Ajuda</a>`,
    onPronto: (dlg, fechar) => {
      dlg.classList.add("ajuda-tela-modal");
      dlg.querySelectorAll("[data-ir]").forEach((a) => a.addEventListener("click", () => fechar()));
      dlg.querySelector("#aj-suporte")?.addEventListener("click", () => { fechar(); import("../suporte.js").then((m) => m.pedirAjuda({ app: "pdv" })).catch(erro); });
      const inp = dlg.querySelector("[name=q]"), sug = dlg.querySelector("#ajuda-rapida-sug");
      inp.addEventListener("input", () => {
        const l = sugerir(inp.value, { perfil: perfil(), limite: 5 });
        render(sug, html`${l.map((x) => html`<a class="ajuda-res compacto" href="#/ajuda/a/${x.id}" data-ir>${x.titulo}</a>`)}`);
        sug.querySelectorAll("[data-ir]").forEach((a) => a.addEventListener("click", () => fechar()));
      });
      dlg.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        const v = inp.value.trim(); if (!v) return;
        fechar(); location.hash = "#/ajuda/q/" + encodeURIComponent(v);
      };
    },
  });
}

/** Tecla F1 em qualquer tela. */
let atalhoLigado = false;
export function iniciarAtalhoAjuda() {
  if (atalhoLigado) return;
  atalhoLigado = true;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "F1" || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    if (!estado.perfil) return;
    abrirAjudaDaTela();
  });
}

/** Texto do menu ao passar o mouse: para que serve a tela. */
export const dicaDoMenu = (rota) => (TELAS[rota] ? `${tituloRota(rota)}: ${TELAS[rota].desc}` : tituloRota(rota));

// =====================================================================
// Apresentação do primeiro acesso (por pessoa e por nível)
// =====================================================================
const CHAVE_TOUR = (uid, p) => `lis-tour-${uid}-${p}`;
const lerLS = (k) => { try { return localStorage.getItem(k); } catch { return "1"; } };   // sem armazenamento: não insiste
const gravarLS = (k) => { try { localStorage.setItem(k, new Date().toISOString()); } catch { /* ok */ } };

/** Mostra a apresentação se esta pessoa ainda não viu (neste nível). */
export function talvezMostrarTour() {
  const uid = estado.usuario?.id, p = papel();
  if (!uid || !p || estado.suporte || estado.offline) return;
  if (lerLS(CHAVE_TOUR(uid, p))) return;
  // espera os avisos obrigatórios (ex.: mudança de setor) e não atropela outra janela
  let tentativas = 0;
  const tentar = () => {
    if (document.querySelector("dialog[open]")) { if (++tentativas < 40) setTimeout(tentar, 3000); return; }
    gravarLS(CHAVE_TOUR(uid, p));
    mostrarTour();
  };
  setTimeout(tentar, 1800);
}

export function mostrarTour() {
  const p = papel();
  const pa = PAPEIS_AJUDA[p] || PAPEIS_AJUDA.caixa;
  const telas = Object.keys(ROTAS).filter((r) => pode(r) && TELAS[r] && r !== "ajuda");
  const nome = String(estado.perfil?.nome || "").split(" ")[0];
  const passos = [
    { titulo: nome ? `Bem-vindo(a), ${nome}!` : "Bem-vindo(a)!", corpo: html`<div class="tour-passo">
        <span class="tour-ic">${icone("ajuda", 'width="40" height="40"')}</span>
        <h3>${pa.titulo}</h3><p>${pa.texto}</p>
        <p class="muted small">São só 4 telinhas. Dá para rever quando quiser na Central de Ajuda.</p></div>` },
    { titulo: "O seu menu", corpo: html`<div class="tour-passo"><p>No menu da esquerda aparecem só as telas que você usa (${PAPEIS[p]?.nome || ""}):</p>
        <ul class="tour-telas">${telas.map((r) => html`<li>${icone(ROTAS[r].icone, 'width="18" height="18"')}<span><strong>${tituloRota(r)}</strong> — ${TELAS[r].desc}</span></li>`)}</ul>
        <p class="muted small">Passe o mouse em cima de um item do menu para lembrar para que ele serve.</p></div>` },
    { titulo: "Comece por aqui", corpo: html`<div class="tour-passo"><ol class="ajuda-passos">${pa.comece.map((x) => html`<li>${x}</li>`)}</ol></div>` },
    { titulo: "Ficou com dúvida?", corpo: html`<div class="tour-passo">
        <ul class="tour-telas">
          <li>${icone("ajuda", 'width="18" height="18"')}<span>Aperte <kbd>F1</kbd> (ou o botão <strong>Ajuda</strong> no menu) em qualquer tela para ver a ajuda daquela tela.</span></li>
          <li>${icone("busca", 'width="18" height="18"')}<span>Na <strong>Central de Ajuda</strong>, escreva a dúvida do seu jeito: “como abro o caixa”, “a impressora não imprime”…</span></li>
          <li>${icone("clipe", 'width="18" height="18"')}<span>Apareceu um erro? Tire um print (tecla PrtSc) e cole na Central de Ajuda com Ctrl+V: o sistema lê a mensagem e mostra a solução.</span></li>
          <li>${icone("headset", 'width="18" height="18"')}<span>Se não resolver, toque em <strong>Falar com o suporte</strong>: uma pessoa ajuda você.</span></li>
        </ul></div>` },
  ];
  let i = 0;
  return modal({
    titulo: passos[0].titulo, largo: true,
    corpo: html`<div id="tour-corpo"></div><div class="tour-pontos" id="tour-pontos"></div>`,
    rodape: html`<button class="btn ghost" data-fechar>Pular</button><span class="grow"></span>
      <button class="btn" id="tour-voltar">Voltar</button><button class="btn primary" id="tour-proximo">Próximo</button>`,
    onPronto: (d, fechar) => {
      const desenhar = () => {
        d.querySelector(".modal-head h2").textContent = passos[i].titulo;
        render(d.querySelector("#tour-corpo"), passos[i].corpo);
        render(d.querySelector("#tour-pontos"), html`${passos.map((_, k) => html`<span class="${k === i ? "ativo" : ""}"></span>`)}`);
        d.querySelector("#tour-voltar").disabled = i === 0;
        d.querySelector("#tour-proximo").textContent = i === passos.length - 1 ? "Começar a usar" : "Próximo";
      };
      d.querySelector("#tour-voltar").onclick = () => { if (i > 0) { i--; desenhar(); } };
      d.querySelector("#tour-proximo").onclick = () => { if (i < passos.length - 1) { i++; desenhar(); } else fechar(); };
      desenhar();
    },
  });
}
