// Impressão automática dos pedidos que chegam de outros aparelhos:
// itens lançados pelo app do garçom (via da cozinha) e pedidos novos do delivery.
// Liga em Configurações › Impressora, em um único computador.
import { sb } from "./api.js";
import { estado } from "./estado.js";
import { configImpressora, imprimir, layoutCozinha, layoutDelivery } from "./impressao/cupom.js";

let canal = null;
const pendentes = new Map(); // venda_id -> { timer, ids:Set }
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

async function imprimirItens(vendaId, ids) {
  const novos = [...ids].filter((id) => !jaImpresso("i:" + id));
  if (!novos.length) return;
  const [{ data: venda }, { data: itens }] = await Promise.all([
    sb.from("vendas").select("id,numero,identificador,canal").eq("id", vendaId).single(),
    sb.from("venda_itens").select("id,descricao,quantidade,unidade,observacao,item,criado_por,removido").in("id", novos).order("item"),
  ]);
  if (!venda || !itens?.length) return;
  const vivos = itens.filter((i) => !i.removido);
  if (!vivos.length) return;
  const { data: quem } = await sb.from("perfis").select("nome").eq("id", vivos[0].criado_por).maybeSingle();
  await imprimir(layoutCozinha(venda, vivos, quem?.nome?.split(" ")[0]));
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
  canal = sb.channel("cozinha-" + emp)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "venda_itens", filter: `empresa_id=eq.${emp}` }, ({ new: i }) => {
      if (!i.criado_por) return; // só itens do garçom (o caixa imprime os seus)
      const p = pendentes.get(i.venda_id) || { ids: new Set() };
      p.ids.add(i.id);
      clearTimeout(p.timer);
      // Junta os itens enviados de uma vez numa única via
      p.timer = setTimeout(() => { pendentes.delete(i.venda_id); imprimirItens(i.venda_id, p.ids).catch(console.error); }, 1200);
      pendentes.set(i.venda_id, p);
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
