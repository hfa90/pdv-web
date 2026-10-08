// Configurações: dados da loja, impressora térmica, emissão fiscal e registro de atividades.
import { sb, q, rpc } from "../api.js";
import { estado, eh, cfgRestaurante } from "../estado.js";
import { esc, html, render, $, $$, lerForm, lerNumero, toast, erro, ocupado, dataHora, docValido, somenteDigitos, formatarDoc } from "../ui.js";
import { configImpressora, salvarConfigImpressora, imprimirTeste, abrirGaveta } from "../impressao/cupom.js";
import { parearUSB, parearSerial, suportaUSB, suportaSerial } from "../impressao/escpos.js";
import { TIPOS_CHAVE, normalizarChave, payloadPix, qrSvg, qrPronto } from "../../../assets/pix.js";
import { raw } from "../ui.js";
import { linkCardapio } from "../links.js";
import { PROTOCOLOS, configBalanca, salvarConfigBalanca, parearBalanca, lerPeso, suportaBalanca, fechar as fecharBalanca } from "../balanca.js";
import { icone } from "../icons.js";

const ACOES = {
  "empresa.criar": "Criou a loja", "caixa.abrir": "Abriu o caixa", "caixa.fechar": "Fechou o caixa", "caixa.sangria": "Fez sangria",
  "caixa.suprimento": "Fez suprimento", "venda.cancelar": "Cancelou venda", "produto.preco": "Alterou preço", "usuario.criar": "Criou usuário",
  "usuario.alterar": "Alterou usuário", "usuario.senha": "Redefiniu senha", "fiscal.emitir": "Emitiu nota", "fiscal.cancelar": "Cancelou nota",
  "fiscal.credenciais": "Alterou credenciais fiscais", "pix.mercado_pago": "Alterou cobrança PIX automática",
  "mesa.transferir": "Transferiu mesa", "mesa.juntar": "Juntou mesas", "mesa.remover_item": "Tirou item da mesa",
  "delivery.cancelar": "Cancelou pedido do delivery",
  "mesa.transferir_itens": "Transferiu itens", "mesa.taxas": "Alterou serviço/couvert da mesa", "mesa.garcom": "Trocou o garçom da mesa",
  "cozinha.recusar": "Recusou pedido da cozinha", "garcom.meta": "Alterou meta/comissão de garçom", "restaurante.config": "Alterou regras do restaurante",
  "suporte.entrou": "Suporte entrou na loja", "suporte.saiu": "Suporte saiu da loja", "suporte.modo": "Suporte trocou o modo de acesso",
};

