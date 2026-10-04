// Painel do fornecedor: leads captados pelo site, lojas em teste e clientes ativos.
// Visível só para e-mails cadastrados em public.plataforma_admins.
import { rpc } from "../api.js";
import { PRECOS } from "../config.js";
import { html, render, $, $$, dinheiro, dataHora, data, toast, erro, modal, lerNumero, formatarDoc, confirmar } from "../ui.js";
import { icone } from "../icons.js";

const STATUS_LEAD = { novo: ["info", "Novo"], contatado: ["", "Contatado"], negociando: ["warn", "Negociando"], convertido: ["ok", "Convertido"], perdido: ["danger", "Perdido"] };
const ORIGEM = { site: "Formulário do site", teste: "Pediu teste", teste_bloqueado: "Tentou repetir o teste", app: "Sistema" };
const CONTA = { teste: ["warn", "Teste"], ativo: ["ok", "Ativo"], suspenso: ["danger", "Suspenso"], cancelado: ["", "Cancelado"] };
const PLANOS = [
  ["sistema", "Sistema", PRECOS.sistema], ["sistema_nota", "Sistema + Nota fiscal", PRECOS.sistemaNota],
  ["combo", "Combo completo", PRECOS.combo], ["kit_compra", "Kit comprado + plano", PRECOS.sistemaNota + PRECOS.manutencaoAvulsa],
  ["interno", "Interno (sem cobrança)", 0],
];

const valorBr = (n) => Number(n || 0).toFixed(2).replace(".", ",");
const zap = (n) => {
  const d = String(n || "").replace(/\D/g, "");
  return d ? `https://wa.me/55${d}` : null;
};
const fone = (n) => {
  const d = String(n || "").replace(/\D/g, "");
  return d.length === 11 ? d.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3") : d.length === 10 ? d.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3") : d;
};

