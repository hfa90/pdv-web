// Páginas legais (termos.html, privacidade.html, tratamento-de-dados.html):
// preenche os dados da empresa a partir de assets/config.js e monta o sumário pelos títulos.
import { LEGAL, MARCA } from "./config.js";

const dataBr = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
const valores = { ...LEGAL, marca: MARCA, vigenteDesde: dataBr(LEGAL.vigenteDesde) };

document.querySelectorAll("[data-legal]").forEach((el) => {
  const v = valores[el.dataset.legal];
  if (v) {
    el.textContent = v;
    if (el.tagName === "A" && /^email/.test(el.dataset.legal)) el.href = "mailto:" + v;
  } else {
    el.textContent = "[a preencher]";
    el.classList.add("legal-falta");
  }
});

// Sumário a partir dos <h2 id> do documento
const sumario = document.getElementById("sumario");
if (sumario) {
  const itens = [...document.querySelectorAll(".legal-texto h2[id]")];
  sumario.innerHTML = "";
  for (const h of itens) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#" + h.id; a.textContent = h.textContent;
    li.appendChild(a); sumario.appendChild(li);
  }
  // Destaca a seção em leitura
  const links = new Map(itens.map((h) => [h, sumario.querySelector(`a[href="#${h.id}"]`)]));
  const obs = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) {
      sumario.querySelectorAll("a.atual").forEach((x) => x.classList.remove("atual"));
      links.get(e.target)?.classList.add("atual");
    }
  }, { rootMargin: "0px 0px -75% 0px" });
  itens.forEach((h) => obs.observe(h));
}

// No celular o sumário começa fechado (não empurra o texto)
if (matchMedia("(max-width: 860px)").matches) document.querySelector(".legal-sumario")?.removeAttribute("open");

document.getElementById("imprimir")?.addEventListener("click", () => print());
