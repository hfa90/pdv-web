// Pedidos do cardápio digital (entrega e retirada) em quadro por etapa, em tempo real.
import { sb, q, rpc } from "../api.js";
import { estado, eh, atualizarCaixa } from "../estado.js";
import { html, render, $, $$, dinheiro, hora, dataHora, qtd as fmtQtd, toast, erro, modal, pedirTexto, ocupado, debounce, urlSegura, raw } from "../ui.js";
import { icone } from "../icons.js";
import { imprimir, imprimirVenda, layoutDelivery, enderecoTexto, pagamentoPrevisto, configImpressora } from "../impressao/cupom.js";
import { bipe, contarNovos } from "../avisos.js";
import { linkCardapio } from "../links.js";
import { tempo, minutos } from "../mesa-detalhe.js";

const ETAPAS = { recebido: "Recebido", preparando: "Em preparo", pronto: "Pronto", saiu: "Saiu para entrega", entregue: "Entregue", cancelado: "Cancelado" };
const CAMPOS = "id,numero,status,canal,created_at,finalizada_em,status_pedido,status_historico,cliente_nome,cliente_telefone,endereco,subtotal,desconto,acrescimo,taxa_entrega,total,forma_prevista,troco_para,pagamento_status,observacao,cliente_id,identificador,alterado_em,motivo_cancelamento";
const CHAVE_SOM = "pdv-delivery-som";

