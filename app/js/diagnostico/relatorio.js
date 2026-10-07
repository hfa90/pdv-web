// Relatório de diagnóstico em um único arquivo .html (abre em qualquer navegador,
// sem internet). O cliente envia pelo WhatsApp/e-mail e o suporte vê tudo:
// check-up, problemas com a solução, linha do tempo e os dados brutos (JSON).
import { diagnosticar, AREAS, GRAVIDADES } from "./catalogo.js";
import { CSS } from "./estilo.js";

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dh = (t) => new Date(t).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
const hora = (t) => new Date(t).toLocaleTimeString("pt-BR");
const corGrav = (g) => ({ critica: "erro", alta: "erro", media: "aviso", baixa: "info", info: "info" })[g] || "info";
const lista = (xs, cls = "") => (xs?.length ? `<ol class="${cls}">${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : "");

export function montarRelatorio({ checks = [], eventos = [], trilha = [], contexto = {}, versao = "", resumo = "" }) {
  const evs = eventos.filter((e) => e.tipo !== "info" || e.origem === "sistema");
  const grupos = new Map();
  for (const ev of evs) {
    if (ev.tipo === "info") continue;
    const d = diagnosticar(ev);
    const g = grupos.get(d.id) || { d, evs: [], vezes: 0, ultimo: 0 };
    g.evs.push(ev); g.vezes += ev.vezes || 1; g.ultimo = Math.max(g.ultimo, ev.ultimo_em || ev.em);
    grupos.set(d.id, g);
  }
  const gs = [...grupos.values()].sort((a, b) => GRAVIDADES[b.d.gravidade].peso - GRAVIDADES[a.d.gravidade].peso || b.ultimo - a.ultimo);
  const erros = checks.filter((c) => c.status === "erro").length, avisos = checks.filter((c) => c.status === "aviso").length;
  const status = erros || gs.some((g) => ["critica", "alta"].includes(g.d.gravidade) && Date.now() - g.ultimo < 2 * 3600e3) ? "erro" : avisos || gs.length ? "aviso" : "ok";

  const secCheck = `<div class="dg-grade">${[...new Set(checks.map((c) => c.grupo))].map((gr) => `<div class="dg-grupo"><h3>${esc(gr)}</h3>
    ${checks.filter((c) => c.grupo === gr).map((c) => `<div class="dg-check ${c.status === "pulado" ? "info" : c.status}"><span class="dg-luz"></span><span class="dg-check-txt">
      <span class="dg-check-tit">${esc(c.titulo)}</span><span class="dg-check-val">${esc(c.valor || "")}</span>${c.detalhe ? `<span class="dg-check-det">${esc(c.detalhe)}</span>` : ""}</span></div>`).join("")}</div>`).join("")}</div>`;

  const secProb = gs.length ? gs.map((g, i) => {
    const d = g.d, ev = g.evs[g.evs.length - 1], cor = AREAS[d.area]?.cor || "#64748B";
    return `<details class="dg-sec dg-rel-prob" style="--c:${cor}" ${i < 3 ? "open" : ""}>
      <summary><span class="dg-selo ${corGrav(d.gravidade)}">${esc(GRAVIDADES[d.gravidade]?.nome)}</span> <strong>${esc(d.titulo)}</strong> <span class="dg-vezes">${g.vezes}×</span> <span class="dg-muted">· ${esc(AREAS[d.area]?.nome)} · último ${dh(g.ultimo)}</span></summary>
      <div class="dg-msg"><span>Mensagem</span><q>${esc(ev.mensagem)}</q></div>
      <p><strong>O que aconteceu:</strong> ${esc(d.explicacao)}</p>
      ${d.impacto ? `<p class="dg-impacto"><strong>O que para:</strong> ${esc(d.impacto)}</p>` : ""}
      <div class="dg-duas">
        <div><h4>Causas prováveis</h4>${lista(d.causas)}</div>
        <div><h4>O que o operador faz</h4>${lista(d.operador)}</div>
      </div>
      <h4>Para o suporte</h4>${lista(d.tecnico)}
      ${d.sql ? `<pre class="dg-code">${esc(d.sql)}</pre>` : ""}
      ${ev.tecnico?.local ? `<p>Código: <code>${esc(ev.tecnico.local.arquivo)}:${ev.tecnico.local.linha}:${ev.tecnico.local.coluna}</code></p>` : ""}
      ${ev.trilha?.length ? `<h4>Antes do erro</h4><ol class="dg-filme">${ev.trilha.map((t) => `<li><span class="dg-t-hora">${hora(t.em)}</span><span class="dg-t-pino"></span><span>${esc(t.texto)}</span></li>`).join("")}<li class="erro final"><span class="dg-t-hora">${hora(ev.em)}</span><span class="dg-t-pino"></span><span>${esc(ev.mensagem)}</span></li></ol>` : ""}
      <details><summary>Detalhes técnicos</summary><pre class="dg-code">${esc(JSON.stringify({ tecnico: ev.tecnico, contexto: ev.contexto }, null, 2))}</pre></details>
    </details>`;
  }).join("") : `<div class="dg-vazio ok"><p>Nenhum problema registrado.</p></div>`;

  const tempo = [...evs.map((e) => ({ ...e, _ev: true })), ...trilha].sort((a, b) => b.em - a.em).slice(0, 300);
  const secTempo = `<ol class="dg-tempo">${tempo.map((x) => x._ev
    ? `<li class="dg-t-ev ${corGrav(diagnosticar(x).gravidade)}"><span class="dg-t-hora">${hora(x.em)}</span><span class="dg-t-pino"></span><div class="dg-t-cart"><span class="dg-t-tit">${esc(diagnosticar(x).titulo)} ${x.vezes > 1 ? `<span class="dg-vezes">${x.vezes}×</span>` : ""}</span><span class="dg-t-msg">${esc(x.mensagem)}</span><span class="dg-t-meta">${new Date(x.em).toLocaleDateString("pt-BR")} · ${esc(x.contexto?.rota || "")} · ${esc(x.origem)}</span></div></li>`
    : `<li class="dg-t-passo"><span class="dg-t-hora">${hora(x.em)}</span><span class="dg-t-pino"></span><span>${esc(x.texto)}</span></li>`).join("")}</ol>`;

  const dados = JSON.stringify({ gerado_em: new Date().toISOString(), versao, contexto, checks, eventos, trilha, navegador: navigator.userAgent }).replace(/</g, "\\u003c");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnóstico · ${esc(contexto.loja || "PDV")} · ${dh(Date.now())}</title>
<style>${CSS}
body{margin:0;background:var(--dg-bg,#F2F4F3)}
.diag-raiz{--dg-bg:#F2F4F3;background:var(--dg-bg);min-height:100vh}
@media (prefers-color-scheme:dark){.diag-raiz{--bg:#0C1211;--surface:#131A19;--ink:#E4EBE8;--muted:#8F9E99;--line:#233029;--line-strong:#31403B;--primary:#34C3AE;--on-primary:#04211C;--ok-soft:#11291A;--danger-soft:#331512;--amber-soft:#2D2514;--warn-ink:#F3C66E;--dg-bg:#0C1211}}
.dg-rel{max-width:1100px;margin:0 auto;padding:20px 16px 60px;display:flex;flex-direction:column;gap:16px}
.dg-rel h2.dg-h{margin:18px 0 0;font-size:1.1rem}
.dg-rel-prob summary{cursor:pointer;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:2px 0}
.dg-rel-prob[open]>summary{margin-bottom:10px}
.dg-rel-prob{border-left:5px solid var(--c)}
.dg-rel-prob h4{margin:12px 0 4px;font-size:.9rem}
.dg-rel-prob ol{margin:0;padding-left:20px;font-size:.92rem}
.dg-rel .dg-heroi{margin:0}
.dg-rel-ctx{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;font-size:.88rem}
.dg-rel-ctx div{background:var(--dg-sf);border:1px solid var(--dg-ln);border-radius:10px;padding:8px 10px}
.dg-rel-ctx span{display:block;font-size:.72rem;color:var(--dg-mut);text-transform:uppercase;letter-spacing:.05em;font-weight:700}
.dg-resumo{white-space:pre-wrap;font-size:.85rem}
</style></head><body><div class="diag-raiz"><div class="dg-rel">
  <header class="dg-topo" style="border-radius:14px;border:1px solid var(--dg-ln)"><div class="dg-titulo"><div class="dg-logo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/></svg></div>
    <div><h1>Relatório de diagnóstico</h1><p class="dg-sub">Gerado em ${dh(Date.now())} · versão ${esc(versao)}</p></div></div></header>
  <section class="dg-heroi ${status}"><div class="dg-semaforo"><span class="r"></span><span class="a"></span><span class="v"></span></div>
    <div class="dg-heroi-txt"><div class="dg-heroi-rot">Situação no momento do relatório</div>
    <h2>${status === "erro" ? esc(gs[0]?.d.titulo || checks.find((c) => c.status === "erro")?.titulo + ": " + checks.find((c) => c.status === "erro")?.valor) : status === "aviso" ? "Funcionando, com pontos de atenção" : "Tudo funcionando"}</h2>
    <div class="dg-placar"><span class="ok">${checks.filter((c) => c.status === "ok").length} ok</span><span class="aviso">${avisos} atenção</span><span class="erro">${erros} problema(s)</span><span class="info">${gs.length} tipo(s) de erro registrados</span></div></div></section>
  <div class="dg-rel-ctx">
    <div><span>Loja</span>${esc(contexto.loja || "—")}</div><div><span>Usuário</span>${esc(contexto.usuario || "—")} ${contexto.papel ? "(" + esc(contexto.papel) + ")" : ""}</div>
    <div><span>Aparelho</span>${esc(contexto.aparelho || "—")}</div><div><span>Tela</span>${esc(contexto.rota || "—")}</div>
    <div><span>Internet</span>${contexto.online ? "conectado" : "sem conexão"}</div><div><span>Navegador</span>${esc((navigator.userAgent.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/) || [""])[0])}</div>
  </div>
  <h2 class="dg-h">Check-up</h2>${secCheck}
  <h2 class="dg-h">Problemas encontrados (com solução)</h2>${secProb}
  <h2 class="dg-h">Linha do tempo (erros e cliques)</h2>${secTempo}
  <details class="dg-sec"><summary><strong>Resumo em texto</strong></summary><pre class="dg-resumo">${esc(resumo)}</pre></details>
  <details class="dg-sec"><summary><strong>Dados brutos (JSON)</strong></summary><pre class="dg-code" id="json"></pre></details>
</div></div>
<script type="application/json" id="dados">${dados}</script>
<script>document.getElementById("json").textContent=JSON.stringify(JSON.parse(document.getElementById("dados").textContent),null,2)</script>
</body></html>`;
}
