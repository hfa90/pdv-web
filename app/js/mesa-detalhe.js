// Detalhe de uma mesa (ou comanda): abrir, lançar itens, acompanhar a cozinha, pedir conta,
// taxa de serviço/couvert, transferir mesa inteira ou itens e tirar itens.
// Usado pela tela Mesas do sistema e pelo app do garçom (mesmo código, mesmas regras do banco).
import { sb, q, rpc } from "./api.js";
import { estado, cfgRestaurante, aprovaCozinha } from "./estado.js";
import { html, render, dinheiro, qtd as fmtQtd, hora, toast, erro, modal, pedirTexto, ocupado, confirmar, rotuloMesa } from "./ui.js";
import { icone } from "./icons.js";
import { escolherItens } from "./seletor.js";
import { minutosDesde, duracao, nivelTempo, ETAPA_COZINHA, taxaServico, rotuloServico, rotuloCouvert } from "./restaurante.js";

export const minutos = minutosDesde;
export const tempo = (d) => duracao(minutosDesde(d));
export const situacao = (m) => (!m.venda_id ? "livre" : m.conta_pedida ? "conta" : "ocupada");
export const NOME_SITUACAO = { livre: "Livre", ocupada: "Ocupada", conta: "Conta pedida" };
const FRACIONADOS = ["KG", "L", "M", "G", "ML"];

async function buscarPedido(vendaId) {
  const [v, tickets] = await Promise.all([
    q(sb.from("vendas")
      .select("id,numero,status,canal,mesa_id,total,subtotal,acrescimo,desconto,taxa_servico,couvert,servico_pct,couvert_unit,pessoas,created_at,alterado_em,conta_pedida_em,identificador,garcom_id,operador:perfis!vendas_operador_id_fkey(nome),garcom:perfis!vendas_garcom_id_fkey(nome),itens:venda_itens(id,item,descricao,quantidade,unidade,preco_unitario,total,observacao,removido,criado_em,criado_por)")
      .eq("id", vendaId).single()),
    q(sb.from("cozinha_pedidos").select("id,status,itens,recusado_motivo,criado_em").eq("venda_id", vendaId).order("criado_em")).catch(() => []),
  ]);
  return { ...v, tickets };
}

/** Situação de cada item na cozinha (último pedido em que ele aparece). */
function etapasDosItens(tickets) {
  const mapa = new Map();
  for (const t of tickets || []) for (const i of t.itens || []) mapa.set(i.id, i.cancelado ? "cancelado" : t.status);
  return mapa;
}

/**
 * Desenha o detalhe da mesa dentro de `alvo`.
 * @param {HTMLElement} alvo
 * @param {object} mesa  linha de mesas_painel() (ou {comanda:true, nome, venda_id} para comandas)
 * @param {{todas:()=>object[], onMudou:()=>void, onFechar?:()=>void, onTrocou?:(id:string)=>void, contexto:'pdv'|'garcom'}} op
 */
