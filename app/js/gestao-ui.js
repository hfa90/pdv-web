// Peças de interface compartilhadas pelas telas de gestão (compras, financeiro, fiado, alertas…).
import { html, render, $, $$ } from "./ui.js";

/** Data local "AAAA-MM-DD". */
export const hojeISO = (d = new Date()) => {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
};
export const somarDias = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return hojeISO(d); };
export const dataBR = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "—");

const PERIODOS = [["hoje", "Hoje"], ["ontem", "Ontem"], ["7d", "7 dias"], ["30d", "30 dias"], ["mes", "Este mês"], ["mes_ant", "Mês passado"], ["custom", "Personalizado"]];

/** Intervalo de datas locais [ini, fim] (inclusive) para a chave escolhida. */
export function periodoDatas(chave, de, ate) {
  const h = hojeISO();
  const [y, m] = h.split("-").map(Number);
  const pad = (n) => String(n).padStart(2, "0");
  switch (chave) {
    case "hoje": return [h, h];
    case "ontem": return [somarDias(h, -1), somarDias(h, -1)];
    case "7d": return [somarDias(h, -6), h];
    case "30d": return [somarDias(h, -29), h];
    case "mes": return [`${y}-${pad(m)}-01`, h];
    case "mes_ant": { const d = new Date(y, m - 2, 1); const f = new Date(y, m - 1, 0); return [hojeISO(d), hojeISO(f)]; }
    default: return [de || h, ate || h];
  }
}
/** Converte o intervalo de datas locais em instantes [ini, fim) para as funções que usam timestamptz. */
export const periodoInstantes = ([ini, fim]) => [new Date(ini + "T00:00:00"), new Date(somarDias(fim, 1) + "T00:00:00")];

/**
 * Barra de período (chips + datas personalizadas). Chama aoMudar([ini, fim]) já na criação.
 * Devolve { atual() }.
 */
export function barraPeriodo(alvo, aoMudar, inicial = "30d", opcoes = PERIODOS) {
  let chave = inicial;
  const h = hojeISO();
  render(alvo, html`<div class="toolbar">
    <div class="chips">${opcoes.map(([k, n]) => html`<button type="button" class="chip ${k === chave ? "ativo" : ""}" data-p="${k}">${n}</button>`)}</div>
    <span class="row" data-custom ${chave === "custom" ? "" : "hidden"}><input class="input" type="date" data-de value="${somarDias(h, -29)}"><input class="input" type="date" data-ate value="${h}"></span></div>`);
  const atual = () => periodoDatas(chave, $("[data-de]", alvo).value, $("[data-ate]", alvo).value);
  $$("[data-p]", alvo).forEach((b) => (b.onclick = () => {
    chave = b.dataset.p; $$("[data-p]", alvo).forEach((x) => x.classList.toggle("ativo", x === b));
    $("[data-custom]", alvo).hidden = chave !== "custom"; aoMudar(atual());
  }));
  $("[data-de]", alvo).onchange = $("[data-ate]", alvo).onchange = () => aoMudar(atual());
  aoMudar(atual());
  return { atual };
}

/** Abas simples. abas: [[chave, rótulo]]. Devolve a função para trocar de aba. */
export function abas(alvo, lista, aoTrocar, inicial = lista[0][0]) {
  render(alvo, html`<div class="tabs">${lista.map(([k, n]) => html`<button type="button" data-aba="${k}" class="${k === inicial ? "ativo" : ""}">${n}</button>`)}</div>`);
  const ir = (k) => { $$("[data-aba]", alvo).forEach((x) => x.classList.toggle("ativo", x.dataset.aba === k)); aoTrocar(k); };
  $$("[data-aba]", alvo).forEach((b) => (b.onclick = () => ir(b.dataset.aba)));
  return ir;
}

/** Baixa um CSV (separado por ";" e com BOM, abre certo no Excel). */
export function baixarCSV(nome, linhas) {
  const csv = "﻿" + linhas.map((l) => l.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = nome; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const numCSV = (n) => String(Number(n) || 0).replace(".", ",");

/** Link do WhatsApp para um telefone brasileiro (com ou sem 55). */
export function linkZap(telefone, texto) {
  let d = String(telefone || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length <= 11) d = "55" + d;
  return `https://wa.me/${d}?text=${encodeURIComponent(texto)}`;
}

/** Lê um arquivo como texto, tentando UTF-8 e caindo para Latin-1 (extratos de banco antigos). */
export async function lerArquivoTexto(arquivo) {
  const buf = await arquivo.arrayBuffer();
  const utf = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  return utf.includes("�") ? new TextDecoder("windows-1252").decode(buf) : utf;
}
