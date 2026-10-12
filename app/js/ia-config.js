// Configurações › Inteligência artificial (migração 026).
// O administrador liga/pausa a IA, escolhe usar os créditos do sistema ou a própria chave da Anthropic,
// compra créditos, escolhe o modelo, um teto mensal e quais recursos usam IA. O gerente só consulta.
// A chave nunca volta para o navegador: só aparecem os 4 últimos caracteres.
import { rpc, fn } from "./api.js";
import { html, render, $, $$, dinheiro, numero, toast, erro, modal, confirmar, ocupado, lerNumero, dataHora, data as fmtData } from "./ui.js";
import { icone } from "./icons.js";

/** Recursos do sistema que usam IA (o banco só aceita estes nomes). */
export const RECURSOS_IA = [
  { id: "pedido_voz", nome: "Pedido por voz", desc: "O garçom fala o pedido e a IA entende frases livres. Sem IA, o próprio aparelho entende (com menos precisão)." },
];
const NOME_RECURSO = Object.fromEntries(RECURSOS_IA.map((r) => [r.id, r.nome]));

export const ESTADOS_IA = {
  ativa: ["ok", "Ativa", "A IA está ajudando nos recursos ligados abaixo."],
  pausada: ["warn", "Pausada", "Tudo continua funcionando sem IA (o pedido por voz é entendido pelo próprio aparelho)."],
  bloqueada: ["danger", "Bloqueada pelo suporte", "Fale com o suporte para liberar."],
  sem_creditos: ["danger", "Sem créditos", "Os créditos acabaram. Compre mais para voltar a usar a IA."],
  limite: ["warn", "Teto do mês atingido", "A loja chegou ao teto de gasto que você definiu. Aumente o teto ou espere o próximo mês."],
  indisponivel: ["", "Indisponível", "A IA do sistema ainda não foi liberada. Você pode usar a sua própria chave da Anthropic."],
  sem_chave: ["warn", "Falta a chave", "Cadastre a sua chave da Anthropic abaixo ou volte para os créditos do sistema."],
};
const MODELOS = [["", "Padrão do sistema"], ["claude-haiku-5-5", "Rápido e econômico (Claude Haiku)"], ["claude-sonnet-5-5", "Mais preciso (Claude Sonnet)"]];
const nomeModelo = (m) => MODELOS.find(([k]) => k === m)?.[1] || m;
const curtoModelo = (m) => nomeModelo(m).replace(/ \(.*\)$/, "").toLowerCase();
const STATUS_COMPRA = { pendente: ["warn", "Aguardando pagamento"], pago: ["ok", "Pago"], cancelado: ["", "Cancelado"] };

