// App do garçom (PWA): mesas, pedidos da cozinha, conta e desempenho no celular ou tablet.
// Usa o mesmo banco, os mesmos usuários e as mesmas regras do sistema do caixa.
import { sb, rpc, fn } from "../app/js/api.js";
import { estado, carregarContexto, limparEstado, PAPEIS } from "../app/js/estado.js";
import { html, render, $, $$, dinheiro, toast, erro, ocupado, iniciais, carregando, debounce, confirmar, qtd as fmtQtd, rotuloMesa } from "../app/js/ui.js";
import { icone } from "../app/js/icons.js";
import { desenharDetalhe, situacao, NOME_SITUACAO, reenviarPendente } from "../app/js/mesa-detalhe.js";
import { tempoMesa, barraTempo, selosCozinha, duracao, minutosDesde, ETAPA_COZINHA } from "../app/js/restaurante.js";
import { bipe } from "../app/js/avisos.js";
import { MARCA } from "../app/js/config.js";

window.lisDiag?.marcar("modulos"); // diagnóstico: arquivos do app carregaram

const app = document.getElementById("app");
let canal = null, relogio = null, instalar = null;
let mesas = [], area = "todas", filtro = "todas", aberta = null, aba = "mesas";
let pedidosCz = [], estadoCz = new Map(), soMeus = true;

// ---------- Instalação (PWA) ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); instalar = e; $("#btn-instalar")?.removeAttribute("hidden"); });
const ehIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
const instalado = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;

// ---------- Login ----------
// Padrão: código da loja (vem do QR) + matrícula ou CPF + senha numérica (6+ dígitos).
// Alternativa: e-mail e senha (gerentes e quem ainda não tem matrícula).
const CHAVE_LOJA = "garcom-loja", CHAVE_LOGIN = "garcom-ultimo-login";
const lerLS = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const gravarLS = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* ignora */ } };
(() => { // ?loja=CODIGO no link/QR vincula o aparelho à loja
  const c = new URLSearchParams(location.search).get("loja");
  if (c && /^[0-9A-Za-z]{4,12}$/.test(c)) { gravarLS(CHAVE_LOJA, c.toUpperCase()); history.replaceState(null, "", location.pathname); }
})();

