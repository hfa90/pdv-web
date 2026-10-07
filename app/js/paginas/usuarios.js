// Usuários da loja e níveis de acesso.
import { sb, q, fn, rpc } from "../api.js";
import { estado, eh, PAPEIS } from "../estado.js";
import { formatarDoc, somenteDigitos, docValido } from "../ui.js";
import { html, render, $, $$, lerForm, toast, erro, modal, dataHora, iniciais } from "../ui.js";
import { icone } from "../icons.js";

export default async function usuarios(el) {
  const admin = eh("admin");
  const papeisPermitidos = admin ? Object.keys(PAPEIS) : ["caixa", "atendente", "cozinha"];

  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Usuários</h1><p>Cada pessoa com seu login. Tudo o que é feito fica registrado no nome dela.</p></div>
      <button class="btn primary" id="novo">${icone("mais", 'width="18" height="18"')} Novo usuário</button></div>
    <div class="panel" id="lista" style="margin-bottom:1.25rem"></div>
    <div id="cod-loja"></div>
    <div class="panel panel-pad" id="aparelhos" style="margin-bottom:1.25rem"></div>
    <div class="panel panel-pad"><h2 style="margin-bottom:.75rem">Níveis de acesso</h2>
      <div class="grid-2">${Object.entries(PAPEIS).map(([k, p]) => html`<div><strong>${p.nome}</strong><p class="muted small">${p.desc}</p></div>`)}</div></div>
  </div>`);

  let acessos = { acessos: [], codigo_loja: null, proxima_matricula: 1 };
  const acessoDe = (id) => acessos.acessos.find((a) => a.perfil_id === id);
  const pinOk = (p) => /^[0-9]{6,12}$/.test(p) && !/^(.)\1+$/.test(p) && !"01234567890123456789".includes(p) && !"98765432109876543210".includes(p);

  async function carregar() {
    const [lista, ac] = await Promise.all([
      q(sb.from("perfis").select("*").order("ativo", { ascending: false }).order("nome")),
      rpc("acessos_garcom").catch(() => null),
    ]);
    if (ac) acessos = ac;
    render($("#lista", el), html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Nome</th><th>E-mail / matrícula</th><th>Nível</th><th>Situação</th><th>Desde</th></tr></thead>
      <tbody>${lista.map((u) => html`<tr class="click" data-id="${u.id}">
        <td><span class="row" style="gap:.6rem"><span class="avatar">${iniciais(u.nome)}</span><strong>${u.nome}</strong>${u.id === estado.perfil.id ? html`<span class="badge">você</span>` : ""}</span></td>
        <td>${u.email || ""}${acessoDe(u.id) ? html`<div class="small muted">${icone("celular", 'width="13" height="13"')} matrícula ${acessoDe(u.id).matricula}${acessoDe(u.id).bloqueado ? html` <span class="badge danger">bloqueado</span>` : ""}</div>` : ""}</td><td><span class="badge ${u.papel === "admin" ? "info" : ""}">${PAPEIS[u.papel].nome}</span></td>
        <td>${u.ativo ? html`<span class="badge ok">Ativo</span>` : html`<span class="badge danger">Bloqueado</span>`}</td><td class="small">${dataHora(u.created_at)}</td></tr>`)}</tbody></table></div>`);
    $$("tr[data-id]", el).forEach((tr) => (tr.onclick = () => editar(lista.find((u) => u.id === tr.dataset.id))));
    render($("#cod-loja", el), acessos.codigo_loja ? html`<div class="alerta info" style="margin-bottom:1.25rem">${icone("celular", 'width="16" height="16"')}
      Código da loja para o app do garçom: <strong style="letter-spacing:.15em">${acessos.codigo_loja}</strong>. O QR em Mesas › App do garçom já leva o código.</div>` : "");
  }

  async function criar() {
    const res = await modal({
      titulo: "Novo usuário",
      corpo: html`<form id="f-u" class="stack">
        <label class="field"><span>Nome</span><input class="input" name="nome" required autofocus></label>
        <label class="field"><span>Nível de acesso</span><select class="input" name="papel">${papeisPermitidos.map((p) => html`<option value="${p}" ${p === "caixa" ? "selected" : ""}>${PAPEIS[p].nome} — ${PAPEIS[p].desc}</option>`)}</select></label>
        <div class="stack" id="bloco-email">
          <label class="field"><span>E-mail (login do sistema)</span><input class="input" name="email" type="email"></label>
          <label class="field"><span>Senha inicial</span><input class="input" name="senha" type="text" minlength="8" autocomplete="off"><span class="hint">Mínimo 8 caracteres. Entregue à pessoa e peça para não compartilhar.</span></label>
        </div>
        <div class="stack bloco-garcom" id="bloco-garcom" hidden>
          <p class="hint" style="margin:0">Garçom entra no app com <b>matrícula ou CPF</b> e uma <b>senha só de números</b> (6 a 12). O e-mail acima é opcional.</p>
          <div class="grid-2">
            <label class="field"><span>Matrícula</span><input class="input" name="matricula" value="${acessos.proxima_matricula}" maxlength="12" autocapitalize="characters"></label>
            <label class="field"><span>CPF (opcional)</span><input class="input" name="cpf" inputmode="numeric"></label>
          </div>
          <label class="field"><span>Senha numérica do app</span><input class="input" name="pin" type="text" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="6 a 12 números"><span class="hint">Sem sequência (123456) nem repetida (111111).</span></label>
        </div>
      </form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-u">Criar usuário</button>`,
      onPronto: (d, f) => {
        const form = d.querySelector("form");
        const vis = () => {
          const garcom = form.papel.value === "atendente";
          d.querySelector("#bloco-garcom").hidden = !garcom;
          form.email.required = !garcom; form.senha.required = !garcom && !!form.email.value;
          form.email.placeholder = garcom ? "Opcional para garçom" : "";
          form.senha.closest("label").hidden = garcom && !form.email.value;
        };
        form.papel.onchange = vis; form.email.oninput = vis; vis();
        form.onsubmit = (e) => {
          e.preventDefault();
          const x = lerForm(form);
          if (x.papel === "atendente") {
            if (!x.matricula) return toast("Informe a matrícula", "erro");
            if (x.cpf && !docValido(x.cpf)) return toast("CPF inválido", "erro");
            if (!pinOk(x.pin)) return toast("Senha numérica: 6 a 12 números, sem sequência ou repetição", "erro");
            if (x.email && x.senha.length < 8) return toast("A senha do e-mail deve ter ao menos 8 caracteres", "erro");
          } else if (!x.email || x.senha.length < 8) return toast("Informe e-mail e senha de ao menos 8 caracteres", "erro");
          f(x);
        };
      },
    });
    if (!res) return;
    try {
      const r = await fn("usuarios", { acao: "criar", nome: res.nome, papel: res.papel, email: res.email || "", senha: res.senha || "" });
      if (res.papel === "atendente") {
        await rpc("definir_acesso_garcom", { p_perfil: r.id, p_matricula: res.matricula, p_cpf: somenteDigitos(res.cpf) || null, p_pin: res.pin });
        toast(`${res.nome} entra no app do garçom com a matrícula ${res.matricula.toUpperCase()} e a senha numérica`, "ok");
      } else toast(`${res.nome} pode entrar com ${res.email}`, "ok");
      carregar();
    } catch (e) { erro(e); carregar(); }
  }

  async function editar(u) {
    const proprio = u.id === estado.perfil.id;
    const podeEditar = admin && !proprio;
    const podeSenha = !proprio && (admin || ["caixa", "atendente", "cozinha"].includes(u.papel));
    const ac = acessoDe(u.id);
    const podeAcesso = u.papel === "atendente" || !!ac;
    const res = await modal({
      titulo: u.nome,
      corpo: html`<form id="f-e" class="stack">
        <label class="field"><span>Nome</span><input class="input" name="nome" value="${u.nome}" ${admin ? "" : "disabled"}></label>
        <label class="field"><span>Nível de acesso</span><select class="input" name="papel" ${podeEditar ? "" : "disabled"}>${Object.keys(PAPEIS).map((p) => html`<option value="${p}" ${u.papel === p ? "selected" : ""}>${PAPEIS[p].nome}</option>`)}</select></label>
        <label class="check"><input type="checkbox" name="ativo" ${u.ativo ? "checked" : ""} ${podeEditar ? "" : "disabled"}> Acesso liberado</label>
        ${proprio ? html`<p class="hint">Você não pode alterar o próprio nível de acesso.</p>` : ""}
        ${podeSenha && u.email ? html`<hr style="border:0;border-top:1px solid var(--line);width:100%"><label class="field"><span>Nova senha do sistema (opcional)</span><input class="input" name="senha" type="text" minlength="8" autocomplete="off" placeholder="Deixe em branco para manter"></label>` : ""}
        ${podeAcesso ? html`<hr style="border:0;border-top:1px solid var(--line);width:100%">
          <div class="stack bloco-garcom"><strong>${icone("celular", 'width="16" height="16"')} App do garçom: matrícula/CPF + senha numérica</strong>
            ${ac?.bloqueado ? html`<div class="alerta warn">Bloqueado por senha errada. Salvar libera o acesso.</div>` : ""}
            <div class="grid-2">
              <label class="field"><span>Matrícula</span><input class="input" name="matricula" value="${ac?.matricula || acessos.proxima_matricula}" maxlength="12" autocapitalize="characters"></label>
              <label class="field"><span>CPF (opcional)</span><input class="input" name="cpf" inputmode="numeric" value="${ac?.cpf ? formatarDoc(ac.cpf) : ""}"></label>
            </div>
            <label class="field"><span>${ac ? "Nova senha numérica (opcional)" : "Senha numérica do app"}</span><input class="input" name="pin" type="text" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="${ac ? "Deixe em branco para manter" : "6 a 12 números"}"></label>
            ${ac ? html`<label class="check"><input type="checkbox" name="sem_acesso"> Remover o acesso por matrícula</label>` : ""}
          </div>` : ""}
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
      if (podeAcesso) {
        if (res.sem_acesso) await rpc("remover_acesso_garcom", { p_perfil: u.id });
        else if (res.pin || ac) {
          if (res.pin && !pinOk(res.pin)) throw new Error("Senha numérica: 6 a 12 números, sem sequência ou repetição");
          if (res.cpf && !docValido(res.cpf)) throw new Error("CPF inválido");
          await rpc("definir_acesso_garcom", { p_perfil: u.id, p_matricula: res.matricula, p_cpf: somenteDigitos(res.cpf) || null, p_pin: res.pin || null });
        }
      }
      toast("Usuário atualizado", "ok"); carregar();
    } catch (e) { erro(e); }
  }

  $("#novo", el).onclick = criar;
  await carregar();
  import("../dispositivos.js").then((m) => m.painelAparelhos($("#aparelhos", el))).catch(erro);
}