export async function desenharDetalhe(alvo, mesa, op) {
  const sit = situacao(mesa);
  const papel = estado.perfil?.papel;
  const podeReceber = op.contexto === "pdv" && ["admin", "gerente", "caixa"].includes(papel);
  const gestor = ["admin", "gerente", "caixa"].includes(papel);
  const cfg = cfgRestaurante();
  const cab = html`<div class="md-cab">
      <div class="grow"><div class="md-nome">${mesa.comanda ? rotuloMesa(mesa.nome) : mesa.nome}</div>
        <div class="muted small">${mesa.comanda ? "Comanda" : `${mesa.area} · ${mesa.lugares} lugares`}</div></div>
      <span class="sit sit-${sit}">${mesa.comanda && sit === "ocupada" ? "Aberta" : NOME_SITUACAO[sit]}</span>
      ${op.onFechar ? html`<button class="btn ghost icon-btn" data-a="fechar" aria-label="Fechar">${icone("fechar", 'width="20" height="20"')}</button>` : ""}
    </div>`;

  if (sit === "livre") {
    let pessoas = Math.min(2, mesa.lugares);
    const avisoCobranca = [
      cfg.servico_modo === "cobrar" && `taxa de serviço de ${cfg.servico_percentual}%`,
      cfg.couvert_ativo && Number(cfg.couvert_valor) > 0 && `${(cfg.couvert_nome || "couvert").toLowerCase()} de ${dinheiro(cfg.couvert_valor)} por pessoa`,
    ].filter(Boolean);
    render(alvo, html`${cab}<div class="md-livre">
      ${icone("mesa", 'width="56" height="56"')}
      <p>Quantas pessoas?</p>
      <div class="qtd grande"><button data-a="menos" aria-label="Menos">−</button><span id="md-pessoas">${pessoas}</span><button data-a="mais" aria-label="Mais">+</button></div>
      <button class="btn primary lg block" data-a="abrir">Abrir mesa e lançar pedido</button>
      ${avisoCobranca.length ? html`<p class="small muted" style="margin:0">Esta mesa terá ${avisoCobranca.join(" e ")}.</p>` : ""}
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
  const podeTirar = (i) => gestor || (i.criado_por === eu && minutosDesde(i.criado_em) < 5);
  const etapas = etapasDosItens(v.tickets);
  const tk = (s) => v.tickets.filter((t) => t.status === s);
  const aguardando = tk("aguardando"), prontos = tk("pronto"), recusados = v.tickets.filter((t) => t.status === "recusado" && minutosDesde(t.criado_em) < 60);
  const ehMesa = v.canal === "mesa";
  const minAberta = minutosDesde(v.created_at);
  const ultimo = itens.length ? Math.max(...itens.map((i) => new Date(i.criado_em).getTime())) : null;
  const semPedir = ultimo ? minutosDesde(ultimo) : minAberta;
  const consumo = Number(v.subtotal) - Number(v.desconto);
  const sugerido = ehMesa && cfg.servico_modo === "sugerir" && !Number(v.servico_pct) ? taxaServico(consumo, cfg.servico_percentual) : 0;
  const garcom = v.garcom?.nome || v.operador?.nome;

  render(alvo, html`${cab}
    <div class="md-tempos">
      <span class="md-tempo t-${nivelTempo(minAberta)}" title="Tempo de ocupação">${icone("relogio", 'width="16" height="16"')} ${duracao(minAberta)}</span>
      ${!v.conta_pedida_em && itens.length ? html`<span class="md-tempo ${semPedir >= cfg.ocioso_min ? "t-alerta" : ""}" title="Desde o último pedido">${icone("chapeu", 'width="16" height="16"')} último pedido há ${duracao(semPedir)}</span>` : ""}
      ${v.conta_pedida_em ? html`<span class="md-tempo t-critico">${icone("conta", 'width="16" height="16"')} conta pedida há ${duracao(minutosDesde(v.conta_pedida_em))}</span>` : ""}
    </div>
    <div class="md-info">
      ${ehMesa ? html`<span class="md-pessoas">${icone("pessoas", 'width="16" height="16"')}
        <button class="btn sm ghost icon-btn" data-a="p-menos" aria-label="Menos pessoas">−</button><b>${v.pessoas || "—"}</b><button class="btn sm ghost icon-btn" data-a="p-mais" aria-label="Mais pessoas">+</button></span>` : ""}
      ${garcom ? html`<span>${icone("usuario", 'width="16" height="16"')} ${garcom.split(" ")[0]}${gestor && ehMesa ? html` <button class="link-btn" data-a="garcom">trocar</button>` : ""}</span>` : ""}
      <span>Pedido nº ${v.numero}</span>
    </div>
    ${aguardando.length ? html`<div class="md-aviso aguardando">${icone("ampulheta", 'width="18" height="18"')}
      <span class="grow">${aguardando.length} ${aguardando.length === 1 ? "pedido aguarda" : "pedidos aguardam"} aprovação do caixa para ir à cozinha</span>
      ${aprovaCozinha() ? html`<button class="btn sm primary" data-a="aprovar">Revisar</button>` : ""}</div>` : ""}
    ${prontos.length ? html`<div class="md-aviso pronto">${icone("sino", 'width="18" height="18"')}
      <span class="grow"><strong>Pronto na cozinha!</strong> ${prontos.flatMap((t) => (t.itens || []).filter((i) => !i.cancelado).map((i) => `${fmtQtd(i.quantidade, i.unidade)}× ${i.descricao}`)).join(", ")}</span>
      <button class="btn sm" data-a="servido">Servido</button></div>` : ""}
    ${recusados.map((t) => html`<div class="md-aviso recusado">${icone("alerta", 'width="18" height="18"')}<span class="grow">Pedido recusado${t.recusado_motivo ? `: ${t.recusado_motivo}` : ""}. Os itens saíram da conta.</span></div>`)}
    <div class="md-itens">${itens.length ? itens.map((i) => {
        const et = etapas.get(i.id);
        return html`<div class="md-item">
        <div class="md-q">${fmtQtd(i.quantidade, i.unidade)}×</div>
        <div class="grow"><div>${i.descricao}</div>${i.observacao ? html`<div class="small obs">${i.observacao}</div>` : ""}
          <div class="muted small">${hora(i.criado_em)}${et ? html` · <span class="etapa e-${et}">${ETAPA_COZINHA[et]}</span>` : ""}</div></div>
        <div class="r">${dinheiro(i.total)}</div>
        ${podeTirar(i) ? html`<button class="btn sm ghost icon-btn" data-tirar="${i.id}" aria-label="Tirar item">${icone("lixo", 'width="16" height="16"')}</button>` : html`<span style="width:32px"></span>`}
      </div>`; }) : html`<div class="empty small"><p>Mesa aberta, sem itens ainda.</p></div>`}</div>
    ${Number(v.taxa_servico) || Number(v.couvert) || Number(v.desconto) ? html`<div class="md-linhas">
      <div class="linha-valor"><span>Consumo</span><span>${dinheiro(v.subtotal)}</span></div>
      ${Number(v.desconto) ? html`<div class="linha-valor"><span>Desconto</span><span>−${dinheiro(v.desconto)}</span></div>` : ""}
      ${Number(v.servico_pct) ? html`<div class="linha-valor"><span>${rotuloServico(v.servico_pct)}</span><span>${dinheiro(v.taxa_servico)}</span></div>` : ""}
      ${Number(v.couvert) ? html`<div class="linha-valor"><span>${rotuloCouvert(v.couvert_unit, v.pessoas)}</span><span>${dinheiro(v.couvert)}</span></div>` : ""}
    </div>` : ""}
    <div class="md-total"><span>Total</span><strong>${dinheiro(v.total)}</strong></div>
    ${sugerido ? html`<div class="muted small r" style="margin-top:-.4rem">Serviço sugerido ${cfg.servico_percentual}%: ${dinheiro(sugerido)} · com serviço ${dinheiro(Number(v.total) + sugerido)}</div>` : ""}
    ${v.pessoas > 1 && Number(v.total) ? html`<div class="muted small r" style="margin-top:-.4rem">${dinheiro(Number(v.total) / v.pessoas)} por pessoa</div>` : ""}
    <div class="md-acoes">
      <button class="btn primary lg" data-a="lancar">${icone("mais", 'width="20" height="20"')} Lançar itens</button>
      <button class="btn ${v.conta_pedida_em ? "conta-on" : ""}" data-a="conta">${icone("conta", 'width="18" height="18"')} ${v.conta_pedida_em ? "Conta pedida ✓" : "Pedir conta"}</button>
      <button class="btn" data-a="transferir">${icone("transferir", 'width="18" height="18"')} Transferir</button>
      ${gestor && ehMesa ? html`<button class="btn" data-a="taxas">${icone("etiqueta", 'width="18" height="18"')} Serviço e couvert</button>` : ""}
      ${op.contexto === "pdv" ? html`<button class="btn" data-a="imprimir">${icone("imprimir", 'width="18" height="18"')} Imprimir conta</button>` : ""}
      ${podeReceber ? html`<button class="btn receber" data-a="receber">${icone("caixa", 'width="18" height="18"')} Receber no caixa</button>` : ""}
      ${op.contexto === "garcom" && itens.length && cfg.garcom_fecha_conta !== false ? html`<button class="btn receber" data-a="fechar-conta">${icone("cartao", 'width="18" height="18"')} Fechar conta · PIX ou cartão</button>` : ""}
      ${!itens.length && gestor ? html`<button class="btn ghost" data-a="liberar">Liberar ${mesa.comanda ? "comanda" : "mesa"}</button>` : ""}
    </div>`);

  alvo.onclick = async (e) => {
    const b = e.target.closest("[data-a], [data-tirar]");
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (b.dataset.tirar) {
        const it = itens.find((i) => i.id === b.dataset.tirar);
        const motivo = await pedirTexto({ titulo: `Tirar ${it.descricao}`, rotulo: "Motivo", minimo: 3, ok: "Tirar item", dica: "Ex.: lançado errado, cliente desistiu. A cozinha é avisada." });
        if (!motivo) return;
        await rpc("remover_item_pedido", { p_item: it.id, p_motivo: motivo });
        toast("Item retirado", "ok");
      }
      if (a === "fechar") return op.onFechar();
      if (a === "lancar") return lancar(alvo, mesa, op);
      if (a === "conta") { await rpc("pedir_conta", { p_venda: v.id, p_pedida: !v.conta_pedida_em }); toast(v.conta_pedida_em ? "Pedido de conta cancelado" : "Conta pedida · o caixa foi avisado", "ok"); }
      if (a === "p-menos" || a === "p-mais") {
        const n = Math.max(1, Math.min(50, (Number(v.pessoas) || 1) + (a === "p-mais" ? 1 : -1)));
        if (n === Number(v.pessoas)) return;
        await rpc("definir_taxas_mesa", { p_venda: v.id, p_servico: null, p_couvert: null, p_pessoas: n });
      }
      if (a === "aprovar") { const { abrirAprovacoes } = await import("./aprovacoes.js"); await abrirAprovacoes(v.id); }
      if (a === "servido") { await Promise.all(prontos.map((t) => rpc("cozinha_avancar", { p_id: t.id, p_status: "entregue" }))); toast("Marcado como servido", "ok"); }
      if (a === "taxas") { if (!(await taxas(v))) return; }
      if (a === "garcom") { if (!(await trocarGarcom(v))) return; }
      if (a === "transferir") {
        const r = await transferir(v, mesa, op.todas(), itens);
        if (!r) return;
        if (r.saiu) { op.onMudou(); return op.onFechar?.(); }
        if (r.mesa) { mesa = { ...r.mesa, venda_id: r.venda_id }; op.onTrocou?.(mesa.id); }
      }
      if (a === "imprimir") { const { imprimirVenda } = await import("./impressao/cupom.js"); await imprimirVenda(v.id, { conta: true }); }
      if (a === "receber") { location.hash = `#/pdv/${v.id}`; return; }
      if (a === "fechar-conta") {
        const { fecharConta } = await import("./fechar-conta.js");
        if (await fecharConta(v.id, mesa.nome)) { op.onMudou(); return op.onFechar?.(); }
      }
      if (a === "liberar") {
        if (!(await confirmar(`Liberar ${mesa.nome} sem consumo?`, { ok: "Liberar" }))) return;
        await rpc("cancelar_venda", { p_venda_id: v.id, p_motivo: "Mesa aberta sem consumo" });
        if (mesa.comanda) { op.onMudou(); return op.onFechar?.(); }
        mesa = { ...mesa, venda_id: null };
      }
      op.onMudou();
      await desenharDetalhe(alvo, mesa, op);
    } catch (err) { erro(err); }
  };
}

