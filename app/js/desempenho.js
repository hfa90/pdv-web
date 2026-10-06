// Painel de desempenho do garçom: vendas, ticket médio, metas, comissão e projeção do mês.
// Usado em "Meu desempenho" (sistema e app do garçom) e pelo gerente ao abrir um garçom.
import { rpc } from "./api.js";
import { html, render, $, $$, dinheiro, numero, erro, carregando } from "./ui.js";
import { icone } from "./icons.js";
import { periodoDatas, somarDias, dataBR } from "./gestao-ui.js";
import { duracao } from "./restaurante.js";

const PERIODOS = [["hoje", "Hoje"], ["7d", "7 dias"], ["mes", "Este mês"], ["mes_ant", "Mês passado"]];
const pct = (n) => `${numero(n, Number(n) % 1 ? 1 : 0)}%`;

function serieDias(porDia, ini, fim) {
  const mapa = new Map((porDia || []).map((d) => [d.dia, d]));
  const out = [];
  for (let d = ini; d <= fim && out.length < 62; d = somarDias(d, 1)) out.push(mapa.get(d) || { dia: d, consumo: 0, comissao: 0, mesas: 0 });
  return out;
}

function grafico(pontos) {
  if (!pontos.some((p) => Number(p.consumo))) return html`<p class="muted small">Sem mesas fechadas no período.</p>`;
  const max = Math.max(...pontos.map((p) => Number(p.consumo)), 1);
  const rot = (i) => pontos.length <= 16 || i % Math.ceil(pontos.length / 10) === 0;
  return html`<div class="chart-cols" role="img" aria-label="Vendas por dia">${pontos.map((p) => html`<div class="col" style="height:${Math.max(1, (p.consumo / max) * 100)}%"
      title="${dataBR(p.dia)}: ${dinheiro(p.consumo)} · ${p.mesas} mesas · comissão ${dinheiro(p.comissao)}"></div>`)}</div>
    <div class="chart-x">${pontos.map((p, i) => html`<span>${rot(i) ? p.dia.slice(8, 10) + "/" + p.dia.slice(5, 7) : ""}</span>`)}</div>`;
}

function anel(fracao, rotulo) {
  const f = Math.max(0, Math.min(1, fracao));
  return html`<div class="anel-meta ${fracao >= 1 ? "batida" : ""}" style="--p:${Math.round(f * 360)}deg" role="img" aria-label="${rotulo}">
    <div><strong>${pct(Math.round(fracao * 1000) / 10)}</strong><span>da meta</span></div></div>`;
}

/**
 * Desenha o painel dentro de `alvo`.
 * @param {HTMLElement} alvo
 * @param {{perfil?: string|null, inicial?: string}} op  perfil = id do garçom (gerente); vazio = o próprio usuário
 */
