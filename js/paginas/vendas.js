// Histórico de vendas: detalhes, reimpressão, nota fiscal e cancelamento.
import { sb, q, rpc, fn } from "../api.js";
import { estado, eh } from "../estado.js";
import { html, render, $, $$, dinheiro, dataHora, qtd as fmtQtd, toast, erro, modal, pedirTexto, confirmar, debounce, formatarDoc, urlSegura } from "../ui.js";
import { icone } from "../icons.js";
import { imprimirVenda, nomeForma } from "../impressao/cupom.js";

const STATUS = { finalizada: ["ok", "Finalizada"], aberta: ["info", "Pedido aberto"], cancelada: ["danger", "Cancelada"] };
const DOC = { autorizado: "ok", processando: "warn", rejeitado: "danger", erro: "danger", cancelado: "" };
const POR_PAGINA = 50;

export default async function vendas(el) {
  const hoje = new Date().toISOString().slice(0, 10);
  const f = { de: hoje, ate: hoje, status: "", busca: "", pagina: 0 };

  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Vendas</h1><p>Consulte, reimprima, emita nota ou cancele.</p></div></div>
    <div class="toolbar">
      <label class="field"><span>De</span><input class="input" type="date" id="de" value="${f.de}"></label>
      <label class="field"><span>Até</span><input class="input" type="date" id="ate" value="${f.ate}"></label>
      <label class="field"><span>Situação</span><select class="input" id="st"><option value="">Todas</option><option value="finalizada">Finalizadas</option><option value="aberta">Pedidos abertos</option><option value="cancelada">Canceladas</option></select></label>
      <label class="field grow"><span>Número ou mesa</span><input class="input" id="busca" placeholder="Ex.: 154 ou Mesa 4"></label>
    </div>
    <div class="panel" id="lista"></div>
  </div>`);

  async function carregar() {
    const inicio = new Date(f.de + "T00:00:00"); const fim = new Date(f.ate + "T00:00:00"); fim.setDate(fim.getDate() + 1);
    let qy = sb.from("vendas").select("id,numero,status,identificador,total,created_at,finalizada_em,operador:perfis!vendas_operador_id_fkey(nome), docs:documentos_fiscais(status,modelo)", { count: "exact" })
      .gte("created_at", inicio.toISOString()).lt("created_at", fim.toISOString())
      .order("created_at", { ascending: false }).range(f.pagina * POR_PAGINA, f.pagina * POR_PAGINA + POR_PAGINA - 1);
    if (f.status) qy = qy.eq("status", f.status);
    const t = f.busca.trim();
    if (t) qy = /^\d+$/.test(t) ? qy.or(`numero.eq.${t},identificador.ilike.%${t}%`) : qy.ilike("identificador", `%${t.replace(/[%,()]/g, "")}%`);
    const { data, count, error } = await qy;
    if (error) throw error;
    const total = data.filter((v) => v.status === "finalizada").reduce((a, v) => a + Number(v.total), 0);
    render($("#lista", el), data.length ? html`
      <div class="panel-head"><span class="muted small">${count} vendas · finalizadas nesta página somam <strong style="color:var(--ink)">${dinheiro(total)}</strong></span>
        <div class="row">${f.pagina > 0 ? html`<button class="btn sm" id="ant">Anteriores</button>` : ""}${(f.pagina + 1) * POR_PAGINA < count ? html`<button class="btn sm" id="prox">Próximas</button>` : ""}</div></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Nº</th><th>Data</th><th>Mesa</th><th>Operador</th><th>Situação</th><th>Nota</th><th class="r">Total</th></tr></thead>
      <tbody>${data.map((v) => { const d = v.docs?.find((x) => x.status === "autorizado") || v.docs?.[0]; return html`<tr class="click" data-id="${v.id}">
        <td><strong>${v.numero}</strong></td><td>${dataHora(v.finalizada_em || v.created_at)}</td><td>${v.identificador || ""}</td><td>${v.operador?.nome || ""}</td>
        <td><span class="badge ${STATUS[v.status][0]}">${STATUS[v.status][1]}</span></td>
        <td>${d ? html`<span class="badge ${DOC[d.status]}">${d.modelo === "55" ? "NF-e" : "NFC-e"} ${d.status}</span>` : ""}</td>
        <td class="r"><strong>${dinheiro(v.total)}</strong></td></tr>`; })}</tbody></table></div>`
      : html`<div class="empty">${icone("vendas", 'width="40" height="40"')}<p>Nenhuma venda neste período.</p></div>`);
    $$("tr[data-id]", el).forEach((tr) => (tr.onclick = () => detalhe(tr.dataset.id)));
    $("#ant", el)?.addEventListener("click", () => { f.pagina--; recarregar(); });
    $("#prox", el)?.addEventListener("click", () => { f.pagina++; recarregar(); });
  }
  const recarregar = () => carregar().catch(erro);

  $("#de", el).onchange = (e) => { f.de = e.target.value; f.pagina = 0; recarregar(); };
  $("#ate", el).onchange = (e) => { f.ate = e.target.value; f.pagina = 0; recarregar(); };
  $("#st", el).onchange = (e) => { f.status = e.target.value; f.pagina = 0; recarregar(); };
  $("#busca", el).oninput = debounce((e) => { f.busca = e.target.value; f.pagina = 0; recarregar(); }, 300);

  async function detalhe(id) {
    const v = await q(sb.from("vendas").select("*, cliente:clientes(*), operador:perfis!vendas_operador_id_fkey(nome), cancelador:perfis!vendas_cancelada_por_fkey(nome), itens:venda_itens(*), pagamentos:venda_pagamentos(*), docs:documentos_fiscais(*)").eq("id", id).single());
    const itens = v.itens.filter((i) => !i.removido).sort((a, b) => a.item - b.item);
    const removidos = v.itens.filter((i) => i.removido);
    const docs = (v.docs || []).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const autorizado = docs.find((d) => d.status === "autorizado");
    const fiscal = estado.fiscal?.habilitado;
    const gerente = eh("admin", "gerente");

    const acao = await modal({
      titulo: `Venda nº ${v.numero}`, largo: true,
      corpo: html`<div class="stack-lg">
        <div class="row wrap"><span class="badge ${STATUS[v.status][0]}">${STATUS[v.status][1]}</span>
          <span class="muted small">${dataHora(v.finalizada_em || v.created_at)} · ${v.operador?.nome || ""}${v.identificador ? ` · Mesa ${v.identificador}` : ""}</span></div>
        ${v.status === "cancelada" ? html`<div class="alerta">Cancelada em ${dataHora(v.cancelada_em)} por ${v.cancelador?.nome || "—"}: ${v.motivo_cancelamento}</div>` : ""}
        <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th class="r">Qtd</th><th class="r">Unit.</th><th class="r">Total</th></tr></thead>
          <tbody>${itens.map((i) => html`<tr><td>${i.descricao}${i.observacao ? html`<div class="hint">${i.observacao}</div>` : ""}</td><td class="r">${fmtQtd(i.quantidade, i.unidade)} ${i.unidade.toLowerCase()}</td><td class="r">${dinheiro(i.preco_unitario)}</td><td class="r">${dinheiro(i.total)}</td></tr>`)}</tbody></table></div>
        <div class="stack" style="gap:.3rem">
          ${Number(v.desconto) ? html`<div class="linha-valor"><span>Desconto</span><span>−${dinheiro(v.desconto)}</span></div>` : ""}
          ${Number(v.acrescimo) ? html`<div class="linha-valor"><span>Acréscimo</span><span>${dinheiro(v.acrescimo)}</span></div>` : ""}
          <div class="total" style="padding:0"><span class="total-label">Total</span><span class="total-valor" style="font-size:1.8rem">${dinheiro(v.total)}</span></div>
          ${v.pagamentos.map((p) => html`<div class="linha-valor"><span>${nomeForma(p.forma)}</span><span>${dinheiro(p.valor)}</span></div>`)}
          ${Number(v.troco) ? html`<div class="linha-valor"><span>Troco</span><span>${dinheiro(v.troco)}</span></div>` : ""}
          ${v.cliente || v.cpf_cnpj_consumidor ? html`<div class="linha-valor"><span>Cliente</span><span>${v.cliente?.nome || ""} ${formatarDoc(v.cpf_cnpj_consumidor || v.cliente?.cpf_cnpj)}</span></div>` : ""}
        </div>
        ${docs.length ? html`<div><h3 style="margin-bottom:.5rem">Notas fiscais</h3><div class="stack" style="gap:.4rem">${docs.map((d) => html`
          <div class="pag-linha" style="align-items:flex-start;gap:1rem"><div class="small">
            <strong>${d.modelo === "55" ? "NF-e" : "NFC-e"} ${d.numero ? "nº " + d.numero : ""}</strong> <span class="badge ${DOC[d.status]}">${d.status}</span>
            ${d.ambiente === "homologacao" ? html` <span class="badge warn">homologação</span>` : ""}
            ${d.mensagem ? html`<div class="muted">${d.mensagem}</div>` : ""}${d.chave ? html`<div class="muted">Chave ${d.chave}</div>` : ""}</div>
            <div class="row" style="gap:.35rem">${d.url_danfe ? html`<a class="btn sm" href="${urlSegura(d.url_danfe)}" target="_blank" rel="noopener">DANFE</a>` : ""}
              ${d.url_xml ? html`<a class="btn sm" href="${urlSegura(d.url_xml)}" target="_blank" rel="noopener">XML</a>` : ""}
              ${d.status === "processando" ? html`<button class="btn sm" data-consultar="${d.id}">Atualizar</button>` : ""}
              ${d.status === "autorizado" && gerente ? html`<button class="btn sm danger" data-cancnota="${d.id}">Cancelar nota</button>` : ""}</div></div>`)}</div></div>` : ""}
        ${removidos.length && gerente ? html`<details><summary class="muted small" style="cursor:pointer">${removidos.length} item(ns) retirado(s) do pedido antes do fechamento</summary>
          <div class="stack small" style="gap:.2rem;margin-top:.5rem">${removidos.map((i) => html`<div class="linha-valor"><span>${i.descricao} · ${fmtQtd(i.quantidade, i.unidade)}</span><span>${dataHora(i.removido_em)}</span></div>`)}</div></details>` : ""}
      </div>`,
      rodape: html`
        ${v.status === "finalizada" && gerente && !autorizado ? html`<button class="btn danger" data-a="cancelar">Cancelar venda</button>` : ""}
        ${v.status === "aberta" && !eh("atendente") ? html`<button class="btn danger" data-a="cancelar">Cancelar pedido</button>` : ""}
        <span class="grow"></span>
        ${v.status === "finalizada" && fiscal && !autorizado ? html`<button class="btn" data-a="nfce">Emitir NFC-e</button>${v.cliente ? html`<button class="btn" data-a="nfe">Emitir NF-e</button>` : ""}` : ""}
        <button class="btn primary" data-a="imprimir">${icone("imprimir", 'width="18" height="18"')} ${v.status === "aberta" ? "Imprimir pedido" : "Reimprimir"}</button>`,
      onPronto: (d, fechar) => {
        d.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => fechar({ a: b.dataset.a })));
        d.querySelectorAll("[data-consultar]").forEach((b) => (b.onclick = () => fechar({ a: "consultar", doc: b.dataset.consultar })));
        d.querySelectorAll("[data-cancnota]").forEach((b) => (b.onclick = () => fechar({ a: "cancnota", doc: b.dataset.cancnota })));
      },
    });
    if (!acao) return;
    try {
      if (acao.a === "imprimir") await imprimirVenda(v.id);
      if (acao.a === "nfce" || acao.a === "nfe") {
        toast("Enviando para a SEFAZ…");
        const doc = await fn("fiscal", { acao: "emitir", venda_id: v.id, modelo: acao.a === "nfe" ? "55" : "65" });
        toast(doc.status === "autorizado" ? "Nota autorizada" : `Nota ${doc.status}: ${doc.mensagem || ""}`, doc.status === "autorizado" ? "ok" : "erro");
        if (doc.status === "autorizado" && acao.a === "nfce") await imprimirVenda(v.id);
      }
      if (acao.a === "consultar") { const doc = await fn("fiscal", { acao: "consultar", documento_id: acao.doc }); toast(`Situação: ${doc.status}`); }
      if (acao.a === "cancnota") {
        const just = await pedirTexto({ titulo: "Cancelar nota fiscal", rotulo: "Justificativa", minimo: 15, ok: "Cancelar nota", dica: "Mínimo de 15 caracteres. O prazo de cancelamento da NFC-e é curto (em geral 30 minutos)." });
        if (just) { await fn("fiscal", { acao: "cancelar", documento_id: acao.doc, justificativa: just }); toast("Nota cancelada", "ok"); }
      }
      if (acao.a === "cancelar") {
        const motivo = await pedirTexto({ titulo: v.status === "aberta" ? "Cancelar pedido" : "Cancelar venda", rotulo: "Motivo", minimo: 3, ok: "Cancelar", dica: v.status === "finalizada" ? "Os itens voltam para o estoque. Devolva o valor ao cliente." : "" });
        if (motivo && (v.status === "aberta" || await confirmar(`Cancelar a venda nº ${v.numero} de ${dinheiro(v.total)}?`, { perigo: true, ok: "Cancelar venda" }))) {
          await rpc("cancelar_venda", { p_venda_id: v.id, p_motivo: motivo }); toast("Cancelada", "ok");
        }
      }
    } catch (e) { erro(e); }
    recarregar();
  }

  await carregar();
}