function telaLogin(modo = "matricula") {
  const loja = lerLS(CHAVE_LOJA);
  render(app, html`<div class="g-login">
    <div class="g-login-card">
      <img src="icones/icone-192.png" alt="" width="72" height="72">
      <h1>App do garçom</h1>
      ${modo === "matricula" ? html`
        <p class="muted">Entre com sua matrícula ou CPF e a senha numérica.</p>
        <form id="f-login" class="stack" autocomplete="on">
          ${loja ? html`<div class="g-loja">Loja <strong>${loja}</strong> <button type="button" class="link-btn" id="trocar-loja">trocar</button></div>`
            : html`<label class="field"><span>Código da loja</span><input class="input lg g-cod" name="loja" maxlength="12" autocapitalize="characters" required placeholder="Ex.: A1B2C3">
              <small class="hint">Está no QR do app do garçom (no sistema: Mesas › App do garçom). Só na primeira vez.</small></label>`}
          <label class="field"><span>Matrícula ou CPF</span><input class="input lg" name="login" autocomplete="username" autocapitalize="characters" value="${lerLS(CHAVE_LOGIN)}" required ${loja && !lerLS(CHAVE_LOGIN) ? "autofocus" : ""}></label>
          <label class="field"><span>Senha</span><input class="input lg g-pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" minlength="6" maxlength="12" autocomplete="current-password" required ${lerLS(CHAVE_LOGIN) ? "autofocus" : ""}></label>
          <button class="btn primary lg block">Entrar</button>
        </form>
        <button class="link-btn" id="modo-email" style="margin-top:.6rem">Entrar com e-mail e senha</button>`
      : html`
        <p class="muted">Entre com o e-mail e a senha do sistema.</p>
        <form id="f-login" class="stack">
          <label class="field"><span>E-mail</span><input class="input lg" name="email" type="email" autocomplete="username" required autofocus></label>
          <label class="field"><span>Senha</span><input class="input lg" name="senha" type="password" autocomplete="current-password" required></label>
          <button class="btn primary lg block">Entrar</button>
        </form>
        <button class="link-btn" id="modo-mat" style="margin-top:.6rem">Entrar com matrícula ou CPF</button>`}
      <p class="small muted" style="margin-top:1rem">${MARCA}</p>
    </div></div>`);
  $("#modo-email")?.addEventListener("click", () => telaLogin("email"));
  $("#modo-mat")?.addEventListener("click", () => telaLogin("matricula"));
  $("#trocar-loja")?.addEventListener("click", () => { gravarLS(CHAVE_LOJA, ""); telaLogin(); });
  $("#f-login").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await ocupado(f.querySelector("button.primary"), async () => {
      if (modo === "email") {
        const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.senha.value });
        if (error) return toast(/Invalid login/i.test(error.message) ? "E-mail ou senha incorretos" : error.message, "erro");
        return iniciar();
      }
      const codigo = (f.loja?.value || loja).trim().toUpperCase();
      const login = f.login.value.trim();
      const pin = f.pin.value;
      if (!/^[0-9]{6,12}$/.test(pin)) return toast("A senha tem de 6 a 12 números", "erro");
      try {
        const r = await fn("garcom-login", { loja: codigo, login, pin });
        const { error } = await sb.auth.setSession({ access_token: r.access_token, refresh_token: r.refresh_token });
        if (error) throw error;
        gravarLS(CHAVE_LOJA, codigo); gravarLS(CHAVE_LOGIN, login);
        iniciar();
      } catch (err) {
        f.pin.value = "";
        toast(/Failed to send|not found|404/i.test(err.message) ? "Login por matrícula ainda não está ativo nesta loja. Use o e-mail." : err.message, "erro");
      }
    });
  };
}

function telaAviso(titulo, texto) {
  render(app, html`<div class="g-login"><div class="g-login-card"><img src="icones/icone-192.png" alt="" width="64" height="64">
    <h1>${titulo}</h1><p class="muted">${texto}</p><button class="btn block" id="sair">Sair</button></div></div>`);
  $("#sair").onclick = sair;
}

// ---------- Tela principal ----------
function montar() {
  const p = estado.perfil;
  render(app, html`<div class="g-shell">
    <header class="g-top">
      <div class="avatar">${iniciais(p.nome)}</div>
      <div class="grow g-top-txt"><strong>${estado.empresa.nome_fantasia || estado.empresa.razao_social}</strong><span>${p.nome.split(" ")[0]} · ${PAPEIS[p.papel].nome}</span></div>
      <button class="btn sm" id="btn-instalar" ${instalar || (ehIOS && !instalado()) ? "" : "hidden"}>Instalar</button>
      <button class="btn ghost icon-btn" id="btn-sair" aria-label="Sair">${icone("sair", 'width="20" height="20"')}</button>
    </header>
    <div class="g-offline" id="offline" hidden>Sem internet. Os pedidos serão enviados quando a conexão voltar.</div>
    <div class="g-prontos" id="prontos" hidden></div>
    <section id="v-mesas">
      <div class="g-resumo" id="resumo"></div>
      <div class="g-filtros">
        <div class="seg" id="filtros">
          <button data-f="todas">Todas</button><button data-f="ocupadas">Ocupadas</button><button data-f="livres">Livres</button><button data-f="minhas">Minhas</button>
        </div>
      </div>
      <div class="chips g-areas" id="areas"></div>
      <main class="g-mesas" id="mesas"></main>
    </section>
    <section id="v-cozinha" class="g-pagina" hidden></section>
    <section id="v-turno" class="g-pagina" hidden></section>
    <section id="v-desemp" class="g-pagina" hidden></section>
    <nav class="g-tabs" aria-label="Seções">
      <button data-aba="mesas">${icone("mesa", 'width="22" height="22"')}<span>Mesas</span></button>
      <button data-aba="cozinha">${icone("chapeu", 'width="22" height="22"')}<span>Cozinha</span><b class="g-tab-n" id="n-cz" hidden></b></button>
      <button data-aba="turno">${icone("carteira", 'width="22" height="22"')}<span>Meu turno</span></button>
      <button data-aba="desemp">${icone("trofeu", 'width="22" height="22"')}<span>Desempenho</span></button>
    </nav>
    <section class="g-detalhe" id="detalhe" hidden></section>
  </div>`);
  $("#btn-sair").onclick = async () => { if (await confirmar("Sair do app?", { ok: "Sair" })) sair(); };
  $("#btn-instalar").onclick = async () => {
    if (instalar) { instalar.prompt(); await instalar.userChoice; instalar = null; $("#btn-instalar").hidden = true; return; }
    toast("No iPhone: toque em Compartilhar e depois em “Adicionar à Tela de Início”.");
  };
  $$("#filtros button").forEach((b) => (b.onclick = () => { filtro = b.dataset.f; desenhar(); }));
  $$(".g-tabs button").forEach((b) => (b.onclick = () => irPara(b.dataset.aba)));
  const rede = () => { $("#offline").hidden = navigator.onLine; if (navigator.onLine) { recarregar(); reenviarPendente().catch(erro); } };
  window.addEventListener("online", rede); window.addEventListener("offline", rede); rede();
  irPara(aba);
}

