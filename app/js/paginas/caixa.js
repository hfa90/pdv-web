// Abertura, sangria, suprimento e fechamento de caixa.
import { sb, q, rpc } from "../api.js";
import { estado, eh, atualizarCaixa } from "../estado.js";
import { html, render, $, $$, dinheiro, dataHora, hora, lerNumero, toast, erro, modal, ocupado, confirmar } from "../ui.js";
import { icone } from "../icons.js";
import { imprimir, layoutFechamento, nomeForma } from "../impressao/cupom.js";
import { fila, sincronizarFila, abrirPainelFila } from "../contingencia.js";

const NSU_FORMAS = { pix: "PIX", debito: "Débito", credito: "Crédito" };

export default async function caixa(el) {
  // Contas fechadas pelos garçons no app: entram neste caixa (PIX e cartão), lista para conferir com a maquininha
  async function desenharRecebidosApp(sessaoId) {
    const alvo = $("#app-receb", el);
    if (!alvo) return;
    const lista = await q(sb.from("vendas").select("id,numero,identificador,total,finalizada_em,operador:perfis!vendas_operador_id_fkey(nome),pagamentos:venda_pagamentos(forma,valor,nsu)")
      .eq("sessao_id", sessaoId).eq("recebido_no_app", true).eq("status", "finalizada").order("finalizada_em", { ascending: false }));
    if (!lista.length) return render(alvo, "");
    const tot = lista.reduce((a, v) => a + Number(v.total), 0);
    render(alvo, html`<div class="panel" style="margin-bottom:1.25rem"><div class="panel-head"><h2>${icone("celular", 'width="18" height="18"')} Fechadas pelos garçons no app</h2>
      <span class="muted small">${lista.length} conta(s) · ${dinheiro(tot)} · já somadas acima</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Hora</th><th>Mesa</th><th>Garçom</th><th>Pagamento</th><th class="r">Total</th></tr></thead>
      <tbody>${lista.map((v) => html`<tr><td>${hora(v.finalizada_em)}</td><td><strong>${v.identificador || "nº " + v.numero}</strong></td><td>${v.operador?.nome || ""}</td>
        <td class="small">${(v.pagamentos || []).map((p) => `${NSU_FORMAS[p.forma] || p.forma} ${dinheiro(p.valor)}${p.nsu ? ` (NSU ${p.nsu})` : ""}`).join(" · ")}</td>
        <td class="r">${dinheiro(v.total)}</td></tr>`)}</tbody></table></div></div>`);
  }

  async function desenhar() {
    await atualizarCaixa();
    const cx = estado.caixa;
    const resumo = cx ? await rpc("resumo_caixa", { p_sessao_id: cx.id }) : null;
    const gerente = eh("admin", "gerente");
    const historico = await q(sb.from("caixa_sessoes").select("*, operador:perfis(nome)").order("aberto_em", { ascending: false }).limit(30));

    render(el, html`<div class="page">
      <div class="page-head"><div><h1>Caixa</h1>
        <p>${cx ? html`Aberto desde ${dataHora(cx.aberto_em)}` : "Seu caixa está fechado."}</p></div>
        <div class="row wrap">${cx ? html`
          <button class="btn" data-mov="suprimento">Suprimento</button>
          <button class="btn" data-mov="sangria">Sangria</button>
          <button class="btn" id="imp-parcial">${icone("imprimir", 'width="18" height="18"')} Resumo parcial</button>
          <button class="btn primary" id="fechar">Fechar caixa</button>`
          : html`<button class="btn primary lg" id="abrir">Abrir caixa</button>`}</div>
      </div>

      ${resumo ? html`
        <div class="kpis">
          <div class="panel kpi"><div class="k-label">Vendido</div><div class="k-valor">${dinheiro(resumo.vendas_total)}</div><div class="k-sub">${resumo.vendas_qtd} vendas</div></div>
          <div class="panel kpi"><div class="k-label">Dinheiro na gaveta (esperado)</div><div class="k-valor">${dinheiro(resumo.esperado_dinheiro)}</div><div class="k-sub">Fundo ${dinheiro(resumo.valor_abertura)}</div></div>
          <div class="panel kpi"><div class="k-label">Sangrias</div><div class="k-valor">${dinheiro(resumo.sangrias)}</div><div class="k-sub">Suprimentos ${dinheiro(resumo.suprimentos)}</div></div>
          <div class="panel kpi"><div class="k-label">Canceladas</div><div class="k-valor">${resumo.canceladas_qtd}</div></div>
        </div>
        <div class="panel" style="margin-bottom:1.25rem"><div class="panel-head"><h2>Recebido por forma de pagamento</h2></div>
          <div class="panel-pad">${Object.keys(resumo.por_forma).length ? html`<div class="bars">${Object.entries(resumo.por_forma).map(([f, v]) => html`
            <div class="bar-row"><span>${nomeForma(f)}</span><div class="bar-track"><div class="bar-fill" style="width:${resumo.vendas_total ? Math.max(2, (v / resumo.vendas_total) * 100) : 0}%"></div></div><strong class="num">${dinheiro(v)}</strong></div>`)}</div>`
            : html`<p class="muted">Nenhuma venda neste caixa ainda.</p>`}</div></div>
        <div id="app-receb"></div>` : ""}

      <div class="panel"><div class="panel-head"><h2>${gerente ? "Caixas recentes" : "Meus caixas"}</h2></div>
        ${historico.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Operador</th><th>Abertura</th><th>Fechamento</th><th class="r">Esperado</th><th class="r">Contado</th><th class="r">Diferença</th><th></th></tr></thead>
          <tbody>${historico.map((s) => html`<tr class="click" data-s="${s.id}" data-op="${s.operador?.nome || ""}">
            <td>${s.operador?.nome || "—"}</td><td>${dataHora(s.aberto_em)}</td>
            <td>${s.status === "aberto" ? html`<span class="badge ok">Aberto</span>` : dataHora(s.fechado_em)}</td>
            <td class="r">${s.valor_esperado != null ? dinheiro(s.valor_esperado) : "—"}</td>
            <td class="r">${s.valor_informado != null ? dinheiro(s.valor_informado) : "—"}</td>
            <td class="r">${s.diferenca != null ? html`<span class="badge ${Number(s.diferenca) === 0 ? "ok" : Number(s.diferenca) < 0 ? "danger" : "warn"}">${dinheiro(s.diferenca)}</span>` : "—"}</td>
            <td class="r">${icone("imprimir", 'width="18" height="18"')}</td></tr>`)}</tbody></table></div>`
          : html`<div class="empty"><p>Nenhum caixa registrado.</p></div>`}
      </div></div>`);

    $("#abrir", el)?.addEventListener("click", abrir);
    if (cx) desenharRecebidosApp(cx.id).catch(() => {});
    $("#fechar", el)?.addEventListener("click", () => fechar(resumo));
    $("#imp-parcial", el)?.addEventListener("click", () => imprimir(layoutFechamento(resumo, estado.perfil.nome)).catch(erro));
    $$("[data-mov]", el).forEach((b) => (b.onclick = () => movimento(b.dataset.mov)));
    $$("tr[data-s]", el).forEach((tr) => (tr.onclick = () => verSessao(tr.dataset.s, tr.dataset.op)));
  }

  async function abrir() {
    const r = await modal({
      titulo: "Abrir caixa",
      corpo: html`<form class="stack" id="f-ab">
        <label class="field"><span>Fundo de troco (R$)</span><input class="input lg" name="valor" inputmode="decimal" value="0,00" autofocus>
          <span class="hint">Dinheiro que já está na gaveta no início do turno.</span></label>
        <label class="field"><span>Terminal</span><input class="input" name="terminal" value="${localStorage.getItem("pdv-terminal") || ""}" placeholder="Ex.: Caixa 1"></label></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-ab">Abrir caixa</button>`,
      onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); fechar({ valor: lerNumero(e.target.valor.value), terminal: e.target.terminal.value.trim() }); }; },
    });
    if (!r) return;
    if (!(r.valor >= 0)) return toast("Valor inválido", "erro");
    try {
      if (r.terminal) localStorage.setItem("pdv-terminal", r.terminal);
      await rpc("abrir_caixa", { p_valor: r.valor, p_terminal: r.terminal || null });
      toast("Caixa aberto", "ok"); desenhar();
    } catch (e) { erro(e); }
  }

  async function movimento(tipo) {
    const r = await modal({
      titulo: tipo === "sangria" ? "Sangria (retirada)" : "Suprimento (reforço de troco)",
      corpo: html`<form class="stack" id="f-mov">
        <label class="field"><span>Valor (R$)</span><input class="input lg" name="valor" inputmode="decimal" autofocus></label>
        <label class="field"><span>Motivo</span><input class="input" name="motivo" placeholder="${tipo === "sangria" ? "Ex.: depósito no cofre" : "Ex.: troco extra"}"></label></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-mov">Registrar</button>`,
      onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); fechar({ valor: lerNumero(e.target.valor.value), motivo: e.target.motivo.value.trim() }); }; },
    });
    if (!r) return;
    try { await rpc("movimentar_caixa", { p_tipo: tipo, p_valor: r.valor, p_motivo: r.motivo || null }); toast(tipo === "sangria" ? "Sangria registrada" : "Suprimento registrado", "ok"); desenhar(); }
    catch (e) { erro(e); }
  }

  async function fechar(resumo) {
    // Vendas feitas sem internet precisam chegar antes, senão o fechamento sai sem elas
    if (fila().some((x) => x.operador_id === estado.perfil.id)) {
      await sincronizarFila().catch(() => {});
      const pend = fila().filter((x) => x.operador_id === estado.perfil.id);
      if (pend.length) {
        toast(`Há ${pend.length} venda(s) feita(s) sem internet ainda não enviada(s). Envie antes de fechar o caixa.`, "erro");
        return abrirPainelFila();
      }
      await desenhar(); return toast("Vendas offline enviadas. Confira o resumo e feche o caixa.", "ok");
    }
    const { count } = await sb.from("vendas").select("id", { count: "exact", head: true }).eq("status", "aberta");
    const r = await modal({
      titulo: "Fechar caixa",
      corpo: html`<form class="stack" id="f-fc">
        ${count ? html`<div class="alerta warn">Há ${count} pedido(s) aberto(s). Eles continuam disponíveis para o próximo caixa.</div>` : ""}
        <p class="muted">Conte o dinheiro da gaveta e informe o valor. O sistema compara com o esperado.</p>
        <label class="field"><span>Dinheiro contado (R$)</span><input class="input lg" name="valor" inputmode="decimal" autofocus></label>
        <label class="field"><span>Observação</span><input class="input" name="obs"></label>
        <label class="check"><input type="checkbox" name="imp" checked> Imprimir fechamento</label></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-fc">Fechar caixa</button>`,
      onPronto: (d, fecharM) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const v = lerNumero(e.target.valor.value); if (!(v >= 0) || e.target.valor.value === "") return toast("Informe o valor contado", "erro"); fecharM({ valor: v, obs: e.target.obs.value.trim(), imp: e.target.imp.checked }); }; },
    });
    if (!r) return;
    try {
      const final = await rpc("fechar_caixa", { p_valor_informado: r.valor, p_observacao: r.obs || null });
      const dif = Number(final.diferenca);
      toast(dif === 0 ? "Caixa fechado sem diferença" : `Caixa fechado. Diferença de ${dinheiro(dif)}`, dif === 0 ? "ok" : "erro");
      if (r.imp) imprimir(layoutFechamento(final, estado.perfil.nome)).catch(erro);
      desenhar();
    } catch (e) { erro(e); }
  }

  async function verSessao(id, operador) {
    try {
      const r = await rpc("resumo_caixa", { p_sessao_id: id });
      const podeFechar = r.status === "aberto" && eh("admin", "gerente") && id !== estado.caixa?.id;
      const acao = await modal({
        titulo: `Caixa de ${operador || "—"}`,
        corpo: html`<div class="stack">
          ${[["Abertura", dataHora(r.aberto_em)], ["Fechamento", r.fechado_em ? dataHora(r.fechado_em) : "Aberto"], ["Vendas", `${r.vendas_qtd} · ${dinheiro(r.vendas_total)}`],
             ...Object.entries(r.por_forma).map(([f, v]) => [nomeForma(f), dinheiro(v)]),
             ["Fundo de troco", dinheiro(r.valor_abertura)], ["Suprimentos", dinheiro(r.suprimentos)], ["Sangrias", dinheiro(r.sangrias)],
             ["Dinheiro esperado", dinheiro(r.esperado_dinheiro)], ...(r.valor_informado != null ? [["Contado", dinheiro(r.valor_informado)], ["Diferença", dinheiro(r.diferenca)]] : [])]
            .map(([k, v]) => html`<div class="linha-valor" style="font-size:1rem"><span>${k}</span><strong style="color:var(--ink)">${v}</strong></div>`)}
        </div>`,
        rodape: html`${podeFechar ? html`<button class="btn danger" data-a="fechar">Fechar este caixa</button>` : ""}<button class="btn" data-a="imp">${icone("imprimir", 'width="18" height="18"')} Imprimir</button>`,
        onPronto: (d, f) => d.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => f(b.dataset.a))),
      });
      if (acao === "imp") imprimir(layoutFechamento(r, operador)).catch(erro);
      if (acao === "fechar") {
        const v = await modal({
          titulo: "Fechar caixa de outro operador",
          corpo: html`<form id="f-fo" class="stack"><label class="field"><span>Dinheiro contado (R$)</span><input class="input lg" name="v" inputmode="decimal" autofocus></label></form>`,
          rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-fo">Fechar</button>`,
          onPronto: (d, f) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); f(lerNumero(e.target.v.value)); }; },
        });
        if (v >= 0 && await confirmar(`Fechar o caixa de ${operador} com ${dinheiro(v)} contados?`)) {
          await rpc("fechar_caixa", { p_valor_informado: v, p_observacao: `Fechado por ${estado.perfil.nome}`, p_sessao_id: id });
          toast("Caixa fechado", "ok"); desenhar();
        }
      }
    } catch (e) { erro(e); }
  }

  await desenhar();
  // Garçom fechou uma conta no app e ela entrou neste caixa: atualiza a tela
  const aoReceber = () => desenhar().catch(() => {});
  window.addEventListener("pdv-recebimento-app", aoReceber);
  return () => window.removeEventListener("pdv-recebimento-app", aoReceber);
}