export async function desenharDesempenho(alvo, op = {}) {
  let chave = op.inicial || "mes";
  render(alvo, html`<div class="desemp">
    <div class="chips desemp-periodos">${PERIODOS.map(([k, n]) => html`<button type="button" class="chip ${k === chave ? "ativo" : ""}" data-p="${k}">${n}</button>`)}</div>
    <div id="desemp-corpo">${carregando()}</div></div>`);
  const corpo = $("#desemp-corpo", alvo);

  async function carregar() {
    const [ini, fim] = periodoDatas(chave);
    render(corpo, carregando());
    let r;
    try { r = await rpc("garcom_desempenho", { p_ini: ini, p_fim: fim, p_perfil: op.perfil || null }); }
    catch (e) { render(corpo, html`<div class="alerta">${e.message}</div>`); return; }
    const p = r.periodo, m = r.mes, ab = r.abertas || {};
    const meta = Number(r.meta_mensal) || 0;
    const progresso = meta > 0 ? Number(m.consumo) / meta : 0;
    const projMeta = meta > 0 ? Number(m.projecao_consumo) / meta : 0;
    const baseTxt = r.comissao_base === "servico" ? "da taxa de serviço" : "do consumo das mesas";
    const rank = m.ranking;

    render(corpo, html`
      <div class="desemp-hero">
        <div class="panel kpi destaque">
          <div class="k-ic">${icone("carteira")}</div>
          <div class="k-label">Comissão ${chave === "hoje" ? "hoje" : chave === "mes" ? "no mês" : "no período"}</div>
          <div class="k-valor grande">${dinheiro(p.comissao)}</div>
          <div class="k-sub">${pct(r.comissao_percentual)} ${baseTxt}</div>
          <div class="desemp-proj">${icone("relatorios", 'width="16" height="16"')}
            <span>No ritmo atual você fecha o mês com <strong>${dinheiro(m.projecao_comissao)}</strong> de comissão
            (${dinheiro(m.comissao)} até o dia ${m.dia} de ${m.dias_mes}).</span></div>
        </div>
        <div class="panel panel-pad desemp-meta">
          ${meta > 0 ? html`${anel(progresso, `Meta do mês: ${pct(progresso * 100)}`)}
            <div class="stack" style="gap:.35rem">
              <div class="muted small">Meta do mês</div>
              <div class="desemp-meta-v"><strong>${dinheiro(m.consumo)}</strong> <span class="muted">de ${dinheiro(meta)}</span></div>
              ${progresso >= 1
                ? html`<div class="badge ok">${icone("trofeu", 'width="14" height="14"')} Meta batida! ${dinheiro(Number(m.consumo) - meta)} acima</div>`
                : html`<div class="small">Faltam <strong>${dinheiro(m.falta_meta)}</strong> · <strong>${dinheiro(m.por_dia_para_meta)}</strong> por dia até o fim do mês</div>
                  <div class="small ${projMeta >= 1 ? "txt-ok" : "txt-alerta"}">${projMeta >= 1
                    ? html`No ritmo atual você bate a meta: <strong>${dinheiro(m.projecao_consumo)}</strong> no mês`
                    : html`No ritmo atual você chega a <strong>${dinheiro(m.projecao_consumo)}</strong> (${pct(Math.round(projMeta * 1000) / 10)} da meta)`}</div>`}
            </div>`
          : html`<div class="stack" style="gap:.35rem"><div class="muted small">Meta do mês</div><strong>Sem meta definida</strong>
              <p class="small muted" style="margin:0">O gerente define a meta em Garçons.</p>
              <div class="small">No ritmo atual: <strong>${dinheiro(m.projecao_consumo)}</strong> vendidos no mês</div></div>`}
        </div>
      </div>

      ${Number(ab.mesas) ? html`<div class="alerta info desemp-agora">${icone("mesa", 'width="18" height="18"')}
        <span>Agora: <strong>${ab.mesas} ${ab.mesas === 1 ? "mesa aberta" : "mesas abertas"}</strong> com ${dinheiro(ab.consumo)} em consumo
        · +${dinheiro(ab.comissao_prevista)} de comissão quando fecharem</span></div>` : ""}

      <div class="kpis">
        <div class="panel kpi"><div class="k-ic">${icone("dinheiro")}</div><div class="k-label">Vendido</div><div class="k-valor">${dinheiro(p.consumo)}</div><div class="k-sub">Consumo das mesas fechadas</div></div>
        <div class="panel kpi cor-azul"><div class="k-ic">${icone("mesa")}</div><div class="k-label">Mesas atendidas</div><div class="k-valor">${p.mesas}</div><div class="k-sub">${p.pessoas ? `${p.pessoas} pessoas` : "—"}</div></div>
        <div class="panel kpi cor-roxo"><div class="k-ic">${icone("conta")}</div><div class="k-label">Ticket médio por mesa</div><div class="k-valor">${dinheiro(p.ticket_mesa)}</div><div class="k-sub">${Number(p.ticket_pessoa) ? `${dinheiro(p.ticket_pessoa)} por pessoa` : "Informe as pessoas ao abrir a mesa"}</div></div>
        <div class="panel kpi cor-ambar"><div class="k-ic">${icone("relogio")}</div><div class="k-label">Tempo médio de mesa</div><div class="k-valor">${p.mesas ? duracao(Number(p.tempo_medio_min)) : "—"}</div><div class="k-sub">${Number(p.servico) ? `Serviço arrecadado ${dinheiro(p.servico)}` : `${numero(p.itens)} itens vendidos`}</div></div>
      </div>

      <div class="two-col desemp-graf">
        <div class="panel panel-pad"><div class="row" style="justify-content:space-between"><h2>Vendas por dia</h2>
          ${rank ? html`<span class="badge info">${icone("trofeu", 'width="14" height="14"')} ${rank.posicao}º de ${rank.de} no mês</span>` : ""}</div>
          ${grafico(serieDias(p.por_dia, ...periodoDatas(chave)))}</div>
        <div class="panel panel-pad"><h2>O que mais vendeu</h2>
          ${(p.top_produtos || []).length ? html`<div class="bars">${p.top_produtos.map((t) => {
            const max = Number(p.top_produtos[0].total) || 1;
            return html`<div class="bar-row"><span title="${t.descricao}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.descricao}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${(t.total / max) * 100}%"></div></div><strong class="num">${dinheiro(t.total)}</strong></div>`;
          })}</div>` : html`<p class="muted small">Sem vendas no período.</p>`}</div>
      </div>
      <p class="hint">A comissão é calculada sobre as mesas já fechadas no caixa. Valores de mesas abertas entram quando a conta é paga.</p>`);
  }

  $$("[data-p]", alvo).forEach((b) => (b.onclick = () => {
    chave = b.dataset.p; $$("[data-p]", alvo).forEach((x) => x.classList.toggle("ativo", x === b)); carregar().catch(erro);
  }));
  await carregar();
  return { recarregar: carregar };
}
