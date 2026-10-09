// Excluir usuários: só o superusuário (migração 022).
// O login é apagado; se a pessoa tem histórico (vendas, caixa…), o nome continua
// nos relatórios marcado como excluído. Antes, o banco guarda um backup da loja.
import { rpc } from "./api.js";
import { PAPEIS } from "./estado.js";
import { html, render, $$, dataHora, toast, erro, modal } from "./ui.js";
import { icone } from "./icons.js";

/** Pergunta e exclui. u = { id, nome, papel, email }. Devolve o resultado ou null. */
export async function excluirUsuario(u, { loja } = {}) {
  const r = await modal({
    titulo: `Excluir ${u.nome}`,
    corpo: html`<form id="f-xu" class="stack">
      <div class="alerta">O login de <strong>${u.nome}</strong>${u.email ? html` (${u.email})` : ""}${loja ? html` da loja <strong>${loja}</strong>` : ""} será apagado:
        a pessoa não entra mais no sistema nem no app do garçom.</div>
      <p class="small">Se ela já vendeu, abriu caixa ou mexeu no estoque, o nome continua no histórico e nos relatórios, marcado como excluído.
        Antes, o sistema guarda um backup da loja — dá para desfazer em Backup.</p>
      ${u.papel === "admin" ? html`<div class="alerta warn">É um <strong>administrador</strong>. Se for o único, a loja fica sem administrador até você criar ou promover outro.</div>` : ""}
      <label class="field"><span>Motivo (opcional)</span><input class="input" name="motivo" placeholder="Saiu da empresa, cadastro duplicado…"></label>
      <label class="field"><span>Digite EXCLUIR para confirmar</span><input class="input" name="conf" autocomplete="off" autofocus></label>
    </form>`,
    rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn danger" form="f-xu">${icone("lixo", 'width="16" height="16"')} Excluir usuário</button>`,
    onPronto: (d, fechar) => {
      d.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        if (e.target.conf.value.trim().toUpperCase() !== "EXCLUIR") return toast("Digite EXCLUIR para confirmar", "erro");
        fechar({ conf: "EXCLUIR", motivo: e.target.motivo.value.trim() || null });
      };
    },
  });
  if (!r) return null;
  try {
    const x = await rpc("plataforma_excluir_usuario", { p_id: u.id, p_confirmacao: r.conf, p_motivo: r.motivo });
    toast(x.modo === "historico" ? `${u.nome} excluído. O nome fica só no histórico das vendas.` : `${u.nome} excluído.`, "ok");
    if (x.loja_sem_admin) {
      await modal({ titulo: "Loja sem administrador", corpo: html`<p>${loja ? html`<strong>${loja}</strong>` : "A loja"} ficou sem nenhum administrador ativo.
        Entre na loja pela <strong>Central de suporte</strong> (acesso total) e, em <strong>Usuários</strong>, promova alguém ou crie um novo administrador.</p>` });
    }
    return x;
  } catch (e) { erro(e); return null; }
}

/** Janela com os usuários de uma loja e o botão Excluir (Plataforma). l = { id, loja } */
export async function abrirUsuariosLoja(l) {
  let mudou = false;
  await modal({
    titulo: `Usuários · ${l.loja}`, largo: true,
    corpo: html`<div id="usuarios-loja"><div class="loading"><div class="spinner"></div></div></div>`,
    onPronto: (d) => {
      const alvo = d.querySelector("#usuarios-loja");
      const desenhar = async () => {
        let lista;
        try { lista = await rpc("plataforma_usuarios_loja", { p_empresa: l.id }); }
        catch (e) { return render(alvo, html`<div class="alerta">${e.message}</div>`); }
        render(alvo, lista.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Nome</th><th>Nível</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead>
          <tbody>${lista.map((u) => html`<tr>
            <td><strong>${u.nome}</strong>${u.eu ? html` <span class="badge">você</span>` : ""}${u.equipe && !u.eu ? html` <span class="badge info">equipe</span>` : ""}<div class="small muted">${u.email || ""}</div></td>
            <td><span class="badge ${u.papel === "admin" ? "info" : ""}">${PAPEIS[u.papel]?.nome || u.papel}</span></td>
            <td>${u.excluido_em ? html`<span class="badge">Excluído</span><div class="small muted">${dataHora(u.excluido_em)}</div>`
              : u.ativo ? html`<span class="badge ok">Ativo</span>` : html`<span class="badge danger">Bloqueado</span>`}</td>
            <td class="small">${u.ultimo_acesso ? dataHora(u.ultimo_acesso) : "—"}</td>
            <td class="r">${u.excluido_em || u.eu || u.equipe ? "" : html`<button class="btn sm danger" data-xu="${u.id}">${icone("lixo", 'width="15" height="15"')} Excluir</button>`}</td>
          </tr>`)}</tbody></table></div>` : html`<div class="empty"><p>Nenhum usuário.</p></div>`);
        $$("[data-xu]", alvo).forEach((b) => (b.onclick = async () => {
          const u = lista.find((x) => x.id === b.dataset.xu);
          if (await excluirUsuario(u, { loja: l.loja })) { mudou = true; desenhar(); }
        }));
      };
      desenhar();
    },
  });
  return mudou;
}
