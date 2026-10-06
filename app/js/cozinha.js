// Impressão automática na cozinha dos pedidos que chegam de outros aparelhos:
// pedidos do salão (garçom) assim que forem aprovados pelo caixa e pedidos novos do delivery.
// Liga em Configurações › Impressora, em um único computador.
import { sb } from "./api.js";
import { estado } from "./estado.js";
import { configImpressora, imprimir, layoutCozinha, layoutDelivery } from "./impressao/cupom.js";

let canal = null;
const CHAVE = "pdv-cozinha-impressos";

// Evita imprimir duas vezes se o sistema estiver aberto em mais de uma aba
function jaImpresso(id) {
  let lista = [];
  try { lista = JSON.parse(localStorage.getItem(CHAVE) || "[]"); } catch { /* vazio */ }
  if (lista.includes(id)) return true;
  lista.push(id);
  try { localStorage.setItem(CHAVE, JSON.stringify(lista.slice(-300))); } catch { /* sem armazenamento */ }
  return false;
}

/** Via da cozinha de um pedido do salão (só quando já aprovado). */
async function imprimirPedido(t) {
  if (!["mesa", "balcao"].includes(t.origem) || jaImpresso("t:" + t.id)) return;
  const itens = (t.itens || []).filter((i) => !i.cancelado);
  if (!itens.length) return;
  let quem = "";
  if (t.garcom_id) { const { data } = await sb.from("perfis").select("nome").eq("id", t.garcom_id).maybeSingle(); quem = data?.nome?.split(" ")[0] || ""; }
  await imprimir(layoutCozinha({ identificador: t.identificador, numero: t.numero_venda }, itens, quem));
}

async function imprimirDelivery(vendaId) {
  if (jaImpresso("v:" + vendaId)) return;
  const { data: venda } = await sb.from("vendas").select("*, itens:venda_itens(*)").eq("id", vendaId).single();
  if (venda) await imprimir(layoutDelivery(venda));
}

export function iniciarCozinha() {
  pararCozinha();
  if (!configImpressora().cozinha || !estado.empresa) return;
  const emp = estado.empresa.id;
  canal = sb.channel("cozinha-imp-" + emp)
    .on("postgres_changes", { event: "*", schema: "public", table: "cozinha_pedidos", filter: `empresa_id=eq.${emp}` }, ({ eventType, new: t, old }) => {
      // Imprime quando entra na fila: lançado já aprovado ou aprovado agora pelo caixa
      if (t?.status !== "novo") return;
      if (eventType === "UPDATE" && old?.status && old.status !== "aguardando") return;
      setTimeout(() => imprimirPedido(t).catch(console.error), 300);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "vendas", filter: `empresa_id=eq.${emp}` }, ({ new: v }) => {
      if (["delivery", "retirada"].includes(v.canal)) setTimeout(() => imprimirDelivery(v.id).catch(console.error), 1500);
    })
    .subscribe();
}

export function pararCozinha() {
  if (canal) { sb.removeChannel(canal); canal = null; }
}

window.addEventListener("pdv-impressora", iniciarCozinha);