export default async function delivery(el) {
  let pedidos = [], concluidos = [];
  let som = (() => { try { return localStorage.getItem(CHAVE_SOM) !== "0"; } catch { return true; } })();
  const podeAbrirFechar = eh("admin", "gerente");

  render(el, html`<div class="page delivery-page">
    <div class="page-head">
      <div><h1>Delivery</h1><p id="resumo-del"></p></div>
      <div class="row wrap">
        <button class="btn" id="loja-status"></button>
        <button class="btn icon-btn" id="som" title="Som de novo pedido"></button>
        ${estado.empresa.slug ? html`<a class="btn" href="${linkCardapio(estado.empresa.slug)}" target="_blank" rel="noopener">${icone("link", 'width="18" height="18"')} Ver cardápio</a>` : ""}
      </div>
    </div>
    <div class="kanban" id="kanban"></div>
    <details class="panel concluidos" id="concl"><summary class="panel-head"><h2>Concluídos hoje</h2><span class="muted small" id="n-concl"></span></summary><div id="lista-concl"></div></details>
  </div>`);

  async function carregar() {
    const ini = new Date(); ini.setHours(0, 0, 0, 0);
    const [abertos, fechados] = await Promise.all([
      q(sb.from("vendas").select(CAMPOS + ",itens:venda_itens(descricao,quantidade,unidade,observacao,removido,item)").eq("status", "aberta").in("canal", ["delivery", "retirada"]).order("created_at")),
      q(sb.from("vendas").select(CAMPOS).neq("status", "aberta").in("canal", ["delivery", "retirada"]).gte("created_at", ini.toISOString()).order("created_at", { ascending: false }).limit(100)),
    ]);
    pedidos = abertos; concluidos = fechados;
    desenhar();
    contarNovos().catch(() => {});
  }
  const carregarDepois = debounce(() => carregar().catch(() => {}), 350);

  function desenharTopo() {
    const aberto = estado.empresa.delivery_aberto;
    const b = $("#loja-status", el);
    b.className = "btn " + (aberto ? "loja-aberta" : "loja-fechada");
    b.innerHTML = `<span class="dot-sit ${aberto ? "livre" : "conta"}"></span> ${aberto ? "Recebendo pedidos" : "Pedidos pausados"}`;
    b.disabled = !podeAbrirFechar;
    $("#som", el).innerHTML = som ? "🔔" : "🔕";
    const fat = concluidos.filter((v) => v.status === "finalizada").reduce((a, v) => a + Number(v.total), 0);
    render($("#resumo-del", el), html`${pedidos.length} em andamento · ${concluidos.filter((v) => v.status === "finalizada").length} entregues hoje · ${dinheiro(fat)}`);
  }

  function desenhar() {
    desenharTopo();
    const col = (titulo, cls, lista, vazio) => html`<section class="kb-col ${cls}">
      <header><h2>${titulo}</h2><span class="kb-n">${lista.length}</span></header>
      <div class="kb-lista">${lista.length ? lista.map(cartao) : html`<p class="kb-vazio">${vazio}</p>`}</div></section>`;
    render($("#kanban", el), html`
      ${col("Novos", "kb-novos", pedidos.filter((p) => p.status_pedido === "recebido"), "Os pedidos do cardápio aparecem aqui na hora.")}
      ${col("Em preparo", "kb-preparo", pedidos.filter((p) => p.status_pedido === "preparando"), "Nada em preparo.")}
      ${col("Prontos e a caminho", "kb-prontos", pedidos.filter((p) => ["pronto", "saiu"].includes(p.status_pedido)), "Nada pronto ainda.")}`);
    $$("[data-acao]", el).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); acao(b.dataset.acao, pedidos.find((p) => p.id === b.dataset.id), b); }));
    $$(".kb-card", el).forEach((c) => (c.onclick = () => detalhes(pedidos.find((p) => p.id === c.dataset.id))));
    $("#n-concl", el).textContent = concluidos.length ? `${concluidos.length} pedidos` : "nenhum";
    render($("#lista-concl", el), concluidos.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Nº</th><th>Cliente</th><th>Tipo</th><th>Hora</th><th>Situação</th><th class="r">Total</th></tr></thead>
      <tbody>${concluidos.map((v) => html`<tr><td>${v.numero}</td><td>${v.cliente_nome}</td><td>${v.canal === "delivery" ? "Entrega" : "Retirada"}</td><td>${hora(v.created_at)}</td>
        <td>${v.status === "cancelada" ? html`<span class="badge danger" title="${v.motivo_cancelamento || ""}">cancelado</span>` : html`<span class="badge ok">entregue</span>`}</td><td class="r">${dinheiro(v.total)}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted panel-pad">Nenhum pedido concluído hoje.</p>`);
  }

  function pagamentoBadge(p) {
    if (p.pagamento_status === "pago") return html`<span class="badge ok">${icone("check", 'width="12" height="12"')} Pago · ${pagamentoPrevisto(p.forma_prevista)}</span>`;
    if (p.forma_prevista === "pix") return html`<span class="badge warn">PIX aguardando</span>`;
    if (p.forma_prevista === "dinheiro") return html`<span class="badge">Dinheiro${p.troco_para ? ` · troco p/ ${dinheiro(p.troco_para)}` : ""}</span>`;
    return html`<span class="badge">${pagamentoPrevisto(p.forma_prevista)}</span>`;
  }

  function cartao(p) {
    const itens = (p.itens || []).filter((i) => !i.removido).sort((a, b) => a.item - b.item);
    const atraso = minutos(p.created_at) > 45 && ["recebido", "preparando"].includes(p.status_pedido);
    const botoes = {
      recebido: html`<button class="btn sm ghost" data-acao="recusar" data-id="${p.id}">Recusar</button><button class="btn sm primary" data-acao="aceitar" data-id="${p.id}">Aceitar${configImpressora().cozinha ? "" : " e imprimir"}</button>`,
      preparando: html`<button class="btn sm primary" data-acao="pronto" data-id="${p.id}">Pedido pronto</button>`,
      pronto: p.canal === "delivery"
        ? html`<button class="btn sm primary" data-acao="saiu" data-id="${p.id}">${icone("moto", 'width="16" height="16"')} Saiu para entrega</button>`
        : html`<button class="btn sm primary" data-acao="concluir" data-id="${p.id}">Entregar ao cliente</button>`,
      saiu: html`<button class="btn sm primary" data-acao="concluir" data-id="${p.id}">Entregue · concluir</button>`,
    }[p.status_pedido];
    return html`<article class="kb-card ${atraso ? "atraso" : ""} ${p.status_pedido === "recebido" ? "novo" : ""}" data-id="${p.id}" tabindex="0">
      <div class="kb-topo"><strong>#${p.numero}</strong>
        <span class="badge ${p.canal === "delivery" ? "canal-delivery" : "canal-retirada"}">${p.canal === "delivery" ? "Entrega" : "Retirada"}</span>
        <span class="grow"></span><span class="kb-tempo ${atraso ? "demora" : ""}">${icone("relogio", 'width="14" height="14"')} ${tempo(p.created_at)}</span></div>
      <div class="kb-cliente">${p.cliente_nome}${p.endereco?.bairro ? html` <span class="muted">· ${p.endereco.bairro}</span>` : ""}</div>
      <ul class="kb-itens">${itens.slice(0, 4).map((i) => html`<li><b>${fmtQtd(i.quantidade, i.unidade)}×</b> ${i.descricao}${i.observacao ? html` <em>(${i.observacao})</em>` : ""}</li>`)}
        ${itens.length > 4 ? html`<li class="muted">+ ${itens.length - 4} itens</li>` : ""}</ul>
      <div class="kb-rodape">${pagamentoBadge(p)}<span class="grow"></span><strong>${dinheiro(p.total)}</strong></div>
      ${p.status_pedido === "saiu" ? html`<div class="small muted">Saiu às ${hora((p.status_historico || []).filter((h) => h.status === "saiu").pop()?.em)}</div>` : ""}
      <div class="kb-acoes">${botoes}</div>
    </article>`;
  }

  async function acao(a, p, botao) {
    try {
      if (a === "aceitar") {
        await ocupado(botao, () => rpc("atualizar_pedido", { p_venda: p.id, p_status: "preparando" }));
        if (!configImpressora().cozinha) imprimirVenda(p.id).catch((e) => toast("Impressão: " + e.message, "erro"));
        toast(`Pedido #${p.numero} aceito · o cliente já está vendo`, "ok");
      }
      if (a === "recusar") {
        const motivo = await pedirTexto({ titulo: `Recusar pedido #${p.numero}`, rotulo: "Motivo (o cliente verá)", minimo: 3, ok: "Recusar pedido", dica: "Ex.: produto em falta, fora da área de entrega." });
        if (!motivo) return;
        await rpc("atualizar_pedido", { p_venda: p.id, p_status: "cancelado", p_motivo: motivo });
        toast("Pedido recusado", "ok");
      }
      if (a === "pronto") await ocupado(botao, () => rpc("atualizar_pedido", { p_venda: p.id, p_status: "pronto" }));
      if (a === "saiu") await ocupado(botao, () => rpc("atualizar_pedido", { p_venda: p.id, p_status: "saiu" }));
      if (a === "concluir") await concluir(p);
      await carregar();
    } catch (e) { erro(e); }
  }

  /** Fecha o pedido como venda (baixa estoque e entra no caixa). */
  async function concluir(p) {
    if (!estado.caixa) await atualizarCaixa();
    if (!estado.caixa) {
      toast("Abra o caixa para concluir. Levando o pedido para o caixa…", "erro");
      location.hash = `#/pdv/${p.id}`; return;
    }
    const pago = p.pagamento_status === "pago";
    const padrao = pago ? "pix" : p.forma_prevista === "cartao" ? "debito" : p.forma_prevista || "dinheiro";
    const r = await modal({
      titulo: `Concluir pedido #${p.numero}`,
      corpo: html`<div class="stack">
        <div class="total" style="padding:0"><span class="total-label">Total</span><span class="total-valor">${dinheiro(p.total)}</span></div>
        ${pago ? html`<div class="alerta ok">Pago por PIX no cardápio. É só confirmar a entrega.</div>` : html`
          <div class="field"><span>Como o cliente pagou</span><div class="formas pequenas">
            ${[["dinheiro", "Dinheiro"], ["pix", "PIX"], ["debito", "Débito"], ["credito", "Crédito"]].map(([f, n]) => html`<label class="forma-radio"><input type="radio" name="forma" value="${f}" ${f === padrao ? "checked" : ""}><span>${n}</span></label>`)}</div></div>
          ${p.troco_para ? html`<p class="small">Cliente pediu troco para ${dinheiro(p.troco_para)}: levar <b>${dinheiro(Number(p.troco_para) - Number(p.total))}</b>.</p>` : ""}`}
        <label class="check"><input type="checkbox" id="imp" ${configImpressora().autoImprimir ? "checked" : ""}> Imprimir cupom</label>
      </div>`,
      rodape: html`<a class="btn" href="#/pdv/${p.id}" data-fechar>Abrir no caixa</a><span class="grow"></span><button class="btn" data-fechar>Voltar</button><button class="btn primary" id="ok">Concluir</button>`,
      onPronto: (d, fechar) => (d.querySelector("#ok").onclick = () => fechar({ forma: pago ? "pix" : d.querySelector("[name=forma]:checked").value, imprimir: d.querySelector("#imp").checked })),
    });
    if (!r) return;
    const completo = await q(sb.from("vendas").select("*, itens:venda_itens(*)").eq("id", p.id).single());
    const vivos = completo.itens.filter((i) => !i.removido).sort((a, b) => a.item - b.item);
    const descItens = vivos.reduce((a, i) => a + Number(i.desconto), 0);
    const res = await rpc("registrar_venda", { p: {
      venda_id: p.id, finalizar: true, alterado_em: completo.alterado_em,
      itens: vivos.map((i) => ({ produto_id: i.produto_id, quantidade: Number(i.quantidade), observacao: i.observacao, desconto: Number(i.desconto) })),
      desconto: Math.max(0, Number(completo.desconto) - descItens), acrescimo: Number(completo.acrescimo),
      cliente_id: completo.cliente_id, identificador: completo.identificador, observacao: completo.observacao,
      pagamentos: [{ forma: r.forma, valor: Number(completo.total) }],
    } });
    toast(`Pedido #${p.numero} concluído`, "ok");
    if (r.imprimir) imprimirVenda(res.id).catch((e) => toast("Impressão: " + e.message, "erro"));
  }

  async function detalhes(p) {
    if (!p) return;
    const v = await q(sb.from("vendas").select(CAMPOS + ",itens:venda_itens(*)").eq("id", p.id).single());
    const itens = v.itens.filter((i) => !i.removido).sort((a, b) => a.item - b.item);
    const end = enderecoTexto(v.endereco);
    const mapa = end ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(end)}` : null;
    const tel = (v.cliente_telefone || "").replace(/\D/g, "");
    const zap = tel ? `https://wa.me/55${tel}?text=${encodeURIComponent(`Olá, ${v.cliente_nome}! Aqui é da ${estado.empresa.nome_fantasia || estado.empresa.razao_social}, sobre o seu pedido #${v.numero}.`)}` : null;
    await modal({
      titulo: `Pedido #${v.numero} · ${v.canal === "delivery" ? "Entrega" : "Retirada"}`, largo: true,
      corpo: html`<div class="two-col" style="gap:1.25rem;margin:0">
        <div class="stack">
          <div class="md-itens">${itens.map((i) => html`<div class="md-item"><div class="md-q">${fmtQtd(i.quantidade, i.unidade)}×</div>
            <div class="grow">${i.descricao}${i.observacao ? html`<div class="small obs">${i.observacao}</div>` : ""}</div><div class="r">${dinheiro(i.total)}</div></div>`)}</div>
          <div class="linha-valor"><span>Subtotal</span><span>${dinheiro(v.subtotal)}</span></div>
          ${Number(v.taxa_entrega) ? html`<div class="linha-valor"><span>Entrega</span><span>${dinheiro(v.taxa_entrega)}</span></div>` : ""}
          <div class="md-total"><span>Total</span><strong>${dinheiro(v.total)}</strong></div>
          ${v.observacao ? html`<div class="alerta info"><b>Observação:</b> ${v.observacao}</div>` : ""}
        </div>
        <div class="stack">
          <div><div class="muted small">Cliente</div><strong>${v.cliente_nome}</strong> <span class="muted">${tel.replace(/(\d{2})(\d{4,5})(\d{4})/, "($1) $2-$3")}</span></div>
          ${end ? html`<div><div class="muted small">Endereço</div>${end}${v.endereco?.referencia ? html`<div class="small">Ref.: ${v.endereco.referencia}</div>` : ""}</div>` : ""}
          <div><div class="muted small">Pagamento</div>${pagamentoBadge(v)}</div>
          <div class="row wrap">
            ${zap ? html`<a class="btn sm" href="${urlSegura(zap)}" target="_blank" rel="noopener">${icone("whatsapp", 'width="16" height="16"')} WhatsApp</a>` : ""}
            ${mapa ? html`<a class="btn sm" href="${urlSegura(mapa)}" target="_blank" rel="noopener">Ver no mapa</a>` : ""}
            <button class="btn sm" id="d-imp">${icone("imprimir", 'width="16" height="16"')} Imprimir</button>
            ${v.pagamento_status !== "pago" && v.forma_prevista === "pix" && v.status === "aberta" ? html`<button class="btn sm primary" id="d-pago">Confirmar PIX recebido</button>` : ""}
          </div>
          <div><div class="muted small" style="margin-bottom:.35rem">Andamento</div>
            <ol class="timeline">${(v.status_historico || []).map((h) => html`<li><b>${ETAPAS[h.status] || h.status}</b> <span class="muted">${dataHora(h.em)}</span></li>`)}</ol></div>
        </div></div>`,
      onPronto: (d, fechar) => {
        d.querySelector("#d-imp").onclick = () => imprimir(layoutDelivery(v)).catch(erro);
        d.querySelector("#d-pago")?.addEventListener("click", async () => {
          try { await rpc("confirmar_pagamento_pedido", { p_venda: v.id }); toast("Pagamento confirmado", "ok"); fechar(); carregar(); } catch (e) { erro(e); }
        });
      },
    });
  }

  $("#loja-status", el).onclick = async () => {
    try {
      const novo = !estado.empresa.delivery_aberto;
      await rpc("delivery_abrir", { p_aberto: novo });
      estado.empresa.delivery_aberto = novo;
      toast(novo ? "Loja recebendo pedidos" : "Pedidos pausados no cardápio", "ok");
      desenharTopo();
    } catch (e) { erro(e); }
  };
  $("#som", el).onclick = () => {
    som = !som;
    try { localStorage.setItem(CHAVE_SOM, som ? "1" : "0"); } catch { /* ignora */ }
    if (som) bipe(1);
    if (som && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
    desenharTopo();
  };

  await carregar();

  const emp = estado.empresa.id;
  const tituloOriginal = document.title;
  let piscar = null;
  const avisar = (v) => {
    if (som) bipe(3);
    toast(`Novo pedido #${v.numero} · ${v.cliente_nome}`, "ok");
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      try { new Notification(`Novo pedido #${v.numero}`, { body: `${v.cliente_nome} · ${dinheiro(v.total)}`, tag: "pedido-" + v.id }); } catch { /* ignora */ }
    }
    if (document.hidden && !piscar) {
      let n = 0; piscar = setInterval(() => { document.title = n++ % 2 ? tituloOriginal : "🔔 Novo pedido!"; }, 1000);
    }
  };
  const voltou = () => { if (!document.hidden && piscar) { clearInterval(piscar); piscar = null; document.title = tituloOriginal; } };
  document.addEventListener("visibilitychange", voltou);
  const canal = sb.channel("delivery-" + emp + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "vendas", filter: `empresa_id=eq.${emp}` }, ({ eventType, new: v }) => {
      if (!["delivery", "retirada"].includes(v?.canal)) return;
      // O total chega depois dos itens: espera um instante antes de avisar
      if (eventType === "INSERT") setTimeout(async () => { const { data } = await sb.from("vendas").select("id,numero,cliente_nome,total").eq("id", v.id).single(); if (data) avisar(data); }, 900);
      carregarDepois();
    })
    .subscribe();
  const relogio = setInterval(() => carregar().catch(() => {}), 45000);

  return () => { sb.removeChannel(canal); clearInterval(relogio); document.removeEventListener("visibilitychange", voltou); if (piscar) clearInterval(piscar); document.title = tituloOriginal; };
}
