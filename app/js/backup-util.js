// Backup: peças usadas pela tela Backup da loja e pela Plataforma (superusuário).
// Regras e dados ficam no banco (supabase/migrations/021_licencas_backup.sql);
// recriar logins ao restaurar fica na Edge Function "backup".
import { rpc, fn } from "./api.js";
import { html, dataHora, toast, modal, numero } from "./ui.js";

export const TIPOS_BACKUP = {
  automatico: ["", "Automático"],
  manual: ["info", "Manual"],
  antes_restauracao: ["warn", "Antes de restaurar"],
  antes_exclusao: ["danger", "Antes de excluir a loja"],
  importado: ["ok", "Importado"],
};
export const FREQUENCIAS = [["diario", "Todo dia"], ["12h", "A cada 12 horas"], ["6h", "A cada 6 horas"], ["semanal", "Uma vez por semana"]];
export const DIAS_SEMANA = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
export const NIVEIS_BACKUP = [["gerente", "Gerente"], ["caixa", "Caixa"], ["atendente", "Atendente / garçom"], ["cozinha", "Cozinha"]];

export const badgeTipo = (t) => html`<span class="badge ${TIPOS_BACKUP[t]?.[0] || ""}">${TIPOS_BACKUP[t]?.[1] || t}</span>`;

