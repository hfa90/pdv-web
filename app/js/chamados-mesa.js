// QR Code na mesa (migração 025): avisos para a equipe quando o cliente chama o garçom, pede a conta,
// faz um pedido pelo celular ou paga por PIX. Aparece em qualquer tela do sistema e no app do garçom.
// Pedido do cliente só vai para a conta e a cozinha depois que alguém da loja confirma.
import { sb, rpc } from "./api.js";
import { estado } from "./estado.js";
import { html, render, toast, erro, modal, ocupado, dinheiro, rotuloMesa } from "./ui.js";
import { icone } from "./icons.js";
import { bipe } from "./avisos.js";
import { minutosDesde, duracao } from "./restaurante.js";

let canal = null, pilula = null, pendentes = [], timer = null, relogio = null, ativo = false;

const TITULO = {
  garcom: (c) => `${rotuloMesa(c.mesa)} chamou o garçom`,
  conta: (c) => `${rotuloMesa(c.mesa)} pediu a conta`,
  pedido: (c) => `${rotuloMesa(c.mesa)} fez um pedido`,
  pix: (c) => c.automatico ? `${rotuloMesa(c.mesa)} pagou ${dinheiro(c.valor)} (confirmado)` : `${rotuloMesa(c.mesa)} diz que pagou ${dinheiro(c.valor)} por PIX`,
  validar: (c) => `${rotuloMesa(c.mesa)} pede para validar o pagamento`,
};
const ICONE = { garcom: "sino", conta: "conta", pedido: "chapeu", pix: "pix", validar: "pix" };
const titulo = (c) => (TITULO[c.tipo] || TITULO.garcom)(c);

/** Chamados pendentes agora (para selos nas mesas). */
export const chamadosAtuais = () => pendentes;
const meu = (c) => !c.garcom_id || c.garcom_id === estado.perfil?.id;

async function atualizar(avisar) {
  const antes = new Set(pendentes.map((c) => c.id));
  try { pendentes = await rpc("mesa_chamados_pendentes"); }
  catch { pendentes = []; } // migração 025 ainda não aplicada: fica quieto
  const novos = pendentes.filter((c) => !antes.has(c.id));
  if (avisar && novos.length) {
    const c = novos[novos.length - 1];
    if (novos.some(meu)) { bipe(c.tipo === "pedido" ? 3 : 2); navigator.vibrate?.([200, 100, 200]); }
    toast(`🔔 ${titulo(c)}`, "ok");
  }
  desenharPilula();
  window.dispatchEvent(new CustomEvent("chamados-mesa", { detail: pendentes }));
}

function desenharPilula() {
  const n = pendentes.length;
  marcarMenu(n);
  if (!n) { pilula?.remove(); pilula = null; return; }
  if (!pilula) {
    pilula = document.createElement("button");
    pilula.className = "pilula-chamados";
    pilula.onclick = () => abrirChamados().catch(erro);
    document.body.appendChild(pilula);
  }
  const maisAntigo = Math.max(...pendentes.map((c) => minutosDesde(c.criado_em)));
  const primeiro = pendentes[0];
  render(pilula, html`${icone("sino", 'width="20" height="20"')}<span><strong>${n === 1 ? titulo(primeiro) : `${n} chamados das mesas`}</strong>
    <small>${maisAntigo ? `há ${duracao(maisAntigo)}` : "agora"} · toque para atender</small></span>`);
  pilula.classList.toggle("urgente", maisAntigo >= 2 || pendentes.some((c) => c.tipo === "pedido"));
}

function marcarMenu(n) {
  const a = document.querySelector('.nav a[data-rota="mesas"]');
  if (!a) return;
  let b = a.querySelector(".nav-badge.chamado");
  if (!b) { b = document.createElement("span"); b.className = "nav-badge chamado"; a.appendChild(b); }
  b.textContent = n || ""; b.hidden = !n;
  b.title = n ? `${n} chamado(s) das mesas pelo QR` : "";
}