function irPara(k) {
  aba = k;
  $$(".g-tabs button").forEach((b) => b.classList.toggle("ativo", b.dataset.aba === k));
  $("#v-mesas").hidden = k !== "mesas";
  $("#v-cozinha").hidden = k !== "cozinha";
  $("#v-desemp").hidden = k !== "desemp";
  $("#v-turno").hidden = k !== "turno";
  if (k === "turno") import("../app/js/turno.js").then((m) => m.desenharTurno($("#v-turno"))).catch(erro);
  if (k === "cozinha") desenharCozinha();
  if (k === "desemp") import("../app/js/desempenho.js").then((m) => m.desenharDesempenho($("#v-desemp"), { inicial: "hoje" })).catch(erro);
  window.scrollTo(0, 0);
}

async function recarregar() {
  try {
    const [m, cz] = await Promise.all([sb.rpc("mesas_painel"), sb.rpc("cozinha_painel")]);
    if (m.error) throw m.error;
    mesas = m.data || [];
    atualizarCozinha(cz.data?.pedidos || []);
    desenhar();
    if (aberta && !document.querySelector("dialog[open]")) {
      const x = mesas.find((y) => y.id === aberta);
      if (x) desenharDetalhe($("#detalhe"), x, opcoes()).catch(() => {});
    }
  } catch (e) { if (navigator.onLine) erro(e); }
}
const recarregarDepois = debounce(recarregar, 350);

// ---------- Pedidos da cozinha (aviso de pronto) ----------
const meu = (p) => p.garcom_id === estado.perfil.id || p.venda_garcom_id === estado.perfil.id;

function atualizarCozinha(lista) {
  const primeira = !estadoCz.size && !pedidosCz.length;
  for (const p of lista) {
    const antes = estadoCz.get(p.id);
    if (!primeira && antes && antes !== p.status && meu(p)) {
      if (p.status === "pronto") avisarPronto(p);
      if (p.status === "recusado") { toast(`${rotuloMesa(p.identificador)}: pedido recusado${p.recusado_motivo ? " · " + p.recusado_motivo : ""}`, "erro"); navigator.vibrate?.([200, 100, 200]); }
      if (p.status === "novo" && antes === "aguardando") toast(`${rotuloMesa(p.identificador)}: pedido aprovado, já está na cozinha`, "ok");
    }
    estadoCz.set(p.id, p.status);
  }
  pedidosCz = lista;
  const prontos = lista.filter((p) => p.status === "pronto" && meu(p));
  const n = $("#n-cz");
  if (n) { n.textContent = prontos.length || ""; n.hidden = !prontos.length; }
  const faixa = $("#prontos");
  if (faixa) {
    faixa.hidden = !prontos.length;
    render(faixa, prontos.length ? html`${icone("sino", 'width="20" height="20"')}<span class="grow"><strong>Pronto para servir:</strong> ${prontos.map((p) => rotuloMesa(p.identificador)).join(", ")}</span><button class="btn sm" id="ver-prontos">Ver</button>` : "");
    $("#ver-prontos")?.addEventListener("click", () => irPara("cozinha"));
  }
  if (aba === "cozinha") desenharCozinha();
}