export default async function plataforma(el) {
  let aba = "leads", filtro = "";

  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Plataforma</h1><p>Seus contatos, testes e clientes. Só você vê esta tela.</p></div></div>
    <div class="kpis" id="kpis"></div>
    <div class="tabs"><button data-aba="leads" class="ativo">Contatos (leads)</button><button data-aba="lojas">Lojas</button></div>
    <div id="corpo"></div></div>`);
  $$(".tabs button", el).forEach((b) => (b.onclick = () => { aba = b.dataset.aba; $$(".tabs button", el).forEach((x) => x.classList.toggle("ativo", x === b)); desenhar(); }));

  async function kpis() {
    const r = await rpc("plataforma_resumo");
    render($("#kpis", el), html`
      <div class="panel kpi"><div class="k-label">Contatos novos</div><div class="k-valor">${r.leads_novos}</div><div class="k-sub">${r.leads_30d} nos últimos 30 dias</div></div>
      <div class="panel kpi"><div class="k-label">Testes em andamento</div><div class="k-valor">${r.testes_ativos}</div><div class="k-sub">${r.testes_vencidos} vencidos sem contratar</div></div>
      <div class="panel kpi"><div class="k-label">Clientes ativos</div><div class="k-valor">${r.clientes_ativos}</div><div class="k-sub">${r.bloqueios_30d} tentativas de repetir o teste (30 dias)</div></div>
      <div class="panel kpi"><div class="k-label">Receita mensal</div><div class="k-valor">${dinheiro(r.mrr)}</div><div class="k-sub">soma das mensalidades ativas</div></div>`);
  }

  async function desenhar() { try { aba === "leads" ? await leads() : await lojas(); } catch (e) { erro(e); } }

  async function leads() {
    const lista = await rpc("plataforma_leads", { p_status: filtro || null });
    render($("#corpo", el), html`
      <div class="toolbar"><select class="input" id="filtro" style="max-width:220px"><option value="">Todos os status</option>
        ${Object.entries(STATUS_LEAD).map(([k, [, n]]) => html`<option value="${k}" ${filtro === k ? "selected" : ""}>${n}</option>`)}</select></div>
      <div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Quando</th><th>Contato</th><th>Loja</th><th>Origem</th><th>Interesse</th><th>Status</th><th></th></tr></thead>
        <tbody>${lista.map((l) => html`<tr>
          <td class="small">${dataHora(l.created_at)}</td>
          <td><strong>${l.nome}</strong><div class="small muted">${fone(l.whatsapp)}${l.email ? ` · ${l.email}` : ""}</div></td>
          <td>${l.loja || "—"}<div class="small muted">${[l.segmento, l.cidade, l.documento && formatarDoc(l.documento)].filter(Boolean).join(" · ")}</div></td>
          <td><span class="badge ${l.origem === "teste_bloqueado" ? "warn" : ""}">${ORIGEM[l.origem] || l.origem}</span></td>
          <td class="small">${l.interesse || ""}${l.mensagem ? html`<div class="muted">${l.mensagem}</div>` : ""}</td>
          <td><select class="input" data-lead="${l.id}" style="min-height:34px;padding:.2rem .4rem">${Object.entries(STATUS_LEAD).map(([k, [, n]]) => html`<option value="${k}" ${l.status === k ? "selected" : ""}>${n}</option>`)}</select></td>
          <td>${zap(l.whatsapp) ? html`<a class="btn sm" href="${zap(l.whatsapp)}" target="_blank" rel="noopener">${icone("whatsapp", 'width="16" height="16"')} Chamar</a>` : ""}</td>
        </tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Nenhum contato ainda. Eles chegam pelo formulário do site e pelos pedidos de teste.</p></div>`}</div>`);
    $("#filtro", el).onchange = (e) => { filtro = e.target.value; desenhar(); };
    $$("[data-lead]", el).forEach((s) => (s.onchange = async () => {
      try { await rpc("plataforma_atualizar_lead", { p_id: s.dataset.lead, p_status: s.value }); toast("Status atualizado", "ok"); kpis(); }
      catch (e) { erro(e); }
    }));
  }

  async function lojas() {
    const [lista, mods] = await Promise.all([rpc("plataforma_lojas"), rpc("plataforma_lojas_modulos").catch(() => [])]);
    const porId = Object.fromEntries((mods || []).map((m) => [m.id, m]));
    lista.forEach((l) => Object.assign(l, porId[l.id] || {}));
    render($("#corpo", el), html`<div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Loja</th><th>Contato</th><th>Situação</th><th>Plano</th><th class="r">Vendas</th><th>Última venda</th><th></th></tr></thead>
      <tbody>${lista.map((l) => {
        const vencido = l.status_conta === "teste" && l.teste_expira_em && new Date(l.teste_expira_em) < new Date();
        return html`<tr>
        <td><strong>${l.loja}</strong><div class="small muted">${[l.segmento, l.documento && formatarDoc(l.documento)].filter(Boolean).join(" · ")} · desde ${data(l.created_at)}</div></td>
        <td class="small">${fone(l.telefone)}<div class="muted">${l.email || ""}</div></td>
        <td><span class="badge ${vencido ? "danger" : CONTA[l.status_conta][0]}">${vencido ? "Teste vencido" : CONTA[l.status_conta][1]}</span>
          ${l.status_conta === "teste" && !vencido ? html`<div class="small muted">até ${dataHora(l.teste_expira_em)}</div>` : ""}</td>
        <td class="small">${l.plano}${l.valor_mensal ? html`<div class="muted">${dinheiro(l.valor_mensal)}/mês</div>` : ""}</td>
        <td class="r">${l.vendas}</td><td class="small">${l.ultima_venda ? dataHora(l.ultima_venda) : "—"}</td>
        <td><button class="btn sm" data-loja="${l.id}">Gerenciar</button></td></tr>`; })}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma loja cadastrada.</p></div>`}</div>`);
    $$("[data-loja]", el).forEach((b) => (b.onclick = () => gerenciar(lista.find((l) => l.id === b.dataset.loja))));
  }

  async function gerenciar(l) {
    const planoAtual = PLANOS.some(([k]) => k === l.plano) ? l.plano : "combo";
    const acao = await modal({
      titulo: l.loja,
      corpo: html`<form id="f-loja" class="stack">
        <p class="muted small">Situação: ${CONTA[l.status_conta][1]} · plano ${l.plano}${l.valor_mensal ? ` · ${dinheiro(l.valor_mensal)}/mês` : ""}</p>
        <h3>Ativar como cliente</h3>
        <div class="grid-2">
          <label class="field"><span>Plano</span><select class="input" name="plano">${PLANOS.map(([k, n, v]) => html`<option value="${k}" data-v="${v}" ${planoAtual === k ? "selected" : ""}>${n}</option>`)}</select></label>
          <label class="field"><span>Mensalidade (R$)</span><input class="input" name="valor" inputmode="decimal" value="${valorBr(l.valor_mensal ?? PLANOS.find(([k]) => k === planoAtual)[2])}"></label>
        </div>
        <button type="button" class="btn primary" data-a="ativar">Ativar cliente</button>
        <h3 style="margin-top:.5rem">Módulos</h3>
        <div class="grid-2">
          <label class="check"><input type="checkbox" name="m_delivery" ${l.modulos?.delivery ? "checked" : ""}> Delivery e cardápio digital</label>
          <label class="check"><input type="checkbox" name="m_garcom" ${l.segmento === "restaurante" || l.modulos?.garcom ? "checked" : ""} ${l.segmento === "restaurante" ? "disabled" : ""}> App do garçom e mesas ${l.segmento === "restaurante" ? html`<span class="muted small">(incluso p/ restaurante)</span>` : ""}</label>
        </div>
        <p class="hint">Durante o teste o delivery já fica liberado. ${l.slug ? html`Cardápio: <code>${l.slug}</code> ${l.delivery_ativo ? "(no ar)" : "(desligado pela loja)"}` : ""}</p>
        <button type="button" class="btn" data-a="modulos">Salvar módulos</button>
        <h3 style="margin-top:.5rem">Teste</h3>
        <div class="row"><select class="input" name="dias" style="max-width:140px"><option value="3">3 dias</option><option value="7" selected>7 dias</option><option value="15">15 dias</option></select>
          <button type="button" class="btn" data-a="estender">Estender teste</button></div>
        <h3 style="margin-top:.5rem">Bloquear</h3>
        <div class="row"><button type="button" class="btn danger" data-a="suspender">Suspender (inadimplência)</button><button type="button" class="btn danger" data-a="cancelar">Cancelar</button></div>
      </form>`,
      onPronto: (d, fechar) => {
        const f = d.querySelector("form");
        f.plano.onchange = () => { f.valor.value = valorBr(Number(f.plano.selectedOptions[0].dataset.v)); };
        d.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => fechar({ a: b.dataset.a, plano: f.plano.value, valor: lerNumero(f.valor.value), dias: Number(f.dias.value), modulos: { delivery: f.m_delivery.checked, garcom: f.m_garcom.checked } })));
      },
    });
    if (!acao) return;
    if (["suspender", "cancelar"].includes(acao.a) && !(await confirmar(`Confirmar: ${acao.a} a loja ${l.loja}? As vendas ficam bloqueadas.`, { perigo: true, ok: "Confirmar" }))) return;
    if (acao.a === "modulos") {
      try { await rpc("plataforma_modulos", { p_id: l.id, p_modulos: acao.modulos }); toast("Módulos atualizados", "ok"); desenhar(); } catch (e) { erro(e); }
      return;
    }
    try {
      await rpc("plataforma_atualizar_loja", { p_id: l.id, p_acao: acao.a, p_plano: acao.plano, p_valor: acao.valor, p_dias: acao.dias });
      toast("Loja atualizada", "ok"); kpis(); desenhar();
    } catch (e) { erro(e); }
  }

  await kpis();
  await desenhar();
}