export function iniciarChamados() {
  pararChamados();
  if (!estado.empresa || estado.perfil?.papel === "cozinha") return;
  ativo = true;
  atualizar(false);
  canal = sb.channel("chamados-mesa-" + estado.empresa.id + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "mesa_chamados", filter: `empresa_id=eq.${estado.empresa.id}` },
      () => { clearTimeout(timer); timer = setTimeout(() => atualizar(true), 300); })
    .subscribe();
  relogio = setInterval(() => { if (!document.hidden) atualizar(true); else desenharPilula(); }, 45000);
}

export function pararChamados() {
  ativo = false;
  if (canal) sb.removeChannel(canal);
  canal = null; pendentes = [];
  clearInterval(relogio); clearTimeout(timer);
  pilula?.remove(); pilula = null;
}

// ---------- Atender ----------
function cartao(c) {
  const itens = c.itens || [];
  return html`<article class="ch-card t-${c.tipo} ${meu(c) ? "meu" : ""}" data-id="${c.id}">
    <div class="ch-topo">${icone(ICONE[c.tipo] || "sino", 'width="18" height="18"')}<strong class="grow">${titulo(c)}</strong>
      <span class="kb-tempo">${icone("relogio", 'width="14" height="14"')} ${duracao(minutosDesde(c.criado_em)) || "agora"}</span></div>
    ${c.tipo === "pedido" ? html`<ul class="kb-itens">${itens.map((i) => html`<li><b>${i.quantidade}×</b> ${i.nome}${i.observacao ? html` <em>(${i.observacao})</em>` : ""}</li>`)}</ul>
      <div class="small muted">Total estimado ${dinheiro(c.valor)} · ${c.venda_id ? "entra na conta aberta da mesa" : "a mesa será aberta ao confirmar"}</div>` : ""}
    ${c.tipo === "pix" ? html`<div class="small ${c.automatico ? "txt-ok" : "txt-alerta"}">${c.automatico
      ? "Confirmado pela operadora de pagamento. Ao fechar a conta, este valor já entra como pago."
      : html`<strong>Confira no app do banco da loja</strong> se o PIX de ${dinheiro(c.valor)} caiu. O cliente já vê o valor descontado (aguardando você). Confirmando, ele entra sozinho como PIX ao fechar a conta.`}</div>` : ""}
    ${c.tipo === "validar" ? html`<div class="small muted">O cliente pagou pelo QR e quer que alguém confira na mesa. Veja o comprovante no celular dele.</div>` : ""}
    <div class="kb-acoes">${c.tipo === "pedido"
      ? html`<button class="btn sm ghost" data-recusar="${c.id}">Recusar</button><button class="btn sm primary" data-aceitar="${c.id}">${icone("check", 'width="16" height="16"')} Confirmar e enviar</button>`
      : c.tipo === "pix" && !c.automatico
        ? html`<button class="btn sm ghost" data-naorecebi="${c.id}">Não recebi</button><button class="btn sm primary" data-atender="${c.id}">${icone("check", 'width="16" height="16"')} Confirmar recebimento</button>`
        : html`<button class="btn sm primary" data-atender="${c.id}">${icone("check", 'width="16" height="16"')} ${c.tipo === "pix" ? "Visto" : c.tipo === "validar" ? "Validado" : "Atendido"}</button>`}</div>
  </article>`;
}