export function tamanho(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${numero(b / 1024, 0)} KB`;
  if (b < 1024 ** 3) return `${numero(b / 1024 ** 2, 1)} MB`;
  return `${numero(b / 1024 ** 3, 2)} GB`;
}

export function descreverAgenda(c) {
  if (!c) return "—";
  if (c.modo === "manual") return "Só manual";
  const h = `${String(c.hora ?? 3).padStart(2, "0")}h`;
  if (c.frequencia === "6h") return "A cada 6 horas";
  if (c.frequencia === "12h") return "A cada 12 horas";
  if (c.frequencia === "semanal") return `${DIAS_SEMANA[c.dia_semana ?? 0]} às ${h}`;
  return `Todo dia às ${h}`;
}

const slug = (s) => String(s || "loja").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 40) || "loja";
const carimbo = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};
export const nomeArquivo = (loja, quando) => `backup-${slug(loja)}-${carimbo(quando ? new Date(quando) : new Date())}.json`;

/** Baixa um objeto como arquivo .json. */
export function baixarJson(obj, nome) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: "application/json" }));
  a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Abre o seletor de arquivo e devolve o JSON lido (ou null se cancelar). */
export function escolherArquivoJson() {
  return new Promise((resolve, reject) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      try { resolve(JSON.parse(await f.text())); } catch { reject(new Error("O arquivo não é um backup válido (JSON ilegível)")); }
    };
    inp.click();
  });
}

/** Separa as lojas de um arquivo: backup de uma loja ou exportação de várias. */
export function lojasDoArquivo(dados) {
  if (dados?.formato === "lis-pdv-backup") return [dados];
  if (dados?.formato === "lis-pdv-exportacao" && Array.isArray(dados.lojas)) return dados.lojas.filter((l) => l?.formato === "lis-pdv-backup");
  throw new Error("Este arquivo não é um backup do sistema");
}

/**
 * Roda uma ação item a item mostrando o progresso (cada chamada ao banco é curta,
 * então funciona com dezenas de lojas). Devolve { ok: [{item, r}], falhas: [{item, erro}] }.
 */
export function emLote(titulo, itens, rotulo, acao) {
  const res = { ok: [], falhas: [] };
  if (!itens.length) return Promise.resolve(res);
  return modal({
    titulo, fixo: true,
    corpo: html`<div class="stack"><div class="lote-barra"><div id="lote-prog"></div></div>
      <p class="small" id="lote-txt">Preparando…</p><div id="lote-falhas" class="small stack" style="gap:.25rem"></div></div>`,
    rodape: html`<button class="btn" id="lote-parar">Parar</button>`,
    onPronto: async (d, fechar) => {
      let parar = false, fim = false;
      d.querySelector(".modal-head [data-fechar]")?.setAttribute("hidden", "");
      d.addEventListener("cancel", (e) => { if (!fim) e.preventDefault(); });
      const btn = d.querySelector("#lote-parar"), txt = d.querySelector("#lote-txt"), prog = d.querySelector("#lote-prog"), falhas = d.querySelector("#lote-falhas");
      btn.onclick = () => { if (fim) return fechar(); parar = true; btn.disabled = true; btn.textContent = "Parando…"; };
      for (let i = 0; i < itens.length && !parar; i++) {
        txt.textContent = `${rotulo(itens[i])} — ${i + 1} de ${itens.length}`;
        try { res.ok.push({ item: itens[i], r: await acao(itens[i]) }); }
        catch (e) {
          res.falhas.push({ item: itens[i], erro: e.message });
          const p = document.createElement("div"); p.className = "alerta"; p.textContent = `${rotulo(itens[i])}: ${e.message}`; falhas.appendChild(p);
        }
        prog.style.width = `${((i + 1) / itens.length) * 100}%`;
      }
      fim = true;
      txt.textContent = `${parar ? "Interrompido" : "Concluído"}: ${res.ok.length} de ${itens.length} com sucesso${res.falhas.length ? `, ${res.falhas.length} com erro` : ""}.`;
      btn.disabled = false; btn.textContent = "Fechar"; btn.className = "btn primary";
      if (!res.falhas.length) setTimeout(() => fechar(), 700);
    },
  }).then(() => res);
}

/**
 * Restaurar uma cópia: confirma, recria logins que não existem mais (Edge Function
 * "backup") e substitui os dados. Devolve o resultado ou null se cancelar.
 */
export async function restaurarBackup(meta, { lojaExiste = true } = {}) {
  const faltando = await rpc("backup_usuarios_faltando", { p_id: meta.id });
  const r = await modal({
    titulo: "Restaurar backup",
    corpo: html`<form id="f-rest" class="stack">
      <div class="alerta warn">${lojaExiste
        ? html`Os dados atuais de <strong>${meta.loja}</strong> serão trocados pelos da cópia de <strong>${dataHora(meta.created_at)}</strong>. Antes, o sistema guarda uma cópia do estado de agora — dá para desfazer.`
        : html`A loja <strong>${meta.loja}</strong> foi excluída e será recriada com os dados da cópia de <strong>${dataHora(meta.created_at)}</strong>.`}</div>
      ${faltando.length ? html`<p>${faltando.length === 1 ? "1 login" : `${faltando.length} logins`} desta cópia não existem mais e serão recriados:
          <strong>${faltando.map((u) => u.nome || u.email).join(", ")}</strong>. Eles recebem uma senha aleatória: entram com “Esqueci a senha” ou o administrador define uma nova em Usuários.</p>
        <label class="check"><input type="checkbox" name="reativar" ${lojaExiste ? "" : "checked"}> Deixar esses usuários ativos já (senão ficam desativados até o administrador conferir)</label>` : ""}
      <p class="hint">Durante a restauração (alguns segundos) a loja não consegue vender.</p>
      <label class="field"><span>Digite RESTAURAR para confirmar</span><input class="input" name="conf" autocomplete="off" autofocus></label>
    </form>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn danger" form="f-rest">Restaurar</button>`,
    onPronto: (d, fechar) => {
      d.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        if (e.target.conf.value.trim().toUpperCase() !== "RESTAURAR") return toast("Digite RESTAURAR para confirmar", "erro");
        fechar({ reativar: !!e.target.reativar?.checked });
      };
    },
  });
  if (!r) return null;
  let recriados = [], trocados = [];
  if (faltando.length) {
    try {
      const x = await fn("backup", { acao: "recriar_usuarios", backup_id: meta.id });
      recriados = x.recriados || []; trocados = x.trocados || [];
    } catch (e) {
      throw new Error(`Não foi possível recriar os logins (${e.message}). Confira se a Edge Function “backup” está publicada: supabase functions deploy backup`);
    }
  }
  const out = await rpc("backup_restaurar", { p_id: meta.id, p_reativar: r.reativar, p_recriados: recriados });
  return { ...out, recriados, trocados };
}

/** Mensagem final da restauração. */
export function avisarRestauracao(r) {
  if (!r) return;
  toast(`Backup restaurado: ${numero(r.registros)} registros${r.recriados?.length ? ` · ${r.recriados.length} login(s) recriado(s)` : ""}`, "ok");
  if (r.trocados?.length) {
    modal({ titulo: "Logins com e-mail provisório", corpo: html`<p>O e-mail destes usuários agora pertence a outra conta, então o login foi recriado com um e-mail provisório. Troque em Usuários:</p>
      <ul>${r.trocados.map((t) => html`<li><strong>${t.nome}</strong>: ${t.email_original || "—"} → <code>${t.email_novo}</code></li>`)}</ul>` });
  }
}

