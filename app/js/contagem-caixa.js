// Fechamento de caixa guiado: o operador conta quantas notas e moedas de cada valor tem na gaveta
// e o sistema soma. Menos erro de conta e menos discussão sobre falta de caixa.
// A contagem vai junto na observação do fechamento (aparece no histórico e no registro).
import { html, dinheiro, lerNumero } from "./ui.js";

export const NOTAS = [200, 100, 50, 20, 10, 5, 2];
export const MOEDAS = [1, 0.5, 0.25, 0.1, 0.05];
const r2 = (n) => Math.round(n * 100) / 100;
const rotulo = (v) => (v >= 1 ? `R$ ${v}` : `${Math.round(v * 100)} ¢`);

/** Campos da contagem (vão dentro do <form> do fechamento). `nome` é o input do valor total. */
export function contagemHtml(nome = "valor") {
  const linha = (v, tipo) => html`<label class="cont-linha"><span class="cont-v ${tipo}">${rotulo(v)}</span>
    <span class="qtd cont-qtd"><button type="button" data-cont-menos="${v}" aria-label="Menos ${rotulo(v)}">−</button>
      <input inputmode="numeric" data-cont="${v}" value="" placeholder="0" aria-label="Quantidade de ${rotulo(v)}">
      <button type="button" data-cont-mais="${v}" aria-label="Mais ${rotulo(v)}">+</button></span>
    <span class="cont-sub" data-cont-sub="${v}"></span></label>`;
  return html`<div class="contagem">
    <div class="seg cont-modo" role="group" aria-label="Como informar o dinheiro">
      <button type="button" data-cont-modo="notas" class="ativo">Contar notas e moedas</button><button type="button" data-cont-modo="total">Digitar o total</button></div>
    <div class="cont-grade" data-cont-grade>
      <div class="cont-col"><h4>Notas</h4>${NOTAS.map((v) => linha(v, "nota"))}</div>
      <div class="cont-col"><h4>Moedas</h4>${MOEDAS.map((v) => linha(v, "moeda"))}</div>
    </div>
    <label class="field"><span>Dinheiro contado (R$)</span><input class="input lg cont-total" name="${nome}" inputmode="decimal" readonly placeholder="0,00"></label>
  </div>`;
}

/**
 * Liga a contagem dentro do formulário. Devolve { resumo() } com o texto da contagem para a observação.
 * @param {HTMLFormElement} form
 */
export function ligarContagem(form, nome = "valor") {
  const total = form.querySelector(`[name="${nome}"]`);
  const grade = form.querySelector("[data-cont-grade]");
  let modo = "notas";
  const qtd = (v) => Math.max(0, Math.floor(lerNumero(form.querySelector(`[data-cont="${v}"]`).value) || 0));
  const somar = () => {
    let t = 0;
    for (const v of [...NOTAS, ...MOEDAS]) {
      const n = qtd(v); t += n * v;
      form.querySelector(`[data-cont-sub="${v}"]`).textContent = n ? dinheiro(n * v) : "";
    }
    total.value = String(r2(t).toFixed(2)).replace(".", ",");
  };
  form.addEventListener("input", (e) => { if (e.target.dataset.cont) somar(); });
  form.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const v = b.dataset.contMais || b.dataset.contMenos;
    if (v) {
      const inp = form.querySelector(`[data-cont="${v}"]`);
      inp.value = String(Math.max(0, qtd(Number(v)) + (b.dataset.contMais ? 1 : -1)) || "");
      somar(); return;
    }
    if (b.dataset.contModo) {
      modo = b.dataset.contModo;
      form.querySelectorAll("[data-cont-modo]").forEach((x) => x.classList.toggle("ativo", x === b));
      grade.hidden = modo !== "notas";
      total.readOnly = modo === "notas";
      if (modo === "total") { total.focus(); total.select(); } else somar();
    }
  });
  setTimeout(() => form.querySelector('[data-cont="100"]')?.focus(), 50);
  return {
    resumo: () => modo !== "notas" ? "" : [...NOTAS, ...MOEDAS].filter((v) => qtd(v)).map((v) => `${qtd(v)}×${v >= 1 ? v : String(v).replace(".", ",")}`).join(" "),
  };
}
