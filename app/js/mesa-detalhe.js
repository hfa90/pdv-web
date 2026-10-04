// Detalhe de uma mesa: abrir, lançar itens, pedir conta, transferir/juntar e tirar itens.
// Usado pela tela Mesas do sistema e pelo app do garçom (mesmo código, mesmas regras do banco).
import { sb, q, rpc } from "./api.js";
import { estado } from "./estado.js";
import { html, render, dinheiro, qtd as fmtQtd, hora, toast, erro, modal, pedirTexto, ocupado, confirmar } from "./ui.js";
import { icone } from "./icons.js";
import { escolherItens } from "./seletor.js";

export const minutos = (d) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d)) / 60000)) : 0);
export const tempo = (d) => { const m = minutos(d); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`; };
export const situacao = (m) => (!m.venda_id ? "livre" : m.conta_pedida ? "conta" : "ocupada");
export const NOME_SITUACAO = { livre: "Livre", ocupada: "Ocupada", conta: "Conta pedida" };

async function buscarPedido(vendaId) {
  return q(sb.from("vendas")
    .select("id,numero,status,total,subtotal,acrescimo,desconto,pessoas,created_at,alterado_em,conta_pedida_em,identificador,operador:perfis!vendas_operador_id_fkey(nome),itens:venda_itens(id,item,descricao,quantidade,unidade,preco_unitario,total,observacao,removido,criado_em,criado_por)")
    .eq("id", vendaId).single());
}

/**
 * Desenha o detalhe da mesa dentro de `alvo`.
 * @param {HTMLElement} alvo
 * @param {object} mesa  linha de mesas_painel()
 * @param {{todas:()=>object[], onMudou:()=>void, onFechar?:()=>void, contexto:'pdv'|'garcom'}} op
 */
export async function desenharDetalhe(alvo, mesa, op) {
  const sit = situacao(mesa);
  const podeReceber = op.contexto === "pdv" && ["admin", "gerente", "caixa"].includes(estado.perfil?.papel);
  const gestor = ["admin", "gerente", "caixa"].includes(estado.perfil?.papel);
  const cab = html`<div class="md-cab">
      <div class="grow"><div class="md-nome">${mesa.nome}</div><div class="muted small">${mesa.area} · ${mesa.lugares} lugares</div></div>
      <span class="sit sit-${sit}">${NOME_SITUACAO[sit]}</span>
      ${op.onFechar ? html`<button class="btn ghost icon-btn" data-a="fechar" aria-label="Fechar">${icone("fechar", 'width="20" height="20"')}</button>` : ""}
    </div>`;

  if (sit === "livre") {
    let pessoas = Math.min(2, mesa.lugares);
    render(alvo, html`${cab}<div class="md-livre">
      ${icone("mesa", 'width="56" height="56"')}
      <p>Quantas pessoas?</p>
      <div class="qtd grande"><button data-a="menos" aria-label="Menos">−</button><span id="md-pessoas">${pessoas}</span><button data-a="mais" aria-label="Mais">+</button></div>
      <button class="btn primary lg block" data-a="abrir">Abrir mesa e lançar pedido</button>
    </div>`);
    alvo.onclick = async (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "fechar") return op.onFechar();
      if (a === "menos" || a === "mais") { pessoas = Math.max(1, Math.min(50, pessoas + (a === "mais" ? 1 : -1))); alvo.querySelector("#md-pessoas").textContent = pessoas; }
      if (a === "abrir") {
        try {
          const id = await ocupado(e.target.closest("button"), () => rpc("abrir_mesa", { p_mesa: mesa.id, p_pessoas: pessoas }));
          mesa = { ...mesa, venda_id: id, aberta_em: new Date().toISOString(), pessoas, total: 0, itens: 0 };
          op.onMudou();
          await desenharDetalhe(alvo, mesa, op);
          lancar(alvo, mesa, op);
        } catch (err) { erro(err); }
      }
    };
    return;
  }

  const v = await buscarPedido(mesa.venda_id);
  if (v.status !== "aberta") { op.onMudou(); toast(`${mesa.nome} já foi fechada`, "ok"); return op.onFechar?.(); }
  const itens = v.itens.filter((i) => !i.removido).sort((a, b) => a.item - b.item);
  const eu = estado.perfil?.id;
  const podeTirar = (i) => gestor || (i.criado_por === eu && minutos(i.criado_em) < 5);

  render(alvo, html`${cab}
    <div class="md-info">
      <span>${icone("relogio", 'width="16" height="16"')} ${tempo(v.created_at)}</span>
      ${v.pessoas ? html`<span>${icone("pessoas", 'width="16" height="16"')} ${v.pessoas}</span>` : ""}
      ${v.operador?.nome ? html`<span>${icone("usuario", 'width="16" height="16"')} ${v.operador.nome.split(" ")[0]}</span>` : ""}
      <span>Pedido nº ${v.numero}</span>
    </div>
    <div class="md-itens">${itens.length ? itens.map((i) => html`<div class="md-item">
        <div class="md-q">${fmtQtd(i.quantidade, i.unidade)}×</div>
        <div class="grow"><div>${i.descricao}</div>${i.observacao ? html`<div class="small obs">${i.observacao}</div>` : ""}<div class="muted small">${hora(i.criado_em)}</div></div>
        <div class="r">${dinheiro(i.total)}</div>
        ${podeTirar(i) ? html`<button class="btn sm ghost icon-btn" data-tirar="${i.id}" aria-label="Tirar item">${icone("lixo", 'width="16" height="16"')}</button>` : html`<span style="width:32px"></span>`}
      </div>`) : html`<div class="empty small"><p>Mesa aberta, sem itens ainda.</p></div>`}</div>
    <div class="md-total"><span>Total</span><strong>${dinheiro(v.total)}</strong></div>
    ${v.pessoas > 1 && Number(v.total) ? html`<div class="muted small r" style="margin-top:-.4rem">${dinheiro(Number(v.total) / v.pessoas)} por pessoa</div>` : ""}
    <div class="md-acoes">
      <button class="btn primary lg" data-a="lancar">${icone("mais", 'width="20" height="20"')} Lançar itens</button>
      <button class="btn ${v.conta_pedida_em ? "conta-on" : ""}" data-a="conta">${icone("conta", 'width="18" height="18"')} ${v.conta_pedida_em ? "Conta pedida ✓" : "Pedir conta"}</button>
      <button class="btn" data-a="transferir">${icone("transferir", 'width="18" height="18"')} Transferir / juntar</button>
      ${op.contexto === "pdv" ? html`<button class="btn" data-a="imprimir">${icone("imprimir", 'width="18" height="18"')} Imprimir conta</button>` : ""}
      ${podeReceber ? html`<button class="btn receber" data-a="receber">${icone("caixa", 'width="18" height="18"')} Receber no caixa</button>` : ""}
      ${!itens.length && gestor ? html`<button class="btn ghost" data-a="liberar">Liberar mesa</button>` : ""}
    </div>`);

  alvo.onclick = async (e) => {
    const b = e.target.closest("[data-a], [data-tirar]");
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (b.dataset.tirar) {
        const it = itens.find((i) => i.id === b.dataset.tirar);
        const motivo = await pedirTexto({ titulo: `Tirar ${it.descricao}`, rotulo: "Motivo", minimo: 3, ok: "Tirar item", dica: "Ex.: lançado errado, cliente desistiu." });
        if (!motivo) return;
        await rpc("remover_item_pedido", { p_item: it.id, p_motivo: motivo });
        toast("Item retirado", "ok");
      }
      if (a === "fechar") return op.onFechar();
      if (a === "lancar") return lancar(alvo, mesa, op);
      if (a === "conta") { await rpc("pedir_conta", { p_venda: v.id, p_pedida: !v.conta_pedida_em }); toast(v.conta_pedida_em ? "Pedido de conta cancelado" : "Conta pedida · o caixa foi avisado", "ok"); }
      if (a === "transferir") { const novo = await transferir(v, mesa, op.todas()); if (!novo) return; mesa = { ...novo.destino, venda_id: novo.id }; op.onTrocou?.(mesa.id); }
      if (a === "imprimir") { const { imprimirVenda } = await import("./impressao/cupom.js"); await imprimirVenda(v.id, { conta: true }); }
      if (a === "receber") { location.hash = `#/pdv/${v.id}`; return; }
      if (a === "liberar") {
        if (!(await confirmar(`Liberar ${mesa.nome} sem consumo?`, { ok: "Liberar" }))) return;
        await rpc("cancelar_venda", { p_venda_id: v.id, p_motivo: "Mesa aberta sem consumo" });
        mesa = { ...mesa, venda_id: null };
      }
      op.onMudou();
      await desenharDetalhe(alvo, mesa, op);
    } catch (err) { erro(err); }
  };
}

