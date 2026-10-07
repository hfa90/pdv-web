// Aprovação dos pedidos que o garçom manda para a cozinha.
// Quem está no caixa (admin, gerente ou caixa) recebe aviso em qualquer tela,
// confere e aprova (vai para a tela da cozinha) ou recusa (os itens saem da conta).
// Quem não pode aprovar (garçom, cozinha) aprova digitando a SENHA DE APROVAÇÃO de
// um gerente ou caixa: 6 números sorteados pelo servidor, trocados a cada 7 dias
// (supabase/migrations/019_senha_aprovacao.sql).
// Administrador e gerente ligam/desligam a exigência de aprovação aqui mesmo.
import { sb, rpc } from "./api.js";
import { estado, aprovaCozinha, eh, cfgRestaurante } from "./estado.js";
import { html, render, toast, erro, modal, pedirTexto, ocupado, qtd as fmtQtd, rotuloMesa, confirmar, data as fmtData, $ } from "./ui.js";
import { icone } from "./icons.js";
import { bipe } from "./avisos.js";
import { minutosDesde, duracao } from "./restaurante.js";

let canal = null, pilula = null, pendentes = [], timer = null;

export async function buscarPendentes() {
  const r = await rpc("cozinha_painel");
  return (r.pedidos || []).filter((p) => p.status === "aguardando");
}

function marcarMenu(n) {
  for (const rota of ["cozinha", "mesas"]) {
    const a = document.querySelector(`.nav a[data-rota="${rota}"]`);
    if (!a) continue;
    let b = a.querySelector(".nav-badge.aprov");
    if (!b) { b = document.createElement("span"); b.className = "nav-badge aprov"; a.appendChild(b); }
    b.textContent = n || ""; b.hidden = !n;
    b.title = n ? `${n} pedido(s) aguardando aprovação` : "";
  }
}

function desenharPilula() {
  const n = pendentes.length;
  marcarMenu(n);
  const naCozinha = location.hash.startsWith("#/cozinha");
  if (!n || naCozinha) { pilula?.remove(); pilula = null; return; }
  if (!pilula) {
    pilula = document.createElement("button");
    pilula.className = "pilula-aprov";
    pilula.onclick = () => abrirAprovacoes().catch(erro);
    document.body.appendChild(pilula);
  }
  const maisAntigo = Math.max(...pendentes.map((p) => minutosDesde(p.criado_em)));
  render(pilula, html`${icone("chapeu", 'width="20" height="20"')}<span><strong>${n} ${n === 1 ? "pedido aguarda" : "pedidos aguardam"} aprovação</strong>
    <small>${maisAntigo ? `o mais antigo há ${duracao(maisAntigo)}` : "agora"} · toque para revisar</small></span>`);
  pilula.classList.toggle("urgente", maisAntigo >= 3);
  const lado = document.getElementById("sidebar")?.getBoundingClientRect().right || 0;
  pilula.style.left = Math.max(16, lado + 16) + "px";
}

async function atualizar(avisar = false) {
  const antes = new Set(pendentes.map((p) => p.id));
  pendentes = await buscarPendentes();
  const novos = pendentes.filter((p) => !antes.has(p.id));
  if (avisar && novos.length) {
    bipe(2);
    toast(`${rotuloMesa(novos[0].identificador)}: novo pedido do garçom aguardando aprovação`, "ok");
  }
  desenharPilula();
}

export function iniciarAprovacoes() {
  pararAprovacoes();
  if (!estado.empresa) return;
  atualizar(false).catch(() => {});
  canal = sb.channel("aprovacoes-" + estado.empresa.id + "-" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "cozinha_pedidos", filter: `empresa_id=eq.${estado.empresa.id}` },
      () => { clearTimeout(timer); timer = setTimeout(() => atualizar(true).catch(() => {}), 400); })
    .subscribe();
  window.addEventListener("hashchange", desenharPilula);
}

export function pararAprovacoes() {
  if (canal) sb.removeChannel(canal);
  canal = null; pendentes = [];
  pilula?.remove(); pilula = null;
  window.removeEventListener("hashchange", desenharPilula);
}

