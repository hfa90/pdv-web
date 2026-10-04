// Seletor de itens para mesas (tela Mesas do sistema e app do garçom).
// Toque no produto para somar, ajuste quantidade e observação, e envie de uma vez.
import { sb, q, todos } from "./api.js";
import { html, render, dinheiro, qtd as fmtQtd, lerNumero, toast, modal, pedirTexto } from "./ui.js";

const FRACIONADOS = ["KG", "G", "L", "ML", "M"];
const r2 = (n) => Math.round(n * 100) / 100;
const semAcento = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

let cache = null, cacheEm = 0;
/** Produtos e categorias ativos (cache de 2 minutos). */
export async function catalogo(forcar = false) {
  if (!forcar && cache && Date.now() - cacheEm < 120000) return cache;
  const [categorias, produtos] = await Promise.all([
    q(sb.from("categorias").select("id,nome,cor,ordem").eq("ativo", true).order("ordem").order("nome")),
    todos(() => sb.from("produtos").select("id,nome,codigo,preco_venda,unidade,categoria_id,favorito,imagem_url").eq("ativo", true).order("nome")),
  ]);
  cache = { categorias, produtos }; cacheEm = Date.now();
  return cache;
}

/**
 * Abre o seletor. Resolve com a lista de itens [{produto_id, quantidade, observacao}] ou null.
 * @param {{titulo:string, enviar?:string}} op
 */