async function lancar(alvo, mesa, op) {
  const itens = await escolherItens({ titulo: `Lançar em ${mesa.nome}`, enviar: "Enviar para a cozinha" });
  if (!itens?.length) return;
  try {
    const r = await rpc("adicionar_itens", { p_venda: mesa.venda_id, p_itens: itens });
    toast(`${r.itens_adicionados} ${r.itens_adicionados === 1 ? "item enviado" : "itens enviados"} · ${mesa.nome}`, "ok");
    navigator.vibrate?.([20, 40, 20]);
  } catch (err) {
    erro(err);
    // Guarda o pedido para não perder se a internet caiu
    try { localStorage.setItem("pdv-pedido-pendente", JSON.stringify({ venda: mesa.venda_id, mesa: mesa.nome, itens, em: Date.now() })); } catch { /* sem armazenamento */ }
  }
  op.onMudou();
  await desenharDetalhe(alvo, mesa, op);
}

/** Reenvia um pedido que falhou por falta de conexão. */
export async function reenviarPendente() {
  let p; try { p = JSON.parse(localStorage.getItem("pdv-pedido-pendente") || "null"); } catch { p = null; }
  if (!p || Date.now() - p.em > 30 * 60000) { localStorage.removeItem("pdv-pedido-pendente"); return; }
  if (!(await confirmar(`Há um pedido de ${p.mesa} que não foi enviado (${p.itens.length} itens). Enviar agora?`, { ok: "Enviar", titulo: "Pedido pendente" }))) {
    localStorage.removeItem("pdv-pedido-pendente"); return;
  }
  await rpc("adicionar_itens", { p_venda: p.venda, p_itens: p.itens });
  localStorage.removeItem("pdv-pedido-pendente");
  toast("Pedido enviado", "ok");
}

