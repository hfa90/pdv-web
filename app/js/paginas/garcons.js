// Garçons: o garçom vê o próprio desempenho; o gerente vê a equipe, define metas e comissões.
import { rpc } from "../api.js";
import { estado, eh, cfgRestaurante } from "../estado.js";
import { html, render, $, $$, dinheiro, numero, erro, toast, modal, lerNumero, carregando } from "../ui.js";
import { icone } from "../icons.js";
import { periodoDatas, baixarCSV, numCSV } from "../gestao-ui.js";
import { desenharDesempenho } from "../desempenho.js";
import { duracao } from "../restaurante.js";

const PERIODOS = [["hoje", "Hoje"], ["7d", "7 dias"], ["mes", "Este mês"], ["mes_ant", "Mês passado"]];

export default async function garcons(el, params = []) {
  const gestor = eh("admin", "gerente");
  if (!gestor) {
    render(el, html`<div class="page"><div class="page-head"><div><h1>Meu desempenho</h1>
      <p class="muted">Suas vendas, metas e comissão. Atualiza quando as mesas que você atendeu são fechadas no caixa.</p></div></div>
      <div id="meu"></div></div>`);
    await desenharDesempenho($("#meu", el));
    return;
  }

  let aba = params[0] === "garcom" ? "garcom" : "equipe", chave = "mes", dados = null, escolhido = params[1] || null;
  const c = cfgRestaurante();
  render(el, html`<div class="page">
    <div class="page-head">
      <div><h1>Garçons</h1><p class="muted">Comissão: ${numero(c.comissao_percentual, 1)}% ${c.comissao_base === "servico" ? "da taxa de serviço" : "do consumo das mesas"} ·
        meta padrão ${Number(c.meta_mensal_padrao) ? dinheiro(c.meta_mensal_padrao) + "/mês" : "não definida"}</p></div>
      <div class="row wrap"><a class="btn" href="#/configuracoes/restaurante">${icone("config", 'width="18" height="18"')} Regras de comissão e taxas</a></div>
    </div>
    <div class="tabs"><button data-aba="equipe">Equipe e ranking</button><button data-aba="garcom">Desempenho individual</button></div>
    <div id="corpo"></div></div>`);

  const trocar = (k) => { aba = k; $$(".tabs button", el).forEach((b) => b.classList.toggle("ativo", b.dataset.aba === k)); desenhar().catch(erro); };
  $$(".tabs button", el).forEach((b) => (b.onclick = () => trocar(b.dataset.aba)));

  async function carregarEquipe() {
    const [ini, fim] = periodoDatas(chave);
    dados = await rpc("garcons_equipe", { p_ini: ini, p_fim: fim });
  }

  async function desenhar() {
    const corpo = $("#corpo", el);
    if (aba === "garcom") return desenharIndividual(corpo);
    render(corpo, html`<div class="toolbar"><div class="chips">${PERIODOS.map(([k, n]) => html`<button class="chip ${k === chave ? "ativo" : ""}" data-p="${k}">${n}</button>`)}</div>
      <span class="grow"></span><button class="btn sm" id="csv">${icone("baixar", 'width="16" height="16"')} Exportar</button></div><div id="equipe">${carregando()}</div>`);
    $$("[data-p]", corpo).forEach((b) => (b.onclick = () => { chave = b.dataset.p; desenhar().catch(erro); }));
    await carregarEquipe();
    const gs = dados.garcons || [];
    const tot = gs.reduce((a, g) => ({ mesas: a.mesas + g.periodo.mesas, consumo: a.consumo + Number(g.periodo.consumo), comissao: a.comissao + Number(g.periodo.comissao), servico: a.servico + Number(g.periodo.servico) }), { mesas: 0, consumo: 0, comissao: 0, servico: 0 });
    const proj = (g) => Number(g.mes.comissao) / Math.max(1, dados.dia) * dados.dias_mes;
    render($("#equipe", corpo), gs.length ? html`
      <div class="kpis">
        <div class="panel kpi"><div class="k-label">Vendido pelos garçons</div><div class="k-valor">${dinheiro(tot.consumo)}</div><div class="k-sub">${tot.mesas} mesas fechadas</div></div>
        <div class="panel kpi"><div class="k-label">Ticket médio por mesa</div><div class="k-valor">${dinheiro(tot.mesas ? tot.consumo / tot.mesas : 0)}</div><div class="k-sub">média da equipe</div></div>
        <div class="panel kpi"><div class="k-label">Comissões no período</div><div class="k-valor">${dinheiro(tot.comissao)}</div><div class="k-sub">${tot.servico ? `Taxa de serviço arrecadada ${dinheiro(tot.servico)}` : "a pagar à equipe"}</div></div>
      </div>
      <div class="panel"><div class="table-wrap"><table class="table equipe">
        <thead><tr><th></th><th>Garçom</th><th class="r">Mesas</th><th class="r">Vendido</th><th class="r">Ticket médio</th><th class="r">Tempo/mesa</th><th class="r">Comissão</th><th>Meta do mês</th><th class="r" title="Comissão no mês se mantiver o ritmo">Projeção</th><th></th></tr></thead>
        <tbody>${gs.map((g, i) => {
          const meta = Number(g.meta_mensal) || 0; const prog = meta ? Number(g.mes.consumo) / meta : 0;
          return html`<tr>
            <td><span class="rank-pos ${i < 3 && Number(g.periodo.consumo) ? "p" + (i + 1) : ""}">${i + 1}</span></td>
            <td><div class="nowrap"><button class="link-nome" data-ver="${g.id}" title="Ver desempenho">${g.nome}</button>${g.ativo ? "" : html` <span class="badge">inativo</span>`}</div>
              ${g.abertas?.mesas ? html`<div class="muted small nowrap">${g.abertas.mesas} aberta(s) · ${dinheiro(g.abertas.consumo)}</div>` : ""}</td>
            <td class="r">${g.periodo.mesas}</td><td class="r">${dinheiro(g.periodo.consumo)}</td>
            <td class="r">${dinheiro(g.periodo.ticket_mesa)}<div class="muted small nowrap">${Number(g.periodo.ticket_pessoa) ? `${dinheiro(g.periodo.ticket_pessoa)}/pessoa` : ""}</div></td>
            <td class="r">${g.periodo.mesas ? duracao(Number(g.periodo.tempo_medio_min)) : "—"}</td>
            <td class="r"><strong>${dinheiro(g.periodo.comissao)}</strong><div class="muted small nowrap">${numero(g.comissao_percentual, 1)}%${g.comissao_propria ? " próprio" : ""}</div></td>
            <td style="min-width:140px">${meta ? html`<div class="small nowrap">${dinheiro(g.mes.consumo)} <span class="muted">de ${dinheiro(meta)}</span></div>
              <div class="rank-barra ${prog >= 1 ? "batida" : ""}"><div style="width:${Math.min(100, prog * 100)}%"></div></div>` : html`<span class="muted small">sem meta</span>`}</td>
            <td class="r" title="Comissão no mês se mantiver o ritmo">${dinheiro(proj(g))}</td>
            <td class="r"><button class="btn sm" data-meta="${g.id}" title="Meta e comissão">${icone("alvo", 'width="16" height="16"')} Meta</button></td></tr>`;
        })}</tbody></table></div></div>
      <p class="hint">Comissão sobre as mesas fechadas no período. A projeção considera o ritmo do mês até hoje (dia ${dados.dia} de ${dados.dias_mes}). Para um garçom aparecer aqui, crie o usuário com o nível <b>Atendente / garçom</b>.</p>`
      : html`<div class="panel panel-pad empty">${icone("usuarios", 'width="40" height="40"')}<h2>Nenhum garçom ainda</h2>
          <p class="muted">Crie um usuário para cada garçom em <a href="#/usuarios">Usuários</a> com o nível <b>Atendente / garçom</b>.</p></div>`);
    $$("[data-ver]", corpo).forEach((b) => (b.onclick = () => { escolhido = b.dataset.ver; trocar("garcom"); }));
    $$("[data-meta]", corpo).forEach((b) => (b.onclick = () => editarMeta(gs.find((g) => g.id === b.dataset.meta)).catch(erro)));
    $("#csv", corpo).onclick = () => {
      const [ini, fim] = periodoDatas(chave);
      baixarCSV(`garcons_${ini}_${fim}.csv`, [["Garçom", "Mesas", "Vendido", "Ticket por mesa", "Ticket por pessoa", "Tempo médio (min)", "Taxa de serviço", "Comissão %", "Comissão", "Meta do mês", "Vendido no mês"],
        ...gs.map((g) => [g.nome, g.periodo.mesas, numCSV(g.periodo.consumo), numCSV(g.periodo.ticket_mesa), numCSV(g.periodo.ticket_pessoa), g.periodo.tempo_medio_min,
          numCSV(g.periodo.servico), numCSV(g.comissao_percentual), numCSV(g.periodo.comissao), numCSV(g.meta_mensal), numCSV(g.mes.consumo)])]);
    };
  }

  async function editarMeta(g) {
    const padrao = cfgRestaurante();
    const r = await modal({
      titulo: `Meta e comissão · ${g.nome}`,
      corpo: html`<form id="f-meta" class="stack">
        <label class="field"><span>Meta de vendas no mês (R$)</span><input class="input lg" name="meta" inputmode="decimal" value="${g.meta_propria ? String(g.meta_mensal).replace(".", ",") : ""}" placeholder="Padrão: ${Number(padrao.meta_mensal_padrao) ? dinheiro(padrao.meta_mensal_padrao) : "sem meta"}"></label>
        <label class="field"><span>Comissão deste garçom (%)</span><input class="input" name="com" inputmode="decimal" value="${g.comissao_propria ? String(g.comissao_percentual).replace(".", ",") : ""}" placeholder="Padrão: ${numero(padrao.comissao_percentual, 1)}%"></label>
        <p class="hint">Deixe em branco para usar o padrão da loja (Configurações › Restaurante).</p>
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-meta">Salvar</button>`,
      onPronto: (d, fechar) => (d.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        const f = e.target;
        const meta = f.meta.value.trim() ? lerNumero(f.meta.value) : null;
        const com = f.com.value.trim() ? lerNumero(f.com.value) : null;
        if (meta !== null && !(meta >= 0)) return toast("Meta inválida", "erro");
        if (com !== null && !(com >= 0 && com <= 100)) return toast("Comissão deve ficar entre 0 e 100%", "erro");
        fechar({ meta, com });
      }),
    });
    if (!r) return;
    await rpc("salvar_meta_garcom", { p_perfil: g.id, p_meta: r.meta, p_comissao: r.com });
    toast("Meta salva", "ok");
    desenhar().catch(erro);
  }

  async function desenharIndividual(corpo) {
    if (!dados) await carregarEquipe();
    const gs = dados.garcons || [];
    if (!escolhido || !gs.some((g) => g.id === escolhido)) escolhido = gs[0]?.id || estado.perfil.id;
    render(corpo, html`<div class="toolbar"><label class="field" style="min-width:260px"><span>Garçom</span>
      <select class="input" id="sel-g">${gs.map((g) => html`<option value="${g.id}" ${g.id === escolhido ? "selected" : ""}>${g.nome}</option>`)}</select></label></div>
      <div id="ind"></div>`);
    $("#sel-g", corpo).onchange = (e) => { escolhido = e.target.value; desenharDesempenho($("#ind", corpo), { perfil: escolhido }).catch(erro); };
    await desenharDesempenho($("#ind", corpo), { perfil: escolhido });
  }

  trocar(aba);
}