async function lancar(alvo, mesa, op) {
  const itens = await escolherItens({ titulo: `Lançar em ${mesa.comanda ? rotuloMesa(mesa.nome) : mesa.nome}`, enviar: "Enviar pedido" });
  if (!itens?.length) return;
  try {
    const r = await rpc("adicionar_itens", { p_venda: mesa.venda_id, p_itens: itens });
    const qtd = `${r.itens_adicionados} ${r.itens_adicionados === 1 ? "item" : "itens"}`;
    toast(r.cozinha === "aguardando" ? `${qtd} · aguardando aprovação do caixa para ir à cozinha`
      : r.cozinha === "novo" ? `${qtd} enviado(s) para a cozinha · ${mesa.nome}` : `${qtd} lançado(s) · ${mesa.nome}`, "ok");
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

/** Liga/desliga taxa de serviço e couvert (caixa e gerente). */
async function taxas(v) {
  const cfg = cfgRestaurante();
  const temServ = Number(v.servico_pct) > 0, temCouv = Number(v.couvert_unit) > 0;
  const r = await modal({
    titulo: "Taxa de serviço e couvert",
    corpo: html`<form id="f-tx" class="stack">
      <label class="check grande"><input type="checkbox" name="serv" ${temServ ? "checked" : ""} ${!temServ && !(cfg.servico_percentual > 0) ? "disabled" : ""}>
        <span><strong>Cobrar taxa de serviço (${temServ ? v.servico_pct : cfg.servico_percentual}%)</strong><small class="muted">A taxa é opcional para o cliente. Desmarque se ele pedir para tirar.</small></span></label>
      <label class="check grande"><input type="checkbox" name="couv" ${temCouv ? "checked" : ""} ${!temCouv && !(Number(cfg.couvert_valor) > 0) ? "disabled" : ""}>
        <span><strong>Cobrar ${(cfg.couvert_nome || "couvert").toLowerCase()} (${dinheiro(temCouv ? v.couvert_unit : cfg.couvert_valor)} por pessoa)</strong><small class="muted">${v.pessoas || 1} pessoa(s) na mesa.</small></span></label>
      ${!(cfg.servico_percentual > 0) || !(Number(cfg.couvert_valor) > 0) ? html`<p class="hint">Valores e regras em Configurações › Restaurante.</p>` : ""}
    </form>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-tx">Aplicar</button>`,
    onPronto: (d, fechar) => (d.querySelector("form").onsubmit = (e) => { e.preventDefault(); fechar({ serv: e.target.serv.checked, couv: e.target.couv.checked }); }),
  });
  if (!r) return false;
  await rpc("definir_taxas_mesa", { p_venda: v.id, p_servico: r.serv, p_couvert: r.couv, p_pessoas: null });
  toast("Conta atualizada", "ok");
  return true;
}

/** Troca o garçom responsável (a comissão da mesa vai para ele). */
async function trocarGarcom(v) {
  const equipe = await q(sb.from("perfis").select("id,nome,papel").eq("ativo", true).neq("papel", "cozinha").order("nome"));
  const id = await modal({
    titulo: "Garçom responsável pela mesa",
    corpo: html`<p class="muted small" style="margin-top:0">A comissão desta mesa vai para quem estiver marcado quando a conta fechar.</p>
      <div class="lista-escolha">${equipe.map((p) => html`<button class="btn ${p.id === v.garcom_id ? "primary" : ""}" data-g="${p.id}">${p.nome}</button>`)}</div>`,
    onPronto: (d, fechar) => d.querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => fechar(b.dataset.g))),
  });
  if (!id || id === v.garcom_id) return false;
  await rpc("trocar_garcom", { p_venda: v.id, p_garcom: id });
  toast("Garçom da mesa alterado", "ok");
  return true;
}