export default async function iaConfig(destino) {
  // Contêiner próprio: os eventos não se acumulam quando a aba é aberta de novo
  const alvo = document.createElement("div");
  destino.replaceChildren(alvo);
  let s;
  try { s = await rpc("ia_status"); }
  catch (e) {
    if (/ia_status|function|does not exist/i.test(e.message)) return render(alvo, html`<div class="alerta warn">Falta atualizar o banco (migração <code>026_ia_simplificar.sql</code>) para usar a inteligência artificial.</div>`);
    throw e;
  }
  const pode = s.pode_editar;
  const dis = pode ? "" : "disabled";

  const desenhar = () => {
    const [tipo, nome, texto] = ESTADOS_IA[s.estado] || ["", s.estado, ""];
    const medio = Number(s.custo_medio) || 0;
    const pedidosRestantes = medio > 0 ? Math.floor(Number(s.disponivel) / medio) : null;
    render(alvo, html`<div class="stack-lg ia-cfg">
      <section class="panel panel-pad ia-estado">
        <div class="ia-estado-topo">
          <span class="ia-ic">${icone("lampada", 'width="26" height="26"')}</span>
          <div class="grow"><div class="row" style="gap:.5rem;align-items:center"><h2 style="margin:0">Inteligência artificial</h2><span class="badge ${tipo}">${nome}</span></div>
            <p class="muted small" style="margin:.25rem 0 0">${s.estado === "bloqueada" && s.bloqueio_motivo ? `${texto} Motivo: ${s.bloqueio_motivo}.` : texto}</p></div>
          ${pode && s.estado !== "bloqueada" ? html`<button class="btn ${s.ativo ? "" : "primary"}" data-a="${s.ativo ? "pausar" : "ativar"}">${s.ativo ? "Pausar" : "Ativar"}</button>` : ""}
        </div>
        <p class="hint" style="margin:0">Modelo em uso: ${nomeModelo(s.modelo || "")}${s.modelo ? "" : `: ${curtoModelo(s.modelo_padrao)}`}. ${s.chamadas_mes} ${s.chamadas_mes === 1 ? "uso" : "usos"} neste mês.</p>
      </section>

      <section class="panel panel-pad stack">
        <div><h2>De onde vem a IA</h2><p class="muted small">Escolha usar os créditos do sistema (mais simples) ou a sua própria conta da Anthropic.</p></div>
        <div class="ia-fontes">
          <label class="ia-fonte ${s.fonte === "sistema" ? "on" : ""}">
            <input type="radio" name="fonte" value="sistema" ${s.fonte === "sistema" ? "checked" : ""} ${dis}>
            <span class="grow"><strong>Créditos do sistema</strong>
              <small>Você compra créditos aqui e paga junto com a mensalidade. Sem cadastro em outro site.</small>
              ${s.sistema_disponivel ? html`<span class="ia-saldo">
                <span><b>${dinheiro(s.disponivel)}</b> disponível${pedidosRestantes != null ? html` · ≈ ${numero(pedidosRestantes)} usos` : ""}</span>
                <span class="small muted">${Number(s.franquia_mensal) ? `Franquia do mês ${dinheiro(s.franquia_restante)} de ${dinheiro(s.franquia_mensal)} · ` : ""}Créditos comprados ${dinheiro(s.creditos)} · Gasto no mês ${dinheiro(s.custo_mes)}</span>
              </span>
              ${pode ? html`<button type="button" class="btn sm primary" data-a="comprar" style="justify-self:start">${icone("mais", 'width="16" height="16"')} Comprar créditos</button>` : ""}`
              : html`<span class="small txt-alerta">A IA do sistema ainda não foi liberada pelo suporte.</span>`}
            </span>
          </label>
          <label class="ia-fonte ${s.fonte === "propria" ? "on" : ""}">
            <input type="radio" name="fonte" value="propria" ${s.fonte === "propria" ? "checked" : ""} ${s.tem_chave ? dis : "disabled"}>
            <span class="grow"><strong>Minha chave da Anthropic</strong>
              <small>A loja paga a Anthropic direto. Bom para quem já tem conta e usa muito.</small>
              ${s.tem_chave ? html`<span class="ia-chave">${icone("cadeado", 'width="15" height="15"')} <code>sk-ant-••••${s.chave_fim}</code>
                  <span class="small muted">${s.chave_validada_em ? `testada em ${dataHora(s.chave_validada_em)}` : ""}</span></span>
                ${s.fonte === "propria" ? html`<span class="small muted">Gasto estimado no mês: ${dinheiro(s.custo_mes_propria)}</span>` : ""}
                ${pode ? html`<span class="row wrap" style="gap:.4rem"><button type="button" class="btn sm" data-a="testar">Testar</button><button type="button" class="btn sm" data-a="trocar-chave">Trocar chave</button><button type="button" class="btn sm ghost" data-a="remover-chave">Remover</button></span>` : ""}`
              : pode ? html`<span class="row wrap" style="gap:.4rem"><button type="button" class="btn sm" data-a="trocar-chave">${icone("cadeado", 'width="15" height="15"')} Cadastrar chave</button></span>` : html`<span class="small muted">Nenhuma chave cadastrada.</span>`}
              <span class="small"><a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Criar chave</a> · <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener">Comprar créditos na Anthropic</a></span>
            </span>
          </label>
        </div>
      </section>

      <form class="panel panel-pad stack" id="f-ia">
        <div><h2>Preferências</h2></div>
        <div class="grid-2">
          <label class="field"><span>Modelo</span><select class="input" name="modelo" ${dis}>${MODELOS.map(([k, n]) => html`<option value="${k}" ${(s.modelo || "") === k ? "selected" : ""}>${n}${k === "" ? `: ${curtoModelo(s.modelo_padrao)}` : ""}</option>`)}</select>
            <small class="hint">O mais preciso custa mais por uso.</small></label>
          <label class="field"><span>Teto de gasto por mês (R$)</span><input class="input" name="limite_mensal" inputmode="decimal" placeholder="Sem teto" value="${s.limite_mensal ? String(s.limite_mensal).replace(".", ",") : ""}" ${dis}>
            <small class="hint">Ao chegar no teto, a IA pausa sozinha até o mês seguinte.</small></label>
        </div>
        <div class="field"><span>Usar IA em</span>
          ${RECURSOS_IA.map((r) => html`<label class="check"><input type="checkbox" data-recurso="${r.id}" ${s.recursos?.[r.id] === false ? "" : "checked"} ${dis}> <span><strong>${r.nome}</strong> <span class="muted small">${r.desc}</span></span></label>`)}</div>
        ${pode ? html`<div><button class="btn primary">Salvar preferências</button></div>` : html`<p class="hint">Só o administrador da loja altera estas opções.</p>`}
      </form>

      <section class="panel panel-pad stack">
        <div><h2>Uso neste mês</h2></div>
        ${s.por_recurso.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Recurso</th><th class="r">Usos</th><th class="r">Custo</th></tr></thead>
          <tbody>${s.por_recurso.map((u) => html`<tr><td>${NOME_RECURSO[u.recurso] || u.recurso}</td><td class="r">${numero(u.chamadas)}</td><td class="r">${dinheiro(u.custo)}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted">Nenhum uso de IA neste mês.</p>`}
        ${s.compras.length ? html`<h3 style="margin:.5rem 0 0">Compras de créditos</h3>
          <div class="ia-compras">${s.compras.map((c) => html`<div class="ia-compra">
            <strong>${dinheiro(c.valor)}</strong><span class="badge ${STATUS_COMPRA[c.status][0]}">${c.origem === "cortesia" ? "Cortesia" : STATUS_COMPRA[c.status][1]}</span>
            <span class="small muted grow">${fmtData(c.criado_em)}${c.status === "pendente" && c.creditado ? " · créditos já liberados" : ""}${c.status === "pendente" && c.vencimento ? ` · vence ${fmtData(c.vencimento + "T12:00")}` : ""}</span>
            ${c.status === "pendente" && c.link_pagamento ? html`<a class="btn sm primary" href="${c.link_pagamento}" target="_blank" rel="noopener">Pagar</a>` : ""}
            ${c.status === "pendente" && !c.link_pagamento ? html`<a class="btn sm" href="#/conta">Ver fatura</a>` : ""}
            ${pode && c.status === "pendente" && !c.creditado ? html`<button class="btn sm ghost" data-cancelar="${c.id}">Cancelar</button>` : ""}
          </div>`)}</div>` : ""}
      </section>
    </div>`);
  };

  const aplicar = async (dados, botao, msg) => {
    s = await ocupado(botao, () => rpc("ia_configurar", { p: dados }));
    if (msg) toast(msg, "ok");
    desenhar();
  };

  alvo.addEventListener("change", async (e) => {
    if (e.target.name !== "fonte" || !pode) return;
    try { await aplicar({ fonte: e.target.value }, null, e.target.value === "propria" ? "Usando a sua chave da Anthropic" : "Usando os créditos do sistema"); }
    catch (err) { erro(err); desenhar(); }
  });
  alvo.addEventListener("submit", async (e) => {
    if (e.target.id !== "f-ia") return;
    e.preventDefault();
    const f = e.target;
    const lim = f.limite_mensal.value.trim() ? lerNumero(f.limite_mensal.value) : null;
    if (lim != null && !(lim >= 0)) return toast("Teto inválido", "erro");
    const recursos = Object.fromEntries($$("[data-recurso]", f).map((c) => [c.dataset.recurso, c.checked]));
    try { await aplicar({ modelo: f.modelo.value, limite_mensal: lim, recursos }, f.querySelector("button.primary"), "Preferências salvas"); } catch (err) { erro(err); }
  });
  alvo.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.a === "pausar") {
        if (!(await confirmar("Pausar a inteligência artificial? Os recursos continuam funcionando sem IA.", { ok: "Pausar" }))) return;
        return aplicar({ ativo: false }, b, "IA pausada");
      }
      if (b.dataset.a === "ativar") return aplicar({ ativo: true }, b, "IA ativada");
      if (b.dataset.a === "comprar") return comprar();
      if (b.dataset.a === "trocar-chave") return cadastrarChave();
      if (b.dataset.a === "testar") {
        const r = await ocupado(b, () => fn("ia", { acao: "testar", escopo: "loja" }));
        if (r.ok) toast("A chave está funcionando ✓", "ok"); else toast(r.erro || "A chave não funcionou", "erro");
        s = await rpc("ia_status"); return desenhar();
      }
      if (b.dataset.a === "remover-chave") {
        if (!(await confirmar("Remover a sua chave da Anthropic? A loja volta a usar os créditos do sistema.", { ok: "Remover", perigo: true }))) return;
        s = await ocupado(b, () => rpc("ia_remover_chave")); toast("Chave removida", "ok"); return desenhar();
      }
      if (b.dataset.cancelar) {
        if (!(await confirmar("Cancelar esta compra de créditos? A fatura também é cancelada.", { ok: "Cancelar compra", perigo: true }))) return;
        await ocupado(b, () => rpc("ia_cancelar_compra", { p_id: b.dataset.cancelar }));
        s = await rpc("ia_status"); toast("Compra cancelada", "ok"); return desenhar();
      }
    } catch (err) { erro(err); }
  });

  async function cadastrarChave() {
    const ok = await modal({
      titulo: "Chave da Anthropic da loja",
      corpo: html`<form id="f-chave" class="stack">
        <p class="muted small" style="margin:0">Crie a chave em <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com › API Keys</a> e cole aqui. Ela é testada e guardada só no servidor: ninguém consegue ver de novo, nem você.</p>
        <label class="field"><span>Chave (começa com sk-ant-)</span><input class="input" name="chave" type="password" autocomplete="off" spellcheck="false" required autofocus></label>
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-chave">Testar e salvar</button>`,
      onPronto: (d, fechar) => (d.querySelector("form").onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          await ocupado(d.querySelector("button.primary"), () => fn("ia", { acao: "salvar_chave", escopo: "loja", chave: ev.target.chave.value.trim() }));
          fechar(true);
        } catch (err) { toast(err.message, "erro"); }
      }),
    });
    if (!ok) return;
    toast("Chave testada e salva ✓ A loja agora usa a própria conta da Anthropic.", "ok");
    s = await rpc("ia_status"); desenhar();
  }

  async function comprar() {
    const medio = Number(s.custo_medio) || 0;
    const valor = await modal({
      titulo: "Comprar créditos de IA",
      corpo: html`<div class="stack">
        <p class="muted small" style="margin:0">Os créditos são usados conforme a IA trabalha. ${s.credito_imediato ? "Eles entram na hora e a fatura vem para pagar." : "A fatura aparece em Minha assinatura; os créditos entram quando o pagamento for confirmado."}</p>
        <div class="ia-pacotes">${(s.pacotes || []).map((v) => html`<button class="ia-pacote" data-v="${v}"><strong>${dinheiro(v)}</strong>
          <small>${medio > 0 ? `≈ ${numero(Math.floor(Number(v) / medio))} usos` : "créditos de IA"}</small></button>`)}</div>
        ${medio > 0 ? html`<p class="hint" style="margin:0">Estimativa pelo custo médio desta loja: ${dinheiro(medio)} por uso.</p>` : ""}
      </div>`,
      onPronto: (d, fechar) => d.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => fechar(Number(b.dataset.v)))),
    });
    if (!valor) return;
    const r = await rpc("ia_comprar", { p_valor: valor });
    toast(r.creditado ? `${dinheiro(valor)} em créditos liberados ✓` : "Fatura gerada. Os créditos entram quando o pagamento for confirmado.", "ok");
    s = await rpc("ia_status"); desenhar();
  }

  desenhar();
}
