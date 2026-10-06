// Tela da cozinha (KDS): pedidos do salão aprovados pelo caixa e do delivery aceito,
// em colunas por etapa, com tempo de preparo, som e modo tela cheia.
import { sb, rpc } from "../api.js";
import { estado, aprovaCozinha } from "../estado.js";
import { html, render, $, $$, toast, erro, ocupado, debounce, hora, qtd as fmtQtd, rotuloMesa } from "../ui.js";
import { icone } from "../icons.js";
import { bipe } from "../avisos.js";
import { minutosDesde, duracao, ETAPA_COZINHA } from "../restaurante.js";
import { cartaoAprovacao, ligarAprovacao } from "../aprovacoes.js";

const CHAVE_SOM = "pdv-cozinha-som";
const ORIGEM = { mesa: "Mesa", balcao: "Comanda", delivery: "Entrega", retirada: "Retirada" };

export default async function cozinha(el) {
  let dados = { pedidos: [], preparo_alvo_min: 20, aprovacao: true };
  let som = (() => { try { return localStorage.getItem(CHAVE_SOM) !== "0"; } catch { return true; } })();
  let vistos = null; // ids já exibidos (para tocar o som só nos novos)
  const aprova = aprovaCozinha();

  render(el, html`<div class="page cozinha-page" id="kds">
    <div class="page-head">
      <div><h1>${icone("chapeu", 'width="26" height="26"')} Cozinha</h1><p id="kds-resumo" class="muted"></p></div>
      <div class="row wrap">
        <span class="kds-relogio" id="relogio"></span>
        <button class="btn icon-btn" id="som" title="Som de novo pedido"></button>
        <button class="btn" id="cheia">${icone("telaCheia", 'width="18" height="18"')} <span>Tela cheia</span></button>
      </div>
    </div>
    <div class="kds" id="kds-colunas"></div>
    <details class="panel concluidos" id="recentes"><summary class="panel-head"><h2>Servidos e recusados (últimas 3 horas)</h2><span class="muted small" id="n-rec"></span></summary><div id="lista-rec"></div></details>
  </div>`);

  async function carregar() {
    dados = await rpc("cozinha_painel");
    const ativos = dados.pedidos.filter((p) => p.status === "novo" || (p.status === "aguardando" && aprova));
    if (vistos && som && ativos.some((p) => !vistos.has(p.id))) bipe(3);
    vistos = new Set(ativos.map((p) => p.id));
    desenhar();
  }
  const carregarDepois = debounce(() => carregar().catch(() => {}), 350);

  function nivel(p) {
    const ini = p.aprovado_em || p.criado_em;
    const min = minutosDesde(ini);
    const alvo = Number(dados.preparo_alvo_min) || 20;
    return { min, cls: min >= alvo ? "atrasado" : min >= alvo * 0.7 ? "alerta" : "ok", alvo };
  }

  function cartao(p) {
    const t = nivel(p);
    const itens = p.itens || [];
    const botoes = {
      novo: html`<button class="btn ghost sm" data-ir="pronto" data-id="${p.id}">Já está pronto</button><button class="btn primary" data-ir="preparando" data-id="${p.id}">${icone("fogo", 'width="18" height="18"')} Começar</button>`,
      preparando: html`<button class="btn ghost sm" data-ir="novo" data-id="${p.id}">Voltar</button><button class="btn primary ok" data-ir="pronto" data-id="${p.id}">${icone("check", 'width="18" height="18"')} Pronto</button>`,
      pronto: html`<button class="btn ghost sm" data-ir="preparando" data-id="${p.id}">Voltar ao preparo</button><button class="btn" data-ir="entregue" data-id="${p.id}">${p.origem === "delivery" ? "Saiu / entregue" : "Servido"}</button>`,
    }[p.status];
    return html`<article class="kds-card k-${t.cls} st-${p.status}" data-id="${p.id}">
      <header>
        <div class="kds-mesa">${p.origem === "mesa" ? rotuloMesa(p.identificador).replace(/^Mesa\s+/i, "") : p.identificador}</div>
        <div class="kds-meta">
          <span class="badge kds-origem o-${p.origem}">${ORIGEM[p.origem] || p.origem}${p.numero_venda ? ` · nº ${p.numero_venda}` : ""}</span>
          <span class="small">${p.garcom ? p.garcom.split(" ")[0] + " · " : ""}${hora(p.criado_em)}</span>
        </div>
        <div class="kds-timer" title="Tempo desde a aprovação · meta ${t.alvo} min">${icone("relogio", 'width="16" height="16"')} ${duracao(t.min)}</div>
      </header>
      <ul class="kds-itens">${itens.map((i) => html`<li class="${i.cancelado ? "cancelado" : ""}">
        <b>${fmtQtd(i.quantidade, i.unidade)}</b><span>${i.descricao}${i.cancelado ? html` <em class="tag-canc">cancelado</em>` : ""}
        ${i.observacao ? html`<small class="kds-obs">${i.observacao}</small>` : ""}</span></li>`)}</ul>
      <footer>${botoes}</footer>
    </article>`;
  }

  function desenhar() {
    const ps = dados.pedidos;
    const por = (s) => ps.filter((p) => p.status === s);
    const aguardando = por("aguardando");
    const col = (titulo, cls, lista, vazio, render) => html`<section class="kds-col ${cls}">
      <header><h2>${titulo}</h2><span class="kb-n">${lista.length}</span></header>
      <div class="kds-lista">${lista.length ? lista.map(render) : html`<p class="kb-vazio">${vazio}</p>`}</div></section>`;
    const mostrarAprov = dados.aprovacao || aguardando.length;
    render($("#kds-colunas", el), html`
      ${mostrarAprov ? col("Aguardando aprovação", "kc-aprov", aguardando, aprova ? "Nada para aprovar." : "Os pedidos aparecem aqui até o caixa aprovar.",
        (p) => aprova ? cartaoAprovacao(p) : html`<article class="aprov-card bloqueado"><div class="aprov-topo"><strong>${rotuloMesa(p.identificador)}</strong><span class="grow"></span><span class="kb-tempo">${duracao(minutosDesde(p.criado_em))}</span></div>
          <ul class="kb-itens">${(p.itens || []).filter((i) => !i.cancelado).map((i) => html`<li><b>${fmtQtd(i.quantidade, i.unidade)}×</b> ${i.descricao}</li>`)}</ul><p class="small muted" style="margin:0">Aguardando o caixa</p></article>`) : ""}
      ${col("Na fila", "kc-novo", por("novo"), "Nenhum pedido novo.", cartao)}
      ${col("Preparando", "kc-preparo", por("preparando"), "Nada no fogo.", cartao)}
      ${col("Prontos", "kc-pronto", por("pronto"), "Nada esperando o garçom.", cartao)}`);
    $("#kds-colunas", el).classList.toggle("sem-aprov", !mostrarAprov);
    ligarAprovacao($("#kds-colunas", el), carregar);
    $$("[data-ir]", el).forEach((b) => (b.onclick = async () => {
      try { await ocupado(b, () => rpc("cozinha_avancar", { p_id: b.dataset.id, p_status: b.dataset.ir })); await carregar(); }
      catch (err) { erro(err); }
    }));

    const atrasados = ps.filter((p) => ["novo", "preparando"].includes(p.status) && nivel(p).cls === "atrasado").length;
    render($("#kds-resumo", el), html`${por("novo").length + por("preparando").length} em produção · ${por("pronto").length} prontos
      ${aguardando.length ? html` · <b class="txt-alerta">${aguardando.length} aguardando aprovação</b>` : ""}
      ${atrasados ? html` · <b class="txt-perigo">${atrasados} acima de ${dados.preparo_alvo_min} min</b>` : ""}`);
    $("#som", el).innerHTML = som ? "🔔" : "🔕";

    const rec = ps.filter((p) => ["entregue", "recusado", "cancelado"].includes(p.status)).sort((a, b) => new Date(b.entregue_em || b.criado_em) - new Date(a.entregue_em || a.criado_em));
    $("#n-rec", el).textContent = rec.length ? `${rec.length}` : "nenhum";
    render($("#lista-rec", el), rec.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Mesa / pedido</th><th>Itens</th><th>Situação</th><th>Hora</th><th></th></tr></thead>
      <tbody>${rec.map((p) => html`<tr><td><strong>${rotuloMesa(p.identificador)}</strong></td>
        <td class="small">${(p.itens || []).filter((i) => !i.cancelado).map((i) => `${fmtQtd(i.quantidade, i.unidade)}× ${i.descricao}`).join(", ")}</td>
        <td>${p.status === "entregue" ? html`<span class="badge ok">${ETAPA_COZINHA.entregue}</span>` : html`<span class="badge danger" title="${p.recusado_motivo || ""}">${ETAPA_COZINHA[p.status]}${p.recusado_motivo ? ": " + p.recusado_motivo : ""}</span>`}</td>
        <td>${hora(p.entregue_em || p.criado_em)}</td>
        <td class="r">${p.status === "entregue" ? html`<button class="btn sm ghost" data-ir="pronto" data-id="${p.id}">Desfazer</button>` : ""}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted panel-pad">Nada por aqui ainda.</p>`);
    $$("#lista-rec [data-ir]", el).forEach((b) => (b.onclick = async () => {
      try { await rpc("cozinha_avancar", { p_id: b.dataset.id, p_status: b.dataset.ir }); await carregar(); } catch (err) { erro(err); }
    }));
  }

  function relogio() { const r = $("#relogio", el); if (r) r.textContent = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }

  $("#som", el).onclick = () => {
    som = !som;
    try { localStorage.setItem(CHAVE_SOM, som ? "1" : "0"); } catch { /* ignora */ }
    if (som) bipe(1);
    desenhar();
  };
  $("#cheia", el).onclick = () => {
    const alvo = $("#kds", el);
    if (document.fullscreenElement) document.exitFullscreen?.();
    else alvo.requestFullscreen?.().catch(() => toast("O navegador não permitiu tela cheia", "erro"));
  };

  await carregar();
  relogio();

  const emp = estado.empresa.id;
  const canal = sb.channel("kds-" + emp + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "cozinha_pedidos", filter: `empresa_id=eq.${emp}` }, carregarDepois)
    .subscribe();
  const tique = setInterval(() => { relogio(); if (!document.hidden) desenhar(); }, 15000);
  const busca = setInterval(() => { if (!document.hidden) carregar().catch(() => {}); }, 30000);
  // Evita a tela apagar na TV/tablet da cozinha
  let trava = null;
  try { trava = await navigator.wakeLock?.request("screen"); } catch { /* sem suporte */ }

  return () => { sb.removeChannel(canal); clearInterval(tique); clearInterval(busca); trava?.release?.().catch(() => {}); if (document.fullscreenElement) document.exitFullscreen?.(); };
}
