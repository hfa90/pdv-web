// Hoje: tudo o que pede atenção do dono ou do gerente, numa lista só, com a ação ao lado.
// Os dados vêm de uma chamada (painel_hoje, migração 025) e a lista se atualiza sozinha.
// "Já vi" esconde o aviso até o fim do dia, só neste aparelho.
import { sb, q, rpc } from "../api.js";
import { estado, pode } from "../estado.js";
import { html, render, $, $$, dinheiro, numero, toast, erro, confirmar, ocupado, debounce } from "../ui.js";
import { icone } from "../icons.js";

const GRUPOS = [
  ["urgente", "Agora", "Resolva primeiro"],
  ["atencao", "Hoje", "Antes de fechar o dia"],
  ["info", "Para acompanhar", "Sem pressa"],
];

// ---------- "Já vi" (por aparelho, vale até o fim do dia) ----------
const chaveVistos = () => `hoje-vistos-${estado.empresa?.id || ""}`;
const diaLocal = () => new Date().toLocaleDateString("sv-SE"); // AAAA-MM-DD
function lerVistos() {
  try {
    const v = JSON.parse(localStorage.getItem(chaveVistos()) || "null");
    return v && v.dia === diaLocal() ? new Set(v.chaves) : new Set();
  } catch { return new Set(); }
}
function gravarVistos(set) { try { localStorage.setItem(chaveVistos(), JSON.stringify({ dia: diaLocal(), chaves: [...set] })); } catch { /* sem armazenamento */ } }

/** Quantos avisos de "Agora" e "Hoje" ainda não vistos (contador do menu). */
export async function contarHoje() {
  const r = await rpc("painel_hoje");
  const vistos = lerVistos();
  return (r.itens || []).filter((i) => i.nivel !== "info" && !vistos.has(i.k)).length;
}

/** Contador no item "Hoje" do menu. */
export function marcarMenuHoje(n) {
  const a = document.querySelector('.nav a[data-rota="hoje"]');
  if (!a) return;
  let b = a.querySelector(".nav-badge.hoje");
  if (!b) { b = document.createElement("span"); b.className = "nav-badge hoje"; a.appendChild(b); }
  b.textContent = n || ""; b.hidden = !n;
  b.title = n ? `${n} ${n === 1 ? "assunto pede" : "assuntos pedem"} sua atenção` : "";
}

const variacao = (agora, antes) => {
  if (!antes) return agora ? html`<span class="muted">sem vendas na mesma hora da semana passada</span>` : "";
  const p = ((agora - antes) / antes) * 100;
  return html`<span class="${p >= 0 ? "txt-ok" : "txt-perigo"}">${p >= 0 ? "▲" : "▼"} ${numero(Math.abs(p), 0)}%</span> <span class="muted">vs. semana passada até agora</span>`;
};