async function transferir(v, mesa, todas) {
  const outras = todas.filter((m) => m.id !== mesa.id);
  if (!outras.length) { toast("Não há outras mesas", "erro"); return null; }
  const destino = await modal({
    titulo: `Transferir ${mesa.nome}`,
    corpo: html`<p class="muted small" style="margin-top:0">Escolha uma mesa livre para mudar o cliente de lugar, ou uma ocupada para juntar as contas.</p>
      <div class="md-destinos">${outras.map((m) => html`<button class="mesa-mini sit-${situacao(m)}" data-m="${m.id}"><strong>${m.nome}</strong><span class="small">${m.venda_id ? "juntar · " + dinheiro(m.total) : "livre"}</span></button>`)}</div>`,
    onPronto: (d, fechar) => d.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => fechar(outras.find((m) => m.id === b.dataset.m)))),
  });
  if (!destino) return null;
  if (destino.venda_id && !(await confirmar(`Juntar a conta de ${mesa.nome} com ${destino.nome}? Os itens passam para ${destino.nome}.`, { ok: "Juntar contas" }))) return null;
  const id = await rpc("transferir_mesa", { p_venda: v.id, p_mesa_destino: destino.id });
  toast(destino.venda_id ? `Contas juntadas em ${destino.nome}` : `${mesa.nome} → ${destino.nome}`, "ok");
  return { id, destino };
}
