// Financeiro: lucro real do período, fluxo de caixa, contas a pagar, conferência de PIX/cartão e taxas.
import { sb, q, rpc } from "../api.js";
import { estado } from "../estado.js";
import { html, render, $, $$, dinheiro, numero, lerNumero, toast, erro, modal, confirmar, dataHora, hora } from "../ui.js";
import { icone } from "../icons.js";
import { nomeForma } from "../impressao/cupom.js";
import { abas, barraPeriodo, hojeISO, somarDias, dataBR, baixarCSV, numCSV, lerArquivoTexto } from "../gestao-ui.js";

export const CATEGORIAS_DESPESA = ["Mercadoria (fornecedor)", "Aluguel", "Energia", "Água", "Internet/telefone", "Salários e encargos", "Impostos", "Manutenção", "Marketing", "Sistema e serviços", "Outros"];
const FORMAS_TAXA = [["debito", "Cartão de débito"], ["credito", "Cartão de crédito"], ["pix", "PIX"], ["vale_refeicao", "Vale-refeição"], ["dinheiro", "Dinheiro"], ["outros", "Outros"]];
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? `${numero((a / b) * 100, 1)}%` : "—");

export default async function financeiro(el, params = []) {
  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Financeiro</h1><p>Quanto sobrou de verdade, o que entra e sai, e se o dinheiro do PIX e do cartão chegou.</p></div></div>
    <div id="abas"></div><div id="corpo"></div></div>`);
  const corpo = $("#corpo", el);
  const telas = { resultado, fluxo, contas, conferencia, taxas };
  const lista = [["resultado", "Lucro real"], ["fluxo", "Fluxo de caixa"], ["contas", "Contas a pagar"], ["conferencia", "Conferência PIX/cartão"], ["taxas", "Taxas"]];
  const inicial = lista.some(([k]) => k === params[0]) ? params[0] : "resultado";
  abas($("#abas", el), lista, (k) => { history.replaceState(null, "", "#/financeiro/" + k); telas[k]().catch(erro); }, inicial);
  await telas[inicial]();

  // =================== Lucro real ===================
  async function resultado() {
    render(corpo, html`<div id="per"></div><div id="dre"></div>`);
    barraPeriodo($("#per", corpo), async ([ini, fim]) => {
      let r; try { r = await rpc("resultado_periodo", { p_ini: ini, p_fim: fim }); } catch (e) { return erro(e); }
      const fat = Number(r.faturamento);
      const linha = (rotulo, valor, { neg = false, forte = false, sub = "", cls = "" } = {}) => html`<tr class="${forte ? "dre-total" : ""} ${cls}">
        <td>${rotulo}${sub ? html`<div class="small muted">${sub}</div>` : ""}</td>
        <td class="r num" style="${neg && valor ? "color:var(--danger)" : ""}">${neg && valor ? "− " : ""}${dinheiro(valor)}</td><td class="r small muted">${pct(valor, fat)}</td></tr>`;
      const semTaxas = !Object.keys(estado.empresa.taxas_pagamento || {}).length;
      render($("#dre", corpo), html`
        <div class="kpis">
          <div class="panel kpi"><div class="k-label">Faturamento</div><div class="k-valor">${dinheiro(fat)}</div><div class="k-sub">${r.vendas} vendas</div></div>
          <div class="panel kpi"><div class="k-label">Lucro bruto</div><div class="k-valor">${dinheiro(r.lucro_bruto)}</div><div class="k-sub">margem ${pct(r.lucro_bruto, fat)}</div></div>
          <div class="panel kpi"><div class="k-label">Lucro líquido</div><div class="k-valor" style="color:${r.lucro_liquido < 0 ? "var(--danger)" : "var(--ok)"}">${dinheiro(r.lucro_liquido)}</div><div class="k-sub">o que sobrou · ${pct(r.lucro_liquido, fat)}</div></div>
        </div>
        ${r.itens_sem_custo ? html`<div class="alerta warn" style="margin-bottom:1rem">${r.itens_sem_custo} item(ns) vendido(s) sem custo cadastrado: o lucro está maior do que o real. Lance as notas de compra pelo XML (Compras) ou preencha o custo em Produtos.</div>` : ""}
        ${semTaxas ? html`<div class="alerta info" style="margin-bottom:1rem">Cadastre as taxas da maquininha na aba <a href="#/financeiro/taxas">Taxas</a> para o lucro descontar o que fica com a operadora.</div>` : ""}
        <div class="panel"><div class="panel-head"><h2>Demonstrativo do período</h2><span class="muted small">${dataBR(ini)} a ${dataBR(fim)}</span></div>
          <div class="table-wrap"><table class="table dre"><tbody>
            ${linha("Faturamento (vendas)", fat, { forte: true, sub: `já com ${dinheiro(r.descontos)} de descontos e promoções` })}
            ${linha("Custo das mercadorias vendidas", r.cmv, { neg: true, sub: "pelo custo de cada item no dia da venda" })}
            ${linha("Lucro bruto", r.lucro_bruto, { forte: true })}
            ${linha("Taxas de cartão/PIX", r.taxas, { neg: true, sub: (r.taxas_por_forma || []).filter((t) => t.taxa > 0).map((t) => `${nomeForma(t.forma)} ${dinheiro(t.taxa)}`).join(" · ") })}
            ${linha("Perdas (vencidos, quebras…)", r.perdas, { neg: true })}
            ${(r.despesas_por_categoria || []).map((d) => linha(d.categoria, d.valor, { neg: true, cls: "dre-desp" }))}
            ${!(r.despesas_por_categoria || []).length ? linha("Despesas", 0, { sub: "cadastre aluguel, energia, salários… em Contas a pagar" }) : ""}
            ${linha("Lucro líquido", r.lucro_liquido, { forte: true })}
          </tbody></table></div>
          <div class="panel-pad small muted">Compras de mercadoria (${dinheiro(r.compras_mercadoria)} vencendo no período) não entram como despesa: o custo delas já aparece quando o produto é vendido.</div></div>`);
    }, "mes");
  }

  // =================== Fluxo de caixa ===================
  async function fluxo() {
    render(corpo, html`<div id="per"></div><div id="fx"></div>`);
    barraPeriodo($("#per", corpo), async ([ini, fim]) => {
      let r; try { r = await rpc("fluxo_caixa", { p_ini: ini, p_fim: fim, p_projecao: 30 }); } catch (e) { return erro(e); }
      let acum = 0;
      const dias = r.dias.map((d) => { acum = r2(acum + Number(d.entradas) - Number(d.saidas)); return { ...d, saldo: r2(d.entradas - d.saidas), acum }; });
      const ent = dias.reduce((a, d) => a + Number(d.entradas), 0), sai = dias.reduce((a, d) => a + Number(d.saidas), 0);
      const max = Math.max(1, ...dias.map((d) => Math.max(d.entradas, d.saidas)));
      const hoje = hojeISO();
      const vencidas = r.a_pagar.filter((c) => c.vencida), proximas = r.a_pagar.filter((c) => !c.vencida);
      render($("#fx", corpo), html`
        <div class="kpis">
          <div class="panel kpi"><div class="k-label">Entradas</div><div class="k-valor" style="color:var(--ok)">${dinheiro(ent)}</div><div class="k-sub">vendas (menos fiado) + fiado recebido</div></div>
          <div class="panel kpi"><div class="k-label">Saídas</div><div class="k-valor" style="color:var(--danger)">${dinheiro(sai)}</div><div class="k-sub">contas pagas</div></div>
          <div class="panel kpi"><div class="k-label">Saldo do período</div><div class="k-valor">${dinheiro(ent - sai)}</div></div>
          <div class="panel kpi"><div class="k-label">A pagar (30 dias)</div><div class="k-valor">${dinheiro(r.a_pagar.reduce((a, c) => a + Number(c.valor), 0))}</div><div class="k-sub">fiado a receber ${dinheiro(r.a_receber_fiado)}</div></div>
        </div>
        ${vencidas.length ? html`<div class="alerta" style="margin-bottom:1rem"><strong>${vencidas.length} conta(s) vencida(s)</strong>: ${vencidas.map((c) => `${c.descricao} (${dataBR(c.vencimento)}, ${dinheiro(c.valor)})`).join(" · ")}</div>` : ""}
        <div class="two-col">
          <div class="panel"><div class="panel-head"><h2>Dia a dia</h2><button class="btn sm" id="csv">CSV</button></div>
            <div class="table-wrap" style="max-height:480px"><table class="table"><thead><tr><th>Dia</th><th style="width:40%"></th><th class="r">Entrou</th><th class="r">Saiu</th><th class="r">Acumulado</th></tr></thead>
            <tbody>${dias.slice().reverse().map((d) => html`<tr><td>${dataBR(d.dia)}</td>
              <td><div class="fluxo-barras"><span class="e" style="width:${(d.entradas / max) * 100}%"></span><span class="s" style="width:${(d.saidas / max) * 100}%"></span></div></td>
              <td class="r num" style="color:var(--ok)">${d.entradas ? dinheiro(d.entradas) : ""}</td><td class="r num" style="color:var(--danger)">${d.saidas ? dinheiro(d.saidas) : ""}</td>
              <td class="r num"><strong>${dinheiro(d.acum)}</strong></td></tr>`)}</tbody></table></div></div>
          <div class="panel"><div class="panel-head"><h2>Próximos pagamentos</h2><a class="btn sm" href="#/financeiro/contas">Ver contas</a></div>
            ${r.a_pagar.length ? html`<div class="table-wrap" style="max-height:480px"><table class="table"><tbody>${[...vencidas, ...proximas].map((c) => html`<tr>
              <td><strong>${c.descricao}</strong><div class="small muted">${c.categoria}</div></td>
              <td><span class="badge ${c.vencida ? "danger" : c.vencimento === hoje ? "warn" : ""}">${c.vencida ? "vencida " : ""}${dataBR(c.vencimento)}</span></td>
              <td class="r"><strong>${dinheiro(c.valor)}</strong></td></tr>`)}</tbody></table></div>` : html`<div class="empty"><p>Nada a pagar nos próximos 30 dias.</p></div>`}</div>
        </div>`);
      $("#csv", corpo).onclick = () => baixarCSV("fluxo-de-caixa.csv", [["Dia", "Entradas", "Saídas", "Saldo", "Acumulado"], ...dias.map((d) => [dataBR(d.dia), numCSV(d.entradas), numCSV(d.saidas), numCSV(d.saldo), numCSV(d.acum)])]);
    }, "30d", [["7d", "7 dias"], ["30d", "30 dias"], ["mes", "Este mês"], ["mes_ant", "Mês passado"], ["custom", "Personalizado"]]);
  }

  // =================== Contas a pagar ===================
  async function contas() {
    let filtro = "abertas";
    render(corpo, html`<div class="toolbar">
      <div class="chips" id="f">${[["abertas", "A pagar"], ["vencidas", "Vencidas"], ["pagas", "Pagas"], ["todas", "Todas"]].map(([k, n]) => html`<button class="chip ${k === filtro ? "ativo" : ""}" data-f="${k}">${n}</button>`)}</div>
      <span class="grow"></span><button class="btn primary" id="nova">${icone("mais", 'width="18" height="18"')} Nova conta</button></div>
      <div class="panel" id="l"></div>`);
    $$("[data-f]", corpo).forEach((b) => (b.onclick = () => { filtro = b.dataset.f; $$("[data-f]", corpo).forEach((x) => x.classList.toggle("ativo", x === b)); carregar(); }));
    $("#nova", corpo).onclick = () => editar(null);
    const hoje = hojeISO();
    async function carregar() {
      let qy = sb.from("contas_pagar").select("*, fornecedor:fornecedores(nome)").limit(500);
      if (filtro === "abertas") qy = qy.is("pago_em", null).order("vencimento");
      else if (filtro === "vencidas") qy = qy.is("pago_em", null).lt("vencimento", hoje).order("vencimento");
      else if (filtro === "pagas") qy = qy.not("pago_em", "is", null).order("pago_em", { ascending: false });
      else qy = qy.order("vencimento", { ascending: false });
      const l = await q(qy);
      const tot = l.reduce((a, c) => a + Number(c.pago_em ? c.valor_pago ?? c.valor : c.valor), 0);
      render($("#l", corpo), l.length ? html`<div class="panel-head"><span class="muted">${l.length} conta(s)</span><strong>${dinheiro(tot)}</strong></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Vencimento</th><th>Descrição</th><th>Categoria</th><th class="r">Valor</th><th>Situação</th><th></th></tr></thead>
        <tbody>${l.map((c) => { const venc = !c.pago_em && c.vencimento < hoje; return html`<tr>
          <td><span class="badge ${venc ? "danger" : !c.pago_em && c.vencimento === hoje ? "warn" : ""}">${dataBR(c.vencimento)}</span></td>
          <td><strong>${c.descricao}</strong>${c.fornecedor?.nome ? html`<div class="small muted">${c.fornecedor.nome}</div>` : ""}</td><td class="small">${c.categoria}</td>
          <td class="r"><strong>${dinheiro(c.valor)}</strong></td>
          <td>${c.pago_em ? html`<span class="badge ok">paga ${dataBR(c.pago_em)}${Number(c.valor_pago) !== Number(c.valor) ? ` · ${dinheiro(c.valor_pago)}` : ""}</span>` : venc ? html`<span class="badge danger">vencida</span>` : html`<span class="badge">a pagar</span>`}</td>
          <td class="r"><div class="row" style="gap:.3rem;justify-content:flex-end">${!c.pago_em ? html`<button class="btn sm primary" data-pagar="${c.id}">Pagar</button>` : html`<button class="btn sm ghost" data-desfazer="${c.id}">Desfazer</button>`}
            <button class="btn sm ghost" data-ed="${c.id}">Editar</button></div></td></tr>`; })}</tbody></table></div>`
        : html`<div class="empty"><p>${filtro === "pagas" ? "Nenhuma conta paga." : "Nenhuma conta aqui."}</p><p class="small">Aluguel, energia, salários e boletos de fornecedor. As parcelas das notas lançadas pelo XML entram sozinhas.</p></div>`);
      $$("[data-pagar]", corpo).forEach((b) => (b.onclick = () => pagar(l.find((c) => c.id === b.dataset.pagar))));
      $$("[data-ed]", corpo).forEach((b) => (b.onclick = () => editar(l.find((c) => c.id === b.dataset.ed))));
      $$("[data-desfazer]", corpo).forEach((b) => (b.onclick = async () => {
        try { await q(sb.from("contas_pagar").update({ pago_em: null, valor_pago: null, forma: null }).eq("id", b.dataset.desfazer)); carregar(); } catch (e) { erro(e); }
      }));
    }
    async function pagar(c) {
      const r = await modal({
        titulo: `Pagar · ${c.descricao}`,
        corpo: html`<form id="fp" class="stack"><div class="grid-2">
          <label class="field"><span>Data do pagamento</span><input class="input" type="date" name="d" value="${hoje}"></label>
          <label class="field"><span>Valor pago (com juros/desconto)</span><input class="input" name="v" inputmode="decimal" value="${String(c.valor).replace(".", ",")}"></label></div>
          <label class="field"><span>Como pagou</span><select class="input" name="f">${["PIX", "Boleto", "Dinheiro do caixa", "Transferência", "Cartão", "Débito automático"].map((x) => html`<option>${x}</option>`)}</select></label></form>`,
        rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="fp">Confirmar pagamento</button>`,
        onPronto: (d, f) => (d.querySelector("form").onsubmit = (e) => { e.preventDefault(); f({ d: e.target.d.value, v: lerNumero(e.target.v.value), f: e.target.f.value }); }),
      });
      if (!r) return;
      if (!(r.v > 0) || !r.d) return toast("Informe data e valor", "erro");
      try { await q(sb.from("contas_pagar").update({ pago_em: r.d, valor_pago: r.v, forma: r.f }).eq("id", c.id)); toast("Conta paga", "ok"); carregar(); } catch (e) { erro(e); }
    }
    async function editar(c) {
      const r = await modal({
        titulo: c ? "Editar conta" : "Nova conta a pagar",
        corpo: html`<form id="fc" class="stack">
          <label class="field"><span>Descrição</span><input class="input" name="descricao" value="${c?.descricao || ""}" required autofocus placeholder="Ex.: Aluguel da loja"></label>
          <div class="grid-2"><label class="field"><span>Categoria</span><select class="input" name="categoria">${CATEGORIAS_DESPESA.map((x) => html`<option ${x === (c?.categoria || "Outros") ? "selected" : ""}>${x}</option>`)}</select></label>
            <label class="field"><span>Valor</span><input class="input" name="valor" inputmode="decimal" value="${c ? String(c.valor).replace(".", ",") : ""}" required></label>
            <label class="field"><span>Vencimento</span><input class="input" type="date" name="vencimento" value="${c?.vencimento || hojeISO()}" required></label>
            ${!c ? html`<label class="field"><span>Repetir todo mês</span><select class="input" name="rep">${[1, 2, 3, 6, 12].map((n) => html`<option value="${n}">${n === 1 ? "Não repetir" : `${n} meses`}</option>`)}</select></label>` : ""}</div>
          <label class="field"><span>Observação</span><input class="input" name="observacao" value="${c?.observacao || ""}"></label></form>`,
        rodape: html`${c ? html`<button class="btn danger" id="exc">Excluir</button>` : ""}<span class="grow"></span><button class="btn" data-fechar>Voltar</button><button class="btn primary" form="fc">Salvar</button>`,
        onPronto: (d, f) => {
          d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const x = e.target; f({ descricao: x.descricao.value.trim(), categoria: x.categoria.value, valor: lerNumero(x.valor.value), vencimento: x.vencimento.value, observacao: x.observacao.value.trim() || null, rep: Number(x.rep?.value || 1) }); };
          d.querySelector("#exc")?.addEventListener("click", () => f({ excluir: true }));
        },
      });
      if (!r) return;
      try {
        if (r.excluir) { if (!(await confirmar(`Excluir "${c.descricao}"?`, { perigo: true, ok: "Excluir" }))) return; await q(sb.from("contas_pagar").delete().eq("id", c.id)); }
        else {
          if (!(r.valor > 0) || !r.descricao || !r.vencimento) return toast("Preencha descrição, valor e vencimento", "erro");
          const { rep, ...dados } = r;
          if (c) await q(sb.from("contas_pagar").update(dados).eq("id", c.id));
          else {
            const [y, m, d] = r.vencimento.split("-").map(Number);
            const linhas = Array.from({ length: rep }, (_, k) => {
              const ult = new Date(y, m - 1 + k + 1, 0).getDate();
              const venc = `${new Date(y, m - 1 + k, 1).getFullYear()}-${String(new Date(y, m - 1 + k, 1).getMonth() + 1).padStart(2, "0")}-${String(Math.min(d, ult)).padStart(2, "0")}`;
              return { ...dados, empresa_id: estado.empresa.id, vencimento: venc, descricao: rep > 1 ? `${dados.descricao} (${k + 1}/${rep})` : dados.descricao };
            });
            await q(sb.from("contas_pagar").insert(linhas));
          }
        }
        toast("Salvo", "ok"); carregar();
      } catch (e) { erro(e); }
    }
    await carregar();
  }

  // =================== Conferência PIX/cartão ===================
  async function conferencia() {
    render(corpo, html`<div class="stack-lg">
      <div class="panel panel-pad row wrap" style="gap:1rem;align-items:flex-end">
        <label class="field"><span>Dia</span><input class="input" type="date" id="dia" value="${somarDias(hojeISO(), -1)}" max="${hojeISO()}"></label>
        <p class="muted small grow">Compare o que o caixa lançou com o que caiu no banco (extrato) e com o relatório da maquininha. Diferenças podem ser erro de lançamento, PIX não recebido ou taxa cobrada a mais.</p></div>
      <div id="conf"></div>
      <div class="panel"><div class="panel-head"><h2>Conferências salvas</h2></div><div id="hist"></div></div></div>`);
    $("#dia", corpo).onchange = () => carregar().catch(erro);
    async function historico() {
      const l = await q(sb.from("conferencias").select("*, usuario:perfis(nome)").order("dia", { ascending: false }).order("created_at", { ascending: false }).limit(30));
      render($("#hist", corpo), l.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Dia</th><th>Forma</th><th class="r">Sistema</th><th class="r">Banco/maquininha</th><th class="r">Diferença</th><th>Origem</th><th>Quem</th></tr></thead>
        <tbody>${l.map((c) => html`<tr><td>${dataBR(c.dia)}</td><td>${nomeForma(c.forma)}</td><td class="r">${dinheiro(c.valor_sistema)}</td><td class="r">${dinheiro(c.valor_conferido)}</td>
          <td class="r"><span class="badge ${Math.abs(c.diferenca) < 0.01 ? "ok" : "danger"}">${dinheiro(c.diferenca)}</span></td><td class="small">${c.origem || ""}${c.observacao ? " · " + c.observacao : ""}</td><td class="small">${c.usuario?.nome || ""}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Nenhuma conferência salva.</p></div>`);
    }
    async function carregar() {
      const dia = $("#dia", corpo).value;
      const pags = await rpc("pagamentos_periodo", { p_ini: dia, p_fim: dia });
      const formas = ["pix", "debito", "credito", "vale_refeicao"];
      const tot = Object.fromEntries(formas.map((f) => [f, r2(pags.filter((p) => p.forma === f).reduce((a, p) => a + Number(p.valor), 0))]));
      const taxas = estado.empresa.taxas_pagamento || {};
      render($("#conf", corpo), html`<div class="two-col">
        <div class="panel"><div class="panel-head"><h2>Digitar os totais</h2><span class="muted small">da maquininha / app do banco</span></div>
          <form id="fm" class="panel-pad stack">${formas.map((f) => html`<div class="conf-linha" data-f="${f}">
            <div><strong>${nomeForma(f)}</strong><div class="small muted">sistema ${dinheiro(tot[f])}${taxas[f] ? ` · líquido esperado ${dinheiro(r2(tot[f] * (1 - taxas[f] / 100)))}` : ""}</div></div>
            <input class="input" data-v inputmode="decimal" placeholder="valor informado"><span class="badge" data-d></span></div>`)}
            <label class="field"><span>Observação</span><input class="input" id="obs"></label>
            <button class="btn primary">Salvar conferência</button></form></div>
        <div class="panel"><div class="panel-head"><h2>Importar extrato do PIX</h2><span class="muted small">OFX ou CSV do banco</span></div>
          <div class="panel-pad stack"><input type="file" id="arq" accept=".ofx,.csv,.txt,text/csv">
            <p class="small muted">Baixe no internet banking o extrato do dia em OFX (Money/Quicken) ou CSV. O sistema confere cada PIX lançado no caixa com o que entrou na conta.</p>
            <div id="ext"></div></div></div></div>`);
      const form = $("#fm", corpo);
      form.addEventListener("input", (e) => {
        const box = e.target.closest("[data-f]"); if (!box) return;
        const v = lerNumero(e.target.value), d = r2(v - tot[box.dataset.f]);
        const b = box.querySelector("[data-d]"); b.textContent = e.target.value ? (Math.abs(d) < 0.01 ? "confere" : `${d > 0 ? "+" : ""}${dinheiro(d)}`) : "";
        b.className = "badge " + (!e.target.value ? "" : Math.abs(d) < 0.01 ? "ok" : "danger");
      });
      form.onsubmit = async (e) => {
        e.preventDefault();
        const linhas = [...form.querySelectorAll("[data-f]")].filter((b) => b.querySelector("[data-v]").value).map((b) => {
          const f = b.dataset.f, v = lerNumero(b.querySelector("[data-v]").value);
          return { empresa_id: estado.empresa.id, dia, forma: f, valor_sistema: tot[f], valor_conferido: v, diferenca: r2(v - tot[f]), origem: "digitado", observacao: $("#obs", corpo).value.trim() || null };
        });
        if (!linhas.length) return toast("Digite ao menos um valor", "erro");
        try { await q(sb.from("conferencias").insert(linhas)); toast("Conferência salva", "ok"); historico(); } catch (err) { erro(err); }
      };
      $("#arq", corpo).onchange = async (e) => {
        const f = e.target.files[0]; e.target.value = ""; if (!f) return;
        try { extrato(await lerArquivoTexto(f), f.name, pags.filter((p) => p.forma === "pix"), dia, tot.pix); } catch (err) { erro(err); }
      };
    }
    function extrato(texto, nomeArq, pixSistema, dia, totalPix) {
      let movs = /<OFX>|<STMTTRN>/i.test(texto) ? lerOFX(texto) : lerCSV(texto);
      if (!movs.length) throw new Error("Não encontrei lançamentos neste arquivo. Use OFX ou CSV com colunas de data e valor.");
      movs = movs.filter((m) => m.valor > 0 && m.dia === dia);
      const soPix = movs.some((m) => /pix/i.test(m.desc));
      const creditos = soPix ? movs.filter((m) => /pix/i.test(m.desc)) : movs;
      // Casa cada PIX do caixa com um crédito do mesmo valor (o mais próximo no horário)
      const livres = creditos.map((c, i) => ({ ...c, i }));
      const casados = [], semExtrato = [];
      for (const p of pixSistema) {
        const t = new Date(p.quando).getTime();
        const cand = livres.filter((c) => !c.usado && Math.abs(c.valor - Number(p.valor)) < 0.005)
          .sort((a, b) => (a.hora ? Math.abs(a.t - t) : 0) - (b.hora ? Math.abs(b.t - t) : 0))[0];
        if (cand) { cand.usado = true; casados.push([p, cand]); } else semExtrato.push(p);
      }
      const semCaixa = livres.filter((c) => !c.usado);
      const totExt = r2(creditos.reduce((a, c) => a + c.valor, 0));
      render($("#ext", corpo), html`<div class="stack">
        <div class="row wrap" style="gap:.5rem"><span class="badge ${semExtrato.length ? "danger" : "ok"}">${casados.length} de ${pixSistema.length} PIX do caixa encontrados</span>
          <span class="badge">${creditos.length} crédito(s) ${soPix ? "PIX " : ""}no extrato · ${dinheiro(totExt)}</span></div>
        ${semExtrato.length ? html`<div class="alerta"><strong>Lançados como PIX no caixa e não encontrados no extrato:</strong>
          ${semExtrato.map((p) => html`<div>${hora(p.quando)} · ${dinheiro(p.valor)} · ${p.venda ? `venda nº ${p.venda}` : "fiado"} · ${p.operador || ""}</div>`)}</div>` : ""}
        ${semCaixa.length ? html`<div class="alerta info"><strong>Entraram no banco e não estão no caixa</strong> (podem ser de outro dia, transferências ou vendas lançadas em outra forma):
          ${semCaixa.map((c) => html`<div>${c.hora || ""} · ${dinheiro(c.valor)} · ${c.desc.slice(0, 60)}</div>`)}</div>` : ""}
        <button class="btn primary" id="salvar-ext">Salvar conferência do PIX</button></div>`);
      $("#salvar-ext", corpo).onclick = async () => {
        try {
          await q(sb.from("conferencias").insert({ empresa_id: estado.empresa.id, dia, forma: "pix", valor_sistema: totalPix, valor_conferido: totExt, diferenca: r2(totExt - totalPix),
            origem: "extrato " + nomeArq.slice(0, 40), detalhes: { nao_encontrados: semExtrato, sem_caixa: semCaixa.map(({ valor, desc, hora: h }) => ({ valor, desc, hora: h })) } }));
          toast("Conferência salva", "ok"); historico();
        } catch (e) { erro(e); }
      };
    }
    await carregar(); historico();
  }

  // =================== Taxas ===================
  async function taxas() {
    const t = estado.empresa.taxas_pagamento || {};
    render(corpo, html`<form id="ft" class="panel panel-pad stack-lg" style="max-width:640px">
      <div><h2>Taxas cobradas por forma de pagamento</h2><p class="muted">Percentual que fica com a maquininha, o banco ou a bandeira. Entra no cálculo do lucro real e da conferência.</p></div>
      <div class="grid-2">${FORMAS_TAXA.map(([k, n]) => html`<label class="field"><span>${n} (%)</span><input class="input" name="${k}" inputmode="decimal" value="${t[k] != null ? String(t[k]).replace(".", ",") : ""}" placeholder="0,00"></label>`)}</div>
      <p class="small muted">Dica: crédito parcelado costuma ter taxa maior. Use a taxa média que aparece no seu extrato da maquininha.</p>
      <div><button class="btn primary">Salvar taxas</button></div></form>`);
    $("#ft", corpo).onsubmit = async (e) => {
      e.preventDefault();
      const p = Object.fromEntries(FORMAS_TAXA.map(([k]) => [k, e.target[k].value.trim()]).filter(([, v]) => v !== "").map(([k, v]) => [k, lerNumero(v)]));
      if (Object.values(p).some((v) => !(v >= 0 && v <= 30))) return toast("Use valores entre 0 e 30%", "erro");
      try {
        await rpc("salvar_taxas", { p });
        estado.empresa = await q(sb.from("empresas").select("*").eq("id", estado.empresa.id).single());
        toast("Taxas salvas", "ok");
      } catch (err) { erro(err); }
    };
  }
}

// ---------- Leitura de extratos ----------
function lerOFX(t) {
  const campo = (b, n) => (b.match(new RegExp(`<${n}>([^<\\r\\n]*)`, "i")) || [])[1]?.trim() || "";
  return [...t.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|<\/BANKTRANLIST>)/gi)].map((m) => {
    const b = m[1]; const d = campo(b, "DTPOSTED");
    const hh = d.length >= 12 && d.slice(8, 12) !== "0000" ? `${d.slice(8, 10)}:${d.slice(10, 12)}` : "";
    const dia = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return { dia, hora: hh, t: hh ? new Date(`${dia}T${hh}:00`).getTime() : 0, valor: Number(campo(b, "TRNAMT").replace(",", ".")), desc: `${campo(b, "NAME")} ${campo(b, "MEMO")}`.trim() };
  }).filter((m) => Number.isFinite(m.valor));
}

