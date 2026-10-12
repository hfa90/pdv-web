// Plataforma › IA (só o superusuário; migração 026).
// Chave da Anthropic do sistema, liberar para as lojas, modelo padrão, preço cobrado por uso,
// franquia mensal, pacotes de créditos, consumo por loja, créditos de cortesia e bloqueio.
import { rpc, fn } from "./api.js";
import { html, render, dinheiro, numero, toast, erro, modal, confirmar, ocupado, lerNumero, dataHora } from "./ui.js";
import { icone } from "./icons.js";
import { ESTADOS_IA } from "./ia-config.js";

const MODELOS = [["claude-haiku-5-5", "Claude Haiku (rápido e econômico)"], ["claude-sonnet-5-5", "Claude Sonnet (mais preciso)"]];
const v2 = (n) => String(Number(n || 0)).replace(".", ",");

export default async function iaPlataforma(destino) {
  const alvo = document.createElement("div");
  destino.replaceChildren(alvo);
  let s;
  try { s = await rpc("ia_plataforma_status"); }
  catch (e) {
    if (/ia_plataforma_status|function|does not exist/i.test(e.message)) return render(alvo, html`<div class="alerta warn">Falta aplicar a migração <code>026_ia_simplificar.sql</code>.</div>`);
    throw e;
  }

  const desenhar = () => {
    const c = s.config, m = s.mes;
    // Custo típico de um pedido por voz (≈ 4.000 tokens de entrada com cardápio em cache, 300 de saída)
    const exemplo = (4000 * Number(c.preco_entrada) + 300 * Number(c.preco_saida)) / 1e6;
    const pend = s.compras.filter((x) => x.status === "pendente");
    render(alvo, html`<div class="stack-lg">
      <div class="kpis">
        <div class="panel kpi"><div class="k-label">IA para as lojas</div><div class="k-valor">${c.ativo ? "Ligada" : "Desligada"}</div><div class="k-sub">${c.tem_chave ? `chave ••••${c.chave_fim}` : "sem chave"}</div></div>
        <div class="panel kpi"><div class="k-label">Usos no mês</div><div class="k-valor">${numero(m.chamadas)}</div><div class="k-sub">${numero(m.tokens_entrada)} tokens de entrada · ${numero(m.tokens_saida)} de saída</div></div>
        <div class="panel kpi"><div class="k-label">Cobrado das lojas no mês</div><div class="k-valor">${dinheiro(m.cobrado)}</div><div class="k-sub">pelo preço que você definiu</div></div>
        <div class="panel kpi"><div class="k-label">Créditos vendidos no mês</div><div class="k-valor">${dinheiro(m.vendido)}</div><div class="k-sub">${pend.length ? `${pend.length} compra(s) aguardando pagamento` : "nenhuma compra pendente"}</div></div>
      </div>

      <section class="panel panel-pad stack">
        <div class="row wrap" style="justify-content:space-between;gap:.75rem;align-items:center">
          <div><h2 style="margin:0">Chave da Anthropic do sistema</h2>
            <p class="muted small" style="margin:.2rem 0 0">É a conta que paga a IA das lojas que usam créditos. Fica só no servidor.</p></div>
          <label class="check"><input type="checkbox" id="ia-ativo" ${c.ativo ? "checked" : ""} ${c.tem_chave ? "" : "disabled"}> <strong>Liberar a IA para as lojas</strong></label>
        </div>
        ${c.tem_chave ? html`<div class="ia-chave">${icone("cadeado", 'width="15" height="15"')} <code>sk-ant-••••${c.chave_fim}</code>
            <span class="small muted">${c.chave_validada_em ? `testada em ${dataHora(c.chave_validada_em)}` : ""}</span></div>` : html`<p class="txt-alerta small" style="margin:0">Nenhuma chave cadastrada: as lojas só conseguem usar a própria chave.</p>`}
        <div class="row wrap" style="gap:.4rem">
          <button class="btn sm ${c.tem_chave ? "" : "primary"}" data-a="chave">${c.tem_chave ? "Trocar chave" : "Cadastrar chave"}</button>
          ${c.tem_chave ? html`<button class="btn sm" data-a="testar">Testar</button><button class="btn sm ghost" data-a="remover">Remover</button>` : ""}
          <a class="btn sm ghost" href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener">Saldo e recarga na Anthropic</a>
        </div>
      </section>

      <form class="panel panel-pad stack" id="f-preco">
        <div><h2>Preço, franquia e pacotes</h2><p class="muted small">Quanto as lojas pagam pela IA. Confira o preço da Anthropic para o modelo e coloque a sua margem.</p></div>
        <div class="grid-3">
          <label class="field"><span>Modelo padrão</span><select class="input" name="modelo">${MODELOS.map(([k, n]) => html`<option value="${k}" ${c.modelo === k ? "selected" : ""}>${n}</option>`)}</select></label>
          <label class="field"><span>R$ por 1 milhão de tokens de entrada</span><input class="input" name="preco_entrada" inputmode="decimal" value="${v2(c.preco_entrada)}"></label>
          <label class="field"><span>R$ por 1 milhão de tokens de saída</span><input class="input" name="preco_saida" inputmode="decimal" value="${v2(c.preco_saida)}"></label>
          <label class="field"><span>Franquia mensal por loja (R$)</span><input class="input" name="franquia_mensal" inputmode="decimal" value="${v2(c.franquia_mensal)}"><small class="hint">IA inclusa todo mês, antes de usar créditos.</small></label>
          <label class="field"><span>Pacotes de créditos (R$)</span><input class="input" name="pacotes" value="${(c.pacotes || []).map(v2).join("; ")}"><small class="hint">Separe por ponto e vírgula. Ex.: 20; 50; 100</small></label>
          <label class="check" style="align-self:end"><input type="checkbox" name="credito_imediato" ${c.credito_imediato ? "checked" : ""}> <span><strong>Liberar crédito na hora da compra</strong><small class="muted"> (a fatura é paga depois)</small></span></label>
        </div>
        <p class="hint" style="margin:0">Com esses preços, um pedido por voz típico custa à loja ≈ ${dinheiro(exemplo)}.</p>
        <div><button class="btn primary">Salvar</button></div>
      </form>

      ${pend.length ? html`<section class="panel"><div class="panel-head"><h2>Compras aguardando pagamento</h2></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Loja</th><th class="r">Valor</th><th>Pedido em</th><th></th></tr></thead><tbody>
          ${pend.map((x) => html`<tr><td>${x.loja}</td><td class="r">${dinheiro(x.valor)}</td><td>${dataHora(x.criado_em)}${x.creditado ? html` <span class="badge ok">já creditado</span>` : ""}</td>
            <td class="r"><button class="btn sm primary" data-liberar="${x.id}">${x.creditado ? "Marcar paga" : "Recebi · liberar créditos"}</button></td></tr>`)}</tbody></table></div>
        <div class="panel-pad small muted">A fatura também aparece em Cobranças. Marcar a fatura como paga lá libera os créditos do mesmo jeito.</div></section>` : ""}

      <section class="panel"><div class="panel-head"><h2>Lojas</h2><span class="muted small">consumo do mês</span></div>
        ${s.lojas.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Loja</th><th>Situação</th><th>Fonte</th><th class="r">Disponível</th><th class="r">Gasto no mês</th><th class="r">Usos</th><th></th></tr></thead><tbody>
          ${s.lojas.map((l) => { const [t, n] = ESTADOS_IA[l.estado] || ["", l.estado]; return html`<tr>
            <td><strong>${l.loja}</strong>${l.pendentes ? html` <span class="badge warn">${l.pendentes} compra(s)</span>` : ""}</td>
            <td><span class="badge ${t}">${n}</span></td>
            <td>${l.fonte === "propria" ? "Chave própria" : "Créditos"}</td>
            <td class="r">${l.fonte === "propria" ? "—" : dinheiro(l.disponivel)}</td>
            <td class="r">${dinheiro(l.fonte === "propria" ? l.custo_mes_propria : l.custo_mes)}</td>
            <td class="r">${numero(l.chamadas_mes)}</td>
            <td class="r"><button class="btn sm" data-cortesia="${l.empresa_id}">Dar créditos</button>
              <button class="btn sm ${l.bloqueado ? "primary" : "ghost"}" data-bloq="${l.empresa_id}" data-v="${l.bloqueado ? "0" : "1"}">${l.bloqueado ? "Desbloquear" : "Bloquear"}</button></td></tr>`; })}</tbody></table></div>`
        : html`<div class="empty"><p>Nenhuma loja ativa.</p></div>`}</section>
    </div>`);
  };

  const recarregar = async () => { s = await rpc("ia_plataforma_status"); desenhar(); };

  alvo.addEventListener("change", async (e) => {
    if (e.target.id !== "ia-ativo") return;
    try { s = await rpc("ia_plataforma_config", { p: { ativo: e.target.checked } }); toast(e.target.checked ? "IA liberada para as lojas" : "IA do sistema desligada", "ok"); desenhar(); }
    catch (err) { erro(err); recarregar(); }
  });
  alvo.addEventListener("submit", async (e) => {
    if (e.target.id !== "f-preco") return;
    e.preventDefault();
    const f = e.target;
    const pacotes = f.pacotes.value.split(";").map((x) => lerNumero(x)).filter((n) => n > 0);
    const dados = { modelo: f.modelo.value, preco_entrada: lerNumero(f.preco_entrada.value), preco_saida: lerNumero(f.preco_saida.value),
      franquia_mensal: lerNumero(f.franquia_mensal.value), pacotes, credito_imediato: f.credito_imediato.checked };
    if ([dados.preco_entrada, dados.preco_saida, dados.franquia_mensal].some((n) => !(n >= 0))) return toast("Confira os valores", "erro");
    try { s = await ocupado(f.querySelector("button.primary"), () => rpc("ia_plataforma_config", { p: dados })); toast("Preços salvos", "ok"); desenhar(); }
    catch (err) { erro(err); }
  });
  alvo.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.a === "chave") {
        const ok = await modal({
          titulo: "Chave da Anthropic do sistema",
          corpo: html`<form id="f-ch" class="stack"><p class="muted small" style="margin:0">Crie em <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com › API Keys</a>. Ela é testada e guardada só no servidor.</p>
            <label class="field"><span>Chave (sk-ant-…)</span><input class="input" name="chave" type="password" autocomplete="off" spellcheck="false" required autofocus></label></form>`,
          rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-ch">Testar e salvar</button>`,
          onPronto: (d, fechar) => (d.querySelector("form").onsubmit = async (ev) => {
            ev.preventDefault();
            try { await ocupado(d.querySelector("button.primary"), () => fn("ia", { acao: "salvar_chave", escopo: "plataforma", chave: ev.target.chave.value.trim() })); fechar(true); }
            catch (err) { toast(err.message, "erro"); }
          }),
        });
        if (ok) { toast("Chave testada e salva ✓", "ok"); await recarregar(); }
        return;
      }
      if (b.dataset.a === "testar") {
        const r = await ocupado(b, () => fn("ia", { acao: "testar", escopo: "plataforma" }));
        toast(r.ok ? "A chave está funcionando ✓" : r.erro || "A chave não funcionou", r.ok ? "ok" : "erro");
        return recarregar();
      }
      if (b.dataset.a === "remover") {
        if (!(await confirmar("Remover a chave do sistema? A IA fica desligada para as lojas que usam créditos.", { ok: "Remover", perigo: true }))) return;
        await ocupado(b, () => fn("ia", { acao: "remover_chave", escopo: "plataforma" }));
        toast("Chave removida", "ok"); return recarregar();
      }
      if (b.dataset.liberar) {
        await ocupado(b, () => rpc("ia_plataforma_liberar", { p_compra: b.dataset.liberar, p_forma: "manual" }));
        toast("Pagamento registrado e créditos liberados", "ok"); return recarregar();
      }
      if (b.dataset.cortesia) {
        const l = s.lojas.find((x) => x.empresa_id === b.dataset.cortesia);
        const r = await modal({
          titulo: `Créditos para ${l.loja}`,
          corpo: html`<form id="f-cort" class="stack"><label class="field"><span>Valor (R$)</span><input class="input" name="v" inputmode="decimal" required autofocus></label>
            <label class="field"><span>Motivo</span><input class="input" name="m" maxlength="200" placeholder="Ex.: boas-vindas, compensação"></label>
            <p class="hint" style="margin:0">Use valor negativo para retirar créditos.</p></form>`,
          rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-cort">Aplicar</button>`,
          onPronto: (d, fechar) => (d.querySelector("form").onsubmit = (ev) => { ev.preventDefault(); fechar({ v: lerNumero(ev.target.v.value), m: ev.target.m.value }); }),
        });
        if (!r) return;
        await rpc("ia_plataforma_loja", { p_emp: l.empresa_id, p: { cortesia: r.v, motivo: r.m } });
        toast("Créditos aplicados", "ok"); return recarregar();
      }
      if (b.dataset.bloq) {
        const bloquear = b.dataset.v === "1";
        let motivo = "";
        if (bloquear) {
          motivo = await modal({
            titulo: "Bloquear a IA desta loja",
            corpo: html`<form id="f-bl"><label class="field"><span>Motivo (a loja vê)</span><input class="input" name="m" maxlength="200" autofocus></label></form>`,
            rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn danger" form="f-bl">Bloquear</button>`,
            onPronto: (d, fechar) => (d.querySelector("form").onsubmit = (ev) => { ev.preventDefault(); fechar(ev.target.m.value || " "); }),
          });
          if (motivo == null) return;
        }
        await rpc("ia_plataforma_loja", { p_emp: b.dataset.bloq, p: { bloqueado: bloquear, motivo: motivo.trim() } });
        toast(bloquear ? "IA bloqueada na loja" : "IA desbloqueada", "ok"); return recarregar();
      }
    } catch (err) { erro(err); }
  });

  desenhar();
}
