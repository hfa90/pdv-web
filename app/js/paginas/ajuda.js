// =====================================================================
// Central de Ajuda (menu Ajuda, tecla F1)
// ---------------------------------------------------------------------
// Um "Google" do próprio sistema: a pessoa escreve do jeito dela, cola a
// mensagem de erro ou anexa um print/foto/PDF e recebe o passo a passo.
// As respostas são os artigos escritos pela equipe (ajuda/artigos.js) e
// o catálogo do Diagnóstico — NÃO há IA gerando texto.
// Rotas: #/ajuda · #/ajuda/q/<busca> · #/ajuda/a/<artigo> · #/ajuda/c/<categoria>
// =====================================================================
import { sb } from "../api.js";
import { estado, pode, papel, ehSuper, tituloRota, ROTAS, PAPEIS } from "../estado.js";
import { html, render, $, $$, toast, erro, debounce } from "../ui.js";
import { icone } from "../icons.js";
import { buscar, sugerir, porId, documentos, podeVer, nomeCategoria, iconeCategoria, CATEGORIAS, reconhecerErro } from "../ajuda/busca.js";
import { TELAS, PAPEIS_AJUDA } from "../ajuda/telas.js";

// Continua valendo enquanto a pessoa navega entre artigos e a busca
const memoria = { anexos: [], vistos: [], ultimaBusca: "" };
let seq = 0;

const perfil = () => ({ papel: papel(), equipe: !!estado.equipe, super: ehSuper() });
const APOSTILA = "../assets/Manual-PDV.pdf";

/** Registra o que foi procurado (ajuda a equipe a melhorar as explicações). Nunca atrapalha. */
export function registrar(origem, { termo = null, resultados = null, artigo = null, util = null } = {}) {
  if (estado.equipe || estado.suporte || estado.offline || !navigator.onLine) return;
  sb.rpc("ajuda_registrar", { p_origem: origem, p_termo: termo, p_resultados: resultados, p_artigo: artigo, p_util: util }).then(() => {}, () => {});
}

const EXEMPLOS = {
  admin: ["Como cadastro um funcionário?", "Mudar o preço de um produto", "Fazer backup", "Quanto lucrei este mês?", "Configurar a impressora"],
  gerente: ["Dar entrada na nota do fornecedor", "Cancelar uma venda", "Criar uma promoção", "Contagem de estoque", "O resumo por e-mail não chega"],
  caixa: ["Como abro o caixa?", "Tirar dinheiro da gaveta", "Cliente quer pagar depois", "A impressora não imprime", "Fechar o caixa"],
  atendente: ["Como abro uma mesa?", "Transferir itens de mesa", "Pedido não chegou na cozinha", "Pedir a conta", "Instalar o app do garçom"],
  cozinha: ["Pedido não chegou na cozinha", "Marcar pedido pronto", "O som não toca", "O sistema travou"],
};

