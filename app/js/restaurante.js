// Regras visuais do restaurante compartilhadas entre Mesas, app do garçom e cozinha:
// tempo de ocupação, situação dos pedidos da cozinha e valores de serviço/couvert.
import { cfgRestaurante } from "./estado.js";
import { html, dinheiro, numero } from "./ui.js";
import { icone } from "./icons.js";

export const minutosDesde = (d) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d)) / 60000)) : 0);
export const duracao = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`);

export const ETAPA_COZINHA = {
  aguardando: "Aguardando aprovação", novo: "Na fila", preparando: "Preparando", pronto: "Pronto",
  entregue: "Servido", recusado: "Recusado", cancelado: "Cancelado",
};

/** Nível do tempo de ocupação da mesa: ok | alerta | critico (limites em Configurações › Restaurante). */
export function nivelTempo(min) {
  const c = cfgRestaurante();
  return min >= c.tempo_critico_min ? "critico" : min >= c.tempo_alerta_min ? "alerta" : "ok";
}

/** Informações de tempo de uma mesa ocupada (linha de mesas_painel). */
export function tempoMesa(m) {
  const c = cfgRestaurante();
  const min = minutosDesde(m.aberta_em);
  const semPedir = m.ultimo_item_em ? minutosDesde(m.ultimo_item_em) : min;
  return {
    min, nivel: nivelTempo(min),
    fracao: Math.min(1, min / Math.max(1, c.tempo_critico_min)),
    semPedir, ociosa: !m.conta_pedida && semPedir >= c.ocioso_min,
    contaHa: m.conta_pedida_em ? minutosDesde(m.conta_pedida_em) : null,
  };
}

/** Barra de tempo usada nos cartões de mesa (cor muda em alerta/crítico). */
export function barraTempo(m) {
  const t = tempoMesa(m);
  return html`<span class="tempo-barra t-${t.nivel}" aria-hidden="true"><i style="width:${Math.round(t.fracao * 100)}%"></i></span>`;
}

/** Selos da cozinha num cartão de mesa: aguardando aprovação, em preparo e pronto para servir. */
export function selosCozinha(cz) {
  if (!cz) return "";
  return html`${cz.pronto ? html`<span class="selo-cz pronto" title="Pedido pronto para servir">${icone("sino", 'width="12" height="12"')}${cz.pronto}</span>` : ""}
    ${cz.aguardando ? html`<span class="selo-cz aguardando" title="Aguardando aprovação do caixa">${icone("ampulheta", 'width="12" height="12"')}${cz.aguardando}</span>` : ""}
    ${cz.preparo && !cz.pronto ? html`<span class="selo-cz preparo" title="Na cozinha">${icone("fogo", 'width="12" height="12"')}${cz.preparo}</span>` : ""}`;
}

/** Legenda do tempo de ocupação. */
export function legendaTempo() {
  const c = cfgRestaurante();
  return html`<span class="legenda-tempo"><span class="tempo-barra t-ok"><i style="width:100%"></i></span> até ${duracao(c.tempo_alerta_min)}
    <span class="tempo-barra t-alerta"><i style="width:100%"></i></span> ${duracao(c.tempo_alerta_min)}+
    <span class="tempo-barra t-critico"><i style="width:100%"></i></span> ${duracao(c.tempo_critico_min)}+</span>`;
}

// ---------- Taxa de serviço e couvert ----------
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const taxaServico = (base, pct) => (Number(pct) > 0 ? r2(base * Number(pct) / 100) : 0);
export const couvertTotal = (unit, pessoas) => (Number(unit) > 0 ? r2(Number(unit) * Math.max(1, Number(pessoas) || 1)) : 0);
export const rotuloServico = (pct) => `Taxa de serviço (${numero(pct, Number(pct) % 1 ? 1 : 0)}%)`;
export function rotuloCouvert(unit, pessoas) {
  const c = cfgRestaurante();
  const p = Math.max(1, Number(pessoas) || 1);
  return `${c.couvert_nome || "Couvert"} (${p} × ${dinheiro(unit)})`;
}