function avisarPronto(p) {
  bipe(3);
  navigator.vibrate?.([300, 120, 300, 120, 300]);
  toast(`🍽 ${rotuloMesa(p.identificador)}: pedido pronto na cozinha!`, "ok");
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    try { new Notification(`${rotuloMesa(p.identificador)}: pedido pronto`, { body: (p.itens || []).filter((i) => !i.cancelado).map((i) => `${fmtQtd(i.quantidade, i.unidade)}× ${i.descricao}`).join(", "), tag: "pronto-" + p.id, icon: "icones/icone-192.png" }); } catch { /* ignora */ }
  }
}

function desenharCozinha() {
  const alvo = $("#v-cozinha");
  if (!alvo) return;
  const lista = pedidosCz.filter((p) => (!soMeus || meu(p)) && p.origem !== "delivery" && p.origem !== "retirada");
  const grupo = (titulo, cls, itens, vazio, acao) => html`<div class="g-cz-grupo ${cls}"><h2>${titulo} <span class="kb-n">${itens.length}</span></h2>
    ${itens.length ? itens.map((p) => html`<article class="g-cz-card">
      <div class="row"><strong class="g-cz-mesa">${rotuloMesa(p.identificador)}</strong><span class="grow"></span><span class="kb-tempo">${icone("relogio", 'width="14" height="14"')} ${duracao(minutosDesde(p.pronto_em || p.aprovado_em || p.criado_em))}</span></div>
      <ul class="kb-itens">${(p.itens || []).map((i) => html`<li class="${i.cancelado ? "riscado" : ""}"><b>${fmtQtd(i.quantidade, i.unidade)}×</b> ${i.descricao}${i.observacao ? html` <em>(${i.observacao})</em>` : ""}</li>`)}</ul>
      ${p.status === "recusado" ? html`<p class="small txt-perigo" style="margin:0">Recusado${p.recusado_motivo ? `: ${p.recusado_motivo}` : ""}</p>` : ""}
      ${acao ? acao(p) : ""}</article>`) : html`<p class="kb-vazio">${vazio}</p>`}</div>`;
  render(alvo, html`<div class="g-cz-topo"><h1>Cozinha</h1><span class="grow"></span>
      <div class="seg"><button data-meus="1" class="${soMeus ? "ativo" : ""}">Meus</button><button data-meus="0" class="${soMeus ? "" : "ativo"}">Todos</button></div></div>
    ${grupo("Prontos para servir", "pronto", lista.filter((p) => p.status === "pronto"), "Nada pronto agora.",
      (p) => html`<button class="btn primary block" data-servido="${p.id}">${icone("check", 'width="18" height="18"')} Servido</button>`)}
    ${grupo("Na cozinha", "preparo", lista.filter((p) => ["novo", "preparando"].includes(p.status)), "Nenhum pedido em preparo.",
      (p) => html`<span class="etapa e-${p.status}">${ETAPA_COZINHA[p.status]}</span>`)}
    ${grupo("Aguardando aprovação do caixa", "aguardando", lista.filter((p) => p.status === "aguardando"), "Nada aguardando.",
      (p) => html`<button class="btn block" data-aprov-senha="${p.id}">${icone("cadeado", 'width="18" height="18"')} Aprovar com senha do caixa</button>`)}
    ${grupo("Servidos e recusados", "fim", lista.filter((p) => ["entregue", "recusado"].includes(p.status)).slice(-8).reverse(), "—")}
    ${"Notification" in window && Notification.permission === "default" ? html`<button class="btn block" id="permitir-not">${icone("sino", 'width="18" height="18"')} Avisar no celular quando ficar pronto</button>` : ""}`);
  $$("[data-meus]", alvo).forEach((b) => (b.onclick = () => { soMeus = b.dataset.meus === "1"; desenharCozinha(); }));
  $$("[data-servido]", alvo).forEach((b) => (b.onclick = async () => {
    try { await ocupado(b, () => rpc("cozinha_avancar", { p_id: b.dataset.servido, p_status: "entregue" })); toast("Servido ✓", "ok"); recarregar(); } catch (e) { erro(e); }
  }));
  $$("[data-aprov-senha]", alvo).forEach((b) => (b.onclick = async () => {
    try {
      const { aprovarPedidos } = await import("../app/js/aprovacoes.js");
      if (await aprovarPedidos([b.dataset.aprovSenha], pedidosCz)) recarregar();
    } catch (e) { erro(e); }
  }));
  $("#permitir-not", alvo)?.addEventListener("click", () => Notification.requestPermission().then(() => desenharCozinha()));
}