export default async function telaAjuda(el, params = []) {
  const [modo, ...resto] = params;
  const valor = decodeURIComponent(resto.join("/") || "");
  const minhaVez = ++seq;
  const q = modo === "q" ? valor : "";
  render(el, html`<div class="page ajuda-page">
    <section class="ajuda-hero">
      <div class="ajuda-hero-tit">${icone("ajuda", 'width="30" height="30"')}<div><h1>Central de Ajuda</h1>
        <p>Escreva sua dúvida do seu jeito, cole a mensagem de erro ou anexe um print. Respondemos com o passo a passo.</p></div></div>
      <form class="ajuda-busca" id="f-busca" role="search" autocomplete="off">
        <span class="ajuda-lupa">${icone("busca", 'width="20" height="20"')}</span>
        <input id="q" name="q" type="search" value="${q}" placeholder="Ex.: como abro o caixa? · a impressora não imprime" aria-label="Sua dúvida" enterkeyhint="search" maxlength="500">
        <label class="btn ghost icon-btn" title="Anexar print, foto ou documento" aria-label="Anexar print, foto ou documento">${icone("clipe", 'width="20" height="20"')}
          <input type="file" id="arq" accept="image/*,application/pdf,.txt,.log,.csv,.json,.doc,.docx" multiple hidden></label>
        <button class="btn primary">Buscar</button>
        <div class="ajuda-sugestoes" id="sug" role="listbox" hidden></div>
      </form>
      <div id="anexos" class="ajuda-anexos"></div>
      <div class="chips wrap ajuda-exemplos">${(EXEMPLOS[papel()] || EXEMPLOS.caixa).map((x) => html`<button type="button" class="chip" data-ex="${x}">${x}</button>`)}</div>
    </section>
    <div id="ajuda-corpo"></div>
  </div>`);

  const inp = $("#q", el), sug = $("#sug", el), corpo = $("#ajuda-corpo", el);
  const ir = (h) => { if (location.hash === h) telaAjuda(el, h.replace(/^#\/ajuda\/?/, "").split("/")); else location.hash = h; };
  const buscarTexto = (t) => { t = String(t || "").trim(); if (t) ir("#/ajuda/q/" + encodeURIComponent(t.slice(0, 500))); };

  $("#f-busca", el).onsubmit = (e) => { e.preventDefault(); sug.hidden = true; if (inp.value.trim()) buscarTexto(inp.value); else if (memoria.anexos.length) mostrarBusca(""); };
  $$("[data-ex]", el).forEach((b) => (b.onclick = () => buscarTexto(b.dataset.ex)));

  // Sugestões enquanto digita
  const atualizarSug = debounce(() => {
    const lista = sugerir(inp.value, { perfil: perfil() });
    if (!lista.length || document.activeElement !== inp) { sug.hidden = true; return; }
    render(sug, html`${lista.map((d) => html`<button type="button" role="option" data-id="${d.id}">${icone(iconeCategoria(d.cat), 'width="16" height="16"')} <span>${d.titulo}</span></button>`)}`);
    sug.hidden = false;
    $$("button", sug).forEach((b) => (b.onmousedown = (e) => { e.preventDefault(); ir("#/ajuda/a/" + b.dataset.id); }));
  }, 120);
  inp.addEventListener("input", atualizarSug);
  inp.addEventListener("blur", () => setTimeout(() => (sug.hidden = true), 150));
  inp.addEventListener("keydown", (e) => {
    const bs = $$("button", sug);
    if (sug.hidden || !bs.length) return;
    const i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); bs[0].focus(); }
    if (e.key === "Escape") sug.hidden = true;
    void i;
  });
  sug.addEventListener("keydown", (e) => {
    const bs = $$("button", sug), i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); (bs[i + 1] || bs[0]).focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); i <= 0 ? inp.focus() : bs[i - 1].focus(); }
    if (e.key === "Enter") { e.preventDefault(); document.activeElement?.dispatchEvent(new MouseEvent("mousedown")); }
    if (e.key === "Escape") { sug.hidden = true; inp.focus(); }
  });

  // ---------- Anexos: escolher, colar (Ctrl+V) ou arrastar ----------
  const arq = $("#arq", el);
  arq.onchange = () => { adicionarAnexos([...arq.files]); arq.value = ""; };
  el.addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) { e.preventDefault(); adicionarAnexos(fs.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `print-${Date.now()}-${i}.png`, { type: f.type })))); }
  });
  const hero = $(".ajuda-hero", el);
  hero.addEventListener("dragover", (e) => { e.preventDefault(); hero.classList.add("arrastando"); });
  hero.addEventListener("dragleave", () => hero.classList.remove("arrastando"));
  hero.addEventListener("drop", (e) => { e.preventDefault(); hero.classList.remove("arrastando"); adicionarAnexos([...(e.dataTransfer?.files || [])]); });

  async function adicionarAnexos(arquivos) {
    const { MAX_ANEXOS, lerArquivo } = await import("../ajuda/anexos.js");
    for (const f of arquivos) {
      if (memoria.anexos.length >= MAX_ANEXOS) { toast(`No máximo ${MAX_ANEXOS} arquivos`, "erro"); break; }
      const a = { id: Math.random().toString(36).slice(2), arquivo: f, status: "lendo", progresso: 0, msg: "Abrindo…", texto: "",
        url: /^image\//.test(f.type) ? URL.createObjectURL(f) : null };
      memoria.anexos.push(a);
      desenharAnexos();
      lerArquivo(f, (p, msg) => { a.progresso = p; a.msg = msg; desenharAnexos(); })
        .then((r) => { a.status = r.lido ? "lido" : "sem-leitura"; a.texto = r.texto || ""; a.aviso = r.aviso; })
        .catch((e) => { a.status = "erro"; a.aviso = e?.message || "Não deu para ler este arquivo."; })
        .finally(() => {
          desenharAnexos();
          if (minhaVez !== seq) return;
          if (memoria.anexos.every((x) => x.status !== "lendo")) {
            const lido = memoria.anexos.some((x) => x.texto);
            registrar("anexo", { termo: inp.value.trim() || null, resultados: lido ? 1 : 0 });
            mostrarBusca(inp.value.trim());
          }
        });
    }
  }

  function desenharAnexos() {
    const alvo = $("#anexos", el);
    if (!alvo) return;
    render(alvo, memoria.anexos.length ? html`${memoria.anexos.map((a) => html`<div class="anexo-cartao ${a.status}">
      ${a.url ? html`<img src="${a.url}" alt="">` : html`<span class="anexo-ic">${icone("caderno", 'width="22" height="22"')}</span>`}
      <div class="grow"><strong>${a.arquivo.name}</strong>
        <div class="small muted">${a.status === "lendo" ? html`${a.msg} <span class="barra-mini"><span style="width:${Math.round(a.progresso * 100)}%"></span></span>`
          : a.status === "lido" ? (a.texto ? `Texto lido (${a.texto.split(/\s+/).length} palavras)` : "Não encontrei texto neste arquivo.")
          : a.aviso}</div></div>
      <button type="button" class="btn ghost icon-btn sm" data-tirar="${a.id}" aria-label="Tirar anexo">✕</button></div>`)}` : "");
    $$("[data-tirar]", alvo).forEach((b) => (b.onclick = () => {
      const i = memoria.anexos.findIndex((x) => x.id === b.dataset.tirar);
      if (i >= 0) { if (memoria.anexos[i].url) URL.revokeObjectURL(memoria.anexos[i].url); memoria.anexos.splice(i, 1); }
      desenharAnexos();
      if (!memoria.anexos.length && !inp.value.trim()) mostrarInicio();
    }));
  }
  desenharAnexos();

  // ---------- Falar com o suporte (com a dúvida, os anexos e o que já foi visto) ----------
  async function falarComSuporte({ pergunta = "", problema = null } = {}) {
    const textoLido = memoria.anexos.map((a) => a.texto).filter(Boolean).join("\n---\n");
    const msg = pergunta || memoria.ultimaBusca || (problema ? `Apareceu: ${problema.titulo}` : "");
    const { pedirAjuda } = await import("../suporte.js");
    await pedirAjuda({
      app: "pdv", mensagem: msg.slice(0, 1000), anexos: memoria.anexos.map((a) => a.arquivo),
      extra: { busca: memoria.ultimaBusca || null, texto_lido: textoLido ? textoLido.slice(0, 2000) : null,
        problema_reconhecido: problema?.titulo || null, artigos_vistos: memoria.vistos.slice(-8) },
    });
  }
  const botaoSuporte = (txt = "Falar com o suporte") => estado.equipe ? "" : html`<button class="btn" data-suporte>${icone("headset", 'width="18" height="18"')} ${txt}</button>`;
  const ligarSuporte = (raiz, opcoes = {}) => $$("[data-suporte]", raiz).forEach((b) => (b.onclick = () => falarComSuporte(opcoes)));

  // =================================================================== INÍCIO
  function mostrarInicio() {
    const pa = PAPEIS_AJUDA[papel()];
    const telas = Object.keys(ROTAS).filter((r) => pode(r) && TELAS[r]);
    const p = perfil();
    const porCat = Object.fromEntries(CATEGORIAS.map(([k]) => [k, documentos().filter((d) => d.cat === k && podeVer(d, p)).length]));
    render(corpo, html`
      ${pa ? html`<section class="panel ajuda-papel">
        <div class="grow"><span class="badge info">${PAPEIS[papel()]?.nome || ""}</span><h2>${pa.titulo}</h2><p>${pa.texto}</p>
          <h3>Comece por aqui</h3><ol class="ajuda-passos compacto">${pa.comece.map((x) => html`<li>${x}</li>`)}</ol></div>
        <div class="ajuda-papel-acoes">
          <button class="btn" id="rever-tour">${icone("lampada", 'width="18" height="18"')} Ver a apresentação de novo</button>
          <a class="btn" href="${APOSTILA}" target="_blank" rel="noopener">${icone("livro", 'width="18" height="18"')} Apostila completa (PDF)</a>
          ${botaoSuporte()}
        </div></section>` : ""}
      <h2 class="ajuda-sec">Assuntos</h2>
      <div class="ajuda-cats">${CATEGORIAS.filter(([k]) => porCat[k]).map(([k, nome, ic]) => html`<a class="panel ajuda-cat" href="#/ajuda/c/${k}">
        <span class="ajuda-cat-ic">${icone(ic, 'width="22" height="22"')}</span><strong>${nome}</strong><span class="muted small">${porCat[k]} ${porCat[k] === 1 ? "artigo" : "artigos"}</span></a>`)}</div>
      <h2 class="ajuda-sec">Para que serve cada tela do menu</h2>
      <div class="panel ajuda-telas">${telas.map((r) => html`<a href="#/ajuda/a/${TELAS[r].artigo}" class="ajuda-tela">
        <span class="ajuda-cat-ic">${icone(ROTAS[r].icone, 'width="18" height="18"')}</span>
        <span class="grow"><strong>${tituloRota(r)}</strong><span class="d-block muted small">${TELAS[r].desc}</span></span>
        <span class="muted">›</span></a>`)}</div>
      <p class="muted small" style="margin-top:1rem">Dica: em qualquer tela, aperte <kbd>F1</kbd> para ver a ajuda daquela tela.</p>`);
    $("#rever-tour", corpo)?.addEventListener("click", () => import("../ajuda/contexto.js").then((m) => m.mostrarTour()).catch(erro));
    ligarSuporte(corpo);
  }

  // =================================================================== RESULTADOS
  function mostrarBusca(pergunta) {
    const textoLido = memoria.anexos.map((a) => a.texto).filter(Boolean).join("\n");
    const temAnexo = memoria.anexos.length > 0;
    memoria.ultimaBusca = pergunta;
    const texto = [pergunta, textoLido].filter(Boolean).join("\n");
    const r = buscar(texto, { perfil: perfil(), limite: 12 });
    // Erro reconhecido no print ou no texto: o artigo do problema vai primeiro
    const problema = r.problema || (textoLido ? reconhecerErro(textoLido) : null);
    const docProblema = problema ? porId("problema-" + problema.id) : null;
    const resultados = r.resultados.filter((x) => x.doc !== docProblema);
    if (pergunta && !temAnexo) registrar("busca", { termo: pergunta, resultados: resultados.length + (docProblema ? 1 : 0) });

    render(corpo, html`
      ${textoLido ? html`<details class="panel ajuda-lido"><summary>${icone("busca", 'width="16" height="16"')} Texto que li no anexo <span class="muted small">(é com ele que procurei)</span></summary>
        <pre>${textoLido.slice(0, 1500)}</pre></details>` : ""}
      ${r.quisDizer && !textoLido ? html`<p class="ajuda-quis">Você quis dizer: <a href="#/ajuda/q/${encodeURIComponent(r.quisDizer)}">${r.quisDizer}</a>?</p>` : ""}
      ${problema ? html`<section class="panel ajuda-problema">
        <div class="ajuda-problema-tit">${icone("alerta", 'width="22" height="22"')}<div><span class="small muted">Reconheci esta mensagem</span><h2>${problema.titulo}</h2></div></div>
        <p>${problema.explicacao}</p>
        ${problema.operador?.length ? html`<h3>O que fazer agora</h3><ol class="ajuda-passos">${problema.operador.map((x) => html`<li>${x}</li>`)}</ol>` : ""}
        <div class="row" style="gap:.5rem;flex-wrap:wrap">${docProblema ? html`<a class="btn primary" href="#/ajuda/a/${docProblema.id}">Ver explicação completa</a>` : ""}${botaoSuporte()}</div>
      </section>` : ""}
      ${r.outroNivel ? html`<div class="alerta info ajuda-outro">${icone("cadeado", 'width="18" height="18"')}
        <span><strong>${r.outroNivel.titulo}</strong>: isso é feito ${quemFaz(r.outroNivel)}. Peça a essa pessoa ou veja como ela faz:
        <a href="#/ajuda/a/${r.outroNivel.id}">abrir a explicação</a>.</span></div>` : ""}
      ${resultados.length ? html`<p class="muted small ajuda-contagem">${resultados.length} ${resultados.length === 1 ? "resultado" : "resultados"}${pergunta ? html` para “${pergunta}”` : ""}</p>
        <div class="ajuda-resultados">${resultados.map(({ doc }) => cartao(doc))}</div>`
        : !problema ? html`<section class="panel empty ajuda-nada">
          ${icone("busca", 'width="34" height="34"')}
          <h2>Não achei uma resposta${pergunta ? html` para “${pergunta}”` : ""}</h2>
          <p>Tente com outras palavras (ex.: “abrir caixa”, “impressora”, “senha”) ou escolha um assunto abaixo.
            ${temAnexo ? "Se o print estiver escuro ou cortado, tire outro mais de perto." : ""}</p>
          <div class="row" style="gap:.5rem;justify-content:center;flex-wrap:wrap"><a class="btn" href="#/ajuda">Ver os assuntos</a>${botaoSuporte("Pedir ajuda a uma pessoa")}</div>
        </section>` : ""}
      ${resultados.length || problema ? html`<div class="panel ajuda-rodape"><span class="grow">Não resolveu? Uma pessoa do suporte ajuda você${temAnexo ? " (os anexos vão junto)" : ""}.</span>${botaoSuporte()}</div>` : ""}`);
    ligarSuporte(corpo, { pergunta, problema });
  }

  const cartao = (doc) => html`<a class="panel ajuda-res" href="#/ajuda/a/${doc.id}">
    <span class="ajuda-cat-ic">${icone(iconeCategoria(doc.cat), 'width="18" height="18"')}</span>
    <span class="grow"><strong>${doc.titulo}</strong><span class="d-block small muted">${nomeCategoria(doc.cat)}${doc.rota && ROTAS[doc.rota] ? ` · tela ${tituloRota(doc.rota)}` : ""}</span>
      <span class="d-block small">${doc.resumo}</span></span></a>`;

  // =================================================================== CATEGORIA
  function mostrarCategoria(cat) {
    const lista = documentos().filter((d) => d.cat === cat && podeVer(d, perfil()));
    render(corpo, html`<nav class="ajuda-trilha"><a href="#/ajuda">Ajuda</a> › ${nomeCategoria(cat) || "Assunto"}</nav>
      <h2 class="ajuda-sec">${icone(iconeCategoria(cat), 'width="22" height="22"')} ${nomeCategoria(cat)}</h2>
      ${lista.length ? html`<div class="ajuda-resultados">${lista.map(cartao)}</div>` : html`<div class="empty"><p>Nada aqui para o seu nível de acesso.</p></div>`}`);
  }

  // =================================================================== ARTIGO
  function mostrarArtigo(id) {
    const d = porId(id);
    if (!d) { render(corpo, html`<div class="empty"><p>Artigo não encontrado.</p><a class="btn" href="#/ajuda">Voltar para a Ajuda</a></div>`); return; }
    const p = perfil();
    if (!podeVer(d, p) && (d.soSuper || d.soEquipe)) { render(corpo, html`<div class="empty"><p>Este artigo é só para a equipe.</p></div>`); return; }
    const outro = !podeVer(d, p);
    if (!memoria.vistos.includes(d.id)) memoria.vistos.push(d.id);
    registrar("artigo", { artigo: d.id, termo: memoria.ultimaBusca || null });
    const gestor = ["admin", "gerente"].includes(papel()) || p.equipe;
    const ver = (d.ver || []).map(porId).filter((x) => x && podeVer(x, p));
    const podeIr = d.rota && ROTAS[d.rota] && pode(d.rota) && location.hash.indexOf("#/" + d.rota) !== 0;
    render(corpo, html`<nav class="ajuda-trilha"><a href="#/ajuda">Ajuda</a> › <a href="#/ajuda/c/${d.cat}">${nomeCategoria(d.cat)}</a></nav>
      <article class="panel ajuda-artigo">
        <h2>${d.titulo}</h2>
        ${outro ? html`<div class="alerta info">${icone("cadeado", 'width="16" height="16"')} Isto é feito ${quemFaz(d)}. Mostre este passo a passo a essa pessoa.</div>` : ""}
        <p class="ajuda-resumo">${d.resumo}</p>
        ${d.impacto ? html`<p class="small"><strong>O que para de funcionar:</strong> ${d.impacto}</p>` : ""}
        ${d.passos?.length ? html`<h3>${d.tipo === "problema" ? "O que fazer agora" : "Passo a passo"}</h3><ol class="ajuda-passos">${d.passos.map((x) => html`<li>${x}</li>`)}</ol>` : ""}
        ${d.causas?.length ? html`<h3>Por que costuma acontecer</h3><ul class="ajuda-lista">${d.causas.map((x) => html`<li>${x}</li>`)}</ul>` : ""}
        ${d.dicas?.length ? html`<div class="ajuda-caixa dica"><strong>${icone("lampada", 'width="16" height="16"')} Dicas</strong><ul>${d.dicas.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
        ${d.atencao?.length ? html`<div class="ajuda-caixa atencao"><strong>${icone("alerta", 'width="16" height="16"')} Atenção</strong><ul>${d.atencao.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
        ${d.tecnico?.length && gestor ? html`<details class="ajuda-tecnico"><summary>Para quem dá suporte (técnico)</summary><ol>${d.tecnico.map((x) => html`<li>${x}</li>`)}</ol></details>` : ""}
        <div class="ajuda-acoes">
          ${podeIr ? html`<a class="btn primary" href="#/${d.rota}">${icone(ROTAS[d.rota].icone, 'width="18" height="18"')} Ir para a tela ${tituloRota(d.rota)}</a>` : ""}
          <button class="btn ghost" id="imprimir">${icone("imprimir", 'width="18" height="18"')} Imprimir</button>
        </div>
        <div class="ajuda-util" id="util">
          <span>Isso resolveu a sua dúvida?</span>
          <button class="btn sm" data-util="1">${icone("joinha", 'width="16" height="16"')} Sim</button>
          <button class="btn sm" data-util="0">Não</button>
        </div>
      </article>
      ${ver.length ? html`<h2 class="ajuda-sec">Veja também</h2><div class="ajuda-resultados">${ver.map(cartao)}</div>` : ""}`);
    $("#imprimir", corpo).onclick = () => window.print();
    $$("[data-util]", corpo).forEach((b) => (b.onclick = () => {
      const util = b.dataset.util === "1";
      registrar("artigo", { artigo: d.id, util, termo: memoria.ultimaBusca || null });
      render($("#util", corpo), util
        ? html`<span>${icone("check", 'width="18" height="18"')} Que bom! Obrigado por avisar.</span>`
        : html`<span class="grow">Poxa. Tente buscar com outras palavras ou chame uma pessoa do suporte${memoria.anexos.length ? " (os anexos vão junto)" : ""}.</span>${botaoSuporte()}`);
      ligarSuporte(corpo, { pergunta: memoria.ultimaBusca ? `${memoria.ultimaBusca} (li: ${d.titulo})` : `Dúvida sobre: ${d.titulo}` });
    }));
    corpo.scrollIntoView?.({ block: "start" });
  }

  // ---------- Qual tela mostrar ----------
  if (modo === "a" && valor) mostrarArtigo(valor);
  else if (modo === "c" && valor) mostrarCategoria(valor);
  else if (modo === "q" && valor) mostrarBusca(valor);
  else if (memoria.anexos.length && memoria.anexos.every((a) => a.status !== "lendo")) mostrarBusca("");
  else mostrarInicio();
  if (!modo) setTimeout(() => inp.focus(), 50);
  return () => { seq++; };
}

function quemFaz(d) {
  const n = (d.niveis || []).filter((x) => x !== "cozinha");
  if (!n.length) return "pela equipe de suporte";
  const nomes = n.map((x) => (x === "admin" ? "pelo administrador" : x === "gerente" ? "pelo gerente" : x === "caixa" ? "pelo caixa" : "pelo garçom"));
  return nomes.length > 1 ? nomes.slice(0, -1).join(", ") + " ou " + nomes[nomes.length - 1] : nomes[0];
}
