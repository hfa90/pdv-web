// Plataforma (superusuário): licenças de cada cliente e dados/backup de todas as lojas.
// Usado pelas abas "Licenças" e "Dados e backup" de app/js/paginas/plataforma.js.
// Regras no banco: supabase/migrations/021_licencas_backup.sql.
import { rpc, fn } from "./api.js";
import { html, render, $, $$, data, dataHora, toast, erro, modal, confirmar, ocupado, numero, debounce, formatarDoc } from "./ui.js";
import { icone } from "./icons.js";
import { nomePlano } from "./pacotes.js";
import {
  badgeTipo, tamanho, descreverAgenda, baixarJson, nomeArquivo, escolherArquivoJson, lojasDoArquivo, emLote,
  restaurarBackup, avisarRestauracao, formAgenda, ligarAgenda, FREQUENCIAS,
} from "./backup-util.js";

const CONTA = { teste: ["warn", "Teste"], ativo: ["ok", "Ativo"], suspenso: ["danger", "Suspenso"], cancelado: ["", "Cancelado"] };
export const MODULOS_LIC = [["pdv", "Sistema (PDV)"], ["delivery", "Delivery"], ["garcom", "Garçom e mesas"], ["fiscal", "Nota fiscal"]];
const DIA = 864e5;
const hojeMais = (dias) => new Date(Date.now() + dias * DIA).toISOString().slice(0, 10);

/** Situação de uma licença: { cls, txt, dias } */
export function situacaoLicenca(l) {
  if (!l?.controlada || !l.expira_em) return { cls: "", txt: "Sem prazo", dias: null };
  const dias = Math.ceil((new Date(l.expira_em) - Date.now()) / DIA);
  if (!l.ok || dias <= 0) return { cls: "danger", txt: `Vencida ${data(l.expira_em)}`, dias: 0 };
  return { cls: dias <= 7 ? "warn" : "ok", txt: `até ${data(l.expira_em)}`, dias };
}

const celLic = (l, contratado = true) => {
  const s = situacaoLicenca(l);
  return html`<span class="badge ${s.cls}" title="${l?.observacao || ""}">${s.txt}</span>${!contratado ? html`<div class="small muted">não contratado</div>` : s.dias != null && s.dias > 0 && s.dias <= 7 ? html`<div class="small muted">${s.dias} dia(s)</div>` : ""}`;
};

/** Cabeçalho de seleção: "N selecionada(s)" + botões. */
function barraSelecao(n, botoes) {
  return html`<div class="sel-barra" ${n ? "" : "hidden"}><strong>${n} selecionada(s)</strong><span class="grow"></span>${botoes}</div>`;
}