/** Cartão de um pedido aguardando aprovação (usado no modal e na tela da cozinha). */
export function cartaoAprovacao(p) {
  const itens = (p.itens || []).filter((i) => !i.cancelado);
  return html`<article class="aprov-card" data-id="${p.id}">
    <div class="aprov-topo"><strong>${rotuloMesa(p.identificador)}</strong>
      ${p.garcom ? html`<span class="muted small">${icone("usuario", 'width="14" height="14"')} ${p.garcom.split(" ")[0]}</span>` : ""}
      <span class="grow"></span><span class="kb-tempo">${icone("relogio", 'width="14" height="14"')} ${duracao(minutosDesde(p.criado_em))}</span></div>
    <ul class="kb-itens">${itens.map((i) => html`<li><b>${fmtQtd(i.quantidade, i.unidade)}×</b> ${i.descricao}${i.observacao ? html` <em>(${i.observacao})</em>` : ""}</li>`)}</ul>
    <div class="kb-acoes">${aprovaCozinha()
      ? html`<button class="btn sm ghost" data-recusar="${p.id}">Recusar</button><button class="btn sm primary" data-aprovar="${p.id}">${icone("check", 'width="16" height="16"')} Aprovar</button>`
      : html`<button class="btn sm primary" data-aprovar="${p.id}">${icone("cadeado", 'width="16" height="16"')} Aprovar com senha</button>`}</div>
  </article>`;
}

// ---------- Senha de aprovação ----------
/**
 * Aprova pedidos. Quem pode aprovar aprova direto; os demais digitam a senha
 * de aprovação de um gerente ou caixa. Devolve quantos foram aprovados (0 se desistiu).
 */
export async function aprovarPedidos(ids, pedidos = []) {
  if (!ids.length) return 0;
  if (aprovaCozinha()) return rpc("cozinha_aprovar", { p_ids: ids });
  const r = await pedirSenhaAprovacao(ids, pedidos);
  return r?.aprovados || 0;
}

/** Popup para digitar a senha de aprovação (garçom, cozinha e outros sem permissão). */
export function pedirSenhaAprovacao(ids, pedidos = []) {
  const resumo = pedidos.filter((p) => ids.includes(p.id));
  const nItens = resumo.reduce((s, p) => s + (p.itens || []).filter((i) => !i.cancelado).length, 0);
  return modal({
    titulo: "Senha de aprovação",
    corpo: html`<form id="f-senha-aprov" class="stack senha-aprov" autocomplete="off">
      <div class="senha-aprov-ic">${icone("cadeado", 'width="30" height="30"')}</div>
      <p style="margin:0;text-align:center">Peça ao <strong>caixa</strong> ou ao <strong>gerente</strong> que digite a senha de aprovação dele.</p>
      ${resumo.length ? html`<p class="muted small" style="margin:0;text-align:center">${resumo.map((p) => rotuloMesa(p.identificador)).join(", ")} · ${nItens} ${nItens === 1 ? "item" : "itens"}</p>` : ""}
      <input class="input senha-aprov-campo" name="senha" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••••" aria-label="Senha de aprovação (6 números)" autofocus>
      <p class="senha-aprov-erro" id="senha-erro" role="alert" hidden></p>
      <p class="hint" style="margin:0;text-align:center">A senha tem 6 números e muda a cada 7 dias. O pedido fica registrado como aprovado por quem é dono da senha.</p>
    </form>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-senha-aprov" id="senha-ok">${icone("check", 'width="18" height="18"')} Aprovar</button>`,
    onPronto: (d, fechar) => {
      const f = d.querySelector("form"), campo = f.senha, msg = d.querySelector("#senha-erro"), ok = d.querySelector("#senha-ok");
      campo.oninput = () => { campo.value = campo.value.replace(/\D/g, "").slice(0, 6); msg.hidden = true; if (campo.value.length === 6) f.requestSubmit(); };
      f.onsubmit = async (e) => {
        e.preventDefault();
        if (campo.value.length !== 6) { msg.textContent = "Digite os 6 números da senha."; msg.hidden = false; return; }
        try {
          const r = await ocupado(ok, () => rpc("cozinha_aprovar_com_senha", { p_ids: ids, p_senha: campo.value }));
          if (!r?.ok) {
            msg.textContent = r?.erro || "Senha incorreta"; msg.hidden = false;
            campo.value = ""; campo.focus();
            campo.classList.remove("tremer"); void campo.offsetWidth; campo.classList.add("tremer");
            if (r?.bloqueado) { campo.disabled = true; ok.disabled = true; }
            return;
          }
          fechar(r); // fecha antes do aviso, senão o aviso some junto com a janela
          toast(`${r.aprovados} ${r.aprovados === 1 ? "pedido aprovado" : "pedidos aprovados"} com a senha de ${r.autorizado_por} · já está na cozinha`, "ok");
        } catch (err) {
          msg.textContent = /cozinha_aprovar_com_senha|schema cache|Could not find/i.test(err.tecnico?.mensagem_original || err.message)
            ? "A aprovação por senha ainda não foi ativada (falta a migração 019 no servidor)." : err.message;
          msg.hidden = false;
        }
      };
    },
  });
}