export default async function hoje(el) {
  let dados = null, mostrarVistos = false, carregando = false;

  render(el, html`<div class="page hoje">
    <div class="page-head"><div><h1 id="h-saud"></h1><p id="h-data"></p></div>
      <div class="row wrap" style="gap:.5rem"><a class="btn" href="#/painel">Painel completo</a><a class="btn primary" href="#/pdv">Abrir o PDV</a></div></div>
    <div class="hoje-resumo" id="h-resumo"></div>
    <div id="h-lista"><div class="loading"><div class="spinner"></div></div></div>
  </div>`);

  async function carregar() {
    if (carregando) return;
    carregando = true;
    try { dados = await rpc("painel_hoje"); desenhar(); }
    catch (e) {
      if (/painel_hoje|function|não existe|does not exist/i.test(e.message)) {
        render($("#h-lista", el), html`<div class="alerta warn">A tela Hoje precisa da atualização do banco (migração <code>025_hoje_qr_mesa.sql</code>). Peça ao suporte para aplicar.</div>`);
      } else erro(e);
    } finally { carregando = false; }
  }
  const recarregar = debounce(carregar, 600);

  function desenhar() {
    const h = new Date().getHours();
    $("#h-saud", el).textContent = `${h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite"}, ${estado.perfil.nome.split(" ")[0]}`;
    $("#h-data", el).textContent = `${new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })} · atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;

    const r = dados.resumo || {};
    render($("#h-resumo", el), html`
      <div class="panel hoje-kpi"><span class="k-label">Vendido hoje</span><strong>${dinheiro(r.faturamento)}</strong><small>${variacao(Number(r.faturamento), Number(r.semana_passada))}</small></div>
      <div class="panel hoje-kpi"><span class="k-label">Vendas</span><strong>${r.vendas || 0}</strong><small class="muted">ticket médio ${dinheiro(r.ticket)}</small></div>
      <div class="panel hoje-kpi"><span class="k-label">${dados.restaurante ? "Mesas e comandas abertas" : "Pedidos em aberto"}</span><strong>${r.abertos || 0}</strong><small class="muted">${dinheiro(r.abertos_valor)} a receber</small></div>
      <div class="panel hoje-kpi"><span class="k-label">Caixas abertos</span><strong>${r.caixas || 0}</strong><small class="muted">${r.delivery_hoje ? `${r.delivery_hoje} pedido(s) de delivery hoje` : r.caixas ? "vendendo agora" : "nenhum caixa aberto"}</small></div>`);

    const vistos = lerVistos();
    const todos = dados.itens || [];
    const visiveis = todos.filter((i) => mostrarVistos || !vistos.has(i.k));
    const escondidos = todos.length - todos.filter((i) => !vistos.has(i.k)).length;
    marcarMenuHoje(todos.filter((i) => i.nivel !== "info" && !vistos.has(i.k)).length);

    const lista = $("#h-lista", el);
    if (!visiveis.length) {
      render(lista, html`<div class="panel hoje-vazio">${icone("check", 'width="40" height="40"')}
        <h2>Tudo em ordem por aqui</h2><p class="muted">Nada precisa da sua atenção agora. Esta lista se atualiza sozinha.</p>
        ${escondidos ? html`<button class="link-btn" data-a="ver-vistos">Mostrar ${escondidos} ${escondidos === 1 ? "aviso que você já viu" : "avisos que você já viu"}</button>` : ""}</div>`);
    } else {
      render(lista, html`${GRUPOS.map(([nivel, titulo, sub]) => {
        const doGrupo = visiveis.filter((i) => i.nivel === nivel);
        if (!doGrupo.length) return "";
        return html`<section class="hoje-grupo g-${nivel}"><h2>${titulo} <span class="kb-n">${doGrupo.length}</span><small>${sub}</small></h2>
          <div class="hoje-itens">${doGrupo.map((i) => cartao(i, vistos.has(i.k)))}</div></section>`;
      })}
      ${escondidos ? html`<p class="small muted r"><button class="link-btn" data-a="ver-vistos">${mostrarVistos ? "Esconder os que já vi" : `Mostrar ${escondidos} que já vi`}</button></p>` : ""}`);
    }
  }

  function cartao(i, visto) {
    const podeIr = i.rota && pode(i.rota);
    const temAcao = i.acao_tipo || podeIr;
    return html`<article class="hoje-item n-${i.nivel} ${visto ? "visto" : ""}" data-k="${i.k}">
      <span class="hoje-ic">${icone(i.icone || "alerta", 'width="20" height="20"')}</span>
      <div class="grow hoje-txt"><strong>${i.titulo}</strong>${i.detalhe ? html`<span>${i.detalhe}</span>` : ""}</div>
      ${i.valor != null ? html`<span class="hoje-valor">${dinheiro(i.valor)}</span>` : ""}
      <div class="hoje-acoes">
        ${temAcao ? html`<button class="btn sm ${i.nivel === "urgente" ? "primary" : ""}" data-acao="${i.k}">${i.acao || "Ver"}</button>` : ""}
        ${visto ? "" : html`<button class="btn sm ghost icon-btn" data-visto="${i.k}" title="Já vi (esconde até amanhã)" aria-label="Já vi">${icone("fechar", 'width="16" height="16"')}</button>`}
      </div>
    </article>`;
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.a === "ver-vistos") { mostrarVistos = !mostrarVistos; return desenhar(); }
    if (b.dataset.visto) {
      const vistos = lerVistos(); vistos.add(b.dataset.visto); gravarVistos(vistos);
      const card = b.closest(".hoje-item"); card?.classList.add("saindo");
      return setTimeout(desenhar, 180);
    }
    const i = (dados?.itens || []).find((x) => x.k === b.dataset.acao);
    if (!i) return;
    try {
      if (i.acao_tipo === "pagar_conta") {
        if (!(await confirmar(`Marcar “${i.titulo}” (${dinheiro(i.valor)}) como paga hoje?`, { ok: "Marcar paga", titulo: "Conta a pagar" }))) return;
        await ocupado(b, () => q(sb.from("contas_pagar").update({ pago_em: diaLocal(), valor_pago: i.valor, forma: "outros" }).eq("id", i.id)));
        toast("Conta marcada como paga", "ok");
        return carregar();
      }
      if (i.acao_tipo === "chamado") {
        const { resolverChamado } = await import("../chamados-mesa.js");
        if (await resolverChamado(i.id, i.tipo_chamado)) carregar();
        return;
      }
      if (i.rota) location.hash = "#/" + i.rota;
    } catch (err) { erro(err); }
  });

  await carregar();

  // Atualiza sozinho: mudanças em pedidos, cozinha e chamados das mesas, e a cada minuto
  const emp = estado.empresa.id;
  const canal = sb.channel("hoje-" + emp + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "cozinha_pedidos", filter: `empresa_id=eq.${emp}` }, recarregar)
    .on("postgres_changes", { event: "*", schema: "public", table: "vendas", filter: `empresa_id=eq.${emp}` }, recarregar)
    .on("postgres_changes", { event: "*", schema: "public", table: "mesa_chamados", filter: `empresa_id=eq.${emp}` }, recarregar)
    .subscribe();
  const relogio = setInterval(() => { if (!document.hidden) carregar(); }, 60000);
  const aoVoltar = () => { if (!document.hidden) carregar(); };
  document.addEventListener("visibilitychange", aoVoltar);
  return () => { sb.removeChannel(canal); clearInterval(relogio); document.removeEventListener("visibilitychange", aoVoltar); };
}