function lerCSV(t) {
  const linhas = t.split(/\r?\n/).filter((l) => l.trim());
  if (linhas.length < 2) return [];
  const sep = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ";" : ",";
  const cel = (l) => { const out = []; let cur = "", aspas = false; for (const ch of l) { if (ch === '"') aspas = !aspas; else if (ch === sep && !aspas) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
  // Acha a linha de cabeçalho (primeira com "data" e "valor")
  let ih = linhas.findIndex((l) => /data|date/i.test(l) && /valor|amount|cr[ée]dito|quantia/i.test(l));
  if (ih < 0) ih = 0;
  const cab = cel(linhas[ih]).map((c) => c.toLowerCase());
  const iData = cab.findIndex((c) => /data|date/.test(c));
  const iValor = cab.findIndex((c) => /^valor|amount|quantia|valor \(r\$\)/.test(c)) >= 0 ? cab.findIndex((c) => /^valor|amount|quantia|valor \(r\$\)/.test(c)) : cab.findIndex((c) => /cr[ée]dito/.test(c));
  const iDesc = cab.findIndex((c) => /descri|hist[óo]rico|memo|lan[çc]amento|detalhe/.test(c));
  if (iData < 0 || iValor < 0) throw new Error("CSV sem colunas de data e valor reconhecíveis");
  const dataISO = (s) => {
    let m = s.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/); if (m) return [`${m[3]}-${m[2]}-${m[1]}`, m[4] ? `${m[4]}:${m[5]}` : ""];
    m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/); if (m) return [`${m[1]}-${m[2]}-${m[3]}`, m[4] ? `${m[4]}:${m[5]}` : ""];
    return ["", ""];
  };
  return linhas.slice(ih + 1).map(cel).map((c) => {
    const [dia, hh] = dataISO(c[iData] || "");
    return { dia, hora: hh, t: hh ? new Date(`${dia}T${hh}:00`).getTime() : 0, valor: lerNumero(String(c[iValor] || "").replace(/[^\d,.-]/g, "")), desc: iDesc >= 0 ? c[iDesc] || "" : c.join(" ") };
  }).filter((m) => m.dia && Number.isFinite(m.valor));
}
export { lerOFX, lerCSV };