const restaDias = (ate) => Math.max(0, Math.ceil((new Date(ate) - Date.now()) / 864e5));

/** Cartão com a senha de aprovação de quem está logado (gerente/caixa). Fica escondida até tocar em "Mostrar". */
export async function cartaoMinhaSenha(el) {
  if (!el || !eh("gerente", "caixa")) return;
  let s;
  try { s = await rpc("minha_senha_aprovacao", { p_nova: false }); } catch { el.hidden = true; return; }
  if (!s?.tem) { el.hidden = true; return; }
  let visivel = false, t = null;
  const desenhar = () => {
    render(el, html`<div class="minha-senha">
      <span class="minha-senha-ic">${icone("cadeado", 'width="18" height="18"')}</span>
      <div class="grow"><div class="small muted">Sua senha de aprovação</div>
        <strong class="minha-senha-cod">${visivel ? s.codigo.replace(/(\d{3})(\d{3})/, "$1 $2") : "••• •••"}</strong>
        <div class="small muted">Troca sozinha em ${restaDias(s.valido_ate)} ${restaDias(s.valido_ate) === 1 ? "dia" : "dias"} (${fmtData(s.valido_ate)}). Não deixe o garçom ver.</div></div>
      <button type="button" class="btn sm" data-ver>${icone("olho", 'width="16" height="16"')} ${visivel ? "Esconder" : "Mostrar"}</button>
      <button type="button" class="btn sm ghost" data-nova title="Sorteia outra senha agora (se alguém viu a atual)">Gerar nova</button></div>`);
    el.querySelector("[data-ver]").onclick = () => { visivel = !visivel; clearTimeout(t); if (visivel) t = setTimeout(() => { visivel = false; desenhar(); }, 15000); desenhar(); };
    el.querySelector("[data-nova]").onclick = async () => {
      if (!(await confirmar("Gerar uma nova senha de aprovação agora? A senha atual para de funcionar na hora.", { titulo: "Nova senha de aprovação", ok: "Gerar nova" }))) return;
      try { s = await rpc("minha_senha_aprovacao", { p_nova: true }); visivel = true; desenhar(); toast("Nova senha gerada", "ok"); } catch (e) { erro(e); }
    };
  };
  desenhar();
}

/** Modal com a senha (botão do menu lateral para gerente/caixa). */
export function abrirMinhaSenha() {
  return modal({ titulo: "Senha de aprovação", corpo: html`<div class="stack"><div id="ms-cartao"></div>
    <p class="hint" style="margin:0">O garçom (ou a cozinha) digita esta senha para aprovar um pedido sem você precisar ir até o aparelho. Cada aprovação fica registrada no seu nome.</p></div>`,
    rodape: html`<button class="btn" data-fechar>Fechar</button>`, onPronto: (d) => cartaoMinhaSenha(d.querySelector("#ms-cartao")) });
}

