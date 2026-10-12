// Identidade Lis PDV: o lírio (flor-de-lis) com a faixa cor de pólen e o logotipo "lis" com o pingo de pólen.
// Um só lugar para desenhar a marca em todo o sistema (sistema, app do garçom, mesa, cardápio e site).
// Estilos e animações: assets/marca.css.  Guia rápido:
//   Verde Lis #136F63 (escuro: #34C3AE) · Pólen #F5B82E · Raiz #12201D · Névoa #F2F4F3

export const VERDE = "#136F63";
export const POLEN = "#F5B82E";

// Pétalas e pés do lírio (viewBox 0 0 48 48). A faixa é desenhada à parte, na cor pólen.
const PETALAS = [
  ["centro", "M24 4C29.8 10.2 30.8 19.2 24 28.6C17.2 19.2 18.2 10.2 24 4Z"],
  ["esq", "M21.6 29.6C19.6 22 15.4 15.6 10.6 14.6C6.8 13.8 4.2 16.8 5.2 20.2C5.9 22.6 8.7 23.4 10.2 21.7C8.7 20.6 9.1 18.3 11 18.6C14.6 19.2 17.4 24.4 17.6 29.6Z"],
  ["dir", "M26.4 29.6C28.4 22 32.6 15.6 37.4 14.6C41.2 13.8 43.8 16.8 42.8 20.2C42.1 22.6 39.3 23.4 37.8 21.7C39.3 20.6 38.9 18.3 37 18.6C33.4 19.2 30.6 24.4 30.4 29.6Z"],
  ["pe", "M24 35.2C26.2 37.8 26.1 40.9 24 44C21.9 40.9 21.8 37.8 24 35.2Z M20.6 35.2C19.8 38.6 17.2 40.6 13.8 40.2C16 38.8 17.4 37 17.8 35.2Z M27.4 35.2C28.2 38.6 30.8 40.6 34.2 40.2C32 38.8 30.6 37 30.2 35.2Z"],
];
const FAIXA = '<rect class="lis-faixa" x="14" y="30.4" width="20" height="4.2" rx="2.1" style="fill:var(--lis-polen,#F5B82E)"/>';

/**
 * Símbolo (lírio). cor: cor das pétalas (padrão: cor do texto ao redor).
 * classe extra permite animar (ex.: "lis-abrindo").
 */
export function simbolo({ tam = 32, cor = "currentColor", classe = "", titulo = "" } = {}) {
  const t = titulo ? `<title>${titulo}</title>` : "";
  return `<svg class="lis-simbolo ${classe}" width="${tam}" height="${tam}" viewBox="0 0 48 48" ${titulo ? 'role="img"' : 'aria-hidden="true"'} focusable="false">${t}`
    + `<g style="fill:${cor}">${PETALAS.map(([k, d]) => `<path class="lis-p-${k}" d="${d}"/>`).join("")}</g>${FAIXA}</svg>`;
}

/** Selo: o lírio branco sobre o quadrado Verde Lis (ícone do app, favicon, menu). */
export function selo({ tam = 34, classe = "" } = {}) {
  return `<span class="lis-selo ${classe}" style="--t:${tam}px" aria-hidden="true">${simbolo({ tam: Math.round(tam * 0.74), cor: "#fff" })}</span>`;
}

/** Logotipo "lis" desenhado (não depende de fonte) com o pingo de pólen. */
export function palavra({ altura = 28, classe = "" } = {}) {
  const w = Math.round(altura * 49 / 40);
  return `<svg class="lis-palavra ${classe}" width="${w}" height="${altura}" viewBox="0 0 49 40" aria-hidden="true" focusable="false">`
    + `<g fill="none" stroke="currentColor" stroke-width="6.6" stroke-linecap="round" stroke-linejoin="round">`
    + `<path class="lis-l" d="M6 4.5V34.5"/><path class="lis-i" d="M18.2 17V34.5"/>`
    + `<path class="lis-s" d="M42.4 19.6C40.9 16.9 38.5 15.6 35.7 15.6C31.9 15.6 29.5 17.5 29.5 20.3C29.5 26.7 43.3 22.9 43.3 29.5C43.3 32.8 40.5 34.9 36.2 34.9C32.9 34.9 30.3 33.7 28.7 31.5"/></g>`
    + `<circle class="lis-pingo" cx="18.2" cy="6" r="4.3" style="fill:var(--lis-polen,#F5B82E)"/></svg>`;
}

/** Logotipo completo: lírio + "lis" + PDV. */
export function logotipo({ altura = 28, classe = "", cor = "" } = {}) {
  return `<span class="lis-logo ${classe}" style="--h:${altura}px${cor ? `;color:${cor}` : ""}" role="img" aria-label="Lis PDV">`
    + simbolo({ tam: Math.round(altura * 1.25), cor: "var(--lis-verde-logo, currentColor)" })
    + palavra({ altura }) + `<span class="lis-pdv">PDV</span></span>`;
}

/** Carregador compacto (dentro das telas): o lírio respira, pétala por pétala. */
export function carregador(texto = "Carregando") {
  return `<div class="lis-carregando" role="status" aria-label="${texto}">${simbolo({ tam: 40, cor: "var(--lis-verde-logo, #136F63)", classe: "lis-respira" })}</div>`;
}

/**
 * Abertura (primeira tela ao abrir o sistema). As páginas já trazem a mesma marcação no HTML,
 * para aparecer antes de qualquer script; esta função existe para quem precisa montá-la depois.
 */
export function abertura(sub = "") {
  return `<div class="lis-abertura" id="lis-abertura" role="status" aria-label="Abrindo o Lis PDV">`
    + `<div class="lis-abertura-in">${simbolo({ tam: 96, cor: "var(--lis-verde-logo, #136F63)", classe: "lis-abrindo" })}`
    + `<div class="lis-abertura-nome">${palavra({ altura: 40, classe: "lis-abrindo" })}<span class="lis-pdv">PDV</span></div>`
    + (sub ? `<div class="lis-abertura-sub">${sub}</div>` : "") + `</div></div>`;
}

/** Fecha a abertura com um esmaecer suave (espera o lírio terminar de abrir). */
export function fecharAbertura() {
  const el = document.getElementById("lis-abertura");
  if (!el || el.classList.contains("saindo")) return;
  const falta = Math.max(0, 900 - performance.now());
  setTimeout(() => {
    el.classList.add("saindo");
    setTimeout(() => el.remove(), 420);
  }, falta);
}
