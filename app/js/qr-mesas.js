// QR Code na mesa (migração 025): imprimir os QRs das mesas e trocar os códigos.
// Cada mesa tem um código próprio (mesas.qr_token). Trocar invalida os QRs já impressos.
import { sb, q, rpc } from "./api.js";
import { estado, eh, cfgRestaurante } from "./estado.js";
import { html, toast, erro, modal, confirmar, ocupado, raw, esc } from "./ui.js";
import { icone } from "./icons.js";
import { linkMesa } from "./links.js";
import { qrSvg, qrPronto } from "../../assets/pix.js";

async function carregarMesas() {
  return q(sb.from("mesas").select("id,numero,nome,area,qr_token").eq("ativo", true).order("area").order("numero"));
}

/** Janela "QR das mesas": explica, mostra um exemplo, imprime e troca os códigos. */
export async function mostrarQrMesas() {
  await qrPronto();
  let mesas;
  try { mesas = await carregarMesas(); }
  catch (e) { return erro(e); }
  if (mesas.length && !mesas[0].qr_token) return toast("Falta atualizar o banco (migração 025_hoje_qr_mesa.sql) para usar o QR na mesa.", "erro");
  const cfg = cfgRestaurante();
  const gestor = eh("admin", "gerente");
  const desligado = cfg.qr_ativo === false;
  const areas = [...new Set(mesas.map((m) => m.area))];

  await modal({
    titulo: "QR Code nas mesas", largo: true,
    corpo: html`<div class="stack">
      ${desligado ? html`<div class="alerta warn">O QR nas mesas está desligado. Ligue em <a href="#/configuracoes/restaurante" data-fechar>Configurações › Restaurante</a>.</div>` : ""}
      <div class="row wrap" style="gap:1.25rem;align-items:flex-start">
        ${mesas[0] ? html`<div class="qr-box">${raw(qrSvg(linkMesa(mesas[0].qr_token), 180))}<div class="small" style="text-align:center;line-height:1.2;padding-top:.3rem">${mesas[0].nome}</div></div>` : ""}
        <div class="stack grow" style="min-width:240px;gap:.5rem">
          <p style="margin:0">O cliente aponta a câmera do celular para o QR da mesa e, <strong>sem baixar app</strong>:</p>
          <ul class="small" style="margin:0;padding-left:1.1rem;display:grid;gap:.2rem">
            <li>vê a conta ao vivo, com o que já está na cozinha;</li>
            <li>chama o garçom e pede a conta (o garçom recebe aviso no app e o caixa no sistema);</li>
            <li>${cfg.qr_pedir !== false ? "faz pedidos: o garçom confirma antes de ir para a cozinha;" : html`<s>faz pedidos</s> (desligado);`}</li>
            <li>${cfg.qr_pagar !== false ? "paga por PIX, a conta toda ou dividida: o valor já entra como pago quando fechar a mesa." : html`<s>paga por PIX</s> (desligado).`}</li>
          </ul>
          <p class="hint" style="margin:0">Cada mesa tem o seu QR. Imprima, plastifique ou coloque num display de acrílico. ${gestor ? html`Escolha o que o cliente pode fazer em <a href="#/configuracoes/restaurante" data-fechar>Configurações › Restaurante</a>.` : ""}</p>
        </div>
      </div>
      ${areas.length > 1 ? html`<label class="field" style="max-width:280px"><span>Imprimir</span><select class="input" id="qr-area">
        <option value="">Todas as mesas (${mesas.length})</option>${areas.map((a) => html`<option value="${a}">${a} (${mesas.filter((m) => m.area === a).length})</option>`)}</select></label>` : ""}
      ${!mesas.length ? html`<p class="muted">Cadastre as mesas primeiro (Editar salão).</p>` : ""}
    </div>`,
    rodape: html`${gestor && mesas.length ? html`<button class="btn ghost" id="qr-trocar" title="Os QRs impressos antes param de funcionar">Trocar todos os códigos</button>` : ""}
      <span class="grow"></span><button class="btn" data-fechar>Fechar</button>
      <button class="btn primary" id="qr-imprimir" ${mesas.length ? "" : "disabled"}>${icone("imprimir", 'width="18" height="18"')} Imprimir QRs</button>`,
    onPronto: (d) => {
      d.querySelector("#qr-imprimir").onclick = () => {
        const a = d.querySelector("#qr-area")?.value;
        imprimir(a ? mesas.filter((m) => m.area === a) : mesas);
      };
      d.querySelector("#qr-trocar")?.addEventListener("click", async (ev) => {
        if (!(await confirmar("Trocar os códigos de todas as mesas? Os QRs já impressos param de funcionar e você precisa imprimir de novo. Use se alguém estiver usando o QR de fora do restaurante.", { ok: "Trocar códigos", perigo: true }))) return;
        try {
          const n = await ocupado(ev.currentTarget, () => rpc("mesa_qr_trocar", { p_mesa: null }));
          mesas = await carregarMesas();
          toast(`${n} código(s) trocado(s). Imprima os novos QRs.`, "ok");
        } catch (e) { erro(e); }
      });
    },
  });
}

/** Folha A4 com 6 QRs por página (cartões para recortar). */
export function imprimir(mesas) {
  const loja = estado.empresa?.nome_fantasia || estado.empresa?.razao_social || "";
  const cartoes = mesas.map((m) => `<div class="c">
      <div class="loja">${esc(loja)}</div>
      <div class="mesa">${esc(m.nome)}</div>
      <div class="qr">${qrSvg(linkMesa(m.qr_token), 260)}</div>
      <div class="cta">Aponte a câmera do celular</div>
      <div class="lista">Veja a conta · Chame o garçom · Peça · Pague com PIX</div>
    </div>`).join("");
  const doc = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>QR das mesas</title><style>
    @page { size: A4; margin: 10mm; }
    * { box-sizing: border-box; } body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #18211F; }
    .g { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
    .c { border: 1px dashed #9AA5A1; border-radius: 4mm; padding: 6mm 5mm; text-align: center; height: 88mm; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5mm; break-inside: avoid; }
    .loja { font-size: 10pt; color: #5E6B67; font-weight: 600; }
    .mesa { font-size: 22pt; font-weight: 800; letter-spacing: -.02em; }
    .qr { width: 46mm; height: 46mm; } .qr svg { width: 100%; height: 100%; }
    .cta { font-size: 11pt; font-weight: 700; } .lista { font-size: 8.5pt; color: #5E6B67; }
  </style></head><body><div class="g">${cartoes}</div></body></html>`;
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write(doc); f.contentDocument.close();
  setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 2000); }, 300);
}