// ---------- Mesas ----------
function desenhar() {
  const alvo = $("#mesas");
  if (!alvo) return;
  const areas = [...new Set(mesas.map((m) => m.area))];
  if (area !== "todas" && !areas.includes(area)) area = "todas";
  render($("#areas"), areas.length > 1 ? html`<button class="chip ${area === "todas" ? "ativo" : ""}" data-a="todas">Todas as áreas</button>${areas.map((a) => html`<button class="chip ${area === a ? "ativo" : ""}" data-a="${a}">${a}</button>`)}` : "");
  $$("#areas [data-a]").forEach((b) => (b.onclick = () => { area = b.dataset.a; desenhar(); }));
  $$("#filtros button").forEach((b) => b.classList.toggle("ativo", b.dataset.f === filtro));

  const livres = mesas.filter((m) => !m.venda_id).length;
  const conta = mesas.filter((m) => m.conta_pedida).length;
  render($("#resumo"), html`<span><span class="dot-sit livre"></span> ${livres} livres</span>
    <span><span class="dot-sit ocupada"></span> ${mesas.length - livres - conta} ocupadas</span>
    <span><span class="dot-sit conta"></span> ${conta} conta</span>`);

  const eu = estado.perfil.id;
  let lista = mesas.filter((m) => area === "todas" || m.area === area);
  if (filtro === "livres") lista = lista.filter((m) => !m.venda_id);
  if (filtro === "ocupadas") lista = lista.filter((m) => m.venda_id);
  if (filtro === "minhas") lista = lista.filter((m) => m.venda_id && m.garcom_id === eu);
  if (!mesas.length) return render(alvo, html`<div class="empty">${icone("mesa", 'width="44" height="44"')}<p>Nenhuma mesa cadastrada.</p><p class="small">O gerente cadastra as mesas no sistema, em Mesas.</p></div>`);
  if (!lista.length) return render(alvo, html`<div class="empty"><p>Nenhuma mesa neste filtro.</p></div>`);
  render(alvo, html`${lista.map((m) => {
    const sit = situacao(m);
    if (sit === "livre") return html`<button class="g-mesa sit-livre" data-m="${m.id}"><span class="g-num">${m.nome.replace(/^Mesa\s+/i, "")}</span><span class="g-sub">${m.lugares} lugares</span><span class="sr-only">Livre</span></button>`;
    const t = tempoMesa(m);
    return html`<button class="g-mesa sit-${sit} t-${t.nivel} ${t.ociosa ? "ociosa" : ""} ${m.cozinha?.pronto ? "cz-pronto" : ""} ${m.garcom_id === eu ? "minha" : ""}" data-m="${m.id}">
      <span class="mm-selos">${selosCozinha(m.cozinha)}</span>
      <span class="g-num">${m.nome.replace(/^Mesa\s+/i, "")}</span>
      <span class="g-total">${dinheiro(m.total)}</span>
      <span class="g-sub t-${t.nivel}">${sit === "conta" && t.contaHa != null ? `conta há ${duracao(t.contaHa)}` : duracao(t.min)}${m.garcom ? " · " + m.garcom.split(" ")[0] : ""}</span>
      ${t.ociosa ? html`<span class="g-ocioso">${duracao(t.semPedir)} sem pedir</span>` : ""}
      ${sit === "conta" ? html`<span class="g-tag">conta</span>` : ""}
      ${barraTempo(m)}
      <span class="sr-only">${NOME_SITUACAO[sit]}</span></button>`;
  })}`);
  $$(".g-mesa", alvo).forEach((b) => (b.onclick = () => abrir(mesas.find((m) => m.id === b.dataset.m))));
}

