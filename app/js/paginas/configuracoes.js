// Configurações: dados da loja, impressora térmica, emissão fiscal e registro de atividades.
import { sb, q, rpc } from "../api.js";
import { estado, eh } from "../estado.js";
import { html, render, $, $$, lerForm, lerNumero, toast, erro, ocupado, dataHora, docValido, somenteDigitos, formatarDoc } from "../ui.js";
import { configImpressora, salvarConfigImpressora, imprimirTeste, abrirGaveta } from "../impressao/cupom.js";
import { parearUSB, parearSerial, suportaUSB, suportaSerial } from "../impressao/escpos.js";

const ACOES = {
  "empresa.criar": "Criou a loja", "caixa.abrir": "Abriu o caixa", "caixa.fechar": "Fechou o caixa", "caixa.sangria": "Fez sangria",
  "caixa.suprimento": "Fez suprimento", "venda.cancelar": "Cancelou venda", "produto.preco": "Alterou preço", "usuario.criar": "Criou usuário",
  "usuario.alterar": "Alterou usuário", "usuario.senha": "Redefiniu senha", "fiscal.emitir": "Emitiu nota", "fiscal.cancelar": "Cancelou nota",
  "fiscal.credenciais": "Alterou credenciais fiscais",
};

export default async function configuracoes(el) {
  const abas = [
    eh("admin", "gerente") && ["loja", "Loja"],
    ["impressora", "Impressora"],
    eh("admin") && ["fiscal", "Nota fiscal"],
    eh("admin", "gerente") && ["atividades", "Registro de atividades"],
  ].filter(Boolean);
  let aba = abas[0][0];

  render(el, html`<div class="page" style="max-width:900px">
    <div class="page-head"><div><h1>Configurações</h1></div></div>
    <div class="tabs">${abas.map(([k, n]) => html`<button data-aba="${k}" class="${k === aba ? "ativo" : ""}">${n}</button>`)}</div>
    <div id="corpo"></div></div>`);
  $$(".tabs button", el).forEach((b) => (b.onclick = () => { aba = b.dataset.aba; $$(".tabs button", el).forEach((x) => x.classList.toggle("ativo", x === b)); desenhar(); }));

  function desenhar() { ({ loja, impressora, fiscal, atividades })[aba]().catch(erro); }

  // ---------- Loja ----------
  async function loja() {
    const e = estado.empresa; const ro = !eh("admin");
    render($("#corpo", el), html`<form id="f-loja" class="panel panel-pad stack-lg">
      ${ro ? html`<div class="alerta info">Somente o administrador pode alterar estes dados.</div>` : ""}
      <fieldset ${ro ? "disabled" : ""} style="border:0;padding:0;margin:0" class="stack-lg">
      <div class="grid-2">
        <label class="field"><span>Razão social</span><input class="input" name="razao_social" value="${e.razao_social}" required></label>
        <label class="field"><span>Nome fantasia (aparece no cupom)</span><input class="input" name="nome_fantasia" value="${e.nome_fantasia || ""}"></label>
        <label class="field"><span>CNPJ</span><input class="input" name="cnpj" value="${formatarDoc(e.cnpj)}" inputmode="numeric"></label>
        <label class="field"><span>Inscrição estadual</span><input class="input" name="inscricao_estadual" value="${e.inscricao_estadual || ""}"></label>
        <label class="field"><span>Telefone</span><input class="input" name="telefone" value="${e.telefone || ""}"></label>
        <label class="field"><span>E-mail</span><input class="input" name="email" type="email" value="${e.email || ""}"></label>
      </div>
      <div class="grid-3">
        <label class="field"><span>CEP</span><input class="input" name="cep" value="${e.cep || ""}" inputmode="numeric"></label>
        <label class="field span-2"><span>Rua</span><input class="input" name="logradouro" value="${e.logradouro || ""}"></label>
        <label class="field"><span>Número</span><input class="input" name="numero" value="${e.numero || ""}"></label>
        <label class="field"><span>Bairro</span><input class="input" name="bairro" value="${e.bairro || ""}"></label>
        <label class="field"><span>Complemento</span><input class="input" name="complemento" value="${e.complemento || ""}"></label>
        <label class="field"><span>Cidade</span><input class="input" name="municipio" value="${e.municipio || ""}"></label>
        <label class="field"><span>UF</span><input class="input" name="uf" value="${e.uf || ""}" maxlength="2"></label>
        <label class="field"><span>Código IBGE da cidade</span><input class="input" name="codigo_municipio" value="${e.codigo_municipio || ""}"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>Regime tributário</span><select class="input" name="regime_tributario">
          ${[[1, "Simples Nacional"], [2, "Simples Nacional – excesso de sublimite"], [3, "Regime normal"], [4, "MEI"]].map(([v, n]) => html`<option value="${v}" ${Number(e.regime_tributario) === v ? "selected" : ""}>${n}</option>`)}</select></label>
        <label class="field"><span>Desconto máximo para caixa e atendente (%)</span><input class="input" name="desconto_maximo_caixa" value="${String(e.desconto_maximo_caixa).replace(".", ",")}" inputmode="decimal"></label>
      </div>
      <label class="field"><span>Mensagem no rodapé do cupom</span><input class="input" name="mensagem_cupom" value="${e.mensagem_cupom || ""}" maxlength="120"></label>
      ${ro ? "" : html`<div><button class="btn primary">Salvar dados da loja</button></div>`}
      </fieldset></form>`);
    const f = $("#f-loja", el);
    f.cep.addEventListener("change", async () => {
      const cep = somenteDigitos(f.cep.value); if (cep.length !== 8) return;
      try { const r = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json(); if (!r.erro) { f.logradouro.value = r.logradouro; f.bairro.value = r.bairro; f.municipio.value = r.localidade; f.uf.value = r.uf; f.codigo_municipio.value = r.ibge; } } catch { /* manual */ }
    });
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const x = lerForm(f);
      x.cnpj = somenteDigitos(x.cnpj) || null;
      if (x.cnpj && !docValido(x.cnpj)) return toast("CNPJ inválido", "erro");
      x.desconto_maximo_caixa = lerNumero(x.desconto_maximo_caixa);
      if (!(x.desconto_maximo_caixa >= 0 && x.desconto_maximo_caixa <= 100)) return toast("Desconto máximo deve ficar entre 0 e 100", "erro");
      x.regime_tributario = Number(x.regime_tributario); x.uf = x.uf.toUpperCase() || null; x.cep = somenteDigitos(x.cep) || null;
      Object.keys(x).forEach((k) => { if (x[k] === "") x[k] = null; });
      await ocupado(f.querySelector("button.primary"), async () => {
        try { estado.empresa = await q(sb.from("empresas").update(x).eq("id", e.id).select().single()); toast("Dados salvos", "ok"); }
        catch (err) { erro(err); }
      });
    };
  }

  // ---------- Impressora ----------
  async function impressora() {
    const c = configImpressora();
    render($("#corpo", el), html`<div class="stack-lg">
      <form id="f-imp" class="panel panel-pad stack-lg">
        <p class="muted">Configuração deste computador. Cada terminal de caixa guarda a sua.</p>
        <div class="field"><span>Como imprimir</span>
          <div class="stack" style="gap:.5rem">
            <label class="check"><input type="radio" name="modo" value="navegador" ${c.modo === "navegador" ? "checked" : ""}> <span><strong>Pelo navegador</strong> — funciona com qualquer impressora instalada no computador (USB, rede ou Bluetooth).</span></label>
            <label class="check"><input type="radio" name="modo" value="usb" ${c.modo === "usb" ? "checked" : ""} ${suportaUSB() ? "" : "disabled"}> <span><strong>Direto na térmica via USB</strong> — mais rápido, sem janela de impressão, abre a gaveta. ${suportaUSB() ? "" : "(use Chrome ou Edge)"}</span></label>
            <label class="check"><input type="radio" name="modo" value="serial" ${c.modo === "serial" ? "checked" : ""} ${suportaSerial() ? "" : "disabled"}> <span><strong>Direto via porta serial / Bluetooth</strong> — para impressoras COM ou pareadas por Bluetooth. ${suportaSerial() ? "" : "(use Chrome ou Edge)"}</span></label>
          </div></div>
        <div class="grid-2">
          <label class="field"><span>Largura do papel</span><select class="input" name="largura"><option value="80" ${c.largura === 80 ? "selected" : ""}>80 mm (48 colunas)</option><option value="58" ${c.largura === 58 ? "selected" : ""}>58 mm (32 colunas)</option></select></label>
          <label class="field" id="baud"><span>Velocidade serial (baud)</span><select class="input" name="baudRate">${[9600, 19200, 38400, 115200].map((b) => html`<option ${c.baudRate === b ? "selected" : ""}>${b}</option>`)}</select></label>
        </div>
        <div class="grid-2">
          <label class="check"><input type="checkbox" name="autoImprimir" ${c.autoImprimir ? "checked" : ""}> Imprimir cupom ao concluir a venda</label>
          <label class="check"><input type="checkbox" name="viaPedido" ${c.viaPedido ? "checked" : ""}> Imprimir via do pedido ao salvar (cozinha)</label>
          <label class="check"><input type="checkbox" name="abrirGaveta" ${c.abrirGaveta ? "checked" : ""}> Abrir gaveta ao imprimir (USB/serial)</label>
          <label class="check"><input type="checkbox" name="acentos" ${c.acentos ? "checked" : ""}> Imprimir acentos (página 860)</label>
        </div>
        <div class="row wrap">
          <button class="btn primary">Salvar</button>
          <button type="button" class="btn" id="parear">Parear impressora</button>
          <button type="button" class="btn" id="teste">Imprimir teste</button>
          <button type="button" class="btn" id="gaveta">Abrir gaveta</button>
        </div>
      </form>
      <div class="panel panel-pad stack small">
        <h3>Dicas</h3>
        <p>Impressão sem janela no modo navegador: crie um atalho do Chrome com <code>--kiosk-printing</code> e defina a térmica como impressora padrão.</p>
        <p>Se aparecerem símbolos no lugar de letras acentuadas, desmarque “Imprimir acentos”. O texto sai sem acento, mas legível em qualquer modelo.</p>
        <p>No Windows, se o pareamento USB não listar a impressora, use o modo navegador com o driver do fabricante ou o modo serial (porta COM virtual).</p>
      </div></div>`);
    const f = $("#f-imp", el);
    const atual = () => { const x = lerForm(f); return { modo: f.querySelector("[name=modo]:checked").value, largura: Number(x.largura), baudRate: Number(x.baudRate), autoImprimir: x.autoImprimir, viaPedido: x.viaPedido, abrirGaveta: x.abrirGaveta, acentos: x.acentos }; };
    const vis = () => { const m = atual().modo; $("#baud", el).hidden = m !== "serial"; $("#parear", el).hidden = m === "navegador"; $("#gaveta", el).hidden = m === "navegador"; };
    f.querySelectorAll("[name=modo]").forEach((r) => (r.onchange = vis)); vis();
    f.onsubmit = (e) => { e.preventDefault(); salvarConfigImpressora(atual()); toast("Impressora configurada", "ok"); };
    $("#parear", el).onclick = async () => {
      const c2 = atual(); salvarConfigImpressora(c2);
      try { const nome = c2.modo === "usb" ? await parearUSB() : await parearSerial(c2.baudRate); toast(`Pareada: ${nome}`, "ok"); }
      catch (e) { if (e.name !== "NotFoundError") erro(e); }
    };
    $("#teste", el).onclick = async (e) => { salvarConfigImpressora(atual()); await ocupado(e.currentTarget, () => imprimirTeste().catch(erro)); };
    $("#gaveta", el).onclick = () => abrirGaveta().catch(erro);
  }

  // ---------- Fiscal ----------
  async function fiscal() {
    const cfg = estado.fiscal || {};
    const cred = (await rpc("credenciais_fiscais_status")) || {};
    render($("#corpo", el), html`<div class="stack-lg">
      ${!estado.empresa.cnpj ? html`<div class="alerta warn">Cadastre o CNPJ e o endereço da loja na aba Loja antes de emitir notas.</div>` : ""}
      <form id="f-fis" class="panel panel-pad stack-lg">
        <label class="check"><input type="checkbox" name="habilitado" ${cfg.habilitado ? "checked" : ""}> <strong>Emitir NFC-e e NF-e por este sistema</strong></label>
        <div class="grid-2">
          <label class="field"><span>Ambiente</span><select class="input" name="ambiente">
            <option value="homologacao" ${cfg.ambiente !== "producao" ? "selected" : ""}>Homologação (testes, sem valor fiscal)</option>
            <option value="producao" ${cfg.ambiente === "producao" ? "selected" : ""}>Produção (notas válidas)</option></select></label>
          <label class="check" style="align-self:end"><input type="checkbox" name="emitir_automatico" ${cfg.emitir_automatico ? "checked" : ""}> Marcar “Emitir NFC-e” por padrão no PDV</label>
          <label class="field"><span>Série NFC-e</span><input class="input" name="serie_nfce" type="number" min="1" value="${cfg.serie_nfce || 1}"></label>
          <label class="field"><span>Série NF-e</span><input class="input" name="serie_nfe" type="number" min="1" value="${cfg.serie_nfe || 1}"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>Token de homologação ${cred.homologacao ? html`<span class="badge ok">configurado</span>` : html`<span class="badge">vazio</span>`}</span>
            <input class="input" name="token_homologacao" type="password" autocomplete="off" placeholder="${cred.homologacao ? "•••••••• (deixe vazio para manter)" : "Cole o token"}"></label>
          <label class="field"><span>Token de produção ${cred.producao ? html`<span class="badge ok">configurado</span>` : html`<span class="badge">vazio</span>`}</span>
            <input class="input" name="token_producao" type="password" autocomplete="off" placeholder="${cred.producao ? "•••••••• (deixe vazio para manter)" : "Cole o token"}"></label>
        </div>
        <p class="hint">Os tokens ficam guardados no servidor e não podem ser lidos de volta pelo navegador.</p>
        <div><button class="btn primary">Salvar</button></div>
      </form>
      <div class="panel panel-pad stack small">
        <h3>Como ativar a nota fiscal</h3>
        <ol style="margin:0;padding-left:1.2rem;display:grid;gap:.35rem">
          <li>Crie uma conta no provedor de emissão Focus NFe e cadastre a empresa com o mesmo CNPJ.</li>
          <li>No painel do provedor, envie o certificado digital A1 e informe o CSC/ID Token da NFC-e (obtido no site da SEFAZ do seu estado).</li>
          <li>Copie os tokens de homologação e de produção e cole acima.</li>
          <li>Teste algumas vendas em homologação. Quando estiver tudo certo, troque o ambiente para Produção.</li>
          <li>Revise NCM, CFOP e CSOSN dos produtos com seu contador.</li>
        </ol></div></div>`);
    const f = $("#f-fis", el);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const x = lerForm(f);
      await ocupado(f.querySelector("button.primary"), async () => {
        try {
          estado.fiscal = await q(sb.from("config_fiscal").update({
            habilitado: x.habilitado, ambiente: x.ambiente, emitir_automatico: x.emitir_automatico,
            serie_nfce: Number(x.serie_nfce) || 1, serie_nfe: Number(x.serie_nfe) || 1,
          }).eq("empresa_id", estado.empresa.id).select().single());
          if (x.token_homologacao || x.token_producao) await rpc("salvar_credenciais_fiscais", { p_token_homologacao: x.token_homologacao || null, p_token_producao: x.token_producao || null });
          toast("Configuração fiscal salva", "ok"); fiscal().catch(erro);
        } catch (err) { erro(err); }
      });
    };
  }

  // ---------- Auditoria ----------
  async function atividades() {
    const [logs, pessoas] = await Promise.all([
      q(sb.from("auditoria").select("*").order("created_at", { ascending: false }).limit(200)),
      q(sb.from("perfis").select("id,nome")),
    ]);
    const nome = Object.fromEntries(pessoas.map((p) => [p.id, p.nome]));
    const detalhe = (l) => {
      const d = l.detalhes || {};
      if (l.acao === "produto.preco") return `${d.produto}: ${d.de} → ${d.para}`;
      if (l.acao === "venda.cancelar") return `Venda nº ${d.numero} (${d.total}) — ${d.motivo}`;
      if (l.acao.startsWith("caixa.")) return [d.valor && `R$ ${d.valor}`, d.motivo, d.informado != null && `esperado ${d.esperado}, contado ${d.informado}`].filter(Boolean).join(" · ");
      if (l.acao.startsWith("usuario.")) return [d.nome, d.papel, d.ativo === false && "bloqueado"].filter(Boolean).join(" · ");
      if (l.acao.startsWith("fiscal.")) return [d.modelo && (d.modelo === "55" ? "NF-e" : "NFC-e"), d.venda && `venda ${d.venda}`, d.status].filter(Boolean).join(" · ");
      return "";
    };
    render($("#corpo", el), html`<div class="panel">${logs.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Quando</th><th>Quem</th><th>O que</th><th>Detalhes</th></tr></thead>
      <tbody>${logs.map((l) => html`<tr><td class="small">${dataHora(l.created_at)}</td><td>${nome[l.usuario_id] || "Sistema"}</td><td>${ACOES[l.acao] || l.acao}</td><td class="small muted">${detalhe(l)}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma atividade registrada.</p></div>`}</div>`);
  }

  desenhar();
}
