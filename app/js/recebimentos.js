// Caixa principal: aviso quando um garçom fecha a conta no app (PIX ou cartão).
// O pagamento já entra neste caixa no servidor; aqui só avisa, atualiza a tela e,
// se ligado em Configurações › Impressora, imprime o cupom neste computador.
import { sb } from "./api.js";
import { estado } from "./estado.js";
import { toast, dinheiro, rotuloMesa } from "./ui.js";
import { bipe } from "./avisos.js";
import { configImpressora, imprimirVenda } from "./impressao/cupom.js";

let canal = null;
const vistos = new Set();

export function iniciarRecebimentos() {
  pararRecebimentos();
  if (!estado.empresa) return;
  canal = sb.channel("receb-app-" + estado.empresa.id + "-" + Date.now())
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "vendas", filter: `empresa_id=eq.${estado.empresa.id}` }, ({ new: v }) => {
      if (v?.status !== "finalizada" || !v.recebido_no_app || vistos.has(v.id)) return;
      if (!estado.caixa || v.sessao_id !== estado.caixa.id) return; // só no caixa que recebeu
      vistos.add(v.id);
      bipe(1);
      toast(`${rotuloMesa(v.identificador) || "Conta nº " + v.numero} fechada pelo garçom no app · ${dinheiro(v.total)} entrou no seu caixa`, "ok");
      if (configImpressora().imprimirApp) setTimeout(() => imprimirVenda(v.id).catch((e) => toast("Impressão: " + e.message, "erro")), 800);
      window.dispatchEvent(new CustomEvent("pdv-recebimento-app", { detail: v }));
    })
    .subscribe();
}

export function pararRecebimentos() {
  if (canal) sb.removeChannel(canal);
  canal = null;
}
