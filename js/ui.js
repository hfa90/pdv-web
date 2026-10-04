// Utilitários de interface: HTML seguro, formatação, toasts e modais.

// ---------- HTML seguro ----------
// Use sempre html`...` para montar telas: todo valor interpolado é escapado
// automaticamente (proteção contra XSS). Para HTML confiável use raw().
const RAW = Symbol("raw");
export const raw = (s) => ({ [RAW]: String(s ?? "") });

export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function valor(v) {
  if (v == null || v === false) return "";
  if (Array.isArray(v)) return v.map(valor).join("");
  if (typeof v === "object" && RAW in v) return v[RAW];
  return esc(v);
}

export function html(strings, ...vals) {
  let s = "";
  strings.forEach((str, i) => { s += str + (i < vals.length ? valor(vals[i]) : ""); });
  return raw(s);
}

export function render(el, conteudo) {
  el.innerHTML = typeof conteudo === "object" && RAW in conteudo ? conteudo[RAW] : esc(conteudo);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Formatação ----------
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const dinheiro = (n) => BRL.format(Number(n) || 0);
export const numero = (n, casas = 0) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas }).format(Number(n) || 0);
export const qtd = (n, unidade = "UN") =>
  ["KG", "L", "M", "G", "ML"].includes(unidade) ? numero(n, 3) : numero(n, Number(n) % 1 ? 3 : 0);
export const dataHora = (d) => d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
export const data = (d) => d ? new Date(d).toLocaleDateString("pt-BR") : "—";
export const hora = (d) => d ? new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";

/** Lê número digitado no padrão brasileiro ("1.234,56" ou "1234.56"). */
export function lerNumero(v) {
  if (typeof v === "number") return v;
  let s = String(v ?? "").trim().replace(/[R$\s]/g, "");
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export const somenteDigitos = (s) => String(s ?? "").replace(/\D/g, "");
export function formatarDoc(s) {
  const d = somenteDigitos(s);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return s || "";
}
export function cpfValido(c) {
  c = somenteDigitos(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}
export function cnpjValido(c) {
  c = somenteDigitos(c);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (n) => {
    const pesos = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const s = pesos.reduce((a, p, i) => a + Number(c[i]) * p, 0);
    const r = s % 11; return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}
export const docValido = (d) => { const x = somenteDigitos(d); return x.length === 11 ? cpfValido(x) : x.length === 14 ? cnpjValido(x) : false; };

/** Só aceita links https (evita javascript: vindo de dados externos). */
export const urlSegura = (u) => (/^https:\/\//i.test(String(u || "")) ? u : "#");

export const iniciais =(nome) => String(nome || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();

export function debounce(fn, ms = 250) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Lê um <form> como objeto (checkbox => boolean). */
export function lerForm(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") o[el.name] = el.checked;
    else o[el.name] = el.value.trim();
  }
  return o;
}

// ---------- Toast ----------
export function toast(msg, tipo = "") {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast " + tipo;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), tipo === "erro" ? 6000 : 3200);
}
export const erro = (e) => toast(e?.message || String(e), "erro");

// ---------- Modal ----------
/**
 * Abre um modal. `corpo` é html``. `onPronto(dialog, fechar)` liga eventos.
 * Retorna Promise resolvida com o valor passado a fechar().
 */
export function modal({ titulo, corpo, rodape, largo = false, onPronto }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "modal" + (largo ? " wide" : "");
    d.innerHTML = html`
      <div class="modal-head"><h2>${titulo}</h2>
        <button class="btn ghost icon-btn" data-fechar aria-label="Fechar">✕</button></div>
      <div class="modal-body">${corpo}</div>
      ${rodape ? html`<div class="modal-foot">${rodape}</div>` : ""}`[RAW];
    document.body.appendChild(d);
    let resultado;
    const fechar = (v) => { resultado = v; d.close(); };
    d.addEventListener("close", () => { d.remove(); resolve(resultado); });
    d.querySelectorAll("[data-fechar]").forEach((b) => b.addEventListener("click", () => fechar()));
    d.addEventListener("click", (e) => { if (e.target === d) fechar(); });
    d.showModal();
    onPronto?.(d, fechar);
    const foco = d.querySelector("[autofocus]") || d.querySelector(".modal-body input, .modal-body select");
    foco?.focus();
  });
}

export function confirmar(mensagem, { titulo = "Confirmar", ok = "Confirmar", perigo = false } = {}) {
  return modal({
    titulo,
    corpo: html`<p>${mensagem}</p>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button>
      <button class="btn ${perigo ? "danger" : "primary"}" data-ok>${ok}</button>`,
    onPronto: (d, fechar) => { const b = d.querySelector("[data-ok]"); b.focus(); b.onclick = () => fechar(true); },
  }).then(Boolean);
}

export function pedirTexto({ titulo, rotulo, ok = "Confirmar", minimo = 0, tipo = "text", valor = "", dica = "" }) {
  return modal({
    titulo,
    corpo: html`<form class="stack" id="f-pedir"><label class="field"><span>${rotulo}</span>
      <input class="input" name="v" type="${tipo}" value="${valor}" autofocus ${tipo === "text" ? "" : raw('inputmode="decimal"')}></label>
      ${dica ? html`<p class="hint">${dica}</p>` : ""}</form>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-pedir">${ok}</button>`,
    onPronto: (d, fechar) => {
      d.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        const v = e.target.v.value.trim();
        if (v.length < minimo) return toast(`Digite ao menos ${minimo} caracteres`, "erro");
        fechar(v);
      };
    },
  });
}

/** Desabilita botão enquanto uma ação assíncrona roda. */
export async function ocupado(botao, acao) {
  const original = botao?.innerHTML;
  if (botao) { botao.disabled = true; botao.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span>'; }
  try { return await acao(); }
  finally { if (botao) { botao.disabled = false; botao.innerHTML = original; } }
}

export const carregando = () => html`<div class="loading"><div class="spinner" aria-label="Carregando"></div></div>`;