/**
 * Transferência: a mesa inteira (muda de lugar ou junta contas) ou só alguns itens,
 * para outra mesa, uma comanda aberta ou uma comanda nova.
 */
async function transferir(v, mesa, todas, itens) {
  const outras = todas.filter((m) => m.id !== mesa.id && !m.comanda);
  const comandas = await q(sb.from("vendas").select("id,numero,identificador,total").eq("status", "aberta").eq("canal", "balcao").neq("id", v.id).order("created_at")).catch(() => []);
  const sel = new Map(); // item id -> quantidade
  let modo = itens.length > 1 ? "itens" : "tudo";

  const escolha = await modal({
    titulo: `Transferir de ${mesa.comanda ? rotuloMesa(mesa.nome) : mesa.nome}`, largo: true,
    corpo: html`<div class="stack">
      <div class="seg" role="group" aria-label="O que transferir"><button type="button" data-m="tudo">${mesa.comanda ? "Comanda inteira" : "Mesa inteira"}</button><button type="button" data-m="itens" ${itens.length ? "" : "disabled"}>Alguns itens</button></div>
      <div id="tr-itens"></div>
      <div><div class="small muted" style="margin-bottom:.4rem" id="tr-dica"></div>
        <div class="md-destinos">${outras.map((m) => html`<button type="button" class="mesa-mini sit-${situacao(m)}" data-dest="mesa:${m.id}"><strong>${m.nome}</strong><span class="small">${m.venda_id ? dinheiro(m.total) : "livre"}</span></button>`)}
          ${comandas.map((c) => html`<button type="button" class="mesa-mini comanda" data-dest="venda:${c.id}"><strong>${rotuloMesa(c.identificador) || "Pedido " + c.numero}</strong><span class="small">comanda · ${dinheiro(c.total)}</span></button>`)}
          <button type="button" class="mesa-mini nova" data-dest="nova"><strong>+ Comanda</strong><span class="small">nova</span></button></div></div>
    </div>`,
    onPronto: (d, fechar) => {
      const desenharModo = () => {
        d.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("ativo", b.dataset.m === modo));
        d.querySelector("#tr-dica").textContent = modo === "tudo"
          ? "Mesa livre: o cliente muda de lugar. Mesa ocupada ou comanda: as contas são juntadas."
          : "Escolha os itens e a quantidade. Depois toque no destino.";
        const box = d.querySelector("#tr-itens");
        if (modo === "tudo") { render(box, ""); return; }
        render(box, html`<div class="tr-lista">${itens.map((i) => {
          const q = sel.get(i.id) || 0; const frac = FRACIONADOS.includes(i.unidade);
          return html`<div class="tr-item ${q ? "on" : ""}" data-i="${i.id}">
            <label class="check"><input type="checkbox" ${q ? "checked" : ""} data-chk="${i.id}"> <span>${i.descricao}${i.observacao ? html` <em class="obs">(${i.observacao})</em>` : ""}</span></label>
            <span class="grow"></span>
            ${Number(i.quantidade) > 1 || frac ? html`<div class="qtd"><button type="button" data-q="-" data-id="${i.id}" aria-label="Menos">−</button>
              <span>${fmtQtd(q || i.quantidade, i.unidade)}</span><button type="button" data-q="+" data-id="${i.id}" aria-label="Mais">+</button></div>
              <span class="muted small">de ${fmtQtd(i.quantidade, i.unidade)}</span>` : html`<span class="muted small">1 un.</span>`}
          </div>`; })}</div>`);
        box.querySelectorAll("[data-chk]").forEach((c) => (c.onchange = () => {
          const it = itens.find((i) => i.id === c.dataset.chk);
          if (c.checked) sel.set(it.id, Number(it.quantidade)); else sel.delete(it.id);
          desenharModo();
        }));
        box.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => {
          const it = itens.find((i) => i.id === b.dataset.id);
          const passo = FRACIONADOS.includes(it.unidade) ? 0.1 : 1;
          const atual = sel.get(it.id) || Number(it.quantidade);
          const novo = Math.round(Math.max(passo, Math.min(Number(it.quantidade), atual + (b.dataset.q === "+" ? passo : -passo))) * 1000) / 1000;
          sel.set(it.id, novo); desenharModo();
        }));
      };
      d.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { modo = b.dataset.m; desenharModo(); }));
      d.querySelectorAll("[data-dest]").forEach((b) => (b.onclick = async () => {
        if (modo === "itens" && !sel.size) return toast("Marque os itens que vão para o outro lugar", "erro");
        let destino;
        const [tipo, id] = b.dataset.dest.split(":");
        if (tipo === "mesa") destino = { mesa_id: id };
        if (tipo === "venda") destino = { venda_id: id };
        if (tipo === "nova") {
          const nome = await pedirTexto({ titulo: "Nova comanda", rotulo: "Nome ou número da comanda", minimo: 1, ok: "Criar e transferir", dica: "Ex.: 25, João, Balcão 3." });
          if (!nome) return;
          destino = { comanda: nome.slice(0, 30) };
        }
        fechar({ destino, rotulo: b.querySelector("strong")?.textContent, mesa: tipo === "mesa" ? outras.find((m) => m.id === id) : null });
      }));
      desenharModo();
    },
  });
  if (!escolha) return null;
  const { destino, mesa: destMesa } = escolha;
  const juntar = modo === "tudo" && (destino.venda_id || destMesa?.venda_id);
  if (juntar && !(await confirmar(`Juntar a conta de ${mesa.nome} com ${escolha.rotulo}? Os itens passam para ${escolha.rotulo}.`, { ok: "Juntar contas" }))) return null;
  const itensSel = modo === "itens" ? [...sel].map(([id, quantidade]) => ({ id, quantidade })) : null;
  const r = await rpc("transferir_pedido", { p_origem: v.id, p_destino: destino, p_itens: itensSel });
  const para = rotuloMesa(r.identificador) || escolha.rotulo;
  if (modo === "itens") { toast(`${r.itens} ${r.itens === 1 ? "item transferido" : "itens transferidos"} para ${para}`, "ok"); return { ficou: true }; }
  toast(r.juntou ? `Contas juntadas em ${para}` : `${mesa.comanda ? rotuloMesa(mesa.nome) : mesa.nome} → ${para}`, "ok");
  if (destMesa) return { mesa: destMesa, venda_id: r.venda_id };
  return { saiu: true };
}