/** Formulário da agenda de backup (tela da loja e Plataforma). */
export function formAgenda(c, { obrigatorio = false, manterMax = 30, mostrarPapeis = true, podePapeisBaixar = true, ehSuper = false } = {}) {
  const travaManual = obrigatorio && !ehSuper;
  return html`
    <div class="grid-2">
      <label class="field"><span>Como fazer</span><select class="input" name="modo">
        <option value="automatico" ${c.modo !== "manual" ? "selected" : ""}>Automático + manual</option>
        <option value="manual" ${c.modo === "manual" ? "selected" : ""} ${travaManual ? "disabled" : ""}>Só manual${travaManual ? " (não permitido)" : ""}</option></select></label>
      <label class="field"><span>Frequência</span><select class="input" name="frequencia">${FREQUENCIAS.map(([k, n]) => html`<option value="${k}" ${c.frequencia === k ? "selected" : ""}>${n}</option>`)}</select></label>
      <label class="field" data-so="dia"><span>Horário</span><select class="input" name="hora">${Array.from({ length: 24 }, (_, h) => html`<option value="${h}" ${Number(c.hora) === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`)}</select></label>
      <label class="field" data-so="semanal"><span>Dia da semana</span><select class="input" name="dia_semana">${DIAS_SEMANA.map((n, i) => html`<option value="${i}" ${Number(c.dia_semana) === i ? "selected" : ""}>${n}</option>`)}</select></label>
      <label class="field"><span>Guardar as últimas</span><input class="input" type="number" name="manter" min="1" max="${manterMax}" value="${Math.min(c.manter ?? 7, manterMax)}"><small class="hint">cópias de cada tipo (máximo ${manterMax})</small></label>
    </div>
    ${travaManual ? html`<p class="hint">O backup automático é obrigatório: definido pela plataforma para proteger seus dados.</p>` : ""}
    ${mostrarPapeis ? html`<div class="stack" style="gap:.4rem;margin-top:.25rem"><strong class="small">Quem pode fazer backup manual e ver a lista</strong>
      <div class="row wrap"><label class="check"><input type="checkbox" checked disabled> Administrador</label>
        ${NIVEIS_BACKUP.map(([k, n]) => html`<label class="check"><input type="checkbox" name="pm_${k}" ${(c.papeis_manual || []).includes(k) ? "checked" : ""}> ${n}</label>`)}</div>
      <strong class="small">Quem pode baixar o arquivo (contém dados sensíveis: chaves de pagamento e fiscais)</strong>
      <div class="row wrap"><label class="check"><input type="checkbox" checked disabled> Administrador</label>
        ${NIVEIS_BACKUP.map(([k, n]) => html`<label class="check"><input type="checkbox" name="pb_${k}" ${(c.papeis_baixar || []).includes(k) ? "checked" : ""} ${podePapeisBaixar ? "" : "disabled"}> ${n}</label>`)}</div>
      <p class="hint">Restaurar e importar: só o administrador da loja.</p></div>` : ""}`;
}

/** Liga o formulário (mostra horário/dia conforme a frequência) e devolve a função que lê os valores. */
export function ligarAgenda(form) {
  const ajustar = () => {
    const f = form.frequencia.value;
    form.querySelector('[data-so="dia"]').hidden = !["diario", "semanal"].includes(f);
    form.querySelector('[data-so="semanal"]').hidden = f !== "semanal";
  };
  form.frequencia.addEventListener("change", ajustar); ajustar();
  return () => ({
    modo: form.modo.value, frequencia: form.frequencia.value, hora: Number(form.hora.value), dia_semana: Number(form.dia_semana.value),
    manter: Math.max(1, Number(form.manter.value) || 7),
    papeis_manual: NIVEIS_BACKUP.map(([k]) => k).filter((k) => form[`pm_${k}`]?.checked),
    papeis_baixar: NIVEIS_BACKUP.map(([k]) => k).filter((k) => form[`pb_${k}`]?.checked),
  });
}