// =====================================================================
// Licenças
// =====================================================================
export async function abaLicencas(corpo, { aoMudar } = {}) {
  const st = { busca: "", filtro: "", sel: new Set(), lista: [] };

  async function carregar() {
    st.lista = await rpc("plataforma_licencas");
    desenhar();
  }

  const filtrada = () => {
    const t = st.busca.trim().toLowerCase();
    return st.lista.filter((l) => {
      if (t && !l.loja.toLowerCase().includes(t)) return false;
      const s = MODULOS_LIC.map(([m]) => situacaoLicenca(l.licencas[m]));
      if (st.filtro === "vencidas") return s.some((x) => x.cls === "danger");
      if (st.filtro === "vencendo") return s.some((x) => x.cls === "warn");
      if (st.filtro === "controladas") return MODULOS_LIC.some(([m]) => l.licencas[m]?.controlada);
      return true;
    });
  };

  function desenhar() {
    const lista = filtrada();
    const venc = st.lista.filter((l) => MODULOS_LIC.some(([m]) => situacaoLicenca(l.licencas[m]).cls === "danger")).length;
    const vencendo = st.lista.filter((l) => MODULOS_LIC.some(([m]) => situacaoLicenca(l.licencas[m]).cls === "warn")).length;
    render(corpo, html`
      <div class="alerta info" style="margin-bottom:1rem">Cada loja tem uma licença por ferramenta. <strong>Sem prazo</strong> = funciona enquanto a conta estiver ativa.
        Licença do <strong>PDV</strong> vencida pausa as vendas e o caixa (os dados ficam guardados); das outras, só aquela ferramenta para.</div>
      <div class="toolbar">
        <input class="input" id="lic-busca" placeholder="Buscar loja…" value="${st.busca}" style="max-width:260px">
        <div class="periodos" id="lic-filtro">${[["", `Todas (${st.lista.length})`], ["vencidas", `Vencidas (${venc})`], ["vencendo", `Vencendo em 7 dias (${vencendo})`], ["controladas", "Com prazo"]]
          .map(([k, n]) => html`<button data-f="${k}" class="${st.filtro === k ? "ativo" : ""}">${n}</button>`)}</div>
      </div>
      ${barraSelecao(st.sel.size, html`<button class="btn sm primary" id="lic-lote">${icone("calendario", 'width="16" height="16"')} Alterar licenças</button><button class="btn sm ghost" id="lic-limpar">Limpar seleção</button>`)}
      <div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th style="width:36px"><input type="checkbox" id="lic-todas" title="Selecionar todas" ${lista.length && lista.every((l) => st.sel.has(l.id)) ? "checked" : ""}></th>
          <th>Loja</th>${MODULOS_LIC.map(([, n]) => html`<th>${n}</th>`)}<th></th></tr></thead>
        <tbody>${lista.map((l) => html`<tr>
          <td><input type="checkbox" data-sel="${l.id}" ${st.sel.has(l.id) ? "checked" : ""}></td>
          <td><strong>${l.loja}</strong><div class="small muted">${nomePlano(l.plano)} · <span class="badge ${CONTA[l.status_conta]?.[0] || ""}">${CONTA[l.status_conta]?.[1] || l.status_conta}</span></div></td>
          ${MODULOS_LIC.map(([m]) => html`<td>${celLic(l.licencas[m], m === "pdv" || m === "fiscal" || l.licencas._modulos?.[m])}</td>`)}
          <td class="r"><button class="btn sm" data-lic="${l.id}">Alterar</button></td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Nenhuma loja aqui.</p></div>`}</div>`);

    const busca = $("#lic-busca", corpo);
    busca.oninput = debounce(() => { st.busca = busca.value; desenhar(); $("#lic-busca", corpo).focus(); $("#lic-busca", corpo).setSelectionRange(99, 99); }, 200);
    $$("#lic-filtro button", corpo).forEach((b) => (b.onclick = () => { st.filtro = b.dataset.f; desenhar(); }));
    $("#lic-todas", corpo)?.addEventListener("change", (e) => { lista.forEach((l) => (e.target.checked ? st.sel.add(l.id) : st.sel.delete(l.id))); desenhar(); });
    $$("[data-sel]", corpo).forEach((c) => (c.onchange = () => { c.checked ? st.sel.add(c.dataset.sel) : st.sel.delete(c.dataset.sel); desenhar(); }));
    $("#lic-limpar", corpo)?.addEventListener("click", () => { st.sel.clear(); desenhar(); });
    const alterar = async (lojas) => { if (await alterarLicencas(lojas)) { aoMudar?.(); await carregar(); } };
    $("#lic-lote", corpo)?.addEventListener("click", () => alterar(st.lista.filter((l) => st.sel.has(l.id))));
    $$("[data-lic]", corpo).forEach((b) => (b.onclick = () => alterar([st.lista.find((l) => l.id === b.dataset.lic)])));
  }

  await carregar();
}

/** Renovar / expirar licenças de uma ou várias lojas ({id, loja, licencas}). Devolve true se mudou. */
export async function alterarLicencas(lojas) {
  if (!lojas.length) return false;
  const uma = lojas.length === 1 ? lojas[0] : null;
  const r = await modal({
    titulo: uma ? `Licenças · ${uma.loja}` : `Licenças de ${lojas.length} lojas`,
    corpo: html`<form id="f-lic" class="stack">
      ${uma ? html`<div class="lic-atual">${MODULOS_LIC.map(([m, n]) => html`<div><span class="small muted">${n}</span>${celLic(uma.licencas[m])}</div>`)}</div>`
        : html`<p class="small muted">${lojas.slice(0, 8).map((l) => l.loja).join(", ")}${lojas.length > 8 ? ` e mais ${lojas.length - 8}` : ""}</p>`}
      <div><strong class="small">Quais licenças</strong>
        <div class="row wrap" style="margin-top:.35rem">${MODULOS_LIC.map(([m, n]) => html`<label class="check"><input type="checkbox" name="m_${m}" ${m === "pdv" ? "checked" : ""}> ${n}</label>`)}</div></div>
      <div class="stack" style="gap:.5rem">
        <label class="check grande"><input type="radio" name="acao" value="renovar" checked><span><strong>Renovar</strong>
          <span class="small muted">soma os dias ao vencimento atual (ou a partir de hoje, se já venceu)</span></span></label>
        <div class="row wrap" style="padding-left:2rem" id="lic-dias">
          ${[[30, "+1 mês"], [90, "+3 meses"], [180, "+6 meses"], [365, "+1 ano"]].map(([d, n]) => html`<button type="button" class="chip ${d === 30 ? "ativo" : ""}" data-dias="${d}">${n}</button>`)}
          <label class="row" style="gap:.35rem"><input class="input" type="number" name="dias" min="1" max="3660" value="30" style="width:90px"> dias</label></div>
        <label class="check grande"><input type="radio" name="acao" value="definir"><span><strong>Vencer em uma data</strong></span></label>
        <div style="padding-left:2rem"><input class="input" type="date" name="ate" value="${hojeMais(30)}" style="max-width:200px"></div>
        <label class="check grande"><input type="radio" name="acao" value="sem_prazo"><span><strong>Sem prazo</strong><span class="small muted">não vence (cliente fiel, conta interna)</span></span></label>
        <label class="check grande"><input type="radio" name="acao" value="expirar"><span><strong style="color:var(--danger)">Expirar agora</strong>
          <span class="small muted">bloqueia na hora o que foi marcado acima</span></span></label>
      </div>
      <label class="field"><span>Observação (opcional)</span><input class="input" name="obs" placeholder="Ex.: pago via PIX em ${data(new Date())}"></label>
    </form>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-lic">Aplicar</button>`,
    onPronto: (d, fechar) => {
      const f = d.querySelector("form");
      d.querySelectorAll("[data-dias]").forEach((b) => (b.onclick = () => {
        f.dias.value = b.dataset.dias; f.acao.value = "renovar";
        d.querySelectorAll("[data-dias]").forEach((x) => x.classList.toggle("ativo", x === b));
      }));
      f.dias.oninput = () => { f.acao.value = "renovar"; d.querySelectorAll("[data-dias]").forEach((x) => x.classList.remove("ativo")); };
      f.ate.oninput = () => { f.acao.value = "definir"; };
      f.onsubmit = (e) => {
        e.preventDefault();
        const modulos = MODULOS_LIC.map(([m]) => m).filter((m) => f[`m_${m}`].checked);
        if (!modulos.length) return toast("Marque ao menos uma licença", "erro");
        if (f.acao.value === "definir" && !f.ate.value) return toast("Escolha a data de vencimento", "erro");
        fechar({ acao: f.acao.value, modulos, dias: Number(f.dias.value) || 30, ate: f.ate.value, obs: f.obs.value });
      };
    },
  });
  if (!r) return false;
  const nomes = r.modulos.map((m) => MODULOS_LIC.find(([k]) => k === m)[1]).join(", ");
  if (r.acao === "expirar" && !(await confirmar(`Expirar agora: ${nomes} de ${uma ? uma.loja : `${lojas.length} lojas`}? ${r.modulos.includes("pdv") ? "As vendas dessas lojas param na hora." : ""}`, { perigo: true, ok: "Expirar" }))) return false;
  try {
    const ate = r.acao === "definir" ? new Date(r.ate + "T23:59:59").toISOString() : null;
    if (r.acao === "definir" && new Date(ate) < new Date() && !(await confirmar("A data escolhida já passou: a licença fica vencida. Continuar?", { perigo: true }))) return false;
    const n = await rpc("plataforma_licenca_acao", { p_ids: lojas.map((l) => l.id), p_modulos: r.modulos, p_acao: r.acao, p_dias: r.dias, p_ate: ate, p_obs: r.obs || null });
    toast(`${n} licença(s) atualizada(s)`, "ok");
    return true;
  } catch (e) { erro(e); return false; }
}

