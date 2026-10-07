// Tela Diagnóstico (menu): o mesmo painel do Ctrl+Shift+D, dentro do sistema.
export default async function telaDiagnostico(alvo) {
  const box = document.createElement("div");
  box.className = "page";
  alvo.innerHTML = "";
  alvo.appendChild(box);
  const { montarNaPagina } = await import("../diagnostico/painel.js");
  return montarNaPagina(box);
}