/** Interruptor "pedidos do garçom precisam de aprovação" (administrador e gerente). */
export function interruptorAprovacao(el, aoMudar) {
  if (!el || !eh("admin", "gerente")) { if (el) el.hidden = true; return; }
  const ligado = cfgRestaurante().aprovacao_cozinha !== false;
  render(el, html`<label class="check interruptor-aprov"><input type="checkbox" ${ligado ? "checked" : ""}>
    <span><strong>Exigir aprovação dos pedidos do garçom</strong> <span class="muted small">${ligado ? "Ligado: o caixa confere antes de ir para a cozinha" : "Desligado: os pedidos vão direto para a cozinha"}</span></span></label>`);
  el.querySelector("input").onchange = async (e) => {
    const novo = e.target.checked;
    try {
      const cfg = await rpc("salvar_config_restaurante", { p: { aprovacao_cozinha: novo } });
      if (estado.empresa) estado.empresa.config_restaurante = { ...(estado.empresa.config_restaurante || {}), aprovacao_cozinha: cfg?.aprovacao_cozinha ?? novo };
      if (!novo) {
        const pend = await buscarPendentes();
        if (pend.length && await confirmar(`Aprovação desligada. Mandar também para a cozinha os ${pend.length} ${pend.length === 1 ? "pedido que estava" : "pedidos que estavam"} aguardando?`, { titulo: "Pedidos aguardando", ok: "Mandar para a cozinha" })) {
          await rpc("cozinha_aprovar", { p_ids: pend.map((p) => p.id) });
        }
      }
      toast(novo ? "Aprovação ligada: pedidos do garçom aguardam o caixa" : "Aprovação desligada: pedidos do garçom vão direto para a cozinha", "ok");
      interruptorAprovacao(el, aoMudar);
      if (canal) atualizar().catch(() => {});
      aoMudar?.(novo);
    } catch (err) { e.target.checked = !novo; erro(err); }
  };
}