// =====================================================================
// Dados e backup de todas as lojas
// =====================================================================
export async function abaDados(corpo, { aoMudar } = {}) {
  const st = { busca: "", sel: new Set(), d: null, sub: "lojas", copias: null, tipoCopia: "" };

  async function carregar() {
    st.d = await rpc("plataforma_dados_lojas");
    const ids = new Set(st.d.lojas.map((l) => l.id));
    [...st.sel].forEach((id) => { if (!ids.has(id)) st.sel.delete(id); });
    desenhar();
  }

  function desenhar() {
    const d = st.d, cfg = d.config;
    render(corpo, html`
      <div class="kpis">
        <div class="panel kpi"><div class="k-ic">${icone("loja")}</div><div class="k-label">Lojas no banco</div><div class="k-valor">${d.lojas.length}</div>
          <div class="k-sub">${numero(d.lojas.reduce((s, l) => s + Number(l.usuarios), 0))} usuários</div></div>
        <div class="panel kpi"><div class="k-ic">${icone("pacote")}</div><div class="k-label">Cópias guardadas</div><div class="k-valor">${numero(d.copias_total)}</div>
          <div class="k-sub">${tamanho(d.espaco_total)} no banco</div></div>
        <div class="panel kpi"><div class="k-ic">${icone("calendario")}</div><div class="k-label">Backup automático</div>
          <div class="k-valor" style="font-size:1.1rem">${cfg.backup_pausado ? "Pausado" : cfg.backup_obrigatorio ? "Obrigatório" : "Opcional"}</div>
          <div class="k-sub">${d.lojas.filter((l) => l.backup?.erro).length ? html`<span style="color:var(--danger)">${d.lojas.filter((l) => l.backup?.erro).length} loja(s) com erro</span>` : "sem erros"}</div></div>
      </div>
      <div class="tabs" id="dados-sub">${[["lojas", "Lojas"], ["copias", "Cópias guardadas"], ["politica", "Regra geral do backup"]]
        .map(([k, n]) => html`<button data-s="${k}" class="${st.sub === k ? "ativo" : ""}">${n}</button>`)}</div>
      <div id="dados-corpo"></div>`);
    $$("#dados-sub button", corpo).forEach((b) => (b.onclick = () => { st.sub = b.dataset.s; desenhar(); }));
    const alvo = $("#dados-corpo", corpo);
    ({ lojas: desenharLojas, copias: desenharCopias, politica: desenharPolitica })[st.sub](alvo);
  }

  // ---------- Lojas ----------
  function desenharLojas(alvo) {
    const t = st.busca.trim().toLowerCase();
    const lista = st.d.lojas.filter((l) => !t || l.loja.toLowerCase().includes(t) || (l.documento || "").includes(t.replace(/\D/g, "") || "§") || (l.municipio || "").toLowerCase().includes(t));
    const selecionadas = st.d.lojas.filter((l) => st.sel.has(l.id));
    render(alvo, html`
      <div class="toolbar">
        <input class="input" id="dl-busca" placeholder="Buscar loja, CNPJ ou cidade…" value="${st.busca}" style="max-width:280px">
        <span class="grow"></span>
        <button class="btn" id="dl-importar">${icone("transferir", 'width="18" height="18"')} Importar arquivo</button>
        <button class="btn" id="dl-exp-todas">${icone("baixar", 'width="18" height="18"')} Exportar todas</button>
        <button class="btn" id="dl-bk-todas">${icone("check", 'width="18" height="18"')} Backup de todas agora</button>
        <button class="btn danger" id="dl-exc-todas">${icone("lixo", 'width="18" height="18"')} Excluir todas</button>
      </div>
      ${barraSelecao(st.sel.size, html`
        <button class="btn sm" id="dl-bk">Backup agora</button><button class="btn sm" id="dl-exp">Exportar</button>
        <button class="btn sm" id="dl-agenda">Agenda do backup</button><button class="btn sm" id="dl-lic">Licenças</button>
        <button class="btn sm danger" id="dl-exc">Excluir</button><button class="btn sm ghost" id="dl-limpar">Limpar seleção</button>`)}
      <div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th style="width:36px"><input type="checkbox" id="dl-todas" ${lista.length && lista.every((l) => st.sel.has(l.id)) ? "checked" : ""}></th>
          <th>Loja</th><th>Situação</th><th class="r">Usuários</th><th class="r">Vendas</th><th>Backup</th><th>Último</th><th class="r">Cópias</th><th></th></tr></thead>
        <tbody>${lista.map((l) => html`<tr>
          <td><input type="checkbox" data-sel="${l.id}" ${st.sel.has(l.id) ? "checked" : ""}></td>
          <td><strong>${l.loja}</strong>${l.minha ? html` <span class="badge info">sua loja</span>` : l.protegida ? html` <span class="badge">equipe</span>` : ""}
            <div class="small muted">${[l.documento && formatarDoc(l.documento), [l.municipio, l.uf].filter(Boolean).join("/"), `desde ${data(l.created_at)}`].filter(Boolean).join(" · ")}</div></td>
          <td><span class="badge ${CONTA[l.status_conta]?.[0] || ""}">${CONTA[l.status_conta]?.[1] || l.status_conta}</span>
            ${situacaoLicenca(l.licencas?.pdv).cls === "danger" ? html`<div><span class="badge danger">licença vencida</span></div>` : ""}</td>
          <td class="r">${l.usuarios}</td><td class="r">${numero(l.vendas)}</td>
          <td class="small">${descreverAgenda(l.backup)}${l.backup?.erro ? html`<div style="color:var(--danger)" title="${l.backup.erro}">último falhou</div>` : ""}</td>
          <td class="small">${l.backup?.ultimo ? dataHora(l.backup.ultimo) : html`<span class="muted">nunca</span>`}</td>
          <td class="r small">${l.copias}<div class="muted">${tamanho(l.espaco)}</div></td>
          <td class="r" style="white-space:nowrap"><button class="btn sm" data-copias="${l.id}">Backups</button>
            <button class="btn sm ghost" data-exp="${l.id}" title="Exportar arquivo">${icone("baixar", 'width="15" height="15"')}</button>
            ${l.protegida ? "" : html`<button class="btn sm ghost" data-exc="${l.id}" title="Excluir loja">${icone("lixo", 'width="15" height="15"')}</button>`}</td>
        </tr>`)}</tbody></table></div>` : html`<div class="empty"><p>Nenhuma loja encontrada.</p></div>`}</div>`);

    const busca = $("#dl-busca", alvo);
    busca.oninput = debounce(() => { st.busca = busca.value; desenharLojas(alvo); const b = $("#dl-busca", alvo); b.focus(); b.setSelectionRange(99, 99); }, 200);
    $("#dl-todas", alvo)?.addEventListener("change", (e) => { lista.forEach((l) => (e.target.checked ? st.sel.add(l.id) : st.sel.delete(l.id))); desenharLojas(alvo); });
    $$("[data-sel]", alvo).forEach((c) => (c.onchange = () => { c.checked ? st.sel.add(c.dataset.sel) : st.sel.delete(c.dataset.sel); desenharLojas(alvo); }));
    $("#dl-limpar", alvo)?.addEventListener("click", () => { st.sel.clear(); desenharLojas(alvo); });
    const porId = (id) => st.d.lojas.find((l) => l.id === id);

    $("#dl-bk", alvo)?.addEventListener("click", () => backupAgora(selecionadas));
    $("#dl-bk-todas", alvo).onclick = () => backupAgora(st.d.lojas);
    $("#dl-exp", alvo)?.addEventListener("click", () => exportar(selecionadas));
    $("#dl-exp-todas", alvo).onclick = () => exportar(st.d.lojas, true);
    $("#dl-agenda", alvo)?.addEventListener("click", () => agendaLote(selecionadas));
    $("#dl-lic", alvo)?.addEventListener("click", async () => { if (await alterarLicencas(selecionadas)) { aoMudar?.(); carregar().catch(erro); } });
    $("#dl-exc", alvo)?.addEventListener("click", () => excluir(selecionadas));
    $("#dl-exc-todas", alvo).onclick = () => excluir(st.d.lojas, true);
    $("#dl-importar", alvo).onclick = importar;
    $$("[data-copias]", alvo).forEach((b) => (b.onclick = () => abrirLoja(porId(b.dataset.copias))));
    $$("[data-exp]", alvo).forEach((b) => (b.onclick = () => exportar([porId(b.dataset.exp)])));
    $$("[data-exc]", alvo).forEach((b) => (b.onclick = () => excluir([porId(b.dataset.exc)])));
  }

  async function abrirLoja(l) {
    const { montarPainelBackup } = await import("./paginas/backup.js");
    let mudou = false;
    await modal({
      titulo: `Backup · ${l.loja}`, largo: true,
      corpo: html`<div id="painel-loja-bk"></div>`,
      onPronto: (d) => montarPainelBackup(d.querySelector("#painel-loja-bk"), l.id, { aoMudar: () => { mudou = true; } }),
    });
    if (mudou) carregar().catch(erro);
  }

  async function backupAgora(lojas) {
    if (!lojas.length) return;
    if (lojas.length > 1 && !(await confirmar(`Fazer agora uma cópia de ${lojas.length} lojas?`, { ok: "Fazer backup" }))) return;
    const r = await emLote("Fazendo backup", lojas, (l) => l.loja, (l) => rpc("backup_criar", { p_empresa: l.id, p_obs: "Pela plataforma" }));
    toast(`${r.ok.length} backup(s) feito(s)`, r.falhas.length ? "erro" : "ok");
    carregar().catch(erro);
  }

  async function exportar(lojas, todas = false) {
    if (!lojas.length) return;
    if (!(await confirmar(html`Exportar ${lojas.length === 1 ? html`<strong>${lojas[0].loja}</strong>` : `${lojas.length} lojas`} para um arquivo .json?
      <br><br><span class="small muted">O arquivo traz todos os dados das lojas (inclusive chaves de pagamento e fiscais). Guarde em local seguro. Ele pode ser importado de volta aqui.</span>`, { titulo: "Exportar dados", ok: "Exportar" }))) return;
    const r = await emLote("Exportando", lojas, (l) => l.loja, (l) => rpc("backup_exportar", { p_empresa: l.id }));
    if (!r.ok.length) return;
    if (r.ok.length === 1 && !todas) return baixarJson(r.ok[0].r, nomeArquivo(r.ok[0].item.loja));
    const geral = await rpc("plataforma_dados_gerais").catch(() => null);
    baixarJson({ formato: "lis-pdv-exportacao", versao: 1, gerado_em: new Date().toISOString(), lojas: r.ok.map((x) => x.r), plataforma: geral },
      nomeArquivo(todas ? "todas-as-lojas" : `${r.ok.length}-lojas`));
    toast(`${r.ok.length} loja(s) exportada(s)`, "ok");
  }

  async function agendaLote(lojas) {
    if (!lojas.length) return;
    const cfg = st.d.config;
    const base = { modo: "automatico", frequencia: cfg.backup_frequencia_padrao, hora: cfg.backup_hora_padrao, dia_semana: 0, manter: cfg.backup_manter_padrao };
    const v = await modal({
      titulo: `Agenda do backup · ${lojas.length} loja(s)`,
      corpo: html`<form id="f-ag" class="stack">${formAgenda(base, { manterMax: cfg.backup_manter_max, mostrarPapeis: false, ehSuper: true })}
        <p class="hint">Quem pode fazer backup e baixar continua como cada loja escolheu.</p></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-ag">Aplicar</button>`,
      onPronto: (d, fechar) => { const f = d.querySelector("form"); const ler = ligarAgenda(f); f.onsubmit = (e) => { e.preventDefault(); const x = ler(); delete x.papeis_manual; delete x.papeis_baixar; fechar(x); }; },
    });
    if (!v) return;
    try { const n = await rpc("plataforma_backup_config_lojas", { p_ids: lojas.map((l) => l.id), p: v }); toast(`Agenda aplicada em ${n} loja(s)`, "ok"); carregar(); }
    catch (e) { erro(e); }
  }

  async function excluir(lojas, todas = false) {
    const podem = lojas.filter((l) => !l.protegida), protegidas = lojas.length - podem.length;
    if (!podem.length) return toast("Nenhuma das lojas pode ser excluída (sua loja e lojas da equipe ficam protegidas)", "erro");
    const dias = st.d.config.backup_exclusao_dias;
    const r = await modal({
      titulo: todas ? "Excluir TODOS os clientes" : `Excluir ${podem.length === 1 ? podem[0].loja : `${podem.length} lojas`}`,
      corpo: html`<form id="f-exc" class="stack">
        <div class="alerta">Apaga do banco <strong>todos os dados</strong> de ${podem.length === 1 ? html`<strong>${podem[0].loja}</strong>` : html`<strong>${podem.length} lojas</strong>`}
          (produtos, vendas, caixa, clientes, estoque, financeiro, notas, configurações) e os <strong>logins</strong> dos usuários delas.
          ${protegidas ? html`<br>${protegidas} loja(s) protegida(s) (a sua e as da equipe) ficam de fora.` : ""}</div>
        ${podem.length > 1 ? html`<div class="lista-excluir small">${podem.map((l) => html`<span>${l.loja}</span>`)}</div>` : ""}
        <p class="small">Antes de apagar, o sistema guarda uma cópia de cada loja por <strong>${dias} dias</strong> (em “Cópias guardadas”) — dá para desfazer restaurando.</p>
        <label class="check"><input type="checkbox" name="baixar" ${todas ? "checked" : ""}> Baixar também um arquivo com os dados antes de excluir</label>
        <label class="field"><span>Motivo (opcional)</span><input class="input" name="motivo" placeholder="Cancelou o contrato, cadastro de teste…"></label>
        <label class="field"><span>Digite EXCLUIR para confirmar</span><input class="input" name="conf" autocomplete="off"></label>
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn danger" form="f-exc">${icone("lixo", 'width="16" height="16"')} Excluir ${podem.length > 1 ? `${podem.length} lojas` : "loja"}</button>`,
      onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        if (e.target.conf.value.trim().toUpperCase() !== "EXCLUIR") return toast("Digite EXCLUIR para confirmar", "erro");
        fechar({ conf: "EXCLUIR", baixar: e.target.baixar.checked, motivo: e.target.motivo.value });
      }; },
    });
    if (!r) return;
    if (r.baixar) {
      const ex = await emLote("Exportando antes de excluir", podem, (l) => l.loja, (l) => rpc("backup_exportar", { p_empresa: l.id }));
      if (ex.falhas.length && !(await confirmar(`${ex.falhas.length} loja(s) não puderam ser exportadas. Continuar a exclusão mesmo assim?`, { perigo: true }))) return;
      if (ex.ok.length) baixarJson({ formato: "lis-pdv-exportacao", versao: 1, gerado_em: new Date().toISOString(), lojas: ex.ok.map((x) => x.r) }, nomeArquivo(`excluidas-${ex.ok.length}-lojas`));
    }
    const pend = [];
    const res = await emLote("Excluindo lojas", podem, (l) => l.loja, async (l) => {
      const x = await rpc("plataforma_excluir_lojas", { p_ids: [l.id], p_confirmacao: r.conf, p_motivo: r.motivo || null });
      pend.push(...(x.usuarios_pendentes || []));
      return x;
    });
    if (pend.length) {
      try { await fn("backup", { acao: "remover_usuarios", ids: pend }); }
      catch (e) { toast(`Lojas excluídas, mas ${pend.length} login(s) ficaram para trás: publique a Edge Function “backup” e tente de novo (${e.message})`, "erro"); }
    }
    if (res.ok.length) toast(`${res.ok.length} loja(s) excluída(s). A cópia de segurança fica em “Cópias guardadas”.`, "ok");
    res.ok.forEach(({ item }) => st.sel.delete(item.id));
    aoMudar?.();
    carregar().catch(erro);
  }

  async function importar() {
    try {
      const dados = await escolherArquivoJson();
      if (!dados) return;
      const lojas = lojasDoArquivo(dados);
      if (!lojas.length) throw new Error("O arquivo não tem lojas");
      const res = await emLote("Importando", lojas, (l) => l.loja || l.empresa?.razao_social || "Loja", (l) => rpc("backup_importar", { p_dados: l }));
      if (!res.ok.length) return;
      const metas = res.ok.map((x) => x.r);
      const escolha = await modal({
        titulo: "Arquivo importado",
        corpo: html`<div class="stack"><p>${metas.length} cópia(s) importada(s). Elas ficam em “Cópias guardadas” por 7 dias. Restaurar agora?</p>
          <div class="table-wrap"><table class="table"><thead><tr><th>Loja</th><th>Gerado em</th><th>Situação</th></tr></thead>
          <tbody>${metas.map((m) => html`<tr><td><strong>${m.loja}</strong></td><td class="small">${m.observacao || ""}</td>
            <td>${m.loja_existe ? html`<span class="badge warn">existe: dados atuais serão trocados</span>` : html`<span class="badge info">será recriada</span>`}
              ${m.usuarios_faltando ? html`<div class="small muted">${m.usuarios_faltando} login(s) a recriar</div>` : ""}</td></tr>`)}</tbody></table></div></div>`,
        rodape: html`<button class="btn" data-fechar>Depois</button>${metas.length === 1 ? "" : html`<button class="btn" data-esc="novas">Restaurar só as excluídas</button>`}<button class="btn danger" data-esc="todas">Restaurar ${metas.length === 1 ? "" : "todas"}</button>`,
        onPronto: (d, fechar) => d.querySelectorAll("[data-esc]").forEach((b) => (b.onclick = () => fechar(b.dataset.esc))),
      });
      if (!escolha) { st.sub = "copias"; st.copias = null; return carregar(); }
      const alvo = metas.filter((m) => escolha === "todas" || !m.loja_existe);
      if (alvo.length === 1) {
        avisarRestauracao(await restaurarBackup(alvo[0], { lojaExiste: alvo[0].loja_existe }));
      } else if (alvo.length) {
        const conf = await modal({
          titulo: `Restaurar ${alvo.length} lojas`,
          corpo: html`<form id="f-rl" class="stack"><div class="alerta warn">${alvo.filter((m) => m.loja_existe).length} loja(s) existentes terão os dados trocados pelos do arquivo (antes, o sistema guarda uma cópia de cada).
            ${alvo.filter((m) => !m.loja_existe).length} loja(s) excluída(s) serão recriadas. Logins que não existem mais são recriados e já ficam ativos (entram com “Esqueci a senha”).</div>
            <label class="field"><span>Digite RESTAURAR para confirmar</span><input class="input" name="conf" autocomplete="off"></label></form>`,
          rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn danger" form="f-rl">Restaurar</button>`,
          onPronto: (d, fechar) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); if (e.target.conf.value.trim().toUpperCase() !== "RESTAURAR") return toast("Digite RESTAURAR", "erro"); fechar(true); }; },
        });
        if (conf) {
          const rr = await emLote("Restaurando", alvo, (m) => m.loja, async (m) => {
            let recriados = [];
            if (m.usuarios_faltando) recriados = (await fn("backup", { acao: "recriar_usuarios", backup_id: m.id })).recriados || [];
            return rpc("backup_restaurar", { p_id: m.id, p_reativar: true, p_recriados: recriados });
          });
          toast(`${rr.ok.length} loja(s) restaurada(s)`, rr.falhas.length ? "erro" : "ok");
        }
      }
      aoMudar?.();
      await carregar();
    } catch (e) { erro(e); }
  }

  // ---------- Cópias guardadas (todas as lojas, inclusive excluídas) ----------
  async function desenharCopias(alvo) {
    render(alvo, html`<div class="loading"><div class="spinner"></div></div>`);
    try { st.copias = await rpc("plataforma_backups", { p_empresa: null, p_tipo: st.tipoCopia || null, p_limite: 500 }); }
    catch (e) { return render(alvo, html`<div class="alerta">${e.message}</div>`); }
    const lista = st.copias;
    render(alvo, html`
      <div class="toolbar"><div class="periodos" id="cp-tipo">${[["", "Todas"], ["antes_exclusao", "Lojas excluídas"], ["manual", "Manuais"], ["automatico", "Automáticas"], ["importado", "Importadas"], ["antes_restauracao", "Antes de restaurar"]]
        .map(([k, n]) => html`<button data-t="${k}" class="${st.tipoCopia === k ? "ativo" : ""}">${n}</button>`)}</div></div>
      <div class="panel">${lista.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Quando</th><th>Loja</th><th>Tipo</th><th>Feito por</th><th class="r">Registros</th><th class="r">Tamanho</th><th></th></tr></thead>
        <tbody>${lista.map((b) => html`<tr>
          <td class="small">${dataHora(b.created_at)}${b.restaurado_em ? html`<div class="muted">restaurado ${dataHora(b.restaurado_em)}</div>` : ""}</td>
          <td><strong>${b.loja || "—"}</strong>${b.loja_existe ? "" : html` <span class="badge danger">excluída</span>`}</td>
          <td>${badgeTipo(b.tipo)}${b.observacao ? html`<div class="small muted">${b.observacao}</div>` : ""}</td>
          <td class="small">${b.criado_por || "—"}</td><td class="r">${numero(b.registros)}</td><td class="r">${tamanho(b.tamanho_bytes)}</td>
          <td class="r" style="white-space:nowrap">
            <button class="btn sm" data-cp="baixar" data-id="${b.id}" title="Baixar">${icone("baixar", 'width="15" height="15"')}</button>
            <button class="btn sm ${b.loja_existe ? "" : "primary"}" data-cp="restaurar" data-id="${b.id}">${b.loja_existe ? "Restaurar" : "Recriar loja"}</button>
            <button class="btn sm ghost" data-cp="apagar" data-id="${b.id}" title="Apagar">${icone("lixo", 'width="15" height="15"')}</button></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma cópia ${st.tipoCopia ? "deste tipo" : "ainda"}.</p></div>`}</div>`);
    $$("#cp-tipo button", alvo).forEach((b) => (b.onclick = () => { st.tipoCopia = b.dataset.t; desenharCopias(alvo); }));
    $$("[data-cp]", alvo).forEach((b) => (b.onclick = () => ocupado(b, async () => {
      const m = lista.find((x) => x.id === b.dataset.id);
      try {
        if (b.dataset.cp === "baixar") return baixarJson(await rpc("backup_baixar", { p_id: m.id }), nomeArquivo(m.loja, m.created_at));
        if (b.dataset.cp === "apagar") {
          if (!(await confirmar(`Apagar a cópia de ${m.loja} (${dataHora(m.created_at)})?${m.loja_existe ? "" : " A loja foi excluída: sem esta cópia não dá mais para recriá-la."}`, { perigo: true, ok: "Apagar" }))) return;
          await rpc("backup_excluir", { p_id: m.id }); toast("Cópia apagada", "ok");
        } else {
          const r = await restaurarBackup(m, { lojaExiste: m.loja_existe });
          if (!r) return;
          avisarRestauracao(r); aoMudar?.();
        }
        st.d = await rpc("plataforma_dados_lojas");
        desenharCopias(alvo);
      } catch (e) { erro(e); }
    })));
  }

  // ---------- Regra geral ----------
  function desenharPolitica(alvo) {
    const c = st.d.config;
    render(alvo, html`<div class="panel" style="max-width:760px"><form id="f-pol" class="panel-pad stack">
      <label class="check grande"><input type="checkbox" name="backup_obrigatorio" ${c.backup_obrigatorio ? "checked" : ""}><span><strong>Backup automático obrigatório</strong>
        <span class="small muted">as lojas não conseguem desligar (só mudam horário e frequência)</span></span></label>
      <label class="check grande"><input type="checkbox" name="backup_pausado" ${c.backup_pausado ? "checked" : ""}><span><strong>Pausar todos os backups automáticos</strong>
        <span class="small muted">use em manutenção do banco; o manual continua funcionando</span></span></label>
      <h3>Padrão para lojas novas</h3>
      <div class="grid-2">
        <label class="field"><span>Frequência</span><select class="input" name="backup_frequencia_padrao">${FREQUENCIAS.map(([k, n]) => html`<option value="${k}" ${c.backup_frequencia_padrao === k ? "selected" : ""}>${n}</option>`)}</select></label>
        <label class="field"><span>Horário</span><select class="input" name="backup_hora_padrao">${Array.from({ length: 24 }, (_, h) => html`<option value="${h}" ${Number(c.backup_hora_padrao) === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`)}</select></label>
        <label class="field"><span>Guardar as últimas (cópias)</span><input class="input" type="number" min="1" max="90" name="backup_manter_padrao" value="${c.backup_manter_padrao}"></label>
      </div>
      <h3>Limites (espaço no banco)</h3>
      <div class="grid-2">
        <label class="field"><span>Máximo de cópias por loja</span><input class="input" type="number" min="1" max="90" name="backup_manter_max" value="${c.backup_manter_max}"></label>
        <label class="field"><span>Guardar cópias de lojas excluídas por (dias)</span><input class="input" type="number" min="1" max="3650" name="backup_exclusao_dias" value="${c.backup_exclusao_dias}"></label>
      </div>
      <div class="row wrap"><button class="btn primary">Salvar regra geral</button>
        <button type="button" class="btn" id="pol-aplicar">Aplicar o padrão em todas as lojas</button></div>
      ${c.atualizado_por ? html`<p class="hint">Alterado por ${c.atualizado_por} em ${dataHora(c.updated_at)}</p>` : ""}
    </form></div>`);
    const f = $("#f-pol", alvo);
    const ler = () => ({
      backup_obrigatorio: f.backup_obrigatorio.checked, backup_pausado: f.backup_pausado.checked,
      backup_frequencia_padrao: f.backup_frequencia_padrao.value, backup_hora_padrao: Number(f.backup_hora_padrao.value),
      backup_manter_padrao: Number(f.backup_manter_padrao.value), backup_manter_max: Number(f.backup_manter_max.value),
      backup_exclusao_dias: Number(f.backup_exclusao_dias.value),
    });
    f.onsubmit = (e) => { e.preventDefault(); ocupado(f.querySelector("button.primary"), async () => {
      try { await rpc("plataforma_backup_config_salvar", { p: ler() }); toast("Regra geral salva", "ok"); await carregar(); } catch (er) { erro(er); }
    }); };
    $("#pol-aplicar", alvo).onclick = async () => {
      const v = ler();
      if (!(await confirmar(`Aplicar em todas as ${st.d.lojas.length} lojas: ${descreverAgenda({ modo: "automatico", frequencia: v.backup_frequencia_padrao, hora: v.backup_hora_padrao })}, guardando ${v.backup_manter_padrao} cópias? A agenda que cada loja escolheu será trocada.`, { ok: "Aplicar" }))) return;
      try {
        await rpc("plataforma_backup_config_salvar", { p: v });
        const n = await rpc("plataforma_backup_config_lojas", { p_ids: st.d.lojas.map((l) => l.id), p: { modo: "automatico", frequencia: v.backup_frequencia_padrao, hora: v.backup_hora_padrao, manter: v.backup_manter_padrao } });
        toast(`Padrão aplicado em ${n} loja(s)`, "ok"); await carregar();
      } catch (er) { erro(er); }
    };
  }

  await carregar();
}
