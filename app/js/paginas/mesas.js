// Controle de mesas (restaurantes): mapa interativo do salão, situação em tempo real,
// lançamento de itens, conta, transferência e envio para o caixa.
import { sb, q, rpc } from "../api.js";
import { estado, eh } from "../estado.js";
import { html, render, $, $$, dinheiro, toast, erro, modal, lerForm, debounce, confirmar, raw } from "../ui.js";
import { icone } from "../icons.js";
import { desenharDetalhe, situacao, tempo, minutos, NOME_SITUACAO, reenviarPendente } from "../mesa-detalhe.js";
import { linkGarcom } from "../links.js";
import { qrSvg, qrPronto } from "../../../assets/pix.js";

const TAM = { quadrada: [3, 3], redonda: [3, 3], retangular: [5, 3] };
const CHAVE_VISAO = "pdv-mesas-visao";

export default async function mesas(el) {
  const gestor = eh("admin", "gerente");
  let lista = [], area = "todas", editando = false, aberta = null;
  let visao = (() => { try { return localStorage.getItem(CHAVE_VISAO) || (innerWidth < 700 ? "lista" : "mapa"); } catch { return "mapa"; } })();

  render(el, html`<div class="page mesas-page">
    <div class="page-head">
      <div><h1>Mesas</h1><p id="resumo-mesas" class="mesas-resumo"></p></div>
      <div class="row wrap">
        <div class="seg" role="group" aria-label="Visualização">
          <button data-v="mapa">Mapa</button><button data-v="lista">Lista</button>
        </div>
        <button class="btn" id="app-garcom">${icone("celular", 'width="18" height="18"')} App do garçom</button>
        ${gestor ? html`<button class="btn" id="editar-mapa">${icone("editar", 'width="18" height="18"')} <span>Editar salão</span></button>` : ""}
      </div>
    </div>
    <div class="chips" id="areas"></div>
    <div class="mesas-layout" id="layout">
      <div class="mesas-area" id="area-mesas"></div>
      <aside class="mesa-painel" id="painel" hidden></aside>
    </div>
  </div>`);

  const painel = $("#painel", el);
  const fecharPainel = () => { aberta = null; painel.hidden = true; $("#layout", el).classList.remove("com-painel"); desenhar(); };

  async function recarregar() {
    lista = await rpc("mesas_painel");
    desenhar();
    if (aberta) {
      const m = lista.find((x) => x.id === aberta);
      if (!m) return fecharPainel();
      if (!document.querySelector("dialog[open]")) abrirDetalhe(m, false);
    }
  }
  const recarregarDepois = debounce(() => recarregar().catch(() => {}), 400);

  function areas() { return [...new Set(lista.map((m) => m.area))]; }

  function desenhar() {
    const livres = lista.filter((m) => !m.venda_id).length;
    const conta = lista.filter((m) => m.conta_pedida).length;
    const ocup = lista.length - livres;
    const aberto = lista.reduce((a, m) => a + Number(m.total || 0), 0);
    render($("#resumo-mesas", el), lista.length ? html`<span class="dot-sit livre"></span>${livres} livres
      <span class="dot-sit ocupada"></span>${ocup - conta} ocupadas <span class="dot-sit conta"></span>${conta} pediram a conta
      <span class="sep-v"></span>${dinheiro(aberto)} em aberto` : "");
    const as = areas();
    if (area !== "todas" && !as.includes(area)) area = "todas";
    render($("#areas", el), as.length > 1 ? html`<button class="chip ${area === "todas" ? "ativo" : ""}" data-area="todas">Todas</button>${as.map((a) => html`<button class="chip ${area === a ? "ativo" : ""}" data-area="${a}">${a}</button>`)}` : "");
    $$("[data-area]", el).forEach((b) => (b.onclick = () => { area = b.dataset.area; desenhar(); }));
    $$(".seg button", el).forEach((b) => b.classList.toggle("ativo", b.dataset.v === visao));
    $("#editar-mapa", el)?.classList.toggle("primary", editando);
    if ($("#editar-mapa span", el)) $("#editar-mapa span", el).textContent = editando ? "Concluir edição" : "Editar salão";

    const alvo = $("#area-mesas", el);
    if (!lista.length) return desenharVazio(alvo);
    const visiveis = lista.filter((m) => area === "todas" || m.area === area);
    if (visao === "lista" && !editando) return desenharLista(alvo, visiveis);
    desenharMapa(alvo, visiveis);
  }

  function cartaoConteudo(m) {
    const sit = situacao(m);
    return html`<strong class="mm-nome">${m.nome.replace(/^Mesa\s+/i, "")}</strong>
      ${sit === "livre" ? html`<span class="mm-info">${m.lugares} lug.</span>`
        : html`<span class="mm-total">${dinheiro(m.total)}</span><span class="mm-info ${minutos(m.aberta_em) > 90 ? "demora" : ""}">${tempo(m.aberta_em)}${m.pessoas ? ` · ${m.pessoas}p` : ""}</span>`}
      ${sit === "conta" ? html`<span class="mm-alerta">${icone("conta", 'width="14" height="14"')}</span>` : ""}`;
  }

  // ---------- Mapa ----------
  function desenharMapa(alvo, visiveis) {
    // Mesas que nunca foram posicionadas são arrumadas automaticamente
    const semPos = visiveis.filter((m) => !m.pos_x && !m.pos_y);
    if (semPos.length > 1) arrumar(semPos, false);
    const largura = alvo.clientWidth || 800;
    const maxX = Math.max(20, ...visiveis.map((m) => m.pos_x + TAM[m.formato][0] + 1));
    const maxY = Math.max(10, ...visiveis.map((m) => m.pos_y + TAM[m.formato][1] + 1));
    const c = Math.max(16, Math.min(34, Math.floor((largura - 24) / maxX)));
    render(alvo, html`<div class="mapa ${editando ? "editando" : ""} ${c < 27 ? "compacto" : ""}" id="mapa" style="--c:${c}px;width:${maxX * c}px;height:${maxY * c}px">
      ${visiveis.map((m) => html`<button class="mesa-mapa sit-${situacao(m)} f-${m.formato} ${aberta === m.id ? "sel" : ""}" data-m="${m.id}"
        style="left:${m.pos_x * c}px;top:${m.pos_y * c}px;width:${TAM[m.formato][0] * c}px;height:${TAM[m.formato][1] * c}px"
        aria-label="${m.nome}, ${NOME_SITUACAO[situacao(m)]}">${cartaoConteudo(m)}</button>`)}
    </div>
    ${editando ? html`<div class="editar-barra">
      <span class="small">Arraste as mesas para montar o salão. Toque numa mesa para editar.</span>
      <span class="grow"></span>
      <button class="btn sm" id="arrumar">Organizar em fileiras</button>
      <button class="btn sm" id="nova-varias">Criar várias</button>
      <button class="btn sm primary" id="nova">${icone("mais", 'width="16" height="16"')} Nova mesa</button></div>` : ""}`);
    if (editando) {
      ligarArrastar($("#mapa", el), c);
      $("#arrumar", el).onclick = () => arrumar(visiveis, true);
      $("#nova", el).onclick = () => editarMesa();
      $("#nova-varias", el).onclick = criarVarias;
    } else {
      $$(".mesa-mapa", alvo).forEach((b) => (b.onclick = () => abrirDetalhe(lista.find((m) => m.id === b.dataset.m))));
    }
  }

  function desenharLista(alvo, visiveis) {
    const ordem = { conta: 0, ocupada: 1, livre: 2 };
    const ord = [...visiveis].sort((a, b) => ordem[situacao(a)] - ordem[situacao(b)] || a.numero - b.numero);
    render(alvo, html`<div class="mesas-grade">${ord.map((m) => html`<button class="mesa-card sit-${situacao(m)} ${aberta === m.id ? "sel" : ""}" data-m="${m.id}">
      ${cartaoConteudo(m)}<span class="mm-sit">${NOME_SITUACAO[situacao(m)]}${m.garcom ? ` · ${m.garcom.split(" ")[0]}` : ""}</span></button>`)}</div>`);
    $$(".mesa-card", alvo).forEach((b) => (b.onclick = () => abrirDetalhe(lista.find((m) => m.id === b.dataset.m))));
  }

  function desenharVazio(alvo) {
    render(alvo, html`<div class="panel panel-pad empty" style="max-width:520px;margin:1rem auto">
      ${icone("mesa", 'width="44" height="44"')}
      <h2>Cadastre as mesas do salão</h2>
      ${gestor ? html`<form class="stack" id="f-rapido" style="width:100%;text-align:left">
        <div class="grid-3">
          <label class="field"><span>Quantas mesas</span><input class="input" name="qtd" type="number" min="1" max="200" value="10" required></label>
          <label class="field"><span>Área</span><input class="input" name="area" value="Salão" maxlength="30" required></label>
          <label class="field"><span>Lugares</span><input class="input" name="lugares" type="number" min="1" max="50" value="4"></label>
        </div>
        <button class="btn primary">Criar mesas</button>
        <p class="hint">Depois é só arrastar para ficar igual ao salão. Dá para criar áreas como Varanda e Mezanino.</p>
      </form>` : html`<p class="muted">Peça ao gerente para cadastrar as mesas.</p>`}
    </div>`);
    $("#f-rapido", el)?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const x = lerForm(e.target);
      await criarSequencia(1, Number(x.qtd), x.area, Number(x.lugares) || 4);
    });
  }

  async function criarSequencia(de, ate, nomeArea, lugares) {
    if (!(ate >= de) || ate - de > 199) return toast("Informe de 1 a 200 mesas", "erro");
    const existentes = new Set(lista.map((m) => m.numero));
    const novas = [];
    for (let n = de; n <= ate; n++) if (!existentes.has(n)) novas.push({ empresa_id: estado.empresa.id, numero: n, nome: `Mesa ${n}`, area: nomeArea || "Salão", lugares });
    if (!novas.length) return toast("Essas mesas já existem", "erro");
    try { await q(sb.from("mesas").insert(novas)); toast(`${novas.length} mesas criadas`, "ok"); await recarregar(); }
    catch (err) { erro(err); }
  }

  async function criarVarias() {
    const prox = Math.max(0, ...lista.map((m) => m.numero)) + 1;
    const r = await modal({
      titulo: "Criar várias mesas",
      corpo: html`<form id="f-varias" class="grid-2">
        <label class="field"><span>Da mesa</span><input class="input" name="de" type="number" min="1" value="${prox}"></label>
        <label class="field"><span>Até a mesa</span><input class="input" name="ate" type="number" min="1" value="${prox + 9}"></label>
        <label class="field"><span>Área</span><input class="input" name="area" list="dl-areas" value="${area === "todas" ? "Salão" : area}" maxlength="30"><datalist id="dl-areas">${areas().map((a) => html`<option value="${a}">`)}</datalist></label>
        <label class="field"><span>Lugares</span><input class="input" name="lugares" type="number" min="1" max="50" value="4"></label>
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-varias">Criar</button>`,
      onPronto: (d, fechar) => (d.querySelector("form").onsubmit = (e) => { e.preventDefault(); fechar(lerForm(e.target)); }),
    });
    if (r) await criarSequencia(Number(r.de), Number(r.ate), r.area, Number(r.lugares) || 4);
  }

  async function editarMesa(m = null) {
    const novo = !m;
    m = m || { numero: Math.max(0, ...lista.map((x) => x.numero)) + 1, area: area === "todas" ? (areas()[0] || "Salão") : area, lugares: 4, formato: "quadrada" };
    const r = await modal({
      titulo: novo ? "Nova mesa" : `Editar ${m.nome}`,
      corpo: html`<form id="f-mesa" class="stack">
        <div class="grid-2">
          <label class="field"><span>Número</span><input class="input" name="numero" type="number" min="1" max="9999" value="${m.numero}" required></label>
          <label class="field"><span>Nome</span><input class="input" name="nome" value="${m.nome || ""}" placeholder="Mesa ${m.numero}" maxlength="30"></label>
          <label class="field"><span>Área</span><input class="input" name="area" list="dl-areas2" value="${m.area}" maxlength="30" required><datalist id="dl-areas2">${areas().map((a) => html`<option value="${a}">`)}</datalist></label>
          <label class="field"><span>Lugares</span><input class="input" name="lugares" type="number" min="1" max="50" value="${m.lugares}"></label>
        </div>
        <div class="field"><span>Formato</span><div class="row">${[["quadrada", "Quadrada"], ["redonda", "Redonda"], ["retangular", "Retangular"]].map(([v, n]) => html`<label class="check"><input type="radio" name="formato" value="${v}" ${m.formato === v ? "checked" : ""}> ${n}</label>`)}</div></div>
      </form>`,
      rodape: html`${!novo ? html`<button class="btn danger" id="remover">Remover</button><span class="grow"></span>` : ""}<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-mesa">Salvar</button>`,
      onPronto: (d, fechar) => {
        d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const x = lerForm(e.target); x.formato = e.target.querySelector("[name=formato]:checked").value; fechar({ x }); };
        d.querySelector("#remover")?.addEventListener("click", () => fechar({ remover: true }));
      },
    });
    if (!r) return;
    try {
      if (r.remover) {
        if (m.venda_id) return toast("Feche a conta antes de remover a mesa", "erro");
        if (!(await confirmar(`Remover ${m.nome}?`, { perigo: true, ok: "Remover" }))) return;
        await q(sb.from("mesas").delete().eq("id", m.id)); // o histórico das vendas guarda o nome da mesa
      } else {
        const dados = { numero: Number(r.x.numero), nome: r.x.nome || `Mesa ${r.x.numero}`, area: r.x.area, lugares: Number(r.x.lugares) || 4, formato: r.x.formato };
        if (novo) {
          const livreX = Math.max(0, ...lista.filter((x) => x.area === dados.area).map((x) => x.pos_x + TAM[x.formato][0] + 1));
          await q(sb.from("mesas").insert({ ...dados, empresa_id: estado.empresa.id, pos_x: Math.min(60, livreX), pos_y: 1 }));
        } else await q(sb.from("mesas").update(dados).eq("id", m.id));
      }
      toast("Salão atualizado", "ok"); await recarregar();
    } catch (err) { erro(/duplicate|mesas_empresa_id_numero/i.test(err.message) ? new Error("Já existe uma mesa com esse número") : err); }
  }

  /** Coloca as mesas em fileiras (6 por linha), mantendo a ordem dos números. */
  async function arrumar(alvo, salvar) {
    const ord = [...alvo].sort((a, b) => a.numero - b.numero);
    let x = 1, y = 1, linha = 0;
    for (const m of ord) {
      const [w, h] = TAM[m.formato];
      if (linha >= 6 || x + w > 58) { x = 1; y += h + 2; linha = 0; }
      m.pos_x = x; m.pos_y = Math.min(60, y);
      x += w + 2; linha++;
    }
    if (!salvar && !gestor) return;
    try { await Promise.all(ord.map((m) => sb.from("mesas").update({ pos_x: m.pos_x, pos_y: m.pos_y }).eq("id", m.id))); } catch { /* tenta de novo na próxima */ }
    if (salvar) desenhar();
  }

  function ligarArrastar(mapa, c) {
    $$(".mesa-mapa", mapa).forEach((b) => {
      let ini = null, moveu = false;
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault(); b.setPointerCapture(e.pointerId);
        ini = { x: e.clientX, y: e.clientY, left: b.offsetLeft, top: b.offsetTop }; moveu = false;
        b.classList.add("arrastando");
      });
      b.addEventListener("pointermove", (e) => {
        if (!ini) return;
        const dx = e.clientX - ini.x, dy = e.clientY - ini.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) moveu = true;
        b.style.left = Math.max(0, ini.left + dx) + "px"; b.style.top = Math.max(0, ini.top + dy) + "px";
      });
      b.addEventListener("pointerup", async () => {
        if (!ini) return;
        b.classList.remove("arrastando");
        const m = lista.find((x) => x.id === b.dataset.m);
        ini = null;
        if (!moveu) return editarMesa(m);
        const px = Math.max(0, Math.min(60, Math.round(b.offsetLeft / c)));
        const py = Math.max(0, Math.min(60, Math.round(b.offsetTop / c)));
        b.style.left = px * c + "px"; b.style.top = py * c + "px";
        m.pos_x = px; m.pos_y = py;
        try { await q(sb.from("mesas").update({ pos_x: px, pos_y: py }).eq("id", m.id)); } catch (err) { erro(err); }
      });
    });
  }

  function abrirDetalhe(m, rolar = true) {
    aberta = m.id;
    painel.hidden = false;
    const jaAberto = $("#layout", el).classList.contains("com-painel");
    $("#layout", el).classList.add("com-painel");
    if (!jaAberto) desenhar(); // o mapa se ajusta à nova largura
    $$(".mesa-mapa, .mesa-card", el).forEach((b) => b.classList.toggle("sel", b.dataset.m === m.id));
    desenharDetalhe(painel, m, { contexto: "pdv", todas: () => lista, onMudou: recarregarDepois, onFechar: fecharPainel, onTrocou: (id) => (aberta = id) }).catch(erro);
    if (rolar && innerWidth > 900) painel.scrollIntoView({ block: "nearest" });
  }

  async function mostrarApp() {
    await qrPronto();
    const link = linkGarcom();
    await modal({
      titulo: "App do garçom",
      corpo: html`<div class="row wrap" style="gap:1.25rem;align-items:center">
        <div class="qr-box">${raw(qrSvg(link, 180))}</div>
        <div class="stack grow" style="min-width:220px">
          <p style="margin:0">Os garçons abrem este endereço no celular ou tablet e entram com o próprio usuário (nível <strong>Atendente</strong>).</p>
          <a href="${link}" target="_blank" rel="noopener" class="link-quebra">${link}</a>
          <ol class="small" style="margin:0;padding-left:1.1rem;display:grid;gap:.25rem">
            <li>Aponte a câmera do celular para o QR.</li>
            <li>No Android: menu ⋮ › <b>Instalar app</b>. No iPhone: Compartilhar › <b>Adicionar à Tela de Início</b>.</li>
            <li>Crie um usuário para cada garçom em <a href="#/usuarios" data-fechar>Usuários</a>.</li>
          </ol>
          <button class="btn sm" id="copiar-link" style="align-self:flex-start">Copiar link</button>
        </div></div>`,
      onPronto: (d) => (d.querySelector("#copiar-link").onclick = () => navigator.clipboard?.writeText(link).then(() => toast("Link copiado", "ok"))),
    });
  }

  $$(".seg button", el).forEach((b) => (b.onclick = () => { visao = b.dataset.v; try { localStorage.setItem(CHAVE_VISAO, visao); } catch { /* ignora */ } desenhar(); }));
  $("#editar-mapa", el)?.addEventListener("click", () => { editando = !editando; if (editando) { painel.hidden = true; aberta = null; $("#layout", el).classList.remove("com-painel"); } desenhar(); });
  $("#app-garcom", el).onclick = () => mostrarApp().catch(erro);

  await recarregar();
  reenviarPendente().catch(erro);

  // Tempo real: qualquer mudança em pedidos, itens ou mesas atualiza o salão
  const emp = estado.empresa.id;
  const canal = sb.channel("mesas-" + emp + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "vendas", filter: `empresa_id=eq.${emp}` }, recarregarDepois)
    .on("postgres_changes", { event: "*", schema: "public", table: "venda_itens", filter: `empresa_id=eq.${emp}` }, recarregarDepois)
    .on("postgres_changes", { event: "*", schema: "public", table: "mesas", filter: `empresa_id=eq.${emp}` }, () => { if (!editando) recarregarDepois(); })
    .subscribe();
  const relogio = setInterval(() => { if (!editando) recarregar().catch(() => {}); }, 30000);
  const aoRedimensionar = debounce(() => { if (!editando) desenhar(); }, 200);
  window.addEventListener("resize", aoRedimensionar);

  return () => { sb.removeChannel(canal); clearInterval(relogio); window.removeEventListener("resize", aoRedimensionar); };
}
