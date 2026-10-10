// Central de suporte (equipe da plataforma; abas extras só para o superusuário).
//  Lojas     → saúde de cada loja e "Entrar na loja" (modo suporte)
//  Chamados  → pedidos de ajuda com código de 6 números, ao vivo
//  Acessos   → histórico de quem entrou em qual loja, quando e por quê
//  Registro  → tudo o que a equipe fez (imutável)
//  Ajuda     → o que os clientes procuram na Central de Ajuda e não acham (024)
//  Avisos    → mensagens para todas as lojas, um setor ou uma loja (superusuário)
//  Equipe    → quem é suporte e quem é superusuário (superusuário)
import { rpc, sb } from "../api.js";
import { estado, ehSuper } from "../estado.js";
import { html, render, $, $$, dataHora, toast, erro, modal, confirmar, debounce, formatarDoc, numero } from "../ui.js";
import { icone } from "../icons.js";
import { entrarNaLoja, sairDaLoja, NOME_STATUS } from "../suporte.js";

const CONTA = { teste: ["warn", "Teste"], ativo: ["ok", "Ativo"], suspenso: ["danger", "Suspenso"], cancelado: ["", "Cancelado"] };
const SEGMENTOS = [["", "Todos os setores"], ["padaria", "Padaria"], ["mercado", "Mercado"], ["mercadinho", "Mercadinho"], ["supermercado", "Supermercado"], ["lanchonete", "Lanchonete"], ["cafe", "Café"], ["restaurante", "Restaurante"]];
const PAPEIS_AVISO = [["admin", "Administrador"], ["gerente", "Gerente"], ["caixa", "Caixa"], ["atendente", "Garçom"], ["cozinha", "Cozinha"]];
const TIPOS = { info: ["info", "Informação"], novidade: ["ok", "Novidade"], alerta: ["warn", "Alerta"], manutencao: ["danger", "Manutenção"] };
const ACAO_LOG = {
  "suporte.entrar": "Entrou na loja", "suporte.sair": "Saiu da loja", "suporte.modo": "Trocou o modo", "suporte.estender": "Estendeu o acesso",
  "chamado.atender": "Atendeu chamado", "chamado.resolver": "Resolveu chamado", "aviso.salvar": "Salvou aviso", "aviso.excluir": "Excluiu aviso",
  "equipe.salvar": "Alterou a equipe", "equipe.remover": "Removeu da equipe",
};

