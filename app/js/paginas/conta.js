// Minha assinatura: área do cliente (dono da loja) com plano, próximo pagamento,
// faturas, pendências da loja e pacotes adicionais.
import { rpc } from "../api.js";
import { estado, eh, diasDeTeste } from "../estado.js";
import { html, raw, render, $, $$, dinheiro, data, dataHora, toast, erro, modal, confirmar, numero, urlSegura } from "../ui.js";
import { icone } from "../icons.js";
import { linkWhatsApp, MARCA, PRECOS } from "../config.js";
import { PLANOS, PACOTES, nomePlano, nomePacote } from "../pacotes.js";

const STATUS_SOL = { pendente: ["warn", "Aguardando aprovação"], aprovado: ["ok", "Aprovado"], recusado: ["danger", "Recusado"], cancelado: ["", "Cancelado"] };
const hojeISO = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const diasAte = (d) => Math.round((new Date(d + "T12:00:00") - new Date(hojeISO() + "T12:00:00")) / 864e5);
const dataBr = (d) => (d ? new Date(d + (d.length === 10 ? "T12:00:00" : "")).toLocaleDateString("pt-BR") : "—");

export default async function conta(el) {
  const admin = eh("admin");

  const zapSuporte = () => linkWhatsApp(`Olá! Sou da loja ${estado.empresa?.nome_fantasia || estado.empresa?.razao_social || ""} e quero renovar a licença.`);

  async function carregar() {
    const [a, baixo] = await Promise.all([rpc("minha_assinatura"), rpc("produtos_estoque_baixo").catch(() => [])]);
    desenhar(a, baixo || []);
  }

  function pendencias(a, baixo) {
    const e = estado.empresa, lista = [];
    const vencidas = a.faturas.filter((f) => f.status === "pendente" && diasAte(f.vencimento) < 0);
    if (vencidas.length) lista.push(["alta", "alerta", `${vencidas.length === 1 ? "1 fatura vencida" : `${vencidas.length} faturas vencidas`}`, `Total de ${dinheiro(vencidas.reduce((s, f) => s + Number(f.valor), 0))}. Regularize para evitar a suspensão das vendas.`, "#faturas", "Ver faturas"]);
    const prox = a.proxima_fatura;
    if (prox && diasAte(prox.vencimento) >= 0 && diasAte(prox.vencimento) <= 5) lista.push(["media", "calendario", `Mensalidade vence ${diasAte(prox.vencimento) === 0 ? "hoje" : `em ${diasAte(prox.vencimento)} dia(s)`}`, `${dinheiro(prox.valor)} · ${prox.descricao}`, "#faturas", "Pagar"]);
    if (a.status === "teste") {
      const d = diasDeTeste();
      lista.push([d <= 2 ? "alta" : "media", "relogio", d === 0 ? "Seu teste termina hoje" : `Faltam ${d} dia(s) de teste`, `${a.uso.vendas_mes} vendas feitas. Contrate um plano para não parar de vender — tudo continua de onde parou.`, "#planos", "Contratar"]);
    }
    if (a.bloqueio && a.status !== "teste") lista.push(["alta", "alerta", "Vendas pausadas", a.bloqueio, null, null]);
    // Licenças com prazo (021): vencidas ou vencendo em até 7 dias
    const NOMES_LIC = { pdv: "do sistema", delivery: "do delivery", garcom: "do app do garçom", fiscal: "da nota fiscal" };
    Object.entries(estado.conta?.licencas || {}).forEach(([m, l]) => {
      if (!l?.expira_em || m === "pdv" && a.bloqueio) return;
      const d = Math.ceil((new Date(l.expira_em) - Date.now()) / 864e5);
      if (!l.ok || d <= 0) lista.push(["alta", "alerta", `Licença ${NOMES_LIC[m] || m} vencida`, `Venceu em ${dataBr(l.expira_em)}. Fale com o suporte para renovar.`, zapSuporte(), zapSuporte() && "Renovar"]);
      else if (d <= 7) lista.push(["media", "calendario", `Licença ${NOMES_LIC[m] || m} vence ${d === 1 ? "amanhã" : `em ${d} dias`}`, `Válida até ${dataBr(l.expira_em)}.`, zapSuporte(), zapSuporte() && "Renovar"]);
    });
    if (!e.cnpj || !e.logradouro) lista.push(["info", "loja", "Dados da loja incompletos", "CNPJ e endereço aparecem no cupom e são obrigatórios para a nota fiscal.", "#/configuracoes/loja", "Completar"]);
    if (!e.pix_chave) lista.push(["info", "pix", "Chave PIX não cadastrada", "Com a chave, o caixa mostra o QR Code com o valor exato da venda.", "#/configuracoes/pix", "Cadastrar"]);
    if (["sistema_nota", "combo", "kit_compra"].includes(a.plano) && !estado.fiscal?.habilitado) lista.push(["info", "nota", "Nota fiscal não ativada", "Seu plano inclui NFC-e. Configure o certificado e o CSC.", "#/configuracoes/fiscal", "Configurar"]);
    if (baixo.length) lista.push(["media", "estoque", `${baixo.length} produto(s) com estoque baixo`, baixo.slice(0, 3).map((p) => p.nome).join(", ") + (baixo.length > 3 ? "…" : ""), "#/estoque", "Ver estoque"]);
    const pend = a.solicitacoes.filter((s) => s.status === "pendente");
    if (pend.length) lista.push(["info", "pacote", `${pend.length} pedido(s) de pacote em análise`, pend.map((s) => nomePacote(s.pacote)).join(", "), "#pacotes", "Ver"]);
    return lista;
  }

  function desenhar(a, baixo) {
    const plano = PLANOS[a.plano] || { nome: a.plano };
    const prox = a.proxima_fatura;
    const pend = pendencias(a, baixo);
    const teste = a.status === "teste";
    const dias = teste ? diasDeTeste() : null;
    const statusTxt = teste ? "Em teste" : { ativo: "Ativo", suspenso: "Suspenso", cancelado: "Cancelado" }[a.status] || a.status;
    const statusCls = teste ? "warn" : a.status === "ativo" ? "" : "danger";
    const zap = linkWhatsApp(`Olá! Sou da loja ${estado.empresa.nome_fantasia || estado.empresa.razao_social} e preciso de ajuda com a minha assinatura do ${MARCA}.`);
    const notasLimite = ["sistema_nota", "combo", "kit_compra"].includes(a.plano) ? 500 : null;
    const pacoteStatus = (id) => {
      if (id === "delivery" && a.delivery && a.status === "ativo" && (a.modulos?.delivery || a.plano === "interno")) return "ativo";
      if (id === "garcom" && a.garcom) return "ativo";
      if (id === "nota_fiscal" && notasLimite) return "ativo";
      if (a.solicitacoes.some((s) => s.pacote === id && s.status === "pendente")) return "pendente";
      return null;
    };

    render(el, html`<div class="page">
      <div class="page-head"><div><h1>Minha assinatura</h1><p>Seu plano, pagamentos, pendências da loja e pacotes adicionais.</p></div>
        <div class="acoes">${zap ? html`<a class="btn" href="${zap}" target="_blank" rel="noopener">${icone("whatsapp", 'width="18" height="18"')} Suporte</a>` : ""}</div></div>

      <div class="conta-hero">
        <div class="plano-card">
          <div class="pc-topo">
            <div><div class="pc-rot">Seu plano</div><div class="pc-nome">${plano.nome}</div></div>
            <span class="selo-status ${statusCls}">${statusTxt}</span>
          </div>
          ${teste ? html`<div><div class="pc-valor">${dias}<small> ${dias === 1 ? "dia restante" : "dias restantes"}</small></div>
              <div class="rank-barra" style="background:rgba(255,255,255,.18);margin-top:.6rem"><div style="width:${Math.min(100, ((7 - (dias ?? 7)) / 7) * 100)}%;background:#fff"></div></div></div>`
            : html`<div class="pc-valor">${a.valor_mensal ? dinheiro(a.valor_mensal) : "—"}<small>${a.valor_mensal ? " /mês" : ""}</small></div>`}
          <div class="pc-info">
            <span>${icone("calendario", 'width="15" height="15"')} ${teste ? `Teste até ${dataHora(a.teste_expira_em)}` : `Vencimento todo dia ${a.dia_vencimento}`}</span>
            <span>${icone("estrela", 'width="15" height="15"')} Cliente desde ${data(a.cliente_desde)}</span>
          </div>
          <div class="row wrap">
            ${admin ? html`<button class="btn ${teste ? "claro" : ""}" id="b-plano">${teste ? "Contratar um plano" : "Mudar de plano"}</button>` : ""}
            <a class="btn" href="#pacotes">Pacotes adicionais</a>
          </div>
        </div>

        <div class="panel prox-pag" id="faturas-topo">
          <div class="row"><div class="modulo-ic" style="width:40px;height:40px">${icone("assinatura", 'width="22" height="22"')}</div>
            <div><div class="small muted">Próximo pagamento</div><strong>${prox ? prox.descricao : teste ? "Nenhum durante o teste" : "Nenhuma fatura em aberto"}</strong></div></div>
          ${prox ? html`
            <div class="pp-valor">${dinheiro(prox.valor)}</div>
            <div class="pp-dias ${diasAte(prox.vencimento) < 0 ? "atrasado" : diasAte(prox.vencimento) <= 5 ? "perto" : "ok"}">
              ${diasAte(prox.vencimento) < 0 ? `Venceu há ${-diasAte(prox.vencimento)} dia(s) · ${dataBr(prox.vencimento)}` : diasAte(prox.vencimento) === 0 ? `Vence hoje · ${dataBr(prox.vencimento)}` : `Vence em ${diasAte(prox.vencimento)} dia(s) · ${dataBr(prox.vencimento)}`}</div>
            <div class="row wrap">
              ${prox.link_pagamento ? html`<a class="btn primary" href="${urlSegura(prox.link_pagamento)}" target="_blank" rel="noopener">Pagar agora</a>` : ""}
              ${prox.linha_digitavel ? html`<button class="btn" data-copiar="${prox.linha_digitavel}">Copiar código</button>` : ""}
              ${!prox.link_pagamento && !prox.linha_digitavel && zap ? html`<a class="btn primary" href="${linkWhatsApp(`Olá! Quero pagar a fatura "${prox.descricao}" de ${dinheiro(prox.valor)} da loja ${estado.empresa.nome_fantasia || estado.empresa.razao_social}.`)}" target="_blank" rel="noopener">Pedir link de pagamento</a>` : ""}
            </div>
            ${a.em_aberto.qtd > 1 ? html`<p class="hint">${a.em_aberto.qtd} faturas em aberto · ${dinheiro(a.em_aberto.valor)}</p>` : ""}`
          : html`<p class="muted small">${teste ? "Você só paga depois de contratar. Durante o teste nada é cobrado." : "Tudo pago. Obrigado!"}</p>
            <div class="pp-dias ok">${icone("check", 'width="16" height="16"')} Em dia</div>`}
        </div>
      </div>

      <div class="two-col" style="margin-bottom:1rem">
        <div class="panel"><div class="panel-head"><h2>Pendências</h2><span class="badge ${pend.some((p) => p[0] === "alta") ? "danger" : pend.length ? "warn" : "ok"}">${pend.length || "Nenhuma"}</span></div>
          <div class="panel-pad pendencias">
            ${pend.length ? pend.map(([nivel, ic, tit, sub, link, acao]) => html`<div class="pend ${nivel}"><div class="p-ic">${icone(ic)}</div>
              <div class="grow"><strong>${tit}</strong><small>${sub}</small></div>
              ${link ? html`<a class="btn sm" href="${link}" ${link === "#planos" ? raw('data-planos="1"') : ""} ${/^https:/.test(link) ? raw('target="_blank" rel="noopener"') : ""}>${acao}</a>` : ""}</div>`)
            : html`<div class="pend ok"><div class="p-ic">${icone("check")}</div><div class="grow"><strong>Tudo em dia</strong><small>Nenhuma pendência na sua loja.</small></div></div>`}
          </div></div>
        <div class="panel"><div class="panel-head"><h2>Uso neste mês</h2></div>
          <div class="panel-pad uso-grade">
            <div class="uso"><b>${dinheiro(a.uso.faturamento_mes)}</b><span>faturamento</span></div>
            <div class="uso"><b>${numero(a.uso.vendas_mes)}</b><span>vendas${teste ? " · limite 200 no teste" : ""}</span>${teste ? html`<div class="medidor"><div style="width:${Math.min(100, a.uso.vendas_mes / 2)}%"></div></div>` : ""}</div>
            <div class="uso"><b>${numero(a.uso.notas_mes)}</b><span>notas fiscais${notasLimite ? ` de ${notasLimite}` : ""}</span>${notasLimite ? html`<div class="medidor"><div style="width:${Math.min(100, (a.uso.notas_mes / notasLimite) * 100)}%"></div></div>` : ""}</div>
            <div class="uso"><b>${a.uso.usuarios}</b><span>usuários ativos${teste ? " · até 3 no teste" : ""}</span></div>
            <div class="uso"><b>${numero(a.uso.produtos)}</b><span>produtos</span></div>
            <div class="uso"><b>${a.uso.caixas_abertos}</b><span>caixas abertos agora</span></div>
          </div></div>
      </div>

      <div class="panel panel-pad stack" id="pacotes" style="margin-bottom:1rem">
        <div class="row wrap"><div class="grow"><h2>Pacotes adicionais</h2><p class="muted small">Peça aqui e nossa equipe ativa para você. ${admin ? "" : "Só o administrador da loja pode contratar."}</p></div></div>
        <div class="pacotes">${PACOTES.map((p) => {
          const s = pacoteStatus(p.id);
          const incluso = p.incluso && a.segmento === p.incluso;
          return html`<div class="pacote ${s === "ativo" || incluso ? "ativo-ja" : ""}">
            <div class="pk-ic" style="background:${p.cor}">${icone(p.icone)}</div>
            ${s === "ativo" || incluso ? html`<span class="badge ok pk-selo">${incluso ? "Incluso" : "Ativo"}</span>` : s === "pendente" ? html`<span class="badge warn pk-selo">Em análise</span>` : ""}
            <strong>${p.nome}</strong>
            <span class="small muted">${p.desc}</span>
            <div class="row" style="margin-top:auto">
              <span class="pk-preco grow">${p.sobConsulta ? html`<small>Sob consulta</small>` : p.preco != null ? html`${dinheiro(p.preco)} <small>${p.unidade || "/mês"}</small>` : html`<small>Consulte</small>`}</span>
              ${admin && !s && !incluso ? html`<button class="btn sm primary" data-pacote="${p.id}">Contratar</button>` : ""}
            </div></div>`; })}</div>
      </div>

      <div class="panel" id="faturas" style="margin-bottom:1rem"><div class="panel-head"><h2>Faturas</h2></div>
        ${a.faturas.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Descrição</th><th>Vencimento</th><th class="r">Valor</th><th>Situação</th><th></th></tr></thead>
          <tbody>${a.faturas.map((f) => {
            const venc = f.status === "pendente" && diasAte(f.vencimento) < 0;
            return html`<tr><td>${f.descricao}</td><td>${dataBr(f.vencimento)}</td><td class="r"><strong>${dinheiro(f.valor)}</strong></td>
              <td><span class="badge ${f.status === "pago" ? "ok" : venc ? "danger" : "warn"}">${f.status === "pago" ? `Paga em ${data(f.pago_em)}` : venc ? "Vencida" : "Em aberto"}</span></td>
              <td class="r">${f.status === "pendente" && f.link_pagamento ? html`<a class="btn sm" href="${urlSegura(f.link_pagamento)}" target="_blank" rel="noopener">Pagar</a>` : ""}
                ${f.status === "pendente" && f.linha_digitavel ? html`<button class="btn sm" data-copiar="${f.linha_digitavel}">Copiar código</button>` : ""}</td></tr>`; })}</tbody></table></div>`
        : html`<div class="empty"><p>${teste ? "As faturas aparecem aqui depois que você contratar um plano." : "Nenhuma fatura ainda."}</p></div>`}
      </div>

      ${a.solicitacoes.length ? html`<div class="panel"><div class="panel-head"><h2>Meus pedidos</h2></div><div class="table-wrap"><table class="table">
        <thead><tr><th>Quando</th><th>Pedido</th><th>Situação</th><th>Resposta</th><th></th></tr></thead>
        <tbody>${a.solicitacoes.map((s) => html`<tr><td class="small">${dataHora(s.created_at)}</td>
          <td>${nomePacote(s.pacote)}${s.quantidade > 1 ? ` × ${s.quantidade}` : ""}${s.detalhes ? html`<div class="small muted">${s.detalhes}</div>` : ""}</td>
          <td><span class="badge ${STATUS_SOL[s.status][0]}">${STATUS_SOL[s.status][1]}</span></td><td class="small">${s.resposta || ""}</td>
          <td class="r">${admin && s.status === "pendente" ? html`<button class="btn sm ghost" data-cancelar="${s.id}">Cancelar</button>` : ""}</td></tr>`)}</tbody></table></div></div>` : ""}
    </div>`);

    $$("[data-copiar]", el).forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copiar); toast("Código copiado", "ok"); } catch { toast("Não foi possível copiar", "erro"); } }));
    $$("[data-pacote]", el).forEach((b) => (b.onclick = () => pedirPacote(PACOTES.find((p) => p.id === b.dataset.pacote), a)));
    $$("[data-cancelar]", el).forEach((b) => (b.onclick = async () => {
      if (!(await confirmar("Cancelar este pedido?", { ok: "Cancelar pedido", perigo: true }))) return;
      try { await rpc("cancelar_solicitacao_pacote", { p_id: b.dataset.cancelar }); toast("Pedido cancelado", "ok"); carregar(); } catch (x) { erro(x); }
    }));
    $$('a[href^="#"]:not([href^="#/"])', el).forEach((l) => (l.onclick = (ev) => {
      ev.preventDefault();
      if (l.dataset.planos) return escolherPlano(a);
      el.querySelector(l.getAttribute("href"))?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    $("#b-plano", el)?.addEventListener("click", () => escolherPlano(a));
  }

  async function pedirPacote(p, a) {
    const r = await modal({
      titulo: p.nome,
      corpo: html`<form id="f-pac" class="stack">
        <div class="row" style="align-items:flex-start"><div class="pacote" style="padding:0;border:0;background:none"><div class="pk-ic" style="background:${p.cor}">${icone(p.icone)}</div></div>
          <p class="grow">${p.desc}</p></div>
        ${p.quantidade ? html`<label class="field"><span>Quantidade</span><input class="input" name="qtd" type="number" min="1" max="20" value="1"></label>` : ""}
        <div class="alerta info">${p.sobConsulta ? "Vamos entrar em contato com o orçamento antes de ativar." : p.preco != null ? html`Valor: <strong>${dinheiro(p.preco)}</strong> ${p.unidade || "por mês"}${p.recorrente && a.status === "ativo" ? ", somado à sua mensalidade depois da aprovação" : ""}.` : "Vamos confirmar o valor com você antes de ativar."}</div>
        <label class="field"><span>Observação (opcional)</span><textarea class="input" name="obs" maxlength="500" placeholder="Algo que precisamos saber?"></textarea></label>
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-pac">Enviar pedido</button>`,
      onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (ev) => { ev.preventDefault(); const f = ev.target; fechar({ qtd: Number(f.qtd?.value || 1), obs: f.obs.value }); }; },
    });
    if (!r) return;
    try { await rpc("solicitar_pacote", { p_pacote: p.id, p_quantidade: r.qtd, p_detalhes: r.obs || null }); toast("Pedido enviado! Nossa equipe vai ativar em breve.", "ok"); carregar(); }
    catch (x) { erro(x); }
  }

  async function escolherPlano(a) {
    if (!eh("admin")) return toast("Só o administrador da loja pode mudar o plano", "erro");
    const opcoes = ["sistema", "sistema_nota", "combo"];
    const escolhido = await modal({
      titulo: a.status === "teste" ? "Contratar um plano" : "Mudar de plano",
      largo: true,
      corpo: html`<div class="pacotes">${opcoes.map((k) => html`<div class="pacote ${a.plano === k ? "ativo-ja" : ""}">
          ${k === "combo" ? html`<span class="badge info pk-selo">Mais escolhido</span>` : ""}
          <strong style="font-size:1.1rem">${PLANOS[k].nome}</strong><span class="small muted">${PLANOS[k].desc}</span>
          <div class="pk-preco" style="font-size:1.4rem">${dinheiro(PLANOS[k].preco)} <small>/mês</small></div>
          ${k === "combo" && a.status === "teste" ? html`<span class="small" style="color:var(--ok)">${dinheiro(PRECOS.comboPromo)} nos 3 primeiros meses contratando no teste</span>` : ""}
          ${a.plano === k ? html`<span class="badge ok">Seu plano</span>` : html`<button class="btn primary" data-plano="${k}">Escolher</button>`}</div>`)}</div>
        <p class="hint" style="margin-top:1rem">Ao escolher, nossa equipe confirma pelo WhatsApp e ativa o plano. Nada muda nos seus dados.</p>`,
      onPronto: (d, fechar) => d.querySelectorAll("[data-plano]").forEach((b) => (b.onclick = () => fechar(b.dataset.plano))),
    });
    if (!escolhido) return;
    try { await rpc("solicitar_pacote", { p_pacote: "plano_" + escolhido, p_quantidade: 1, p_detalhes: null }); toast(`Pedido do plano ${nomePlano(escolhido)} enviado!`, "ok"); carregar(); }
    catch (x) { erro(x); }
  }

  await carregar();
}
