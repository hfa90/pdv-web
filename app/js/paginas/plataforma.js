// Painel do fornecedor: leads captados pelo site, lojas em teste e clientes ativos.
// Visível só para e-mails cadastrados em public.plataforma_admins.
import { rpc } from "../api.js";
import { PRECOS } from "../config.js";
import { html, render, $, $$, dinheiro, dataHora, data, toast, erro, modal, lerNumero, formatarDoc, confirmar, numero, debounce } from "../ui.js";
import { icone } from "../icons.js";
import { colunas, barras, preencherHoras } from "./relatorios.js";
import { nomeForma } from "../impressao/cupom.js";
import { nomePacote, nomePlano } from "../pacotes.js";

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
  let aba = "faturamento", filtro = "";

  render(el, html`<div class="page" style="max-width:1400px">
    <div class="page-head"><div><h1>Plataforma</h1><p>Faturamento de todos os clientes, contatos, testes, cobranças, licenças e backup. Só você vê esta tela.</p></div></div>
    <div class="kpis" id="kpis"></div>
    <div class="tabs">
      <button data-aba="faturamento" class="ativo">${icone("relatorios", 'width="16" height="16" style="vertical-align:-3px"')} Faturamento dos clientes</button>
      <button data-aba="lojas">Lojas</button><button data-aba="leads">Contatos (leads)</button>
      <button data-aba="cobrancas">Cobranças</button><button data-aba="pedidos">Pedidos de pacotes <span class="badge warn" id="n-pedidos" hidden></span></button>
      <button data-aba="licencas">${icone("calendario", 'width="16" height="16" style="vertical-align:-3px"')} Licenças</button>
      <button data-aba="dados">${icone("pacote", 'width="16" height="16" style="vertical-align:-3px"')} Dados e backup</button></div>
    <div id="corpo"></div></div>`);
  $$(".tabs button", el).forEach((b) => (b.onclick = () => { aba = b.dataset.aba; $$(".tabs button", el).forEach((x) => x.classList.toggle("ativo", x === b)); desenhar(); }));

  async function kpis() {
    const [r, fin] = await Promise.all([rpc("plataforma_resumo"), rpc("plataforma_financeiro").catch(() => null)]);
    const np = $("#n-pedidos", el);
    if (np && fin) { np.hidden = !fin.pacotes_pendentes; np.textContent = fin.pacotes_pendentes; }
    render($("#kpis", el), html`
      <div class="panel kpi"><div class="k-label">Contatos novos</div><div class="k-valor">${r.leads_novos}</div><div class="k-sub">${r.leads_30d} nos últimos 30 dias</div></div>
      <div class="panel kpi"><div class="k-label">Testes em andamento</div><div class="k-valor">${r.testes_ativos}</div><div class="k-sub">${r.testes_vencidos} vencidos sem contratar</div></div>
      <div class="panel kpi"><div class="k-label">Clientes ativos</div><div class="k-valor">${r.clientes_ativos}</div><div class="k-sub">${r.bloqueios_30d} tentativas de repetir o teste (30 dias)</div></div>
      <div class="panel kpi"><div class="k-label">Receita mensal</div><div class="k-valor">${dinheiro(r.mrr)}</div><div class="k-sub">soma das mensalidades ativas</div></div>
      ${fin ? html`<div class="panel kpi"><div class="k-label">A receber</div><div class="k-valor">${dinheiro(fin.a_receber)}</div>
        <div class="k-sub" style="${fin.vencido > 0 ? "color:var(--danger)" : ""}">${fin.vencido > 0 ? `${dinheiro(fin.vencido)} vencido (${fin.vencidas_qtd})` : `recebido no mês ${dinheiro(fin.recebido_mes)}`}</div></div>` : ""}`);
  }

  async function desenhar() {
    try { await ({ faturamento, leads, lojas, cobrancas, pedidos, licencas, dados })[aba](); } catch (e) { erro(e); }
  }

  // ================= Faturamento consolidado de todos os clientes =================
  const SEGMENTOS = [["", "Todos os setores"], ["padaria", "Padaria"], ["mercado", "Mercadinho e supermercado"], ["lanchonete", "Lanchonete"], ["cafe", "Café / cafeteria"], ["restaurante", "Restaurante"]];
  const NOME_SEG = { padaria: "Padaria", mercadinho: "Mercadinho", supermercado: "Supermercado", mercado: "Mercado", lanchonete: "Lanchonete", cafe: "Café", restaurante: "Restaurante", outros: "Outros" };
  const PERIODOS = [["hoje", "Hoje"], ["ontem", "Ontem"], ["semana", "Esta semana"], ["7d", "7 dias"], ["mes", "Este mês"], ["mes_ant", "Mês passado"], ["30d", "30 dias"], ["custom", "Personalizado"]];
  const fat = { periodo: "mes", segmento: "", busca: "", de: new Date().toISOString().slice(0, 10), ate: new Date().toISOString().slice(0, 10), ultimo: null };
  function intervaloFat() {
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const d = (n) => { const x = new Date(hoje); x.setDate(x.getDate() + n); return x; };
    switch (fat.periodo) {
      case "hoje": return [hoje, d(1)];
      case "ontem": return [d(-1), hoje];
      case "semana": return [d(-((hoje.getDay() + 6) % 7)), d(1)];
      case "7d": return [d(-6), d(1)];
      case "30d": return [d(-29), d(1)];
      case "mes": return [new Date(hoje.getFullYear(), hoje.getMonth(), 1), d(1)];
      case "mes_ant": return [new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1), new Date(hoje.getFullYear(), hoje.getMonth(), 1)];
      default: { const a = new Date(fat.de + "T00:00:00"), b = new Date(fat.ate + "T00:00:00"); b.setDate(b.getDate() + 1); return [a, b]; }
    }
  }
  const variacao = (atual, antes) => {
    if (!antes) return "";
    const v = ((atual - antes) / antes) * 100;
    return html`<span class="k-var ${v >= 0 ? "sobe" : "desce"}">${icone(v >= 0 ? "setaCima" : "setaBaixo", 'width="12" height="12"')}${numero(Math.abs(v), 0)}%</span>`;
  };

  async function faturamento() {
    const corpo = $("#corpo", el);
    if (!$("#fat-filtros", corpo)) {
      render(corpo, html`
        <div class="toolbar" id="fat-filtros">
          <div class="periodos" id="fat-per">${PERIODOS.map(([k, n]) => html`<button data-p="${k}" class="${k === fat.periodo ? "ativo" : ""}">${n}</button>`)}</div>
          <span id="fat-custom" class="row" ${fat.periodo === "custom" ? "" : "hidden"}><input class="input" type="date" id="fat-de" value="${fat.de}"><input class="input" type="date" id="fat-ate" value="${fat.ate}"></span>
          <select class="input" id="fat-seg" style="max-width:240px">${SEGMENTOS.map(([k, n]) => html`<option value="${k}" ${fat.segmento === k ? "selected" : ""}>${n}</option>`)}</select>
          <span class="grow"></span>
          <button class="btn" id="fat-csv">${icone("baixar", 'width="18" height="18"')} Exportar CSV</button>
        </div>
        <div id="fat-corpo"><div class="loading"><div class="spinner"></div></div></div>`);
      $$("#fat-per button", corpo).forEach((b) => (b.onclick = () => {
        fat.periodo = b.dataset.p; $$("#fat-per button", corpo).forEach((x) => x.classList.toggle("ativo", x === b));
        $("#fat-custom", corpo).hidden = fat.periodo !== "custom"; carregarFat();
      }));
      $("#fat-de", corpo).onchange = (e) => { fat.de = e.target.value; carregarFat(); };
      $("#fat-ate", corpo).onchange = (e) => { fat.ate = e.target.value; carregarFat(); };
      $("#fat-seg", corpo).onchange = (e) => { fat.segmento = e.target.value; carregarFat(); };
      $("#fat-csv", corpo).onclick = exportarFat;
    }
    await carregarFat();
  }

  async function carregarFat() {
    const alvo = $("#fat-corpo", el); if (!alvo) return;
    const [ini, fim] = intervaloFat();
    try {
      const r = await rpc("plataforma_faturamento", { p_inicio: ini.toISOString(), p_fim: fim.toISOString(), p_segmento: fat.segmento || null });
      fat.ultimo = r;
      const at = r.atalhos, res = r.resumo;
      const umDia = fat.periodo === "hoje" || fat.periodo === "ontem" || (fat.periodo === "custom" && fat.de === fat.ate);
      const total = Number(res.faturamento) || 0;
      render(alvo, html`
        <div class="kpis">
          <div class="panel kpi destaque"><div class="k-ic">${icone("dinheiro")}</div><div class="k-label">Faturamento no período</div>
            <div class="k-valor">${dinheiro(total)}</div><div class="k-sub">${numero(res.vendas)} vendas · ${res.lojas_com_venda} de ${r.lojas_total} lojas venderam</div></div>
          <div class="panel kpi"><div class="k-ic">${icone("relogio")}</div><div class="k-label">Hoje</div><div class="k-valor">${dinheiro(at.hoje)}</div><div class="k-sub">${numero(at.hoje_vendas)} vendas</div></div>
          <div class="panel kpi cor-azul"><div class="k-ic">${icone("calendario")}</div><div class="k-label">Esta semana</div><div class="k-valor">${dinheiro(at.semana)}</div><div class="k-sub">${numero(at.semana_vendas)} vendas · desde segunda</div></div>
          <div class="panel kpi cor-roxo"><div class="k-ic">${icone("relatorios")}</div><div class="k-label">Este mês ${variacao(Number(at.mes), Number(at.mes_anterior_parcial))}</div><div class="k-valor">${dinheiro(at.mes)}</div><div class="k-sub">mês passado: ${dinheiro(at.mes_anterior)}</div></div>
          <div class="panel kpi cor-ambar"><div class="k-ic">${icone("vendas")}</div><div class="k-label">Ticket médio</div><div class="k-valor">${dinheiro(res.ticket_medio)}</div><div class="k-sub">descontos ${dinheiro(res.descontos)}</div></div>
        </div>
        <div class="panel" style="margin-bottom:1rem"><div class="panel-head"><h2>${umDia ? "Vendas por hora (todas as lojas)" : "Vendas por dia (todas as lojas)"}</h2></div>
          <div class="panel-pad">${umDia ? colunas(preencherHoras(r.por_hora), (p) => `${p.hora}h`) : colunas(r.por_dia, (p) => data(p.dia + "T12:00:00").slice(0, 5))}</div></div>
        <div class="two-col" style="margin-bottom:1rem">
          <div class="panel"><div class="panel-head"><h2>Por setor</h2></div><div class="panel-pad">${barras(r.por_segmento.filter((s) => Number(s.total) > 0 || r.por_segmento.length <= 6), (i) => `${NOME_SEG[i.segmento] || i.segmento} (${i.lojas})`, (i) => Number(i.total))}</div></div>
          <div class="panel"><div class="panel-head"><h2>Formas de pagamento</h2></div><div class="panel-pad">${barras(r.por_forma, (i) => nomeForma(i.forma), (i) => Number(i.valor))}</div></div>
        </div>
        <div class="panel"><div class="panel-head"><h2>Ranking das lojas</h2>
            <input class="input" id="fat-busca" placeholder="Filtrar loja ou cidade…" style="max-width:260px;min-height:36px" value="${fat.busca}"></div>
          <div id="fat-rank"></div></div>`);
      const busca = $("#fat-busca", el);
      busca.oninput = debounce(() => { fat.busca = busca.value; desenharRanking(); }, 150);
      desenharRanking();
    } catch (e) { erro(e); render(alvo, html`<div class="alerta">${e.message}</div>`); }
  }

  function desenharRanking() {
    const r = fat.ultimo; if (!r) return;
    const t = fat.busca.trim().toLowerCase();
    const max = Math.max(1, ...r.por_loja.map((l) => Number(l.total)));
    const total = Number(r.resumo.faturamento) || 1;
    const lista = r.por_loja.map((l, i) => ({ ...l, pos: i + 1 }))
      .filter((l) => !t || l.loja.toLowerCase().includes(t) || (l.municipio || "").toLowerCase().includes(t));
    render($("#fat-rank", el), lista.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Loja</th><th class="r">Hoje</th><th class="r">Semana</th><th class="r">Mês</th><th class="r">No período</th><th class="r">Vendas</th><th class="r">Ticket</th><th>Última venda</th><th></th></tr></thead>
      <tbody>${lista.map((l) => html`<tr class="click" data-loja-fat="${l.id}">
        <td><span class="rank-pos ${Number(l.total) > 0 && l.pos <= 3 ? "p" + l.pos : ""}">${l.pos}</span></td>
        <td><strong>${l.loja}</strong><div class="small muted">${[NOME_SEG[l.segmento] || l.segmento, [l.municipio, l.uf].filter(Boolean).join("/"), nomePlano(l.plano)].filter(Boolean).join(" · ")}</div>
          <div class="rank-barra"><div style="width:${(Number(l.total) / max) * 100}%"></div></div></td>
        <td class="r">${dinheiro(l.hoje)}</td><td class="r">${dinheiro(l.semana)}</td><td class="r">${dinheiro(l.mes)}</td>
        <td class="r"><strong>${dinheiro(l.total)}</strong><div class="small muted">${numero((Number(l.total) / total) * 100, 1)}%</div></td>
        <td class="r">${numero(l.vendas)}</td><td class="r">${dinheiro(l.ticket)}</td>
        <td class="small">${l.ultima_venda ? dataHora(l.ultima_venda) : html`<span class="muted">—</span>`}</td>
        <td><span class="badge ${CONTA[l.status_conta]?.[0] || ""}">${CONTA[l.status_conta]?.[1] || l.status_conta}</span></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma loja encontrada.</p></div>`);
    $$("[data-loja-fat]", el).forEach((tr) => (tr.onclick = () => detalheLoja(r.por_loja.find((l) => l.id === tr.dataset.lojaFat))));
  }

  async function detalheLoja(l) {
    const [ini, fim] = intervaloFat();
    let d;
    try { d = await rpc("plataforma_loja_vendas", { p_id: l.id, p_inicio: ini.toISOString(), p_fim: fim.toISOString() }); } catch (e) { return erro(e); }
    const umDia = (fim - ini) <= 864e5 + 3600e3;
    await modal({
      titulo: l.loja, largo: true,
      corpo: html`<div class="stack-lg">
        <p class="muted small">${[NOME_SEG[l.segmento] || l.segmento, [l.municipio, l.uf].filter(Boolean).join("/"), nomePlano(l.plano)].filter(Boolean).join(" · ")} · ${PERIODOS.find(([k]) => k === fat.periodo)?.[1]}</p>
        <div class="kpis" style="margin:0">
          <div class="panel kpi destaque"><div class="k-label">Faturamento</div><div class="k-valor">${dinheiro(d.resumo.faturamento)}</div><div class="k-sub">${numero(d.resumo.vendas)} vendas</div></div>
          <div class="panel kpi"><div class="k-label">Ticket médio</div><div class="k-valor">${dinheiro(d.resumo.ticket_medio)}</div></div>
          <div class="panel kpi"><div class="k-label">Hoje · semana · mês</div><div class="k-valor" style="font-size:1.1rem">${dinheiro(l.hoje)} · ${dinheiro(l.semana)} · ${dinheiro(l.mes)}</div></div>
        </div>
        ${umDia ? "" : html`<div><h3 style="margin-bottom:.5rem">Por dia</h3>${colunas(d.por_dia, (p) => data(p.dia + "T12:00:00").slice(0, 5))}</div>`}
        <div class="two-col">
          <div><h3 style="margin-bottom:.6rem">Formas de pagamento</h3>${barras(d.por_forma, (i) => nomeForma(i.forma), (i) => Number(i.valor))}</div>
          <div><h3 style="margin-bottom:.6rem">Mais vendidos</h3>${d.top_produtos.length ? html`<div class="stack" style="gap:.35rem">${d.top_produtos.map((p) => html`<div class="linha-valor"><span style="color:var(--ink)">${p.produto}</span><span>${numero(p.quantidade, p.quantidade % 1 ? 3 : 0)} · <strong>${dinheiro(p.total)}</strong></span></div>`)}</div>` : html`<p class="muted">Sem vendas.</p>`}</div>
        </div></div>`,
    });
  }

  function exportarFat() {
    const r = fat.ultimo; if (!r) return;
    const br = (n) => String(Number(n || 0).toFixed(2)).replace(".", ",");
    const linhas = [["Loja", "Setor", "Cidade", "UF", "Situação", "Plano", "Hoje", "Semana", "Mês", "Período", "Vendas", "Ticket", "Última venda"],
      ...r.por_loja.map((l) => [l.loja, l.segmento, l.municipio, l.uf, l.status_conta, l.plano, br(l.hoje), br(l.semana), br(l.mes), br(l.total), l.vendas, br(l.ticket), l.ultima_venda ? dataHora(l.ultima_venda) : ""])];
    const csv = "\ufeff" + linhas.map((x) => x.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `faturamento-clientes-${fat.periodo}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ================= Licenças e Dados/backup (migração 021) =================
  async function licencas() {
    const { abaLicencas } = await import("../plataforma-dados.js");
    await abaLicencas($("#corpo", el), { aoMudar: () => kpis().catch(() => {}) });
  }
  async function dados() {
    const { abaDados } = await import("../plataforma-dados.js");
    await abaDados($("#corpo", el), { aoMudar: () => kpis().catch(() => {}) });
  }

  // ================= Cobranças (faturas) =================
  let filtroFat = "pendente";
  async function cobrancas() {
    const [lista, lojasLista] = await Promise.all([rpc("plataforma_faturas", { p_status: filtroFat || null }), rpc("plataforma_lojas")]);
    const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    render($("#corpo", el), html`
      <div class="toolbar">
        <div class="periodos" id="f-fat">${[["pendente", "Em aberto"], ["vencido", "Vencidas"], ["pago", "Pagas"], ["", "Todas"]].map(([k, n]) => html`<button data-f="${k}" class="${filtroFat === k ? "ativo" : ""}">${n}</button>`)}</div>
        <span class="grow"></span>
        <button class="btn" id="b-nova-fat">${icone("mais", 'width="18" height="18"')} Fatura avulsa</button>
        <button class="btn primary" id="b-gerar-fat">${icone("calendario", 'width="18" height="18"')} Gerar mensalidades do mês</button>
      </div>
      <div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Loja</th><th>Descrição</th><th>Vencimento</th><th class="r">Valor</th><th>Situação</th><th></th></tr></thead>
        <tbody>${lista.map((f) => { const venc = f.status === "pendente" && f.vencimento < hoje; return html`<tr>
          <td><strong>${f.loja}</strong></td><td class="small">${f.descricao}${f.link_pagamento ? html`<div class="muted">com link de pagamento</div>` : ""}</td>
          <td>${data(f.vencimento + "T12:00:00")}</td><td class="r"><strong>${dinheiro(f.valor)}</strong></td>
          <td><span class="badge ${f.status === "pago" ? "ok" : f.status === "cancelado" ? "" : venc ? "danger" : "warn"}">${f.status === "pago" ? `Paga ${data(f.pago_em)}` : f.status === "cancelado" ? "Cancelada" : venc ? "Vencida" : "Em aberto"}</span></td>
          <td class="r" style="white-space:nowrap">${f.status === "pendente" ? html`<button class="btn sm primary" data-fa="pagar" data-id="${f.id}">Recebida</button>
              <button class="btn sm" data-fa="cobranca" data-id="${f.id}">Link</button><button class="btn sm ghost" data-fa="cancelar" data-id="${f.id}">Cancelar</button>`
            : f.status === "pago" ? html`<button class="btn sm ghost" data-fa="reabrir" data-id="${f.id}">Reabrir</button>` : ""}</td></tr>`; })}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma fatura ${filtroFat === "pendente" ? "em aberto" : "aqui"}. Use “Gerar mensalidades do mês” para criar as cobranças dos clientes ativos.</p></div>`}</div>`);
    $$("#f-fat button", el).forEach((b) => (b.onclick = () => { filtroFat = b.dataset.f; cobrancas().catch(erro); }));
    $("#b-gerar-fat", el).onclick = async () => {
      try { const n = await rpc("plataforma_gerar_faturas", { p_competencia: null }); toast(n ? `${n} mensalidade(s) gerada(s)` : "Todas as mensalidades do mês já existem", "ok"); kpis(); cobrancas(); } catch (e) { erro(e); }
    };
    $("#b-nova-fat", el).onclick = () => novaFatura(lojasLista);
    $$("[data-fa]", el).forEach((b) => (b.onclick = async () => {
      const f = lista.find((x) => x.id === b.dataset.id), acao = b.dataset.fa;
      let extra = {};
      if (acao === "cancelar" && !(await confirmar(`Cancelar a fatura de ${dinheiro(f.valor)} da loja ${f.loja}?`, { perigo: true }))) return;
      if (acao === "pagar") {
        const forma = await modal({ titulo: "Registrar recebimento", corpo: html`<p>${f.loja} · ${dinheiro(f.valor)}</p><label class="field" style="margin-top:.75rem"><span>Forma</span><select class="input" id="forma-rec"><option>PIX</option><option>Boleto</option><option>Cartão</option><option>Dinheiro</option><option>Transferência</option></select></label>`,
          rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" id="ok-rec">Confirmar</button>`,
          onPronto: (d, fechar) => { d.querySelector("#ok-rec").onclick = () => fechar(d.querySelector("#forma-rec").value); } });
        if (!forma) return; extra = { p_forma: forma };
      }
      if (acao === "cobranca") {
        const r = await modal({ titulo: "Dados de pagamento", corpo: html`<form id="f-cob" class="stack">
            <label class="field"><span>Link de pagamento (https://…)</span><input class="input" name="link" value="${f.link_pagamento || ""}" placeholder="Mercado Pago, Asaas, PagSeguro…"></label>
            <label class="field"><span>Código PIX copia e cola ou linha digitável do boleto</span><textarea class="input" name="linha">${f.linha_digitavel || ""}</textarea></label>
            <p class="hint">O cliente vê o botão “Pagar agora” e o código na tela Minha assinatura.</p></form>`,
          rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-cob">Salvar</button>`,
          onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); fechar({ p_link: e.target.link.value, p_linha: e.target.linha.value }); }; } });
        if (!r) return; extra = r;
      }
      try { await rpc("plataforma_fatura_acao", { p_id: f.id, p_acao: acao, ...extra }); toast("Fatura atualizada", "ok"); kpis(); cobrancas(); } catch (e) { erro(e); }
    }));
  }

  async function novaFatura(lojasLista) {
    const ativas = lojasLista.filter((l) => l.status_conta !== "cancelado");
    const venc = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const r = await modal({
      titulo: "Fatura avulsa",
      corpo: html`<form id="f-nf" class="stack">
        <label class="field"><span>Loja</span><select class="input" name="loja" required>${ativas.map((l) => html`<option value="${l.id}">${l.loja}</option>`)}</select></label>
        <label class="field"><span>Descrição</span><input class="input" name="desc" required placeholder="Instalação, visita técnica, pacote…"></label>
        <div class="grid-2"><label class="field"><span>Valor (R$)</span><input class="input" name="valor" inputmode="decimal" required></label>
          <label class="field"><span>Vencimento</span><input class="input" type="date" name="venc" value="${venc}" required></label></div>
        <label class="field"><span>Link de pagamento (opcional)</span><input class="input" name="link" placeholder="https://…"></label>
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-nf">Criar fatura</button>`,
      onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const f = e.target; fechar({ p_empresa: f.loja.value, p_descricao: f.desc.value, p_valor: lerNumero(f.valor.value), p_vencimento: f.venc.value, p_link: f.link.value || null, p_linha: null }); }; },
    });
    if (!r) return;
    if (!(r.p_valor >= 0)) return toast("Valor inválido", "erro");
    try { await rpc("plataforma_nova_fatura", r); toast("Fatura criada", "ok"); kpis(); cobrancas(); } catch (e) { erro(e); }
  }

  // ================= Pedidos de pacotes =================
  let filtroPed = "pendente";
  async function pedidos() {
    const lista = await rpc("plataforma_solicitacoes", { p_status: filtroPed || null });
    render($("#corpo", el), html`
      <div class="toolbar"><div class="periodos" id="f-ped">${[["pendente", "Aguardando"], ["aprovado", "Aprovados"], ["recusado", "Recusados"], ["", "Todos"]].map(([k, n]) => html`<button data-f="${k}" class="${filtroPed === k ? "ativo" : ""}">${n}</button>`)}</div></div>
      <div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Quando</th><th>Loja</th><th>Pedido</th><th>Situação</th><th></th></tr></thead>
        <tbody>${lista.map((s) => html`<tr><td class="small">${dataHora(s.created_at)}</td>
          <td><strong>${s.loja}</strong><div class="small muted">${s.solicitante || ""} ${s.telefone ? `· ${fone(s.telefone)}` : ""}</div></td>
          <td>${nomePacote(s.pacote)}${s.quantidade > 1 ? ` × ${s.quantidade}` : ""}${s.detalhes ? html`<div class="small muted">${s.detalhes}</div>` : ""}${s.resposta ? html`<div class="small">Resposta: ${s.resposta}</div>` : ""}</td>
          <td><span class="badge ${s.status === "aprovado" ? "ok" : s.status === "pendente" ? "warn" : s.status === "recusado" ? "danger" : ""}">${s.status}</span></td>
          <td class="r" style="white-space:nowrap">${zap(s.telefone) ? html`<a class="btn sm" href="${zap(s.telefone)}" target="_blank" rel="noopener">${icone("whatsapp", 'width="16" height="16"')}</a>` : ""}
            ${s.status === "pendente" ? html`<button class="btn sm primary" data-ped="aprovado" data-id="${s.id}">Aprovar</button><button class="btn sm ghost" data-ped="recusado" data-id="${s.id}">Recusar</button>` : ""}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhum pedido ${filtroPed === "pendente" ? "aguardando" : "aqui"}. Os clientes pedem pacotes pela tela Minha assinatura.</p></div>`}</div>`);
    $$("#f-ped button", el).forEach((b) => (b.onclick = () => { filtroPed = b.dataset.f; pedidos().catch(erro); }));
    $$("[data-ped]", el).forEach((b) => (b.onclick = async () => {
      const s = lista.find((x) => x.id === b.dataset.id), st = b.dataset.ped;
      const r = await modal({
        titulo: `${st === "aprovado" ? "Aprovar" : "Recusar"}: ${nomePacote(s.pacote)}`,
        corpo: html`<form id="f-resp" class="stack"><p>${s.loja}</p>
          ${st === "aprovado" ? html`<label class="field"><span>Somar à mensalidade (R$, opcional)</span><input class="input" name="acr" inputmode="decimal" placeholder="0,00"></label>
            <p class="hint">${["delivery", "garcom"].includes(s.pacote) ? "O módulo é liberado na loja na hora." : s.pacote.startsWith("plano_") ? "Depois ative o plano em Lojas › Gerenciar." : "Combine a instalação com o cliente."}</p>` : ""}
          <label class="field"><span>Mensagem para o cliente (opcional)</span><textarea class="input" name="msg"></textarea></label></form>`,
        rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn ${st === "aprovado" ? "primary" : "danger"}" form="f-resp">Confirmar</button>`,
        onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); fechar({ msg: e.target.msg.value, acr: e.target.acr ? lerNumero(e.target.acr.value) || null : null }); }; },
      });
      if (!r) return;
      try { await rpc("plataforma_responder_solicitacao", { p_id: s.id, p_status: st, p_resposta: r.msg || null, p_acrescimo: r.acr }); toast("Pedido respondido", "ok"); kpis(); pedidos(); } catch (e) { erro(e); }
    }));
  }

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
    const [lista, mods, venc] = await Promise.all([rpc("plataforma_lojas"), rpc("plataforma_lojas_modulos").catch(() => []), rpc("plataforma_lojas_vencimento").catch(() => [])]);
    const porId = Object.fromEntries((mods || []).map((m) => [m.id, m]));
    const vencId = Object.fromEntries((venc || []).map((m) => [m.id, m.dia_vencimento]));
    lista.forEach((l) => Object.assign(l, porId[l.id] || {}, { dia_vencimento: vencId[l.id] }));
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
        <td><div class="row" style="gap:.35rem;flex-wrap:nowrap"><button class="btn sm" data-loja="${l.id}">Gerenciar</button><button class="btn sm ghost" data-apar="${l.id}" title="Aparelhos autorizados e limites">${icone("escudo", 'width="15" height="15"')} Aparelhos</button></div></td></tr>`; })}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma loja cadastrada.</p></div>`}</div>`);
    $$("[data-loja]", el).forEach((b) => (b.onclick = () => gerenciar(lista.find((l) => l.id === b.dataset.loja))));
    $$("[data-apar]", el).forEach((b) => (b.onclick = () => import("../dispositivos.js").then((m) => m.modalAparelhosLoja(lista.find((l) => l.id === b.dataset.apar))).catch(erro)));
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
        <div class="row"><label class="field" style="max-width:200px"><span>Dia do vencimento</span><input class="input" name="dia" type="number" min="1" max="28" value="${l.dia_vencimento || 10}"></label>
          <button type="button" class="btn" data-a="dia" style="align-self:flex-end">Salvar dia</button></div>
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
        <h3 style="margin-top:.5rem">Licenças e dados</h3>
        <div class="row wrap"><button type="button" class="btn" data-a="licencas">${icone("calendario", 'width="16" height="16"')} Renovar / expirar licenças</button>
          <button type="button" class="btn" data-a="backup">${icone("pacote", 'width="16" height="16"')} Backups desta loja</button></div>
        <p class="hint">Para exportar, importar ou excluir lojas do banco: aba Dados e backup.</p>
      </form>`,
      onPronto: (d, fechar) => {
        const f = d.querySelector("form");
        f.plano.onchange = () => { f.valor.value = valorBr(Number(f.plano.selectedOptions[0].dataset.v)); };
        d.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => fechar({ a: b.dataset.a, plano: f.plano.value, valor: lerNumero(f.valor.value), dias: Number(f.dias.value), dia: Number(f.dia.value), modulos: { delivery: f.m_delivery.checked, garcom: f.m_garcom.checked } })));
      },
    });
    if (!acao) return;
    if (["suspender", "cancelar"].includes(acao.a) && !(await confirmar(`Confirmar: ${acao.a} a loja ${l.loja}? As vendas ficam bloqueadas.`, { perigo: true, ok: "Confirmar" }))) return;
    if (acao.a === "licencas") {
      const [{ alterarLicencas }, todas] = await Promise.all([import("../plataforma-dados.js"), rpc("plataforma_licencas")]);
      const alvo = todas.find((x) => x.id === l.id);
      if (alvo && (await alterarLicencas([alvo]))) desenhar();
      return;
    }
    if (acao.a === "backup") {
      const { montarPainelBackup } = await import("./backup.js");
      await modal({ titulo: `Backup · ${l.loja}`, largo: true, corpo: html`<div id="painel-loja-bk"></div>`,
        onPronto: (d) => montarPainelBackup(d.querySelector("#painel-loja-bk"), l.id) });
      return;
    }
    if (acao.a === "dia") {
      try { await rpc("plataforma_dia_vencimento", { p_id: l.id, p_dia: acao.dia }); toast("Dia de vencimento salvo", "ok"); } catch (e) { erro(e); }
      return;
    }
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
