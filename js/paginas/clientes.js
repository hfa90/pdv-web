// Cadastro de clientes (necessário para NF-e e crediário).
import { sb, q } from "../api.js";
import { estado, eh } from "../estado.js";
import { html, render, $, $$, lerForm, toast, erro, modal, confirmar, debounce, formatarDoc, docValido, somenteDigitos } from "../ui.js";
import { icone } from "../icons.js";

export default async function clientes(el) {
  let busca = "";
  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Clientes</h1><p>Para CPF na nota, NF-e e vendas no crediário.</p></div>
      <button class="btn primary" id="novo">${icone("mais", 'width="18" height="18"')} Novo cliente</button></div>
    <div class="toolbar"><input class="input" id="busca" placeholder="Nome, CPF/CNPJ ou telefone"></div>
    <div class="panel" id="lista"></div></div>`);

  async function carregar() {
    let qy = sb.from("clientes").select("*").eq("ativo", true).order("nome").limit(200);
    const dig = somenteDigitos(busca);
    if (busca) qy = dig.length >= 3 ? qy.or(`cpf_cnpj.ilike.%${dig}%,telefone.ilike.%${dig}%`) : qy.ilike("nome", `%${busca.replace(/[%,()]/g, "")}%`);
    const lista = await q(qy);
    render($("#lista", el), lista.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Nome</th><th>CPF/CNPJ</th><th>Telefone</th><th>Cidade</th></tr></thead>
      <tbody>${lista.map((c) => html`<tr class="click" data-id="${c.id}"><td><strong>${c.nome}</strong></td><td>${formatarDoc(c.cpf_cnpj)}</td><td>${c.telefone || ""}</td><td>${c.municipio ? `${c.municipio}/${c.uf || ""}` : ""}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">${icone("clientes", 'width="40" height="40"')}<p>${busca ? "Nenhum cliente encontrado." : "Nenhum cliente cadastrado."}</p></div>`);
    $$("tr[data-id]", el).forEach((tr) => (tr.onclick = () => editar(lista.find((c) => c.id === tr.dataset.id))));
  }

  async function editar(c = null) {
    const novo = !c; c = c || {};
    const res = await modal({
      titulo: novo ? "Novo cliente" : "Editar cliente", largo: true,
      corpo: html`<form id="f-cli" class="stack-lg">
        <div class="grid-2">
          <label class="field span-2"><span>Nome / razão social</span><input class="input" name="nome" value="${c.nome || ""}" required maxlength="120" autofocus></label>
          <label class="field"><span>CPF ou CNPJ</span><input class="input" name="cpf_cnpj" value="${formatarDoc(c.cpf_cnpj)}" inputmode="numeric"></label>
          <label class="field"><span>Inscrição estadual</span><input class="input" name="inscricao_estadual" value="${c.inscricao_estadual || ""}" placeholder="Só para empresas contribuintes"></label>
          <label class="field"><span>Telefone</span><input class="input" name="telefone" value="${c.telefone || ""}" inputmode="tel"></label>
          <label class="field"><span>E-mail</span><input class="input" name="email" type="email" value="${c.email || ""}"></label>
        </div>
        <div><h3 style="margin-bottom:.6rem">Endereço <span class="muted small" style="font-weight:400">(obrigatório para NF-e)</span></h3>
        <div class="grid-3">
          <label class="field"><span>CEP</span><input class="input" name="cep" value="${c.cep || ""}" inputmode="numeric"><span class="hint">Preenche o endereço automaticamente.</span></label>
          <label class="field span-2"><span>Rua</span><input class="input" name="logradouro" value="${c.logradouro || ""}"></label>
          <label class="field"><span>Número</span><input class="input" name="numero" value="${c.numero || ""}"></label>
          <label class="field"><span>Complemento</span><input class="input" name="complemento" value="${c.complemento || ""}"></label>
          <label class="field"><span>Bairro</span><input class="input" name="bairro" value="${c.bairro || ""}"></label>
          <label class="field"><span>Cidade</span><input class="input" name="municipio" value="${c.municipio || ""}"></label>
          <label class="field"><span>UF</span><input class="input" name="uf" value="${c.uf || ""}" maxlength="2" style="text-transform:uppercase"></label>
          <input type="hidden" name="codigo_municipio" value="${c.codigo_municipio || ""}">
        </div></div>
        <label class="field"><span>Observações</span><textarea class="input" name="observacoes">${c.observacoes || ""}</textarea></label>
      </form>`,
      rodape: html`${!novo && eh("admin", "gerente") ? html`<button class="btn danger" id="exc">Excluir</button><span class="grow"></span>` : ""}<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-cli">Salvar</button>`,
      onPronto: (d, fechar) => {
        const f = d.querySelector("form");
        f.cep.addEventListener("change", async () => {
          const cep = somenteDigitos(f.cep.value);
          if (cep.length !== 8) return;
          try {
            const r = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
            if (r.erro) return toast("CEP não encontrado", "erro");
            f.logradouro.value = r.logradouro || ""; f.bairro.value = r.bairro || ""; f.municipio.value = r.localidade || "";
            f.uf.value = r.uf || ""; f.codigo_municipio.value = r.ibge || ""; f.numero.focus();
          } catch { /* sem internet: preenchimento manual */ }
        });
        f.onsubmit = (e) => {
          e.preventDefault();
          const x = lerForm(f);
          x.cpf_cnpj = somenteDigitos(x.cpf_cnpj) || null;
          if (x.cpf_cnpj && !docValido(x.cpf_cnpj)) return toast("CPF/CNPJ inválido", "erro");
          x.cep = somenteDigitos(x.cep) || null; x.uf = x.uf.toUpperCase() || null;
          Object.keys(x).forEach((k) => { if (x[k] === "") x[k] = null; });
          fechar({ dados: x });
        };
        d.querySelector("#exc")?.addEventListener("click", () => fechar({ excluir: true }));
      },
    });
    if (!res) return;
    try {
      if (res.excluir) {
        if (!(await confirmar(`Excluir ${c.nome}? As vendas antigas continuam registradas.`, { perigo: true, ok: "Excluir" }))) return;
        await q(sb.from("clientes").update({ ativo: false }).eq("id", c.id));
      } else if (novo) await q(sb.from("clientes").insert({ ...res.dados, empresa_id: estado.empresa.id }));
      else await q(sb.from("clientes").update(res.dados).eq("id", c.id));
      toast(res.excluir ? "Cliente excluído" : "Cliente salvo", "ok");
      carregar();
    } catch (e) { erro(e); }
  }

  $("#novo", el).onclick = () => editar();
  $("#busca", el).oninput = debounce((e) => { busca = e.target.value.trim(); carregar().catch(erro); }, 250);
  await carregar();
}