const relativo = (d) => {
  if (!d) return "—";
  const s = Math.round((Date.now() - new Date(d)) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
};
const zap = (n) => { const d = String(n || "").replace(/\D/g, ""); return d.length >= 10 ? `https://wa.me/${d.startsWith("55") ? d : "55" + d}` : null; };
const paraLocal = (d) => d ? new Date(new Date(d) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "";

export default async function central(el) {
  const sup = ehSuper();
  let aba = "lojas";
  const abas = [["lojas", "Lojas"], ["chamados", "Chamados"], ["acessos", "Acessos às lojas"], ["registro", "Registro"], ["ajuda", "Ajuda"],
    ...(sup ? [["avisos", "Avisos"], ["equipe", "Equipe"]] : [])];

  render(el, html`<div class="page" style="max-width:1400px">
    <div class="page-head"><div><h1>Central de suporte</h1>
      <p>${sup ? "Superusuário" : "Equipe de suporte"} · ${estado.equipe?.nome || ""}. Entre na loja de qualquer cliente, atenda chamados e acompanhe tudo o que a equipe fez.</p></div></div>
    ${estado.suporte ? html`<div class="alerta info" style="margin-bottom:1rem;display:flex;gap:.75rem;align-items:center">
      <span class="grow">Você está dentro da loja <strong>${estado.suporte.loja}</strong> em modo suporte.</span>
      <button class="btn sm" id="sair-loja">${icone("sair", 'width="16" height="16"')} Sair da loja</button></div>` : ""}
    <div class="tabs">${abas.map(([k, n]) => html`<button data-aba="${k}" class="${k === aba ? "ativo" : ""}">${n}${k === "chamados" ? html` <span class="badge warn" id="n-ch" hidden></span>` : ""}</button>`)}</div>
    <div id="corpo"></div></div>`);
  $("#sair-loja", el)?.addEventListener("click", sairDaLoja);
  $$(".tabs button", el).forEach((b) => (b.onclick = () => { aba = b.dataset.aba; $$(".tabs button", el).forEach((x) => x.classList.toggle("ativo", x === b)); desenhar(); }));

  const desenhar = async () => {
    const corpo = $("#corpo", el);
    render(corpo, html`<div class="loading"><div class="spinner"></div></div>`);
    try { await ({ lojas, chamados, acessos, registro, ajuda, avisos, equipe })[aba](corpo); }
    catch (e) { erro(e); render(corpo, html`<div class="alerta">${/suporte_|chamado_|equipe_|avisos_|super_log/.test(e.message) ? "Rode a migração 020_superusuario.sql no Supabase." : e.message}</div>`); }
  };

  // Contador de chamados na aba (atualizado pelo aviso em tempo real)
  const contarChamados = (lista) => { const n = (lista || []).filter((c) => c.status === "aguardando").length; const b = $("#n-ch", el); if (b) { b.hidden = !n; b.textContent = n; } };
  const aoChamado = (e) => { contarChamados(e.detail); if (aba === "chamados") desenhar(); };
  window.addEventListener("chamados", aoChamado);
  rpc("chamado_fila", { p_horas: 3 }).then(contarChamados).catch(() => {});

  // ================= Lojas =================
  let busca = "", filtroLoja = "todas", cacheLojas = null;
  async function lojas(corpo) {
    cacheLojas = await rpc("suporte_lojas", { p_busca: null });
    render(corpo, html`
      <div class="toolbar">
        <input class="input" id="busca-loja" placeholder="Nome, cidade, CNPJ ou telefone…" style="max-width:340px" value="${busca}">
        <div class="periodos" id="f-loja">${[["todas", "Todas"], ["problemas", "Com problema"], ["ajuda", "Pedindo ajuda"], ["inativas", "Sem uso há 3 dias"]].map(([k, n]) => html`<button data-f="${k}" class="${filtroLoja === k ? "ativo" : ""}">${n}</button>`)}</div>
        <span class="grow"></span><span class="muted small" id="n-lojas"></span>
      </div>
      <div class="panel" id="lista-lojas"></div>`);
    const b = $("#busca-loja", corpo);
    b.oninput = debounce(() => { busca = b.value; listar(); }, 150);
    $$("#f-loja button", corpo).forEach((x) => (x.onclick = () => { filtroLoja = x.dataset.f; $$("#f-loja button", corpo).forEach((y) => y.classList.toggle("ativo", y === x)); listar(); }));
    listar();
    b.focus();
  }
  function listar() {
    const alvo = $("#lista-lojas", el); if (!alvo) return;
    const t = busca.trim().toLowerCase(), dig = t.replace(/\D/g, "");
    const lista = cacheLojas.filter((l) => {
      if (t && !(`${l.loja} ${l.razao_social} ${l.municipio || ""} ${l.slug || ""}`.toLowerCase().includes(t)
        || (dig.length >= 4 && (String(l.cnpj || "").replace(/\D/g, "").includes(dig) || String(l.telefone || "").replace(/\D/g, "").includes(dig))))) return false;
      if (filtroLoja === "problemas") return l.erros_24h > 0 || l.bloqueio || l.suspeitas > 0;
      if (filtroLoja === "ajuda") return l.pedidos_ajuda > 0;
      if (filtroLoja === "inativas") return !l.ultima_atividade || Date.now() - new Date(l.ultima_atividade) > 3 * 864e5;
      return true;
    });
    $("#n-lojas", el).textContent = `${lista.length} de ${cacheLojas.length} lojas`;
    render(alvo, lista.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Loja</th><th>Situação</th><th class="r">Vendas hoje</th><th>Última atividade</th><th>Sinais</th><th></th></tr></thead>
      <tbody>${lista.map((l) => html`<tr>
        <td><strong>${l.loja}</strong>${estado.suporte?.empresa_id === l.id ? html` <span class="badge info">você está aqui</span>` : ""}
          <div class="small muted">${[l.segmento, [l.municipio, l.uf].filter(Boolean).join("/"), l.cnpj && formatarDoc(l.cnpj)].filter(Boolean).join(" · ")}</div></td>
        <td><span class="badge ${CONTA[l.status_conta]?.[0] || ""}">${CONTA[l.status_conta]?.[1] || l.status_conta}</span>
          ${l.bloqueio ? html`<div class="small" style="color:var(--danger)">${l.bloqueio.slice(0, 60)}</div>` : ""}</td>
        <td class="r">${numero(l.vendas_hoje)}<div class="small muted">${l.caixas_abertos} caixa(s) aberto(s)</div></td>
        <td class="small">${relativo(l.ultima_atividade)}<div class="muted">${l.usuarios} usuário(s)</div></td>
        <td class="small"><div class="sinais">
          ${l.pedidos_ajuda ? html`<span class="badge warn">${icone("headset", 'width="13" height="13"')} ${l.pedidos_ajuda} pedindo ajuda</span>` : ""}
          ${l.erros_24h ? html`<span class="badge danger">${l.erros_24h} erro(s) graves 24h</span>` : ""}
          ${l.suspeitas ? html`<span class="badge warn">${l.suspeitas} aviso(s) de aparelho</span>` : ""}
          ${!l.pedidos_ajuda && !l.erros_24h && !l.suspeitas ? html`<span class="muted">—</span>` : ""}</div></td>
        <td class="r" style="white-space:nowrap">
          ${zap(l.telefone) ? html`<a class="btn sm ghost" href="${zap(l.telefone)}" target="_blank" rel="noopener" title="WhatsApp da loja">${icone("whatsapp", 'width="16" height="16"')}</a>` : ""}
          <button class="btn sm primary" data-entrar="${l.id}">${icone("entrar", 'width="16" height="16"')} Entrar</button></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma loja encontrada.</p></div>`);
    $$("[data-entrar]", alvo).forEach((x) => (x.onclick = () => entrarNaLoja(cacheLojas.find((l) => l.id === x.dataset.entrar))));
  }

  // ================= Chamados =================
  async function chamados(corpo) {
    const lista = await rpc("chamado_fila", { p_horas: 72 });
    contarChamados(lista);
    render(corpo, html`
      <div class="toolbar">
        <form id="f-cod" class="row" style="gap:.5rem">
          <input class="input cod-input" name="cod" inputmode="numeric" maxlength="7" placeholder="Código do cliente" aria-label="Código de 6 números">
          <button class="btn primary">Atender pelo código</button></form>
        <span class="grow"></span><span class="muted small">Atualiza sozinho quando chega chamado novo.</span>
      </div>
      <div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Código</th><th>Quando</th><th>Loja · pessoa</th><th>Problema</th><th>Situação</th><th></th></tr></thead>
        <tbody>${lista.map((c) => html`<tr class="${c.status === "aguardando" ? "linha-destaque" : ""}">
          <td><strong class="cod-mini">${c.codigo}</strong><div class="small muted">${c.app === "garcom" ? "App do garçom" : "Sistema"}</div></td>
          <td class="small">${dataHora(c.criado_em)}<div class="muted">${relativo(c.criado_em)}</div></td>
          <td><strong>${c.loja}</strong><div class="small muted">${c.usuario_nome || "Sem login"}${c.contato ? ` · ${c.contato}` : ""}</div></td>
          <td class="small" style="max-width:360px">${c.mensagem || html`<span class="muted">—</span>`}
            ${c.info?.rota ? html`<div class="muted">Tela: ${c.info.rota}${c.info.online === false ? " · sem internet" : ""}</div>` : ""}
            ${c.info?.anexos?.length ? html`<div class="muted">${icone("clipe", 'width="13" height="13"')} ${c.info.anexos.length} anexo(s)</div>` : ""}
            ${c.info?.problema_reconhecido ? html`<div class="muted">Reconhecido: ${c.info.problema_reconhecido}</div>` : ""}
            ${c.nota ? html`<div style="margin-top:.25rem">✔ ${c.nota}</div>` : ""}</td>
          <td><span class="badge ${c.status === "aguardando" ? "warn" : c.status === "em_atendimento" ? "info" : c.status === "resolvido" ? "ok" : ""}">${NOME_STATUS[c.status] || c.status}</span>
            ${c.atendido_nome ? html`<div class="small muted">${c.atendido_nome}</div>` : ""}</td>
          <td class="r" style="white-space:nowrap">
            ${zap(c.contato) ? html`<a class="btn sm ghost" href="${zap(c.contato)}" target="_blank" rel="noopener" title="WhatsApp">${icone("whatsapp", 'width="16" height="16"')}</a>` : ""}
            ${["aguardando", "em_atendimento"].includes(c.status) ? html`
              <button class="btn sm primary" data-ch="atender" data-id="${c.id}">${c.status === "aguardando" ? "Atender" : "Abrir"}</button>
              <button class="btn sm" data-ch="resolver" data-id="${c.id}">Resolvido</button>` : ""}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Nenhum chamado nos últimos 3 dias. Os clientes abrem chamados em “Pedir ajuda” (menu lateral, diagnóstico ou app do garçom).</p></div>`}</div>`);
    $("#f-cod", corpo).onsubmit = (e) => { e.preventDefault(); atender({ p_codigo: e.target.cod.value }); };
    $$("[data-ch]", corpo).forEach((b) => (b.onclick = () => b.dataset.ch === "atender" ? atender({ p_id: b.dataset.id }) : resolver(lista.find((c) => c.id === b.dataset.id))));
  }

  async function atender(param) {
    let c;
    try { c = await rpc("chamado_atender", { p_id: null, p_codigo: null, ...param }); } catch (e) { return erro(e); }
    desenhar();
    const acao = await modal({
      titulo: `Chamado ${c.codigo}`,
      corpo: html`<div class="stack">
        <div class="linha-valor"><span>Loja</span><strong>${c.loja}</strong></div>
        <div class="linha-valor"><span>Pessoa</span><strong>${c.usuario_nome || "Sem login"}</strong></div>
        ${c.contato ? html`<div class="linha-valor"><span>Contato</span><strong>${c.contato}</strong></div>` : ""}
        <div class="alerta info">${c.mensagem || "Sem descrição"}</div>
        ${c.info?.problema_reconhecido ? html`<div class="linha-valor"><span>A Ajuda reconheceu</span><strong>${c.info.problema_reconhecido}</strong></div>` : ""}
        ${c.info?.busca ? html`<div class="linha-valor"><span>Procurou na Ajuda</span><strong>${c.info.busca}</strong></div>` : ""}
        ${c.info?.anexos?.length ? html`<div><strong class="small">Anexos</strong><div class="anexos-ch" id="ch-anexos">${c.info.anexos.map((a, i) => html`<div class="anexo-ch" data-i="${i}">
          <span class="spinner" style="width:18px;height:18px;border-width:2px"></span><span>${a.nome}</span></div>`)}</div></div>` : ""}
        ${c.info?.texto_lido ? html`<details><summary class="small">Texto lido do print</summary><pre class="small" style="white-space:pre-wrap;margin:.5rem 0 0;max-height:200px;overflow:auto">${c.info.texto_lido}</pre></details>` : ""}
        ${c.info ? html`<details><summary class="small">Detalhes do aparelho</summary><pre class="small" style="white-space:pre-wrap;margin:.5rem 0 0">${JSON.stringify(c.info, null, 2)}</pre></details>` : ""}
        ${c.empresa_id ? "" : html`<p class="small muted">A pessoa pediu ajuda sem estar logada (ex.: não consegue entrar). Procure a loja na aba Lojas ou fale pelo contato.</p>`}
      </div>`,
      rodape: html`${zap(c.contato) ? html`<a class="btn" href="${zap(c.contato)}" target="_blank" rel="noopener">${icone("whatsapp", 'width="18" height="18"')} WhatsApp</a>` : ""}
        <button class="btn" data-fechar>Fechar</button>
        ${c.empresa_id ? html`<button class="btn primary" id="ch-entrar">${icone("entrar", 'width="18" height="18"')} Entrar na loja</button>` : ""}`,
      onPronto: (d, fechar) => {
        d.querySelector("#ch-entrar")?.addEventListener("click", () => fechar("entrar"));
        mostrarAnexos(d, c.info?.anexos || []);
      },
    });
    if (acao === "entrar") entrarNaLoja({ id: c.empresa_id, loja: c.loja }, { chamado: c });
  }

  async function resolver(c) {
    const nota = await modal({
      titulo: `Resolver chamado ${c.codigo}`,
      corpo: html`<form id="f-res" class="stack"><label class="field"><span>O que foi feito (o cliente vê)</span>
        <textarea class="input" name="nota" rows="3" maxlength="1000" placeholder="Ex.: impressora reinstalada e testada"></textarea></label></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-res">Marcar resolvido</button>`,
      onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); fechar(e.target.nota.value.trim() || "Resolvido"); }; },
    });
    if (!nota) return;
    try { await rpc("chamado_resolver", { p_id: c.id, p_nota: nota }); toast("Chamado resolvido", "ok"); desenhar(); } catch (e) { erro(e); }
  }

  // ================= Acessos às lojas =================
  async function acessos(corpo) {
    const lista = await rpc("suporte_sessoes", { p_dias: 60, p_empresa: null });
    render(corpo, html`<div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Início</th><th>Quem</th><th>Loja</th><th>Modo</th><th>Motivo</th><th>Duração</th></tr></thead>
      <tbody>${lista.map((s) => {
        const fim = s.encerrado_em || (s.aberta ? new Date().toISOString() : s.expira_em);
        const min = Math.max(1, Math.round((new Date(fim) - new Date(s.inicio)) / 6e4));
        return html`<tr><td class="small">${dataHora(s.inicio)}</td><td>${s.quem}</td><td><strong>${s.loja}</strong></td>
          <td><span class="badge ${s.modo === "total" ? "warn" : "info"}">${s.modo === "total" ? "Total" : "Leitura"}</span></td>
          <td class="small">${s.motivo}</td>
          <td class="small">${s.aberta ? html`<span class="badge ok">aberto</span>` : `${min} min`}${s.encerrado_motivo ? html`<div class="muted">${s.encerrado_motivo}</div>` : ""}</td></tr>`; })}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhum acesso às lojas nos últimos 60 dias.</p></div>`}</div>`);
  }

  // ================= Registro do superusuário =================
  let buscaLog = "";
  async function registro(corpo) {
    const lista = await rpc("super_log", { p_limite: 500, p_empresa: null, p_busca: buscaLog || null });
    render(corpo, html`
      <div class="toolbar"><input class="input" id="busca-log" placeholder="Filtrar por loja, ação ou pessoa…" style="max-width:340px" value="${buscaLog}">
        <span class="grow"></span><span class="muted small">${sup ? "Toda a equipe" : "Só as suas ações"} · não pode ser apagado</span></div>
      <div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Quando</th><th>Quem</th><th>O que</th><th>Loja</th><th>Detalhes</th></tr></thead>
        <tbody>${lista.map((l) => html`<tr><td class="small">${dataHora(l.criado_em)}</td><td>${l.nome || l.email}</td>
          <td>${ACAO_LOG[l.acao] || l.acao}</td><td>${l.loja || html`<span class="muted">—</span>`}</td>
          <td class="small muted">${Object.entries(l.detalhes || {}).filter(([, v]) => v != null && typeof v !== "object").map(([k, v]) => `${k}: ${v}`).join(" · ")}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Nada registrado ainda.</p></div>`}</div>`);
    const b = $("#busca-log", corpo);
    b.onchange = () => { buscaLog = b.value.trim(); desenhar(); };
  }

  // ================= Ajuda: o que os clientes procuram (024) =================
  let diasAjuda = 30;
  async function ajuda(corpo) {
    let r;
    try { r = await rpc("ajuda_relatorio", { p_dias: diasAjuda }); }
    catch (e) { render(corpo, html`<div class="alerta">${/ajuda_relatorio|function/.test(e.message) ? "Rode a migração 024_central_ajuda.sql no Supabase." : e.message}</div>`); return; }
    const { porId } = await import("../ajuda/busca.js");
    const tituloArt = (id) => porId(id)?.titulo || id;
    render(corpo, html`
      <div class="toolbar"><select class="input" id="dias-ajuda" style="max-width:200px">${[7, 30, 90, 365].map((d) => html`<option value="${d}" ${d === diasAjuda ? "selected" : ""}>Últimos ${d} dias</option>`)}</select>
        <span class="grow"></span><span class="muted small">A Central de Ajuda responde com os artigos de app/js/ajuda/artigos.js. Use esta lista para escrever o que falta.</span></div>
      <div class="kpis">
        <div class="panel kpi"><div class="k-label">Buscas</div><div class="k-valor">${numero(r.buscas)}</div><div class="k-sub">${numero(r.pessoas)} pessoas usaram a Ajuda</div></div>
        <div class="panel kpi"><div class="k-label">Sem resposta</div><div class="k-valor">${numero(r.sem_resultado_total)}</div>
          <div class="k-sub">${r.buscas ? Math.round((r.sem_resultado_total / r.buscas) * 100) : 0}% das buscas</div></div>
        <div class="panel kpi"><div class="k-label">Por nível</div><div class="k-sub" style="font-size:var(--fs-sm)">${Object.entries(r.por_papel || {}).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}</div></div>
      </div>
      <div class="ajuda-rel-grid" style="margin-top:1rem">
        <div class="panel"><h3 style="padding:.9rem 1rem 0">Procuraram e não acharam</h3>${r.sem_resultado.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>O que escreveram</th><th class="r">Vezes</th><th class="r">Lojas</th></tr></thead>
          <tbody>${r.sem_resultado.map((x) => html`<tr><td>${x.termo}</td><td class="r">${x.vezes}</td><td class="r">${x.lojas}</td></tr>`)}</tbody></table></div>`
          : html`<div class="empty"><p>Nenhuma busca sem resposta. 🎉</p></div>`}</div>
        <div class="panel"><h3 style="padding:.9rem 1rem 0">Artigos (aberturas e “isso ajudou?”)</h3>${r.artigos.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Artigo</th><th class="r">Aberto</th><th class="r">Ajudou</th><th class="r">Não ajudou</th></tr></thead>
          <tbody>${r.artigos.map((x) => html`<tr class="${x.nao_ajudou > x.ajudou ? "linha-destaque" : ""}"><td><a href="#/ajuda/a/${x.artigo}">${tituloArt(x.artigo)}</a></td>
            <td class="r">${x.aberturas}</td><td class="r">${x.ajudou}</td><td class="r">${x.nao_ajudou}</td></tr>`)}</tbody></table></div>`
          : html`<div class="empty"><p>Nenhum artigo aberto no período.</p></div>`}</div>
        <div class="panel"><h3 style="padding:.9rem 1rem 0">Mais procurados</h3>${r.mais_buscados.length ? html`<div class="table-wrap"><table class="table">
          <tbody>${r.mais_buscados.map((x) => html`<tr><td><a href="#/ajuda/q/${encodeURIComponent(x.termo)}">${x.termo}</a></td><td class="r">${x.vezes}</td></tr>`)}</tbody></table></div>`
          : html`<div class="empty"><p>Sem buscas no período.</p></div>`}</div>
      </div>`);
    $("#dias-ajuda", corpo).onchange = (e) => { diasAjuda = +e.target.value; desenhar(); };
  }

  // ================= Avisos (superusuário) =================
  async function avisos(corpo) {
    const lista = await rpc("avisos_listar");
    render(corpo, html`
      <div class="toolbar"><span class="muted small">Aparecem no topo do sistema das lojas escolhidas, entre o início e o fim.</span><span class="grow"></span>
        <button class="btn primary" id="novo-aviso">${icone("mais", 'width="18" height="18"')} Novo aviso</button></div>
      <div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Aviso</th><th>Para</th><th>Período</th><th>Situação</th><th></th></tr></thead>
        <tbody>${lista.map((a) => html`<tr>
          <td><span class="badge ${TIPOS[a.tipo]?.[0]}">${TIPOS[a.tipo]?.[1]}</span> <strong>${a.titulo}</strong><div class="small muted">${a.mensagem}</div></td>
          <td class="small">${a.loja || "Todas as lojas"}${a.segmento ? ` · ${a.segmento}` : ""}${a.papeis?.length ? html`<div class="muted">${a.papeis.join(", ")}</div>` : ""}</td>
          <td class="small">${dataHora(a.inicio)}<div class="muted">${a.fim ? "até " + dataHora(a.fim) : "sem fim"}</div></td>
          <td>${a.no_ar ? html`<span class="badge ok">No ar</span>` : a.ativo ? html`<span class="badge">Agendado/encerrado</span>` : html`<span class="badge">Desligado</span>`}${a.fixo ? html` <span class="badge warn">fixo</span>` : ""}</td>
          <td class="r" style="white-space:nowrap"><button class="btn sm" data-av="editar" data-id="${a.id}">Editar</button>
            <button class="btn sm ghost" data-av="excluir" data-id="${a.id}">${icone("lixo", 'width="16" height="16"')}</button></td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Nenhum aviso. Use para avisar manutenção, novidades ou instabilidades.</p></div>`}</div>`);
    $("#novo-aviso", corpo).onclick = () => editarAviso({});
    $$("[data-av]", corpo).forEach((b) => (b.onclick = async () => {
      const a = lista.find((x) => x.id === b.dataset.id);
      if (b.dataset.av === "editar") return editarAviso(a);
      if (!(await confirmar(`Excluir o aviso “${a.titulo}”?`, { perigo: true, ok: "Excluir" }))) return;
      try { await rpc("aviso_excluir", { p_id: a.id }); toast("Aviso excluído", "ok"); desenhar(); } catch (e) { erro(e); }
    }));
  }

  async function editarAviso(a) {
    const lojasLista = cacheLojas || await rpc("suporte_lojas", { p_busca: null }).catch(() => []);
    const r = await modal({
      titulo: a.id ? "Editar aviso" : "Novo aviso", largo: true,
      corpo: html`<form id="f-av" class="stack">
        <div class="grid-2"><label class="field"><span>Título</span><input class="input" name="titulo" required maxlength="120" value="${a.titulo || ""}"></label>
          <label class="field"><span>Tipo</span><select class="input" name="tipo">${Object.entries(TIPOS).map(([k, [, n]]) => html`<option value="${k}" ${a.tipo === k ? "selected" : ""}>${n}</option>`)}</select></label></div>
        <label class="field"><span>Mensagem</span><textarea class="input" name="mensagem" rows="3" required maxlength="1500">${a.mensagem || ""}</textarea></label>
        <div class="grid-2"><label class="field"><span>Loja</span><select class="input" name="empresa_id"><option value="">Todas as lojas</option>
            ${lojasLista.map((l) => html`<option value="${l.id}" ${a.empresa_id === l.id ? "selected" : ""}>${l.loja}</option>`)}</select></label>
          <label class="field"><span>Setor</span><select class="input" name="segmento">${SEGMENTOS.map(([k, n]) => html`<option value="${k}" ${(a.segmento || "") === k ? "selected" : ""}>${n}</option>`)}</select></label></div>
        <fieldset class="field" style="border:0;padding:0;margin:0"><span>Quem vê (nenhum marcado = todos)</span>
          <div class="row wrap">${PAPEIS_AVISO.map(([k, n]) => html`<label class="check"><input type="checkbox" name="p_${k}" ${a.papeis?.includes(k) ? "checked" : ""}> ${n}</label>`)}</div></fieldset>
        <div class="grid-2"><label class="field"><span>Início</span><input class="input" type="datetime-local" name="inicio" value="${paraLocal(a.inicio || new Date())}"></label>
          <label class="field"><span>Fim (opcional)</span><input class="input" type="datetime-local" name="fim" value="${paraLocal(a.fim)}"></label></div>
        <label class="field"><span>Link “Saiba mais” (opcional, https://)</span><input class="input" name="link" value="${a.link || ""}"></label>
        <div class="row wrap"><label class="check"><input type="checkbox" name="fixo" ${a.fixo ? "checked" : ""}> Fixo (a loja não consegue dispensar)</label>
          <label class="check"><input type="checkbox" name="ativo" ${a.ativo !== false ? "checked" : ""}> Ligado</label></div>
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-av">Salvar aviso</button>`,
      onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => {
        e.preventDefault(); const f = e.target;
        fechar({ id: a.id || null, titulo: f.titulo.value.trim(), tipo: f.tipo.value, mensagem: f.mensagem.value.trim(),
          empresa_id: f.empresa_id.value || null, segmento: f.segmento.value || null,
          papeis: PAPEIS_AVISO.map(([k]) => k).filter((k) => f["p_" + k].checked),
          inicio: f.inicio.value ? new Date(f.inicio.value).toISOString() : null, fim: f.fim.value ? new Date(f.fim.value).toISOString() : null,
          link: f.link.value.trim() || null, fixo: f.fixo.checked, ativo: f.ativo.checked });
      }; },
    });
    if (!r) return;
    try { await rpc("aviso_salvar", { p: r }); toast("Aviso salvo", "ok"); desenhar(); } catch (e) { erro(e); }
  }

  // ================= Equipe (superusuário) =================
  async function equipe(corpo) {
    const lista = await rpc("equipe_listar");
    render(corpo, html`
      <div class="toolbar"><span class="muted small"><strong>Superusuário</strong>: tudo, inclusive Plataforma, cobranças, avisos e equipe. <strong>Suporte</strong>: entra nas lojas, atende chamados e vê só o próprio registro.</span>
        <span class="grow"></span><button class="btn primary" id="novo-membro">${icone("mais", 'width="18" height="18"')} Adicionar pessoa</button></div>
      <div class="panel"><div class="table-wrap"><table class="table">
        <thead><tr><th>Pessoa</th><th>Nível</th><th>Conta</th><th>Agora</th><th class="r">Acessos 30 dias</th><th></th></tr></thead>
        <tbody>${lista.map((m) => html`<tr>
          <td><strong>${m.nome || m.email}</strong>${m.eu ? html` <span class="badge info">você</span>` : ""}<div class="small muted">${m.email}</div></td>
          <td><span class="badge ${m.nivel === "super" ? "warn" : "info"}">${m.nivel === "super" ? html`${icone("coroa", 'width="13" height="13"')} Superusuário` : "Suporte"}</span>${m.ativo ? "" : html` <span class="badge danger">desativado</span>`}</td>
          <td class="small">${m.tem_conta ? (m.confirmado ? `último acesso ${relativo(m.ultimo_login)}` : "e-mail não confirmado") : html`<span style="color:var(--warn-ink)">precisa criar conta com este e-mail</span>`}</td>
          <td class="small">${m.em_loja ? html`dentro de <strong>${m.em_loja}</strong>` : html`<span class="muted">—</span>`}</td>
          <td class="r">${m.acessos_30d}</td>
          <td class="r" style="white-space:nowrap"><button class="btn sm" data-eq="editar" data-email="${m.email}">Editar</button>
            ${m.eu ? "" : html`<button class="btn sm ghost" data-eq="remover" data-email="${m.email}">${icone("lixo", 'width="16" height="16"')}</button>`}</td></tr>`)}</tbody></table></div></div>`);
    $("#novo-membro", corpo).onclick = () => editarMembro({ nivel: "suporte", ativo: true });
    $$("[data-eq]", corpo).forEach((b) => (b.onclick = async () => {
      const m = lista.find((x) => x.email === b.dataset.email);
      if (b.dataset.eq === "editar") return editarMembro(m);
      if (!(await confirmar(`Tirar ${m.nome || m.email} da equipe? Se estiver dentro de alguma loja, sai na hora.`, { perigo: true, ok: "Remover" }))) return;
      try { await rpc("equipe_remover", { p_email: m.email }); toast("Removido da equipe", "ok"); desenhar(); } catch (e) { erro(e); }
    }));
  }

  async function editarMembro(m) {
    const r = await modal({
      titulo: m.email ? "Editar pessoa da equipe" : "Adicionar à equipe",
      corpo: html`<form id="f-eq" class="stack">
        <label class="field"><span>E-mail (o mesmo da conta no sistema)</span><input class="input" type="email" name="email" required value="${m.email || ""}" ${m.email ? "readonly" : "autofocus"}></label>
        <label class="field"><span>Nome</span><input class="input" name="nome" value="${m.nome || ""}"></label>
        <label class="field"><span>Nível</span><select class="input" name="nivel"><option value="suporte" ${m.nivel === "suporte" ? "selected" : ""}>Suporte</option><option value="super" ${m.nivel === "super" ? "selected" : ""}>Superusuário</option></select></label>
        <label class="check"><input type="checkbox" name="ativo" ${m.ativo !== false ? "checked" : ""}> Acesso ativo</label>
        <p class="hint">A pessoa precisa ter uma conta (e-mail confirmado) no sistema. Superusuário tem exatamente o mesmo poder que você.</p></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-eq">Salvar</button>`,
      onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const f = e.target; fechar({ p_email: f.email.value.trim(), p_nome: f.nome.value.trim(), p_nivel: f.nivel.value, p_ativo: f.ativo.checked }); }; },
    });
    if (!r) return;
    if (r.p_nivel === "super" && m.nivel !== "super" && !(await confirmar(`${r.p_email} vai ter acesso total a todas as lojas, à Plataforma e à equipe.`, { titulo: "Dar nível de superusuário?", ok: "Confirmar" }))) return;
    try { await rpc("equipe_salvar", r); toast("Equipe atualizada", "ok"); desenhar(); } catch (e) { erro(e); }
  }

  await desenhar();
  return () => window.removeEventListener("chamados", aoChamado);
}

/** Anexos do chamado (bucket privado "ajuda-anexos"): links temporários de 10 minutos. */
async function mostrarAnexos(d, anexos) {
  for (const [i, a] of anexos.entries()) {
    const alvo = d.querySelector(`.anexo-ch[data-i="${i}"]`);
    if (!alvo) continue;
    try {
      const { data, error } = await sb.storage.from("ajuda-anexos").createSignedUrl(a.caminho, 600);
      if (error) throw error;
      const url = data.signedUrl;
      render(alvo, /^image\//.test(a.tipo || "")
        ? html`<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${a.nome}"></a><span>${a.nome}</span>`
        : html`<a class="btn sm" href="${url}" target="_blank" rel="noopener">${icone("baixar", 'width="16" height="16"')} Abrir</a><span>${a.nome}</span>`);
    } catch { render(alvo, html`<span class="muted">${a.nome} (não abriu)</span>`); }
  }
}