export async function escolherItens({ titulo, enviar = "Enviar pedido" }) {
  const { categorias, produtos } = await catalogo();
  if (!produtos.length) { toast("Nenhum produto cadastrado", "erro"); return null; }
  const cor = Object.fromEntries(categorias.map((c) => [c.id, c.cor]));
  let cat = produtos.some((p) => p.favorito) ? "fav" : "todos";
  let busca = "";
  const itens = []; // { produto, quantidade, observacao }

  return modal({
    titulo, largo: true, fixo: true,
    corpo: html`<div class="seletor">
      <input class="input" id="sel-busca" type="search" placeholder="Buscar produto" autocomplete="off" enterkeyhint="search">
      <div class="chips" id="sel-chips"></div>
      <div class="sel-grade" id="sel-grade"></div>
      <div class="sel-carrinho" id="sel-carrinho"></div>
    </div>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary lg" id="sel-enviar" disabled>${enviar}</button>`,
    onPronto: (d, fechar) => {
      d.classList.add("modal-seletor");
      const chips = () => {
        const lista = [];
        if (produtos.some((p) => p.favorito)) lista.push(["fav", "Mais pedidos"]);
        lista.push(["todos", "Todos"]);
        categorias.forEach((c) => lista.push([c.id, c.nome]));
        render(d.querySelector("#sel-chips"), html`${lista.map(([id, nome]) => html`<button type="button" class="chip ${cat === id ? "ativo" : ""}" data-c="${id}">${nome}</button>`)}`);
        d.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { cat = b.dataset.c; chips(); grade(); }));
      };
      const grade = () => {
        const t = semAcento(busca.trim());
        let lista = produtos;
        if (t) lista = lista.filter((p) => semAcento(p.nome).includes(t) || semAcento(p.codigo) === t);
        else if (cat === "fav") lista = lista.filter((p) => p.favorito);
        else if (cat !== "todos") lista = lista.filter((p) => p.categoria_id === cat);
        const noCarrinho = (id) => itens.filter((i) => i.produto.id === id).reduce((a, i) => a + i.quantidade, 0);
        render(d.querySelector("#sel-grade"), lista.length ? html`${lista.slice(0, 200).map((p) => {
          const n = noCarrinho(p.id);
          return html`<button type="button" class="sel-prod ${n ? "tem" : ""}" data-p="${p.id}" style="--cat:${cor[p.categoria_id] || "var(--line-strong)"}">
            ${n ? html`<span class="sel-n">${fmtQtd(n, p.unidade)}</span>` : ""}
            <span class="sel-nome">${p.nome}</span><span class="sel-preco">${dinheiro(p.preco_venda)}</span></button>`;
        })}` : html`<p class="muted" style="grid-column:1/-1;text-align:center;padding:1rem">Nada encontrado.</p>`);
        d.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => somar(produtos.find((p) => p.id === b.dataset.p))));
      };
      const somar = async (p) => {
        let qn = 1;
        if (FRACIONADOS.includes(p.unidade)) {
          const v = await pedirTexto({ titulo: p.nome, rotulo: `Quantidade (${p.unidade.toLowerCase()})`, ok: "Adicionar", dica: "Ex.: 0,350" });
          if (v == null) return;
          qn = lerNumero(v);
          if (!(qn > 0)) return toast("Quantidade inválida", "erro");
        }
        const ex = !FRACIONADOS.includes(p.unidade) && itens.find((i) => i.produto.id === p.id && !i.observacao);
        if (ex) ex.quantidade += qn; else itens.push({ produto: p, quantidade: Math.round(qn * 1000) / 1000, observacao: "" });
        navigator.vibrate?.(15);
        grade(); carrinho();
      };
      const carrinho = () => {
        const total = r2(itens.reduce((a, i) => a + i.quantidade * i.produto.preco_venda, 0));
        const btn = d.querySelector("#sel-enviar");
        btn.disabled = !itens.length;
        btn.textContent = itens.length ? `${enviar} · ${dinheiro(total)}` : enviar;
        render(d.querySelector("#sel-carrinho"), itens.length ? html`<div class="sel-lista">${itens.map((i, idx) => html`
          <div class="sel-item"><div class="grow"><strong>${i.produto.nome}</strong>${i.observacao ? html`<div class="small obs">${i.observacao}</div>` : ""}</div>
            <button type="button" class="btn sm ghost" data-obs="${idx}">${i.observacao ? "Editar obs." : "Obs."}</button>
            <div class="qtd"><button type="button" data-menos="${idx}" aria-label="Diminuir">−</button><span>${fmtQtd(i.quantidade, i.produto.unidade)}</span><button type="button" data-mais="${idx}" aria-label="Aumentar">+</button></div>
          </div>`)}</div>` : html`<p class="muted small" style="text-align:center;margin:.25rem 0">Toque nos produtos para montar o pedido.</p>`);
        d.querySelectorAll("[data-mais]").forEach((b) => (b.onclick = () => { const i = itens[b.dataset.mais]; i.quantidade = r2(i.quantidade + (FRACIONADOS.includes(i.produto.unidade) ? 0.1 : 1)); grade(); carrinho(); }));
        d.querySelectorAll("[data-menos]").forEach((b) => (b.onclick = () => {
          const k = Number(b.dataset.menos), i = itens[k], passo = FRACIONADOS.includes(i.produto.unidade) ? 0.1 : 1;
          if (i.quantidade - passo <= 0) itens.splice(k, 1); else i.quantidade = r2(i.quantidade - passo);
          grade(); carrinho();
        }));
        d.querySelectorAll("[data-obs]").forEach((b) => (b.onclick = async () => {
          const i = itens[b.dataset.obs];
          const v = await pedirTexto({ titulo: i.produto.nome, rotulo: "Observação para a cozinha", valor: i.observacao, ok: "Salvar", dica: "Ex.: sem cebola, bem passado, sem gelo." });
          if (v == null) return;
          i.observacao = v.slice(0, 140); carrinho();
        }));
      };
      const inp = d.querySelector("#sel-busca");
      inp.oninput = () => { busca = inp.value; grade(); };
      d.querySelector("#sel-enviar").onclick = () => fechar(itens.map((i) => ({ produto_id: i.produto.id, quantidade: i.quantidade, observacao: i.observacao || null })));
      // Evita perder um pedido montado ao tocar fora
      d.addEventListener("cancel", (e) => { if (itens.length) e.preventDefault(); });
      chips(); grade(); carrinho();
    },
  });
}
