// Aprovação dos pedidos que o garçom manda para a cozinha.
// Quem está no caixa (admin, gerente ou caixa) recebe aviso em qualquer tela,
// confere e aprova (vai para a tela da cozinha) ou recusa (os itens saem da conta).
import { sb, rpc } from "./api.js";
import { estado } from "./estado.js";
import { html, render, toast, erro, modal, pedirTexto, ocupado, qtd as fmtQtd, rotuloMesa } from "./ui.js";
import { icone } from "./icons.js";
import { bipe } from "./avisos.js";
import { minutosDesde, duracao } from "./restaurante.js";

let canal = null, pilula = null, pendentes = [], timer = null;

export async function buscarPendentes() {
  const r = await rpc("cozinha_painel");
  return (r.pedidos || []).filter((p) => p.status === "aguardando");
}

function marcarMenu(n) {
  for (const rota of ["cozinha", "mesas"]) {
    const a = document.querySelector(`.nav a[data-rota="${rota}"]`);
    if (!a) continue;
    let b = a.querySelector(".nav-badge.aprov");
    if (!b) { b = document.createElement("span"); b.className = "nav-badge aprov"; a.appendChild(b); }
    b.textContent = n || ""; b.hidden = !n;
    b.title = n ? `${n} pedido(s) aguardando aprovação` : "";
  }
}

function desenharPilula() {
  const n = pendentes.length;
  marcarMenu(n);
  const naCozinha = location.hash.startsWith("#/cozinha");
  if (!n || naCozinha) { pilula?.remove(); pilula = null; return; }
  if (!pilula) {
    pilula = document.createElement("button");
    pilula.className = "pilula-aprov";
    pilula.onclick = () => abrirAprovacoes().catch(erro);
    document.body.appendChild(pilula);
  }
  const maisAntigo = Math.max(...pendentes.map((p) => minutosDesde(p.criado_em)));
  render(pilula, html`${icone("chapeu", 'width="20" height="20"')}<span><strong>${n} ${n === 1 ? "pedido aguarda" : "pedidos aguardam"} aprovação</strong>
    <small>${maisAntigo ? `o mais antigo há ${duracao(maisAntigo)}` : "agora"} · toque para revisar</small></span>`);
  pilula.classList.toggle("urgente", maisAntigo >= 3);
  const lado = document.getElementById("sidebar")?.getBoundingClientRect().right || 0;
  pilula.style.left = Math.max(16, lado + 16) + "px";
}

async function atualizar(avisar = false) {
  const antes = new Set(pendentes.map((p) => p.id));
  pendentes = await buscarPendentes();
  const novos = pendentes.filter((p) => !antes.has(p.id));
  if (avisar && novos.length) {
    bipe(2);
    toast(`${rotuloMesa(novos[0].identificador)}: novo pedido do garçom aguardando aprovação`, "ok");
  }
  desenharPilula();
}

export function iniciarAprovacoes() {
  pararAprovacoes();
  if (!estado.empresa) return;
  atualizar(false).catch(() => {});
  canal = sb.channel("aprovacoes-" + estado.empresa.id + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "cozinha_pedidos", filter: `empresa_id=eq.${estado.empresa.id}` },
      () => { clearTimeout(timer); timer = setTimeout(() => atualizar(true).catch(() => {}), 400); })
    .subscribe();
  window.addEventListener("hashchange", desenharPilula);
}

export function pararAprovacoes() {
  if (canal) sb.removeChannel(canal);
  canal = null; pendentes = [];
  pilula?.remove(); pilula = null;
  window.removeEventListener("hashchange", desenharPilula);
}

/** Cartão de um pedido aguardando aprovação (usado no modal e na tela da cozinha). */
export function cartaoAprovacao(p) {
  const itens = (p.itens || []).filter((i) => !i.cancelado);
  return html`<article class="aprov-card" data-id="${p.id}">
    <div class="aprov-topo"><strong>${rotuloMesa(p.identificador)}</strong>
      ${p.garcom ? html`<span class="muted small">${icone("usuario", 'width="14" height="14"')} ${p.garcom.split(" ")[0]}</span>` : ""}
      <span class="grow"></span><span class="kb-tempo">${icone("relogio", 'width="14" height="14"')} ${duracao(minutosDesde(p.criado_em))}</span></div>
    <ul class="kb-itens">${itens.map((i) => html`<li><b>${fmtQtd(i.quantidade, i.unidade)}×</b> ${i.descricao}${i.observacao ? html` <em>(${i.observacao})</em>` : ""}</li>`)}</ul>
    <div class="kb-acoes"><button class="btn sm ghost" data-recusar="${p.id}">Recusar</button><button class="btn sm primary" data-aprovar="${p.id}">${icone("check", 'width="16" height="16"')} Aprovar</button></div>
  </article>`;
}

/** Liga os botões aprovar/recusar dentro de um elemento. */
export function ligarAprovacao(raiz, aoMudar) {
  raiz.querySelectorAll("[data-aprovar]").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    try { await ocupado(b, () => rpc("cozinha_aprovar", { p_ids: [b.dataset.aprovar] })); toast("Aprovado · já está na cozinha", "ok"); aoMudar?.(); }
    catch (err) { erro(err); }
  }));
  raiz.querySelectorAll("[data-recusar]").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const motivo = await pedirTexto({ titulo: "Recusar pedido", rotulo: "Motivo (o garçom verá)", minimo: 3, ok: "Recusar", dica: "Ex.: item em falta, lançado em duplicidade. Os itens saem da conta da mesa." });
    if (!motivo) return;
    try { await rpc("cozinha_recusar", { p_id: b.dataset.recusar, p_motivo: motivo }); toast("Pedido recusado · itens retirados da conta", "ok"); aoMudar?.(); }
    catch (err) { erro(err); }
  }));
}

/** Modal com os pedidos aguardando aprovação. Opcional: só os de uma venda. */
export async function abrirAprovacoes(vendaId = null) {
  let lista = (await buscarPendentes()).filter((p) => !vendaId || p.venda_id === vendaId);
  if (!lista.length) { toast("Nenhum pedido aguardando aprovação", "ok"); return; }
  await modal({
    titulo: "Pedidos aguardando aprovação", largo: true,
    corpo: html`<p class="muted small" style="margin-top:0">Confira e aprove para a cozinha começar. Recusar tira os itens da conta da mesa.</p><div class="aprov-lista" id="aprov-lista"></div>`,
    rodape: html`<button class="btn" data-fechar>Fechar</button><button class="btn primary" id="aprovar-todos">${icone("check", 'width="18" height="18"')} Aprovar todos</button>`,
    onPronto: (d, fechar) => {
      const desenhar = () => {
        if (!lista.length) { fechar(); return; }
        render(d.querySelector("#aprov-lista"), html`${lista.map(cartaoAprovacao)}`);
        ligarAprovacao(d, async () => { lista = (await buscarPendentes()).filter((p) => !vendaId || p.venda_id === vendaId); desenhar(); atualizar().catch(() => {}); });
      };
      desenhar();
      d.querySelector("#aprovar-todos").onclick = async (e) => {
        try {
          const n = await ocupado(e.currentTarget, () => rpc("cozinha_aprovar", { p_ids: lista.map((p) => p.id) }));
          toast(`${n} ${n === 1 ? "pedido aprovado" : "pedidos aprovados"} · já estão na cozinha`, "ok");
          atualizar().catch(() => {}); fechar();
        } catch (err) { erro(err); }
      };
    },
  });
}