const opcoes = () => ({ contexto: "garcom", todas: () => mesas, onMudou: recarregarDepois, onFechar: () => history.back(), onTrocou: (id) => (aberta = id) });

function abrir(m) {
  aberta = m.id;
  const d = $("#detalhe");
  d.hidden = false;
  document.body.classList.add("com-detalhe");
  history.pushState({ mesa: m.id }, "");
  desenharDetalhe(d, m, opcoes()).catch(erro);
}
function fecharDetalhe() {
  aberta = null;
  $("#detalhe").hidden = true;
  document.body.classList.remove("com-detalhe");
  recarregar();
}
window.addEventListener("popstate", () => {
  if (document.querySelector("dialog[open]")) { document.querySelector("dialog[open]").close(); history.pushState({ mesa: aberta }, ""); return; }
  if (aberta) fecharDetalhe();
});

function ligarTempoReal() {
  if (canal) sb.removeChannel(canal);
  const emp = estado.empresa.id;
  canal = sb.channel("garcom-" + emp + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "vendas", filter: `empresa_id=eq.${emp}` }, recarregarDepois)
    .on("postgres_changes", { event: "*", schema: "public", table: "venda_itens", filter: `empresa_id=eq.${emp}` }, recarregarDepois)
    .on("postgres_changes", { event: "*", schema: "public", table: "mesas", filter: `empresa_id=eq.${emp}` }, recarregarDepois)
    .on("postgres_changes", { event: "*", schema: "public", table: "cozinha_pedidos", filter: `empresa_id=eq.${emp}` }, recarregarDepois)
    .subscribe();
  clearInterval(relogio);
  relogio = setInterval(() => { if (!document.hidden) recarregar(); }, 25000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) recarregar(); });
}

// ---------- Início ----------
async function iniciar() {
  render(app, carregando());
  try {
    const logado = await carregarContexto();
    if (!logado) return telaLogin();
    if (!estado.perfil) return telaAviso("Conta sem loja", "Este usuário ainda não está ligado a uma loja. Use o sistema principal para concluir o cadastro.");
    if (estado.perfil.papel === "cozinha") return telaAviso("Usuário da cozinha", "Este usuário é da cozinha. Abra o sistema principal no computador ou TV da cozinha.");
    if (["limite", "conflito"].includes(estado.dispositivo?.status)) return telaAviso("Aparelho não liberado", `Seu usuário já está vinculado a ${estado.dispositivo.limite === 1 ? "outro aparelho" : "outros aparelhos"}. Use o aparelho liberado ou peça ao administrador da loja em Usuários › Aparelhos. Código deste aparelho: ${estado.dispositivo.aparelho || ""}.`);
    if (!estado.conta?.garcom) return telaAviso("Exclusivo para restaurantes", "O app do garçom faz parte do plano para restaurantes. Fale com o administrador da loja.");
    montar();
    import("../app/js/diagnostico/envio.js").then((m) => m.iniciarEnvio()).catch(() => {});
    await recarregar();
    ligarTempoReal();
    reenviarPendente().catch(erro);
  } catch (e) {
    erro(e);
    await sb.auth.signOut();
    limparEstado();
    telaLogin();
  }
}

async function sair() {
  if (canal) sb.removeChannel(canal);
  clearInterval(relogio);
  estadoCz = new Map(); pedidosCz = [];
  await sb.auth.signOut();
  limparEstado();
  telaLogin();
}

iniciar();
