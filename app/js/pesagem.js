// Tela de pesagem: mostra o peso da balança ao vivo e devolve a quantidade em kg.
import { html, render, modal, dinheiro, numero, toast } from "./ui.js";
import { icone } from "./icons.js";
import { configBalanca, lerPeso, aoMudar, novoItemSimulador } from "./balanca.js";

/**
 * Abre o visor de pesagem para um produto vendido por peso.
 * Resolve com o peso (kg), "manual" (quer digitar) ou undefined (cancelou).
 */
export function pesar(produto) {
  const c = configBalanca();
  const precoKg = Number(produto.preco_venda) || 0;
  const porGrama = produto.unidade === "G";
  novoItemSimulador();
  return modal({
    titulo: produto.nome,
    fixo: true,
    corpo: html`<div class="stack">
      <div class="peso-visor" id="visor" aria-live="polite">
        <div class="pv-info"><span>${icone("balanca", 'width="16" height="16"')} Balança</span><span id="pv-sit">Aguardando…</span></div>
        <div class="pv-peso"><span id="pv-peso">0,000</span><small>kg</small></div>
      </div>
      <div class="peso-total"><span class="muted">${dinheiro(precoKg)} / ${porGrama ? "g" : "kg"}</span><strong id="pv-total">${dinheiro(0)}</strong></div>
      <p class="hint">${c.autoConfirmar ? "Coloque o produto na balança: o item entra sozinho quando o peso estabilizar." : "Coloque o produto na balança e confirme com Enter."}
        Tara (pote, bandeja) é descontada na própria balança.</p>
    </div>`,
    rodape: html`<button class="btn" data-a="manual">Digitar peso</button><span class="grow"></span>
      <button class="btn" data-fechar>Cancelar</button><button class="btn primary" data-a="ok" disabled>Confirmar <span class="kbd">Enter</span></button>`,
    onPronto: (d, fechar) => {
      let atual = null, iguais = 0, vivo = true, anterior = null;
      const btnOk = d.querySelector('[data-a="ok"]');
      const mostrar = (r) => {
        if (!vivo || !r) return;
        const visor = d.querySelector("#visor");
        const peso = r.peso ?? 0;
        d.querySelector("#pv-peso").textContent = numero(Math.max(0, peso), 3);
        d.querySelector("#pv-sit").textContent = r.erro || (peso <= 0 ? "Coloque o produto" : r.estavel ? "Estável" : "Estabilizando…");
        visor.classList.toggle("instavel", !r.estavel || !!r.erro);
        const qtd = porGrama ? peso * 1000 : peso;
        d.querySelector("#pv-total").textContent = dinheiro(Math.round(qtd * precoKg * 100) / 100);
        const valido = !r.erro && r.estavel && peso > 0;
        atual = valido ? qtd : null;
        btnOk.disabled = !valido;
        iguais = valido && anterior === peso ? iguais + 1 : 0;
        anterior = peso;
        if (c.autoConfirmar && valido && iguais >= 2) { vivo = false; fechar(Math.round(qtd * 1000) / 1000); }
      };
      const tirar = aoMudar((e) => mostrar(e.ultimo));
      const ciclo = async () => {
        while (vivo && d.open) {
          try { mostrar(await lerPeso({ timeout: 900 })); }
          catch (e) { if (vivo) { d.querySelector("#pv-sit").textContent = e.message; } await new Promise((r) => setTimeout(r, 900)); }
          await new Promise((r) => setTimeout(r, 300));
        }
      };
      ciclo();
      d.addEventListener("close", () => { vivo = false; tirar(); });
      btnOk.onclick = () => { if (atual) fechar(Math.round(atual * 1000) / 1000); };
      d.querySelector('[data-a="manual"]').onclick = () => fechar("manual");
      d.addEventListener("keydown", (e) => { if (e.key === "Enter" && atual) { e.preventDefault(); fechar(Math.round(atual * 1000) / 1000); } });
      btnOk.focus?.();
      if (!navigator.serial && c.protocolo !== "simulador") toast("Este navegador não acessa a balança. Use Chrome ou Edge.", "erro");
    },
  });
}