export default async function configuracoes(el) {
  const abas = [
    eh("admin", "gerente") && ["loja", "Loja"],
    eh("admin", "gerente") && ["pix", "PIX"],
    eh("admin", "gerente") && estado.conta?.delivery_contratado && ["delivery", "Delivery e cardápio"],
    eh("admin", "gerente") && estado.conta?.garcom && ["restaurante", "Restaurante"],
    ["impressora", "Impressora"],
    !eh("cozinha") && ["balanca", "Balança"],
    eh("admin") && ["fiscal", "Nota fiscal"],
    eh("admin", "gerente") && ["atividades", "Registro de atividades"],
  ].filter(Boolean);
  let aba = abas.some(([k]) => k === location.hash.split("/")[2]) ? location.hash.split("/")[2] : abas[0][0];

  render(el, html`<div class="page" style="max-width:900px">
    <div class="page-head"><div><h1>Configurações</h1></div></div>
    <div class="tabs">${abas.map(([k, n]) => html`<button data-aba="${k}" class="${k === aba ? "ativo" : ""}">${n}</button>`)}</div>
    <div id="corpo"></div></div>`);
  $$(".tabs button", el).forEach((b) => (b.onclick = () => { aba = b.dataset.aba; $$(".tabs button", el).forEach((x) => x.classList.toggle("ativo", x === b)); desenhar(); }));

  function desenhar() { ({ loja, pix, delivery, restaurante, impressora, balanca, fiscal, atividades })[aba]().catch(erro); }

  // ---------- Restaurante: taxa de serviço, couvert, comissão, cozinha e tempos ----------
  async function restaurante() {
    const c = cfgRestaurante();
    const cats = await q(sb.from("categorias").select("id,nome,envia_cozinha").eq("ativo", true).order("ordem").order("nome")).catch(() => []);
    const [caixas, cxStatus] = await Promise.all([
      q(sb.from("perfis").select("id,nome,papel").eq("ativo", true).in("papel", ["admin", "gerente", "caixa"]).order("nome")).catch(() => []),
      rpc("caixa_principal_status").catch(() => null),
    ]);
    const v = (n) => String(Number(n || 0)).replace(".", ",");
    render($("#corpo", el), html`<form id="f-rest" class="stack-lg">
      <section class="panel panel-pad stack">
        <div><h2>Taxa de serviço</h2><p class="muted small">Pela lei a taxa é opcional para o cliente. Você escolhe se ela entra na conta.</p></div>
        <div class="opcoes-cartao">
          ${[["nao", "Não cobrar", "A conta sai só com o consumo."],
             ["sugerir", "Só sugerir", "A conta impressa mostra o valor com serviço; o caixa inclui se o cliente aceitar."],
             ["cobrar", "Cobrar na conta", "Toda mesa nova já abre com a taxa. O caixa tira se o cliente pedir."]].map(([k, n, d]) => html`
            <label class="opcao"><input type="radio" name="servico_modo" value="${k}" ${c.servico_modo === k ? "checked" : ""}><span><strong>${n}</strong><small>${d}</small></span></label>`)}
        </div>
        <label class="field" style="max-width:220px"><span>Percentual (%)</span><input class="input" name="servico_percentual" value="${v(c.servico_percentual)}" inputmode="decimal"></label>
      </section>

      <section class="panel panel-pad stack">
        <div><h2>Couvert</h2><p class="muted small">Valor por pessoa (música ao vivo, pão de entrada…). Vale para as mesas abertas a partir de agora; nas que já estão abertas o caixa liga em “Serviço e couvert”.</p></div>
        <label class="check"><input type="checkbox" name="couvert_ativo" ${c.couvert_ativo ? "checked" : ""}> <strong>Cobrar couvert</strong></label>
        <div class="grid-2">
          <label class="field"><span>Nome na conta</span><input class="input" name="couvert_nome" value="${c.couvert_nome}" maxlength="40"></label>
          <label class="field"><span>Valor por pessoa (R$)</span><input class="input" name="couvert_valor" value="${v(c.couvert_valor)}" inputmode="decimal"></label>
        </div>
      </section>

      <section class="panel panel-pad stack">
        <div><h2>Comissão e metas dos garçons</h2><p class="muted small">Cada garçom vê em “Meu desempenho” quanto já ganhou e quanto vai receber se mantiver o ritmo. Metas individuais ficam em Garçons.</p></div>
        <div class="grid-3">
          <label class="field"><span>Comissão (%)</span><input class="input" name="comissao_percentual" value="${v(c.comissao_percentual)}" inputmode="decimal"></label>
          <label class="field"><span>Calculada sobre</span><select class="input" name="comissao_base">
            <option value="consumo" ${c.comissao_base === "consumo" ? "selected" : ""}>Consumo das mesas atendidas</option>
            <option value="servico" ${c.comissao_base === "servico" ? "selected" : ""}>Taxa de serviço arrecadada</option></select></label>
          <label class="field"><span>Meta mensal padrão (R$)</span><input class="input" name="meta_mensal_padrao" value="${v(c.meta_mensal_padrao)}" inputmode="decimal"></label>
        </div>
        <p class="hint">Ex.: 10% sobre o consumo, ou 100% da taxa de serviço para repassar toda a taxa à equipe.</p>
      </section>

      <section class="panel panel-pad stack">
        <div><h2>Fechar conta pelo app do garçom</h2><p class="muted small">O garçom cobra na mesa com PIX (QR com o valor) ou cartão na maquininha, sem TEF. O pagamento entra no caixa principal: aparece no resumo e no fechamento desse caixa, baixa o estoque e libera a mesa.</p></div>
        <label class="check"><input type="checkbox" name="garcom_fecha_conta" ${c.garcom_fecha_conta !== false ? "checked" : ""}> <strong>Garçom pode fechar a conta no app</strong></label>
        <label class="field" style="max-width:420px"><span>Caixa principal (recebe os pagamentos)</span><select class="input" name="caixa_principal_id">
          <option value="">Qualquer caixa aberto (o aberto há mais tempo)</option>
          ${caixas.map((u) => html`<option value="${u.id}" ${c.caixa_principal_id === u.id ? "selected" : ""}>Caixa de ${u.nome}</option>`)}</select></label>
        ${cxStatus ? html`<p class="small ${cxStatus.aberto ? "txt-ok" : "txt-alerta"}" style="margin:0">${cxStatus.aberto
          ? `Agora os pagamentos do app vão para o caixa de ${cxStatus.operador}.`
          : "Nenhum caixa aberto agora: o garçom só consegue fechar conta depois que abrirem o caixa."}</p>` : ""}
        <p class="hint">PIX ${cxStatus?.pix_automatico ? "com confirmação automática (Mercado Pago)" : "pelo QR da chave da loja (o garçom confirma no app do banco do cliente)"}. Dinheiro continua sendo recebido no caixa.</p>
      </section>

      <section class="panel panel-pad stack">
        <div><h2>Cozinha</h2><p class="muted small">Os pedidos do garçom aparecem na tela Cozinha. Com aprovação, o caixa confere antes de a cozinha começar.</p></div>
        <label class="check"><input type="checkbox" name="aprovacao_cozinha" ${c.aprovacao_cozinha ? "checked" : ""}> <span><strong>Pedidos do garçom precisam de aprovação do caixa</strong> <span class="muted small">(admin, gerente ou caixa aprova; garçom e cozinha podem aprovar com a senha de aprovação de um gerente ou caixa, trocada a cada 7 dias; o que eles mesmos lançam já vai aprovado)</span></span></label>
        <label class="field" style="max-width:260px"><span>Tempo ideal de preparo (min)</span><input class="input" name="preparo_alvo_min" value="${c.preparo_alvo_min}" inputmode="numeric"></label>
        ${cats.length ? html`<div class="field"><span>Categorias que vão para a cozinha</span>
          <div class="chips wrap">${cats.map((k) => html`<label class="chip"><input type="checkbox" data-cat="${k.id}" ${k.envia_cozinha !== false ? "checked" : ""}> ${k.nome}</label>`)}</div>
          <small class="hint">Desmarque o que não precisa de preparo (ex.: bebidas em lata). Esses itens entram na conta mas não aparecem para a cozinha.</small></div>` : ""}
      </section>

      <section class="panel panel-pad stack">
        <div><h2>Tempo das mesas</h2><p class="muted small">Cores no mapa do salão e no app do garçom.</p></div>
        <div class="grid-3">
          <label class="field"><span>Amarelo a partir de (min)</span><input class="input" name="tempo_alerta_min" value="${c.tempo_alerta_min}" inputmode="numeric"></label>
          <label class="field"><span>Vermelho a partir de (min)</span><input class="input" name="tempo_critico_min" value="${c.tempo_critico_min}" inputmode="numeric"></label>
          <label class="field"><span>Avisar mesa sem pedir há (min)</span><input class="input" name="ocioso_min" value="${c.ocioso_min}" inputmode="numeric"></label>
        </div>
      </section>
      <div><button class="btn primary">Salvar</button></div>
    </form>`);
    const f = $("#f-rest", el);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const x = lerForm(f);
      const num = (k) => lerNumero(x[k]);
      const dados = {
        servico_modo: f.querySelector("[name=servico_modo]:checked")?.value || "sugerir",
        servico_percentual: num("servico_percentual"), couvert_ativo: x.couvert_ativo, couvert_nome: x.couvert_nome, couvert_valor: num("couvert_valor"),
        comissao_percentual: num("comissao_percentual"), comissao_base: x.comissao_base, meta_mensal_padrao: num("meta_mensal_padrao"),
        aprovacao_cozinha: x.aprovacao_cozinha, preparo_alvo_min: Math.round(num("preparo_alvo_min")),
        tempo_alerta_min: Math.round(num("tempo_alerta_min")), tempo_critico_min: Math.round(num("tempo_critico_min")), ocioso_min: Math.round(num("ocioso_min")),
      };
      if (Object.values(dados).some((n) => typeof n === "number" && !(n >= 0))) return toast("Confira os números digitados", "erro");
      if (dados.couvert_ativo && !(dados.couvert_valor > 0)) return toast("Informe o valor do couvert", "erro");
      if (cats.length) dados.categorias_fora_cozinha = $$("[data-cat]", f).filter((i) => !i.checked).map((i) => i.dataset.cat);
      await ocupado(f.querySelector("button.primary"), async () => {
        try {
          await rpc("salvar_config_fechamento_app", { p_ligado: x.garcom_fecha_conta, p_caixa: x.caixa_principal_id || null });
          const nova = await rpc("salvar_config_restaurante", { p: dados });
          estado.empresa.config_restaurante = { ...(estado.empresa.config_restaurante || {}), ...nova };
          toast("Regras do restaurante salvas · valem para as próximas mesas", "ok");
        } catch (e) { erro(e); }
      });
    };
  }

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
          ${estado.conta?.garcom ? html`<label class="check"><input type="checkbox" name="imprimirApp" ${c.imprimirApp ? "checked" : ""}> <span>Imprimir aqui o cupom das contas que o garçom fechar no app <span class="muted small">(no computador do caixa principal)</span></span></label>` : ""}
          ${estado.conta?.garcom || estado.conta?.delivery_contratado ? html`<label class="check"><input type="checkbox" name="cozinha" ${c.cozinha ? "checked" : ""}> <span>Imprimir sozinho os pedidos do garçom e do delivery <span class="muted small">(os do garçom saem assim que o caixa aprova; deixe ligado em um só computador, o da cozinha ou do caixa)</span></span></label>` : ""}
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
    const atual = () => { const x = lerForm(f); return { modo: f.querySelector("[name=modo]:checked").value, largura: Number(x.largura), baudRate: Number(x.baudRate), autoImprimir: x.autoImprimir, viaPedido: x.viaPedido, abrirGaveta: x.abrirGaveta, acentos: x.acentos, cozinha: !!x.cozinha, imprimirApp: !!x.imprimirApp }; };
    const vis = () => { const m = atual().modo; $("#baud", el).hidden = m !== "serial"; $("#parear", el).hidden = m === "navegador"; $("#gaveta", el).hidden = m === "navegador"; };
    f.querySelectorAll("[name=modo]").forEach((r) => (r.onchange = vis)); vis();
    f.onsubmit = (e) => { e.preventDefault(); salvarConfigImpressora(atual()); window.dispatchEvent(new Event("pdv-impressora")); toast("Impressora configurada", "ok"); };
    $("#parear", el).onclick = async () => {
      const c2 = atual(); salvarConfigImpressora(c2);
      try { const nome = c2.modo === "usb" ? await parearUSB() : await parearSerial(c2.baudRate); toast(`Pareada: ${nome}`, "ok"); }
      catch (e) { if (e.name !== "NotFoundError") erro(e); }
    };
    $("#teste", el).onclick = async (e) => { salvarConfigImpressora(atual()); await ocupado(e.currentTarget, () => imprimirTeste().catch(erro)); };
    $("#gaveta", el).onclick = () => { rpc("registrar_gaveta", { p_motivo: "teste em Configurações" }).catch(() => {}); abrirGaveta().catch(erro); };
  }


  // ---------- Balança ----------
  async function balanca() {
    const c = configBalanca();
    render($("#corpo", el), html`<div class="stack-lg">
      <form id="f-bal" class="panel panel-pad stack-lg">
        <div class="row" style="align-items:flex-start;gap:1rem">
          <div class="modulo-ic">${icone("balanca", 'width="26" height="26"')}</div>
          <div class="grow"><h2>Balança no caixa</h2>
            <p class="muted small">Pão, frios, comida e sorvete por quilo: ao tocar no produto vendido por KG o PDV lê o peso direto da balança, sem digitar.
            Configuração deste computador (cada caixa guarda a sua).</p></div>
        </div>
        ${suportaBalanca() ? "" : html`<div class="alerta warn">Este navegador não acessa portas seriais. Abra o sistema no Google Chrome ou no Microsoft Edge do computador do caixa.</div>`}
        <label class="check"><input type="checkbox" name="ativa" ${c.ativa ? "checked" : ""}> <strong>Usar balança neste caixa</strong></label>
        <div class="grid-2">
          <label class="field"><span>Marca / protocolo</span><select class="input" name="protocolo">
            ${Object.entries(PROTOCOLOS).map(([k, v]) => html`<option value="${k}" ${c.protocolo === k ? "selected" : ""}>${v.nome}</option>`)}</select></label>
          <label class="field"><span>Velocidade (baud)</span><select class="input" name="baudRate">
            ${[2400, 4800, 9600, 19200].map((b) => html`<option ${Number(c.baudRate) === b ? "selected" : ""}>${b}</option>`)}</select></label>
          <label class="field"><span>Paridade</span><select class="input" name="paridade">
            ${[["none", "Nenhuma (8N1)"], ["even", "Par (8E1)"], ["odd", "Ímpar (8O1)"]].map(([k, n]) => html`<option value="${k}" ${c.paridade === k ? "selected" : ""}>${n}</option>`)}</select></label>
          <label class="field"><span>Bits de dados</span><select class="input" name="dataBits">
            ${[8, 7].map((b) => html`<option ${Number(c.dataBits) === b ? "selected" : ""}>${b}</option>`)}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="autoConfirmar" ${c.autoConfirmar ? "checked" : ""}> Lançar o item sozinho quando o peso estabilizar</label>
        <div class="row wrap">
          <button class="btn primary">Salvar</button>
          <button type="button" class="btn" id="b-parear">${icone("link", 'width="18" height="18"')} Parear balança</button>
          <button type="button" class="btn" id="b-testar">${icone("balanca", 'width="18" height="18"')} Ler peso agora</button>
        </div>
        <div class="peso-visor" id="b-visor" hidden><div class="pv-info"><span>Leitura</span><span id="b-sit">—</span></div><div class="pv-peso"><span id="b-peso">0,000</span><small>kg</small></div></div>
      </form>

      <form id="f-etq" class="panel panel-pad stack">
        <h2>Etiquetas da balança (código de barras)</h2>
        <p class="muted small">Balanças que imprimem etiqueta (Toledo Prix 4, Filizola Platina, Urano…) geram um EAN-13 começando com 2. O PDV lê no leitor de código de barras normalmente. O código do produto na balança deve ser o mesmo campo <strong>Código</strong> do cadastro.</p>
        <div class="grid-2">
          <label class="field"><span>A etiqueta traz</span><select class="input" name="etiquetaTipo">
            <option value="preco" ${c.etiquetaTipo === "preco" ? "selected" : ""}>Preço total (mais comum)</option>
            <option value="peso" ${c.etiquetaTipo === "peso" ? "selected" : ""}>Peso em gramas</option></select></label>
          <label class="field"><span>Dígitos do código do produto</span><select class="input" name="etiquetaDigitos">
            <option value="5" ${Number(c.etiquetaDigitos) !== 4 ? "selected" : ""}>5 dígitos · 2 CCCCC VVVVV D</option>
            <option value="4" ${Number(c.etiquetaDigitos) === 4 ? "selected" : ""}>4 dígitos · 2 CCCC VVVVVV D</option></select></label>
        </div>
        <div><button class="btn">Salvar formato da etiqueta</button></div>
      </form>

      <div class="panel panel-pad stack small">
        <h3>Como ligar</h3>
        <p>1. Ligue o cabo da balança no computador (serial/COM ou adaptador USB-serial) e instale o driver do adaptador, se houver.</p>
        <p>2. Na balança, deixe a comunicação no protocolo da marca (Toledo: P03 · Filizola/Urano: protocolo padrão de PDV) e anote a velocidade (normalmente 9600 ou 4800).</p>
        <p>3. Clique em <strong>Parear balança</strong>, escolha a porta COM da balança e depois em <strong>Ler peso agora</strong> com algo sobre o prato.</p>
        <p>Sem balança à mão? Escolha <strong>Simulador</strong> para treinar a equipe.</p>
      </div></div>`);
    const f = $("#f-bal", el), fe = $("#f-etq", el);
    const atual = () => { const x = lerForm(f); return { ativa: x.ativa, protocolo: x.protocolo, baudRate: Number(x.baudRate), paridade: x.paridade, dataBits: Number(x.dataBits), autoConfirmar: x.autoConfirmar }; };
    f.protocolo.onchange = () => { f.baudRate.value = String(PROTOCOLOS[f.protocolo.value]?.baud || 9600); };
    f.onsubmit = (e) => { e.preventDefault(); salvarConfigBalanca(atual()); toast("Balança configurada", "ok"); };
    fe.onsubmit = (e) => { e.preventDefault(); const x = lerForm(fe); salvarConfigBalanca({ etiquetaTipo: x.etiquetaTipo, etiquetaDigitos: Number(x.etiquetaDigitos) }); toast("Formato da etiqueta salvo", "ok"); };
    $("#b-parear", el).onclick = async () => {
      salvarConfigBalanca({ ...atual(), ativa: true }); f.ativa.checked = true;
      try { toast(await parearBalanca(), "ok"); } catch (e) { if (e.name !== "NotFoundError") erro(e); }
    };
    $("#b-testar", el).onclick = async (ev) => {
      salvarConfigBalanca(atual());
      const visor = $("#b-visor", el); visor.hidden = false;
      await ocupado(ev.currentTarget, async () => {
        try {
          const r = await lerPeso({ timeout: 2000 });
          $("#b-peso", el).textContent = (r.peso ?? 0).toFixed(3).replace(".", ",");
          $("#b-sit", el).textContent = r.erro || (r.estavel ? "Estável" : "Instável");
          visor.classList.toggle("instavel", !r.estavel || !!r.erro);
        } catch (e) { $("#b-sit", el).textContent = e.message; visor.classList.add("instavel"); }
      });
    };
    return () => fecharBalanca();
  }

  // ---------- PIX ----------
  async function pix() {
    const e = estado.empresa; const ro = !eh("admin");
    const mp = await rpc("mercado_pago_status").catch(() => false);
    render($("#corpo", el), html`<div class="stack-lg">
      <form id="f-pix" class="panel panel-pad stack-lg">
        <div><h2>Chave PIX da loja</h2><p class="muted">Com a chave cadastrada, o PDV mostra o QR Code com o valor exato quando o cliente escolhe PIX. O dinheiro cai direto na sua conta, sem intermediário e sem taxa.</p></div>
        ${ro ? html`<div class="alerta info">Somente o administrador pode alterar a chave PIX.</div>` : ""}
        <fieldset ${ro ? "disabled" : ""} style="border:0;padding:0;margin:0" class="stack-lg">
        <div class="grid-2">
          <label class="field"><span>Tipo de chave</span><select class="input" name="pix_tipo">
            <option value="">Selecione</option>
            ${TIPOS_CHAVE.map(([v, n]) => html`<option value="${v}" ${e.pix_tipo === v ? "selected" : ""}>${n}</option>`)}</select></label>
          <label class="field"><span>Chave</span><input class="input" name="pix_chave" value="${e.pix_chave || ""}" autocomplete="off"></label>
          <label class="field"><span>Nome do recebedor (até 25 letras)</span><input class="input" name="pix_nome" maxlength="25" value="${e.pix_nome || (e.nome_fantasia || e.razao_social || "").slice(0, 25)}"></label>
          <label class="field"><span>Cidade (até 15 letras)</span><input class="input" name="pix_cidade" maxlength="15" value="${e.pix_cidade || (e.municipio || "").slice(0, 15)}"></label>
        </div>
        <div class="pix-previa" id="previa"></div>
        ${ro ? "" : html`<div class="row wrap"><button class="btn primary">Salvar chave PIX</button>${e.pix_chave ? html`<button type="button" class="btn ghost" id="tirar-pix">Remover chave</button>` : ""}</div>`}
        </fieldset>
      </form>
      <form id="f-mp" class="panel panel-pad stack">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div><h2>Confirmação automática (opcional)</h2>
          <p class="muted">Com uma conta Mercado Pago, cada cobrança ganha um QR único e o sistema confirma o pagamento sozinho, no PDV e no cardápio digital. Sem isso, o caixa confere o PIX no celular e confirma.</p></div>
          ${mp ? html`<span class="badge ok">ativo</span>` : html`<span class="badge">desligado</span>`}
        </div>
        <fieldset ${ro ? "disabled" : ""} style="border:0;padding:0;margin:0" class="stack">
          <label class="field"><span>Access Token de produção do Mercado Pago</span>
            <input class="input" name="token" type="password" autocomplete="off" placeholder="${mp ? "•••••••• (deixe vazio para manter)" : "APP_USR-..."}"></label>
          <p class="hint">Mercado Pago › Seu negócio › Configurações › Credenciais. O token fica guardado no servidor e não volta para o navegador.</p>
          ${ro ? "" : html`<div class="row wrap"><button class="btn">Salvar token</button>${mp ? html`<button type="button" class="btn ghost" id="tirar-mp">Desligar</button>` : ""}</div>`}
        </fieldset>
      </form></div>`);
    const f = $("#f-pix", el);
    await qrPronto();
    const previa = () => {
      const x = lerForm(f);
      const alvo = $("#previa", el);
      if (!x.pix_tipo || !x.pix_chave) return render(alvo, html`<p class="hint">Preencha tipo e chave para ver a prévia do QR.</p>`);
      if (!normalizarChave(x.pix_tipo, x.pix_chave)) return render(alvo, html`<p class="hint" style="color:var(--danger)">Chave não confere com o tipo escolhido.</p>`);
      const codigo = payloadPix({ tipo: x.pix_tipo, chave: x.pix_chave, nome: x.pix_nome, cidade: x.pix_cidade, valor: 1, txid: "TESTE" });
      render(alvo, html`<div class="row" style="gap:1rem;align-items:center"><div class="qr-box sm">${raw(qrSvg(codigo, 140))}</div>
        <p class="small muted">Prévia com R$ 1,00. Leia com o app do banco para conferir o nome antes de usar no caixa. Não precisa pagar.</p></div>`);
    };
    f.addEventListener("input", previa); previa();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const x = lerForm(f);
      const chave = normalizarChave(x.pix_tipo, x.pix_chave);
      if (!chave) return toast("Chave PIX inválida para o tipo escolhido", "erro");
      if (x.pix_nome.length < 2) return toast("Informe o nome do recebedor", "erro");
      await ocupado(f.querySelector("button.primary"), async () => {
        try {
          estado.empresa = await q(sb.from("empresas").update({ pix_tipo: x.pix_tipo, pix_chave: chave, pix_nome: x.pix_nome, pix_cidade: x.pix_cidade || null }).eq("id", e.id).select().single());
          toast("Chave PIX salva. O PDV já mostra o QR Code.", "ok"); pix().catch(erro);
        } catch (err) { erro(err); }
      });
    };
    $("#tirar-pix", el)?.addEventListener("click", async () => {
      try { estado.empresa = await q(sb.from("empresas").update({ pix_tipo: null, pix_chave: null }).eq("id", e.id).select().single()); toast("Chave removida", "ok"); pix().catch(erro); } catch (err) { erro(err); }
    });
    const fm = $("#f-mp", el);
    fm.onsubmit = async (ev) => {
      ev.preventDefault();
      const tk = fm.token.value.trim();
      if (!tk) return toast("Cole o Access Token", "erro");
      if (!/^APP_USR-|^TEST-/.test(tk)) return toast("O token do Mercado Pago começa com APP_USR-", "erro");
      try { await rpc("salvar_mercado_pago", { p_token: tk }); toast("Confirmação automática ligada", "ok"); pix().catch(erro); } catch (err) { erro(err); }
    };
    $("#tirar-mp", el)?.addEventListener("click", async () => {
      try { await rpc("salvar_mercado_pago", { p_token: "" }); toast("Confirmação automática desligada", "ok"); pix().catch(erro); } catch (err) { erro(err); }
    });
  }

  // ---------- Delivery e cardápio ----------
  async function delivery() {
    await qrPronto();
    const e = estado.empresa; const ro = !eh("admin");
    const c = { taxa_entrega: 0, pedido_minimo: 0, tempo_estimado: "40-60 min", entrega: true, retirada: true, mensagem: "", horario: "", ...(e.delivery_config || {}) };
    const sugestao = (e.nome_fantasia || e.razao_social || "minha-loja").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const link = e.slug ? linkCardapio(e.slug) : "";
    const v = (n) => String(Number(n || 0).toFixed(2)).replace(".", ",");
    render($("#corpo", el), html`<div class="stack-lg">
      ${link && e.delivery_ativo ? html`<div class="panel panel-pad row wrap" style="gap:1.25rem;align-items:center">
        <div class="qr-box">${raw(qrSvg(link, 160))}</div>
        <div class="stack grow" style="min-width:220px">
          <h2>Seu cardápio digital está no ar</h2>
          <a href="${link}" target="_blank" rel="noopener" class="link-quebra">${link}</a>
          <div class="row wrap"><button class="btn sm" id="copiar">Copiar link</button><a class="btn sm" href="${link}" target="_blank" rel="noopener">Abrir</a><button class="btn sm" id="imp-qr">Imprimir QR para o balcão</button></div>
          <p class="hint">Divulgue no WhatsApp, Instagram e nas mesas. Os pedidos chegam na tela Delivery e não pagam comissão.</p>
        </div></div>` : ""}
      <form id="f-del" class="panel panel-pad stack-lg">
        ${ro ? html`<div class="alerta info">Somente o administrador pode alterar estas opções.</div>` : ""}
        <fieldset ${ro ? "disabled" : ""} style="border:0;padding:0;margin:0" class="stack-lg">
        <label class="check"><input type="checkbox" name="delivery_ativo" ${e.delivery_ativo ? "checked" : ""}> <strong>Receber pedidos pelo cardápio digital</strong></label>
        <label class="field"><span>Endereço do cardápio</span>
          <div class="row" style="gap:.4rem"><span class="muted small" style="white-space:nowrap">…/cardapio/?loja=</span><input class="input" name="slug" value="${e.slug || sugestao}" maxlength="40" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" required></div>
          <small class="hint">Letras minúsculas, números e hífen. Ex.: padaria-do-ze</small></label>
        <div class="grid-3">
          <label class="field"><span>Taxa de entrega (R$)</span><input class="input" name="taxa_entrega" value="${v(c.taxa_entrega)}" inputmode="decimal"></label>
          <label class="field"><span>Pedido mínimo (R$)</span><input class="input" name="pedido_minimo" value="${v(c.pedido_minimo)}" inputmode="decimal"></label>
          <label class="field"><span>Tempo estimado</span><input class="input" name="tempo_estimado" value="${c.tempo_estimado}" maxlength="20"></label>
        </div>
        <div class="grid-2">
          <label class="check"><input type="checkbox" name="entrega" ${c.entrega !== false ? "checked" : ""}> Faz entrega</label>
          <label class="check"><input type="checkbox" name="retirada" ${c.retirada !== false ? "checked" : ""}> Cliente pode retirar na loja</label>
        </div>
        <label class="field"><span>Horário de atendimento (aparece no cardápio)</span><input class="input" name="horario" value="${c.horario}" maxlength="80" placeholder="Ter a dom, 18h às 23h"></label>
        <label class="field"><span>Recado no topo do cardápio</span><input class="input" name="mensagem" value="${c.mensagem}" maxlength="140" placeholder="Ex.: Entregamos em todo o centro"></label>
        ${!e.pix_chave ? html`<div class="alerta warn">Cadastre a chave PIX na aba PIX para o cliente pagar pelo cardápio.</div>` : ""}
        <p class="hint">Escolha quais produtos aparecem no cardápio em Produtos › editar › “Mostrar no cardápio digital” (com foto e descrição).</p>
        ${ro ? "" : html`<div><button class="btn primary">Salvar</button></div>`}
        </fieldset></form></div>`);
    const f = $("#f-del", el);
    $("#copiar", el)?.addEventListener("click", () => navigator.clipboard?.writeText(link).then(() => toast("Link copiado", "ok")));
    $("#imp-qr", el)?.addEventListener("click", () => imprimirQrCardapio(link));
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const x = lerForm(f);
      const slug = x.slug.toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) return toast("Endereço inválido: use letras minúsculas, números e hífen", "erro");
      const taxa = lerNumero(x.taxa_entrega), min = lerNumero(x.pedido_minimo);
      if (!(taxa >= 0) || !(min >= 0)) return toast("Valores inválidos", "erro");
      if (!x.entrega && !x.retirada) return toast("Marque entrega, retirada ou as duas", "erro");
      await ocupado(f.querySelector("button.primary"), async () => {
        try {
          estado.empresa = await q(sb.from("empresas").update({
            slug, delivery_ativo: x.delivery_ativo,
            delivery_config: { ...c, taxa_entrega: taxa, pedido_minimo: min, tempo_estimado: x.tempo_estimado, entrega: x.entrega, retirada: x.retirada, horario: x.horario, mensagem: x.mensagem },
          }).eq("id", e.id).select().single());
          toast("Delivery configurado", "ok"); delivery().catch(erro);
        } catch (err) { erro(/duplicate|empresas_slug/i.test(err.message) ? new Error("Este endereço já está em uso por outra loja. Escolha outro.") : err); }
      });
    };
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
      if (l.acao.startsWith("suporte.")) return [d.modo && (d.modo === "total" ? "acesso total" : "somente leitura"), d.motivo, d.minutos != null && `${d.minutos} min`].filter(Boolean).join(" · ");
      if (l.acao.startsWith("fiscal.")) return [d.modelo && (d.modelo === "55" ? "NF-e" : "NFC-e"), d.venda && `venda ${d.venda}`, d.status].filter(Boolean).join(" · ");
      return "";
    };
    render($("#corpo", el), html`<div class="panel">${logs.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Quando</th><th>Quem</th><th>O que</th><th>Detalhes</th></tr></thead>
      <tbody>${logs.map((l) => html`<tr><td class="small">${dataHora(l.created_at)}</td><td>${l.detalhes?.via_suporte ? html`<span class="badge info">Suporte</span> ${l.detalhes.por || l.detalhes.suporte_nome || ""}` : nome[l.usuario_id] || "Sistema"}</td><td>${ACOES[l.acao] || l.acao}</td><td class="small muted">${detalhe(l)}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>Nenhuma atividade registrada.</p></div>`}</div>`);
  }

  desenhar();
}

/** Folha A4 com o QR do cardápio para colar no balcão ou nas mesas. */
function imprimirQrCardapio(link) {
  const nome = estado.empresa.nome_fantasia || estado.empresa.razao_social;
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(f);
  f.onload = () => setTimeout(() => { f.contentWindow.print(); setTimeout(() => f.remove(), 1000); }, 80);
  f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:system-ui,sans-serif;text-align:center;padding:30mm 15mm;color:#111}
    h1{font-size:30pt;margin:0 0 4mm} p{font-size:15pt;margin:2mm 0} svg{width:110mm;height:110mm;margin:10mm auto;display:block}
    small{font-size:10pt;color:#555;word-break:break-all}</style></head><body>
    <h1>${esc(nome)}</h1><p>Peça pelo celular</p>${qrSvg(link, 400)}<p><b>Aponte a câmera para o QR Code</b></p><small>${esc(link)}</small></body></html>`;
}
