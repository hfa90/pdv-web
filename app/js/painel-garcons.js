// Painel ao vivo dos garçons (administrador): um boneco por garçom com a % da meta,
// quanto está faturando agora (mesas abertas), no dia, na semana e no mês, e o mapa
// do salão com a cor de quem atende cada mesa. Atualiza sozinho (tempo real).
import { sb, rpc } from "./api.js";
import { estado } from "./estado.js";
import { html, render, $, $$, dinheiro, numero, debounce, rotuloMesa, iniciais, raw } from "./ui.js";
import { icone } from "./icons.js";
import { duracao, minutosDesde } from "./restaurante.js";

export const CORES = ["#136F63", "#3B6FE0", "#D9467A", "#E8772E", "#8B5CF6", "#2F9E44", "#B7791F", "#0E7490", "#BE185D", "#4B5563"];
const PELES = ["#F1C7A0", "#D9A27A", "#B9805A", "#8D5B3C", "#F5D3B5"];
const CABELOS = ["#2B1D14", "#5A3825", "#111827", "#7C4A1E", "#3F2A1D"];
const PERIODOS = [["hoje", "Hoje"], ["semana", "Semana"], ["mes", "Mês"]];

/** Boneco de garçom em SVG: cor do uniforme, expressão conforme o desempenho e anel de progresso. */
export function boneco(cor, i, pct, { tamanho = 120, anel = true } = {}) {
  const f = Math.max(0, Math.min(1, pct ?? 0));
  const humor = pct == null ? "neutro" : pct >= 1 ? "festa" : pct >= 0.6 ? "feliz" : pct >= 0.3 ? "neutro" : "preocupado";
  const pele = PELES[i % PELES.length], cabelo = CABELOS[(i * 3) % CABELOS.length];
  const C = 2 * Math.PI * 52;
  const boca = { festa: "M42 49 Q50 58 58 49 Z", feliz: "M43 49 Q50 55 57 49", neutro: "M44 51 L56 51", preocupado: "M43 53 Q50 48 57 53" }[humor];
  const sobr = humor === "preocupado" ? '<path d="M40 38 q3 -3 6 -2 M60 38 q-3 -3 -6 -2" stroke="#3a2a20" stroke-width="1.6" fill="none" stroke-linecap="round"/>' : "";
  return raw(`<svg class="boneco humor-${humor}" viewBox="0 0 120 120" width="${tamanho}" height="${tamanho}" role="img" aria-label="Garçom ${Math.round(f * 100)}%">
    ${anel ? `<circle cx="60" cy="60" r="52" fill="none" stroke="var(--line)" stroke-width="7"/>
    <circle cx="60" cy="60" r="52" fill="none" stroke="${f >= 1 ? "var(--ok)" : cor}" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 60 60)" class="boneco-anel"/>` : ""}
    <g transform="translate(10 8)">
      <path d="M22 98 C22 76 34 66 50 66 C66 66 78 76 78 98 Z" fill="${cor}"/>
      <path d="M43 66 L50 80 L57 66 Z" fill="#fff"/>
      <path d="M44 69 L50 72 L56 69 L56 75 L50 72 L44 75 Z" fill="#111"/>
      <rect x="46" y="58" width="8" height="9" rx="3" fill="${pele}"/>
      <circle cx="50" cy="44" r="16" fill="${pele}"/>
      <path d="M34 42 C34 28 44 24 51 24 C60 24 67 30 66 42 C62 35 55 33 50 34 C44 35 38 36 34 42 Z" fill="${cabelo}"/>
      <circle cx="44.5" cy="44" r="1.9" fill="#2a1d14"/><circle cx="55.5" cy="44" r="1.9" fill="#2a1d14"/>
      ${sobr}
      <path d="${boca}" stroke="#7a2e22" stroke-width="2" fill="${humor === "festa" ? "#7a2e22" : "none"}" stroke-linecap="round"/>
      <g class="bandeja" transform="translate(70 66)"><ellipse cx="8" cy="0" rx="12" ry="3" fill="#9CA3AF"/><rect x="5" y="-9" width="6" height="9" rx="1.5" fill="#F2B33D"/></g>
      ${humor === "festa" ? '<g fill="#F2B33D"><path d="M20 20 l2 5 5 1-5 2-2 5-2-5-5-2 5-1z"/><path d="M80 14 l1.5 4 4 .8-4 1.6-1.5 4-1.5-4-4-1.6 4-.8z"/></g>' : ""}
    </g></svg>`);
}

/**
 * @param {HTMLElement} alvo
 * @returns {Promise<() => void>} função para parar o tempo real
 */
export async function desenharAoVivo(alvo) {
  let per = "hoje", dados = null, mesas = [], atualizadoEm = null;
  render(alvo, html`<div class="aovivo" id="aovivo">
    <div class="aovivo-topo">
      <div class="seg" role="group" aria-label="Período">${PERIODOS.map(([k, n]) => html`<button data-per="${k}" class="${k === per ? "ativo" : ""}">${n}</button>`)}</div>
      <span class="aovivo-status"><span class="pulso"></span> <span id="av-hora">ao vivo</span></span>
      <span class="grow"></span>
      <button class="btn" id="av-cheia">${icone("telaCheia", 'width="18" height="18"')} Tela cheia</button>
    </div>
    <div id="av-equipe"></div>
    <div class="aovivo-grade" id="av-grade"></div>
    <section class="panel panel-pad aovivo-mapa"><div class="row" style="justify-content:space-between"><h2>Quem está em cada mesa</h2><span class="small muted" id="av-leg"></span></div>
      <div id="av-mapa"></div></section>
  </div>`);

  const metaDo = (g) => {
    const m = Number(g.meta_mensal) || 0;
    if (!m) return 0;
    return per === "mes" ? m : per === "semana" ? (m / dados.dias_mes) * 7 : m / dados.dias_mes;
  };

  function desenhar() {
    if (!dados) return;
    const gs = [...dados.garcons];
    const cor = new Map(gs.slice().sort((a, b) => a.nome.localeCompare(b.nome)).map((g, i) => [g.id, { cor: CORES[i % CORES.length], i }]));
    const lider = Math.max(1, ...gs.map((g) => Number(g[per].consumo)));
    gs.sort((a, b) => Number(b[per].consumo) - Number(a[per].consumo) || Number(b.agora.consumo) - Number(a.agora.consumo));
    const tot = (k) => gs.reduce((a, g) => a + Number(k === "agora" ? g.agora.consumo : g[k].consumo), 0);
    const nomePer = { hoje: "do dia", semana: "da semana", mes: "do mês" }[per];

    render($("#av-equipe", alvo), html`<div class="aovivo-equipe">
      <div><span>${icone("mesa", 'width="18" height="18"')} Em mesa agora</span><strong>${dinheiro(tot("agora"))}</strong><small>${gs.reduce((a, g) => a + g.agora.mesas, 0)} mesas abertas</small></div>
      <div><span>Hoje</span><strong>${dinheiro(tot("hoje"))}</strong><small>${gs.reduce((a, g) => a + g.hoje.mesas, 0)} mesas fechadas</small></div>
      <div><span>Semana</span><strong>${dinheiro(tot("semana"))}</strong><small>desde segunda</small></div>
      <div><span>Mês</span><strong>${dinheiro(tot("mes"))}</strong><small>dia ${dados.dia} de ${dados.dias_mes}</small></div></div>`);

    render($("#av-grade", alvo), gs.length ? html`${gs.map((g, pos) => {
      const { cor: c, i } = cor.get(g.id);
      const meta = metaDo(g);
      const pct = meta ? Number(g[per].consumo) / meta : Number(g[per].consumo) / lider;
      const ult = g.ultimo_lancamento ? minutosDesde(g.ultimo_lancamento) : null;
      const ativo = g.agora.mesas > 0 || (ult != null && ult < 30);
      const linha = (k, n) => {
        const v = Number(k === "agora" ? g.agora.consumo : g[k].consumo);
        const ref = k === "agora" ? null : metaDoPer(g, k);
        return html`<div class="av-linha ${k === per ? "atual" : ""}"><span>${n}</span><strong>${dinheiro(v)}</strong>
          ${ref ? html`<i class="av-mini"><b style="width:${Math.min(100, (v / ref) * 100)}%;background:${c}"></b></i>` : html`<i></i>`}</div>`;
      };
      return html`<article class="av-card ${ativo ? "ativo" : "parado"}" style="--cor:${c}">
        ${pos < 3 && Number(g[per].consumo) > 0 ? html`<span class="av-medalha m${pos + 1}">${pos + 1}º</span>` : ""}
        <div class="av-boneco">${boneco(c, i, pct)}<span class="av-pct" style="color:${pct >= 1 ? "var(--ok)" : c}">${numero(Math.round(pct * 100))}%</span></div>
        <div class="av-pct-rot">${meta ? `da meta ${nomePer}` : "em relação ao líder"}</div>
        <h3 class="av-nome">${g.nome}</h3>
        <div class="av-estado">${g.agora.mesas ? html`<span class="badge" style="background:color-mix(in srgb, ${c} 14%, var(--surface));color:${c}">${g.agora.mesas} mesa(s): ${g.agora.nomes.map((n) => rotuloMesa(n).replace(/^Mesa\s+/i, "")).join(", ")}</span>` : html`<span class="badge">sem mesa aberta</span>`}
          ${g.prontos ? html`<span class="badge ok">${icone("sino", 'width="12" height="12"')} ${g.prontos} pronto(s)</span>` : ""}
          ${g.agora.contas_pedidas ? html`<span class="badge danger">${g.agora.contas_pedidas} conta(s)</span>` : ""}</div>
        <div class="av-linhas">${linha("agora", "Agora")}${linha("hoje", "Hoje")}${linha("semana", "Semana")}${linha("mes", "Mês")}</div>
        <div class="av-rodape small muted">${g[per].mesas} mesa(s) ${nomePer} · ticket ${dinheiro(g[per].ticket_mesa)} · comissão ${dinheiro(g[per].comissao)}
          <br>${ult != null ? `último pedido há ${duracao(ult)}` : "nenhum pedido hoje"}</div>
      </article>`;
    })}` : html`<div class="panel panel-pad empty">${icone("usuarios", 'width="40" height="40"')}<p>Nenhum garçom ainda. Crie em <a href="#/usuarios">Usuários</a> com o nível Atendente / garçom.</p></div>`);

    // Mapa do salão com a cor do garçom de cada mesa
    render($("#av-leg", alvo), html`${gs.map((g) => html`<span class="av-leg"><i style="background:${cor.get(g.id).cor}"></i>${g.nome.split(" ")[0]}</span>`)}`);
    if (!mesas.length) { render($("#av-mapa", alvo), html`<p class="muted small">Cadastre as mesas em Mesas para ver o salão aqui.</p>`); return; }
    const maxX = Math.max(20, ...mesas.map((m) => m.pos_x + (m.formato === "retangular" ? 5 : 3) + 1));
    const maxY = Math.max(8, ...mesas.map((m) => m.pos_y + 4));
    const larg = $("#av-mapa", alvo).clientWidth || 900;
    const cel = Math.max(14, Math.min(30, Math.floor((larg - 8) / maxX)));
    render($("#av-mapa", alvo), html`<div class="av-salao" style="width:${maxX * cel}px;height:${maxY * cel}px">${mesas.map((m) => {
      const g = m.venda_id && cor.get(m.garcom_id);
      const w = (m.formato === "retangular" ? 5 : 3) * cel, h = 3 * cel;
      return html`<div class="av-mesa ${m.formato === "redonda" ? "redonda" : ""} ${g ? "ocupada" : ""} ${m.conta_pedida ? "conta" : ""}"
        style="left:${m.pos_x * cel}px;top:${m.pos_y * cel}px;width:${w}px;height:${h}px;${g ? `--cor:${g.cor}` : ""}" title="${m.nome}${g ? ` · ${m.garcom || ""} · ${dinheiro(m.total)}` : " · livre"}">
        <b>${m.nome.replace(/^Mesa\s+/i, "")}</b>${g ? html`<span class="av-cabeca">${iniciais(m.garcom || "")}</span>` : ""}</div>`;
    })}</div>`);
  }
  const metaDoPer = (g, k) => { const s = per; per = k; const v = metaDo(g); per = s; return v; };

  async function carregar() {
    try {
      const [d, m] = await Promise.all([rpc("garcons_ao_vivo"), rpc("mesas_painel").catch(() => [])]);
      dados = d; mesas = m; atualizadoEm = new Date();
      $("#av-hora", alvo).textContent = "ao vivo · " + atualizadoEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      desenhar();
    } catch (e) {
      render($("#av-grade", alvo), html`<div class="alerta">${/garcons_ao_vivo|function/.test(e.message) ? "Atualização do banco pendente (migração 016)." : e.message}</div>`);
    }
  }
  const carregarDepois = debounce(() => carregar(), 1200);

  $$("[data-per]", alvo).forEach((b) => (b.onclick = () => { per = b.dataset.per; $$("[data-per]", alvo).forEach((x) => x.classList.toggle("ativo", x === b)); desenhar(); }));
  $("#av-cheia", alvo).onclick = () => {
    const el = $("#aovivo", alvo);
    if (document.fullscreenElement) document.exitFullscreen?.(); else el.requestFullscreen?.().catch(() => {});
  };

  await carregar();
  const emp = estado.empresa.id;
  const canal = sb.channel("aovivo-" + emp + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "vendas", filter: `empresa_id=eq.${emp}` }, carregarDepois)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "venda_itens", filter: `empresa_id=eq.${emp}` }, carregarDepois)
    .on("postgres_changes", { event: "*", schema: "public", table: "cozinha_pedidos", filter: `empresa_id=eq.${emp}` }, carregarDepois)
    .subscribe();
  const relogio = setInterval(() => { if (!document.hidden) carregar(); }, 60000);
  const aoRedim = debounce(desenhar, 250);
  window.addEventListener("resize", aoRedim);
  return () => { sb.removeChannel(canal); clearInterval(relogio); window.removeEventListener("resize", aoRedim); if (document.fullscreenElement) document.exitFullscreen?.(); };
}

