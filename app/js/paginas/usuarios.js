// Usuários da loja e níveis de acesso.
import { sb, q, fn } from "../api.js";
import { estado, eh, PAPEIS } from "../estado.js";
import { html, render, $, $$, lerForm, toast, erro, modal, dataHora, iniciais } from "../ui.js";
import { icone } from "../icons.js";

export default async function usuarios(el) {
  const admin = eh("admin");
  const papeisPermitidos = admin ? Object.keys(PAPEIS) : ["caixa", "atendente"];

  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Usuários</h1><p>Cada pessoa com seu login. Tudo o que é feito fica registrado no nome dela.</p></div>
      <button class="btn primary" id="novo">${icone("mais", 'width="18" height="18"')} Novo usuário</button></div>
    <div class="panel" id="lista" style="margin-bottom:1.25rem"></div>
    <div class="panel panel-pad"><h2 style="margin-bottom:.75rem">Níveis de acesso</h2>
      <div class="grid-2">${Object.entries(PAPEIS).map(([k, p]) => html`<div><strong>${p.nome}</strong><p class="muted small">${p.desc}</p></div>`)}</div></div>
  </div>`);

  async function carregar() {
    const lista = await q(sb.from("perfis").select("*").order("ativo", { ascending: false }).order("nome"));
    render($("#lista", el), html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Nome</th><th>E-mail</th><th>Nível</th><th>Situação</th><th>Desde</th></tr></thead>
      <tbody>${lista.map((u) => html`<tr class="click" data-id="${u.id}">
        <td><span class="row" style="gap:.6rem"><span class="avatar">${iniciais(u.nome)}</span><strong>${u.nome}</strong>${u.id === estado.perfil.id ? html`<span class="badge">você</span>` : ""}</span></td>
        <td>${u.email || ""}</td><td><span class="badge ${u.papel === "admin" ? "info" : ""}">${PAPEIS[u.papel].nome}</span></td>
        <td>${u.ativo ? html`<span class="badge ok">Ativo</span>` : html`<span class="badge danger">Bloqueado</span>`}</td><td class="small">${dataHora(u.created_at)}</td></tr>`)}</tbody></table></div>`);
    $$("tr[data-id]", el).forEach((tr) => (tr.onclick = () => editar(lista.find((u) => u.id === tr.dataset.id))));
  }

  async function criar() {
    const res = await modal({
      titulo: "Novo usuário",
      corpo: html`<form id="f-u" class="stack">
        <label class="field"><span>Nome</span><input class="input" name="nome" required autofocus></label>
        <label class="field"><span>E-mail (login)</span><input class="input" name="email" type="email" required></label>
        <label class="field"><span>Senha inicial</span><input class="input" name="senha" type="text" minlength="8" required autocomplete="off"><span class="hint">Mínimo 8 caracteres. Entregue à pessoa e peça para não compartilhar.</span></label>
        <label class="field"><span>Nível de acesso</span><select class="input" name="papel">${papeisPermitidos.map((p) => html`<option value="${p}" ${p === "caixa" ? "selected" : ""}>${PAPEIS[p].nome} — ${PAPEIS[p].desc}</option>`)}</select></label>
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-u">Criar usuário</button>`,
      onPronto: (d, f) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); f(lerForm(e.target)); }; },
    });
    if (!res) return;
    try { await fn("usuarios", { acao: "criar", ...res }); toast(`${res.nome} pode entrar com ${res.email}`, "ok"); carregar(); }
    catch (e) { erro(e); }
  }

  async function editar(u) {
    const proprio = u.id === estado.perfil.id;
    const podeEditar = admin && !proprio;
    const podeSenha = !proprio && (admin || ["caixa", "atendente"].includes(u.papel));
    const res = await modal({
      titulo: u.nome,
      corpo: html`<form id="f-e" class="stack">
        <label class="field"><span>Nome</span><input class="input" name="nome" value="${u.nome}" ${admin ? "" : "disabled"}></label>
        <label class="field"><span>Nível de acesso</span><select class="input" name="papel" ${podeEditar ? "" : "disabled"}>${Object.keys(PAPEIS).map((p) => html`<option value="${p}" ${u.papel === p ? "selected" : ""}>${PAPEIS[p].nome}</option>`)}</select></label>
        <label class="check"><input type="checkbox" name="ativo" ${u.ativo ? "checked" : ""} ${podeEditar ? "" : "disabled"}> Acesso liberado</label>
        ${proprio ? html`<p class="hint">Você não pode alterar o próprio nível de acesso.</p>` : ""}
        ${podeSenha ? html`<hr style="border:0;border-top:1px solid var(--line);width:100%"><label class="field"><span>Nova senha (opcional)</span><input class="input" name="senha" type="text" minlength="8" autocomplete="off" placeholder="Deixe em branco para manter"></label>` : ""}
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button>${admin || podeSenha ? html`<button class="btn primary" form="f-e">Salvar</button>` : ""}`,
      onPronto: (d, f) => { d.querySelector("form").onsubmit = (e) => { e.preventDefault(); f(lerForm(e.target)); }; },
    });
    if (!res) return;
    try {
      if (admin) {
        const dados = { nome: res.nome };
        if (podeEditar) Object.assign(dados, { papel: res.papel, ativo: res.ativo });
        await q(sb.from("perfis").update(dados).eq("id", u.id));
      }
      if (res.senha) await fn("usuarios", { acao: "redefinir_senha", user_id: u.id, senha: res.senha });
      toast("Usuário atualizado", "ok"); carregar();
    } catch (e) { erro(e); }
  }

  $("#novo", el).onclick = criar;
  await carregar();
}