/** Abre a lista de chamados pendentes. */
export async function abrirChamados(soId = null) {
  if (ativo) await atualizar(false);
  else { try { pendentes = await rpc("mesa_chamados_pendentes"); } catch (e) { return erro(e); } }
  const lista = () => (soId ? pendentes.filter((c) => c.id === soId) : pendentes);
  if (!lista().length) { toast(soId ? "Este chamado já foi atendido" : "Nenhum chamado pendente", "ok"); return false; }
  let mudou = false;
  await modal({
    titulo: "Chamados das mesas (QR)", largo: true,
    corpo: html`<div id="ch-lista" class="ch-lista"></div><p class="hint" style="margin-top:.75rem">O cliente vê na hora no celular dele quando você atende, confirma ou recusa.</p>`,
    onPronto: (d, fechar) => {
      const box = d.querySelector("#ch-lista");
      const desenhar = () => {
        if (!lista().length) return fechar(true);
        render(box, html`${lista().map(cartao)}`);
      };
      box.addEventListener("click", async (e) => {
        const b = e.target.closest("button"); if (!b) return;
        try {
          if (b.dataset.atender) await ocupado(b, () => rpc("mesa_chamado_resolver", { p_id: b.dataset.atender, p_acao: "atender" }));
          if (b.dataset.aceitar) {
            const r = await ocupado(b, () => rpc("mesa_chamado_resolver", { p_id: b.dataset.aceitar, p_acao: "aceitar" }));
            toast(r.cozinha === "aguardando" ? "Pedido lançado · aguardando aprovação do caixa" : r.cozinha === "novo" ? "Pedido lançado e enviado para a cozinha" : "Pedido lançado na conta", "ok");
          }
          if (b.dataset.naorecebi) {
            const motivo = await escolherMotivo(true);
            if (motivo == null) return;
            await ocupado(b, () => rpc("mesa_chamado_resolver", { p_id: b.dataset.naorecebi, p_acao: "recusar", p_motivo: motivo }));
            toast("PIX não confirmado · o valor voltou para a conta e o cliente foi avisado", "ok");
          }
          if (b.dataset.atender && pendentes.find((c) => c.id === b.dataset.atender)?.tipo === "pix") toast("PIX confirmado · já entra como pagamento ao fechar a conta", "ok");
          if (b.dataset.recusar) {
            const motivo = await escolherMotivo();
            if (motivo == null) return;
            await rpc("mesa_chamado_resolver", { p_id: b.dataset.recusar, p_acao: "recusar", p_motivo: motivo });
            toast("Pedido recusado · o cliente foi avisado", "ok");
          }
          mudou = true;
          pendentes = pendentes.filter((c) => c.id !== (b.dataset.atender || b.dataset.aceitar || b.dataset.recusar || b.dataset.naorecebi));
          desenharPilula();
          desenhar();
        } catch (err) { erro(err); if (/cancelou|não encontrado/i.test(err.message)) { await atualizar(false); desenhar(); } }
      });
      desenhar();
    },
  });
  return mudou;
}

/** Atende um chamado específico (tela Hoje). Pedido e PIX abrem a conferência; os demais são marcados como atendidos. */
export async function resolverChamado(id, tipo) {
  if (tipo === "pedido" || tipo === "pix") return abrirChamados(id);
  await rpc("mesa_chamado_resolver", { p_id: id, p_acao: "atender" });
  toast("Chamado atendido", "ok");
  return true;
}

function escolherMotivo(pix = false) {
  const MOTIVOS = pix ? ["O PIX não caiu na conta da loja", "Valor diferente do informado", "Comprovante não confere"]
    : ["Produto acabou", "Cozinha fechada", "Pedido repetido", "Mesa errada"];
  return modal({
    titulo: pix ? "PIX não recebido" : "Recusar pedido",
    corpo: html`<p class="muted small" style="margin-top:0">O cliente vê o motivo no celular.</p>
      <div class="lista-escolha">${MOTIVOS.map((m) => html`<button class="btn" data-m="${m}">${m}</button>`)}</div>
      <label class="field" style="margin-top:.75rem"><span>Outro motivo</span><input class="input" id="ch-mot" maxlength="120"></label>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn danger" id="ch-ok">${pix ? "Não recebi" : "Recusar"}</button>`,
    onPronto: (d, fechar) => {
      d.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => fechar(b.dataset.m)));
      d.querySelector("#ch-ok").onclick = () => fechar(d.querySelector("#ch-mot").value.trim());
    },
  });
}