/** Usuários: senhas de aprovação de gerentes e caixas (admin vê todas; gerente vê a sua e as dos caixas). */
export async function painelSenhas(el) {
  if (!el) return;
  let lista;
  try { lista = await rpc("senhas_aprovacao_loja"); }
  catch (e) { el.hidden = !/senhas_aprovacao_loja|schema cache|Could not find/i.test(e.tecnico?.mensagem_original || e.message);
    render(el, html`<div class="alerta warn">Para usar a senha de aprovação, rode <code>supabase/migrations/019_senha_aprovacao.sql</code> no Supabase.</div>`); return; }
  const vis = new Set();
  const desenhar = () => {
    render(el, html`<h2 style="margin:0 0 .25rem">${icone("cadeado", 'width="18" height="18" style="vertical-align:-3px"')} Senhas de aprovação</h2>
      <p class="muted small" style="margin:0 0 .75rem">Garçom e cozinha usam a senha de um gerente ou caixa para aprovar pedidos. Cada senha tem 6 números e é trocada sozinha a cada 7 dias.</p>
      ${lista.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Usuário</th><th>Senha</th><th>Troca em</th><th></th></tr></thead>
        <tbody>${lista.map((s) => html`<tr><td><strong>${s.nome}</strong><div class="small muted">${s.papel === "gerente" ? "Gerente" : "Caixa"}</div></td>
          <td><strong class="minha-senha-cod" style="font-size:1.05rem">${vis.has(s.perfil_id) ? s.codigo.replace(/(\d{3})(\d{3})/, "$1 $2") : "••• •••"}</strong></td>
          <td class="small">${restaDias(s.valido_ate)} ${restaDias(s.valido_ate) === 1 ? "dia" : "dias"} · ${fmtData(s.valido_ate)}</td>
          <td class="r"><button class="btn sm ghost" data-ver="${s.perfil_id}">${vis.has(s.perfil_id) ? "Esconder" : "Mostrar"}</button>
            <button class="btn sm ghost" data-trocar="${s.perfil_id}" data-nome="${s.nome}">Trocar agora</button></td></tr>`)}</tbody></table></div>`
        : html`<p class="muted small">Nenhum gerente ou caixa ativo.</p>`}`);
    el.querySelectorAll("[data-ver]").forEach((b) => (b.onclick = () => { const id = b.dataset.ver; vis.has(id) ? vis.delete(id) : vis.add(id); desenhar(); }));
    el.querySelectorAll("[data-trocar]").forEach((b) => (b.onclick = async () => {
      if (!(await confirmar(`Sortear uma nova senha para ${b.dataset.nome}? A atual para de funcionar na hora.`, { titulo: "Trocar senha de aprovação", ok: "Trocar" }))) return;
      try { const r = await rpc("trocar_senha_aprovacao", { p_perfil: b.dataset.trocar }); const s = lista.find((x) => x.perfil_id === b.dataset.trocar); Object.assign(s, r); vis.add(s.perfil_id); desenhar(); toast("Senha trocada", "ok"); }
      catch (e) { erro(e); }
    }));
  };
  desenhar();
}

/** Liga os botões aprovar/recusar dentro de um elemento. */
export function ligarAprovacao(raiz, aoMudar) {
  raiz.querySelectorAll("[data-aprovar]").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    try {
      if (aprovaCozinha()) { await ocupado(b, () => rpc("cozinha_aprovar", { p_ids: [b.dataset.aprovar] })); toast("Aprovado · já está na cozinha", "ok"); aoMudar?.(); return; }
      const n = await aprovarPedidos([b.dataset.aprovar], await buscarPendentes().catch(() => []));
      if (n) aoMudar?.();
    } catch (err) { erro(err); }
  }));
  raiz.querySelectorAll("[data-recusar]").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const motivo = await pedirTexto({ titulo: "Recusar pedido", rotulo: "Motivo (o garçom verá)", minimo: 3, ok: "Recusar", dica: "Ex.: item em falta, lançado em duplicidade. Os itens saem da conta da mesa." });
    if (!motivo) return;
    try { await rpc("cozinha_recusar", { p_id: b.dataset.recusar, p_motivo: motivo }); toast("Pedido recusado · itens retirados da conta", "ok"); aoMudar?.(); }
    catch (err) { erro(err); }
  }));
}

/** Modal com os pedidos aguardando aprovação. Opcional: só os de uma venda. */
export async function abrirAprovacoes(vendaId = null) {
  let lista = (await buscarPendentes()).filter((p) => !vendaId || p.venda_id === vendaId);
  if (!lista.length) { toast("Nenhum pedido aguardando aprovação", "ok"); return; }
  await modal({
    titulo: "Pedidos aguardando aprovação", largo: true,
    corpo: html`<p class="muted small" style="margin-top:0">${aprovaCozinha() ? "Confira e aprove para a cozinha começar. Recusar tira os itens da conta da mesa." : "Para aprovar, peça ao caixa ou ao gerente a senha de aprovação."}</p>
      <div class="aprov-ctl"><div id="aprov-interruptor"></div><div id="aprov-senha"></div></div>
      <div class="aprov-lista" id="aprov-lista"></div>`,
    rodape: html`<button class="btn" data-fechar>Fechar</button><button class="btn primary" id="aprovar-todos">${icone(aprovaCozinha() ? "check" : "cadeado", 'width="18" height="18"')} ${aprovaCozinha() ? "Aprovar todos" : "Aprovar todos com senha"}</button>`,
    onPronto: (d, fechar) => {
      const desenhar = () => {
        if (!lista.length) { fechar(); return; }
        render(d.querySelector("#aprov-lista"), html`${lista.map(cartaoAprovacao)}`);
        ligarAprovacao(d, async () => { lista = (await buscarPendentes()).filter((p) => !vendaId || p.venda_id === vendaId); desenhar(); atualizar().catch(() => {}); });
      };
      desenhar();
      cartaoMinhaSenha(d.querySelector("#aprov-senha"));
      interruptorAprovacao(d.querySelector("#aprov-interruptor"), (ligado) => { if (!ligado) fechar(); });
      d.querySelector("#aprovar-todos").onclick = async (e) => {
        try {
          if (!aprovaCozinha()) { const n = await aprovarPedidos(lista.map((p) => p.id), lista); if (n) { atualizar().catch(() => {}); fechar(); } return; }
          const n = await ocupado(e.currentTarget, () => rpc("cozinha_aprovar", { p_ids: lista.map((p) => p.id) }));
          toast(`${n} ${n === 1 ? "pedido aprovado" : "pedidos aprovados"} · já estão na cozinha`, "ok");
          atualizar().catch(() => {}); fechar();
        } catch (err) { erro(err); }
      };
    },
  });
}
