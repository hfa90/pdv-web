// Aviso de novo pedido do delivery em qualquer tela: som, toast e contador no menu.
import { sb } from "./api.js";
import { estado } from "./estado.js";
import { toast } from "./ui.js";

let canal = null;

/** Bipe curto gerado no navegador (sem arquivo de áudio). */
export function bipe(vezes = 2) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < vezes; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = i % 2 ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.28);
      g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + i * 0.28 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.28 + 0.24);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.28); o.stop(ctx.currentTime + i * 0.28 + 0.26);
    }
    setTimeout(() => ctx.close(), vezes * 300 + 200);
  } catch { /* sem áudio */ }
}

export async function contarNovos() {
  const { count } = await sb.from("vendas").select("id", { count: "exact", head: true })
    .eq("status", "aberta").in("canal", ["delivery", "retirada"]).eq("status_pedido", "recebido");
  const a = document.querySelector('.nav a[data-rota="delivery"]');
  if (!a) return;
  let b = a.querySelector(".nav-badge");
  if (!b) { b = document.createElement("span"); b.className = "nav-badge"; a.appendChild(b); }
  b.textContent = count || ""; b.hidden = !count;
}

export function iniciarAvisos() {
  if (canal) sb.removeChannel(canal);
  canal = null;
  if (!estado.empresa) return;
  contarNovos().catch(() => {});
  canal = sb.channel("avisos-" + estado.empresa.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "vendas", filter: `empresa_id=eq.${estado.empresa.id}` }, ({ eventType, new: v }) => {
      if (!["delivery", "retirada"].includes(v?.canal)) return;
      contarNovos().catch(() => {});
      if (eventType === "INSERT" && !location.hash.startsWith("#/delivery")) {
        bipe(3);
        toast(`Novo pedido ${v.canal === "delivery" ? "para entrega" : "para retirada"} nº ${v.numero}`, "ok");
      }
    })
    .subscribe();
}
