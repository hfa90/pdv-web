// Fiado (contas a receber): quem deve, quanto está vencido, receber, extrato e cobrança pelo WhatsApp com PIX.
import { sb, q, rpc } from "../api.js";
import { estado, eh } from "../estado.js";
import { html, raw, render, $, $$, dinheiro, lerNumero, toast, erro, modal, dataHora, debounce, formatarDoc } from "../ui.js";
import { icone } from "../icons.js";
import { imprimir } from "../impressao/cupom.js";
import { payloadPix, qrSvg, qrPronto } from "../../../assets/pix.js";
import { linkZap, dataBR, baixarCSV, numCSV } from "../gestao-ui.js";

const TIPOS = { compra: ["Compra", "warn"], pagamento: ["Pagamento", "ok"], estorno: ["Estorno", ""], ajuste: ["Ajuste", "info"] };
const FORMAS = [["dinheiro", "Dinheiro"], ["pix", "PIX"], ["debito", "Débito"], ["credito", "Crédito"], ["outros", "Outros"]];

function codigoPix(valor) {
  const e = estado.empresa;
  if (!e.pix_chave || !e.pix_tipo || !(valor > 0)) return null;
  try { return payloadPix({ tipo: e.pix_tipo, chave: e.pix_chave, nome: e.pix_nome || e.nome_fantasia || e.razao_social, cidade: e.pix_cidade || e.municipio, valor }); } catch { return null; }
}

export default async function fiado(el) {
  const gestor = eh("admin", "gerente");
  let todos = false, busca = "", lista = [];
  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Fiado</h1><p>Clientes que compram para pagar depois. No caixa, use a forma de pagamento “Crediário” com o cliente identificado.</p></div>
      <button class="btn" id="csv">Exportar CSV</button></div>
    <div class="kpis" id="k"></div>
    <div class="toolbar"><input class="input" id="b" placeholder="Buscar cliente"><div class="chips">
      <button class="chip ativo" data-t="0">Com saldo</button>${gestor ? html`<button class="chip" data-t="1">Todos os clientes (limites)</button>` : ""}</div></div>
    <div class="panel" id="l"></div></div>`);
  await qrPronto(1500);

  $("#b", el).oninput = debounce((e) => { busca = e.target.value.trim().toLowerCase(); desenhar(); }, 150);
  $$("[data-t]", el).forEach((b) => (b.onclick = () => { todos = b.dataset.t === "1"; $$("[data-t]", el).forEach((x) => x.classList.toggle("ativo", x === b)); carregar().catch(erro); }));
  $("#csv", el).onclick = () => baixarCSV("fiado.csv", [["Cliente", "Telefone", "Saldo", "Vencido", "Limite", "Último pagamento"],
    ...lista.map((c) => [c.nome, c.telefone || "", numCSV(c.saldo), numCSV(c.vencido), c.limite == null ? "" : numCSV(c.limite), c.ultimo_pagamento ? dataHora(c.ultimo_pagamento) : ""])]);

  async function carregar() {
    lista = await rpc("fiado_clientes", { p_todos: todos });
    const dev = lista.filter((c) => c.saldo > 0);
    render($("#k", el), html`
      <div class="panel kpi"><div class="k-label">A receber</div><div class="k-valor">${dinheiro(dev.reduce((a, c) => a + Number(c.saldo), 0))}</div><div class="k-sub">${dev.length} cliente(s)</div></div>
      <div class="panel kpi"><div class="k-label">Vencido</div><div class="k-valor" style="color:var(--danger)">${dinheiro(dev.reduce((a, c) => a + Number(c.vencido), 0))}</div><div class="k-sub">${dev.filter((c) => c.vencido > 0).length} cliente(s) atrasados</div></div>`);
    desenhar();
  }

  function desenhar() {
    const f = lista.filter((c) => !busca || c.nome.toLowerCase().includes(busca) || (c.telefone || "").includes(busca) || (c.cpf_cnpj || "").includes(busca));
    render($("#l", el), f.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Cliente</th><th class="r">Deve</th><th class="r">Vencido</th><th class="r">Limite</th><th>Último pagamento</th><th></th></tr></thead>
      <tbody>${f.map((c) => html`<tr>
        <td><strong>${c.nome}</strong>${c.bloqueado ? html` <span class="badge danger">bloqueado</span>` : ""}<div class="small muted">${c.telefone || ""}${c.cpf_cnpj ? " · " + formatarDoc(c.cpf_cnpj) : ""}</div></td>
        <td class="r"><strong style="color:${c.saldo < 0 ? "var(--ok)" : ""}">${c.saldo < 0 ? "crédito " + dinheiro(-c.saldo) : dinheiro(c.saldo)}</strong></td>
        <td class="r">${c.vencido > 0 ? html`<span class="badge danger">${dinheiro(c.vencido)}</span>` : "—"}</td>
        <td class="r small">${c.limite == null ? "sem limite" : dinheiro(c.limite)}<div class="muted">${c.prazo} dias</div></td>
        <td class="small">${c.ultimo_pagamento ? dataHora(c.ultimo_pagamento) : "—"}</td>
        <td class="r"><div class="row wrap" style="gap:.3rem;justify-content:flex-end">
          ${c.saldo > 0 ? html`<button class="btn sm primary" data-a="receber" data-id="${c.id}">Receber</button><button class="btn sm" data-a="cobrar" data-id="${c.id}">${icone("whatsapp", 'width="15" height="15"')} Cobrar</button>` : ""}
          <button class="btn sm ghost" data-a="extrato" data-id="${c.id}">Extrato</button>
          ${gestor ? html`<button class="btn sm ghost" data-a="limite" data-id="${c.id}">Limite</button>` : ""}</div></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>${todos ? "Nenhum cliente cadastrado." : "Ninguém devendo. 🎉"}</p><p class="small">Para vender fiado: no caixa identifique o cliente (botão CPF) e escolha “Crediário”.</p></div>`);
    $$("[data-a]", el).forEach((b) => (b.onclick = () => {
      const c = lista.find((x) => x.id === b.dataset.id);
      ({ receber, cobrar, extrato, limite })[b.dataset.a](c).catch(erro);
    }));
  }

  async function receber(c) {
    const r = await modal({
      titulo: `Receber de ${c.nome}`,
      corpo: html`<form id="fr" class="stack">
        <p>Deve <strong>${dinheiro(c.saldo)}</strong>${c.vencido > 0 ? html` · vencido <span class="badge danger">${dinheiro(c.vencido)}</span>` : ""}</p>
        <div class="grid-2"><label class="field"><span>Valor recebido</span><input class="input lg" name="v" inputmode="decimal" value="${String(c.saldo).replace(".", ",")}" autofocus></label>
        <label class="field"><span>Forma</span><select class="input lg" name="f">${FORMAS.map(([k, n]) => html`<option value="${k}">${n}</option>`)}</select></label></div>
        <div id="pix-rec"></div>
        <label class="field"><span>Observação</span><input class="input" name="o"></label>
        <p class="small muted">Dinheiro entra no seu caixa aberto (aparece no fechamento). PIX e cartão não mexem na gaveta.</p></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="fr">Confirmar recebimento</button>`,
      onPronto: (d, fechar) => {
        const f = d.querySelector("form");
        const pix = () => {
          const v = lerNumero(f.v.value), cod = f.f.value === "pix" ? codigoPix(v) : null;
          render(d.querySelector("#pix-rec"), cod ? html`<div class="row wrap pix-linha"><div class="qr-box">${raw(qrSvg(cod, 170))}</div>
            <div class="stack grow" style="gap:.4rem"><span class="small muted">Mostre o QR ao cliente e confira no app do banco antes de confirmar.</span>
            <button type="button" class="btn sm" data-copiar>Copiar código PIX</button></div></div>` : "");
          d.querySelector("[data-copiar]")?.addEventListener("click", () => navigator.clipboard?.writeText(cod).then(() => toast("Código copiado", "ok")));
        };
        f.f.onchange = pix; f.v.oninput = debounce(pix, 300);
        f.onsubmit = (e) => { e.preventDefault(); fechar({ v: lerNumero(f.v.value), f: f.f.value, o: f.o.value.trim() }); };
      },
    });
    if (!r) return;
    if (!(r.v > 0)) return toast("Informe o valor", "erro");
    const res = await rpc("receber_fiado", { p_cliente: c.id, p_valor: r.v, p_forma: r.f, p_obs: r.o || null });
    toast(`Recebido ${dinheiro(r.v)}. ${res.saldo > 0 ? `Ainda deve ${dinheiro(res.saldo)}` : "Quitado!"}`, "ok");
    imprimir([
      { t: "texto", s: estado.empresa.nome_fantasia || estado.empresa.razao_social, align: "centro", bold: true },
      { t: "texto", s: "RECIBO DE PAGAMENTO - FIADO", align: "centro", bold: true }, { t: "sep" },
      { t: "texto", s: `Cliente: ${c.nome}` }, { t: "cols", esq: "Valor pago", dir: dinheiro(r.v), bold: true },
      { t: "cols", esq: "Forma", dir: FORMAS.find(([k]) => k === r.f)[1] }, { t: "cols", esq: "Saldo restante", dir: dinheiro(res.saldo) },
      { t: "texto", s: new Date().toLocaleString("pt-BR") }, { t: "espaco" }, { t: "texto", s: "______________________________", align: "centro" }, { t: "texto", s: "Assinatura", align: "centro" },
    ]).catch(() => {});
    carregar();
  }

  async function cobrar(c) {
    const valor = Number(c.vencido > 0 ? c.vencido : c.saldo);
    const cod = codigoPix(valor);
    const loja = estado.empresa.nome_fantasia || estado.empresa.razao_social;
    const texto = `Olá, ${c.nome.split(" ")[0]}! Aqui é do ${loja}. 😊\n\nSeu saldo no fiado é de ${dinheiro(c.saldo)}${c.vencido > 0 ? `, sendo ${dinheiro(c.vencido)} já vencido` : ""}.`
      + (cod ? `\n\nPara pagar ${dinheiro(valor)} pelo PIX, copie o código abaixo e cole no app do seu banco (PIX › Copia e Cola):\n\n${cod}` : "")
      + `\n\nQualquer dúvida é só chamar. Obrigado!`;
    const link = linkZap(c.telefone, texto);
    await modal({
      titulo: `Cobrar ${c.nome}`,
      corpo: html`<div class="stack"><textarea class="input" rows="9" id="msg">${texto}</textarea>
        ${!cod ? html`<p class="small muted">Cadastre a chave PIX da loja em Configurações › PIX para mandar o código de pagamento junto.</p>` : ""}
        ${!c.telefone ? html`<p class="small muted">Cliente sem telefone: copie a mensagem e envie como preferir.</p>` : ""}</div>`,
      rodape: html`<button class="btn" id="copiar">Copiar mensagem</button>${link ? html`<button class="btn primary" id="zap">${icone("whatsapp", 'width="18" height="18"')} Abrir no WhatsApp</button>` : ""}`,
      onPronto: (d) => {
        d.querySelector("#copiar").onclick = () => navigator.clipboard?.writeText(d.querySelector("#msg").value).then(() => toast("Mensagem copiada", "ok"));
        d.querySelector("#zap")?.addEventListener("click", () => window.open(linkZap(c.telefone, d.querySelector("#msg").value), "_blank", "noopener"));
      },
    });
  }

  async function extrato(c) {
    const l = await q(sb.from("fiado_lancamentos").select("*, usuario:perfis(nome)").eq("cliente_id", c.id).order("created_at"));
    let saldo = 0;
    const linhas = l.map((x) => { saldo = Math.round((saldo + Number(x.valor)) * 100) / 100; return { ...x, saldo }; });
    await modal({
      titulo: `Extrato · ${c.nome}`, largo: true,
      corpo: linhas.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Data</th><th>Tipo</th><th>Detalhe</th><th class="r">Valor</th><th class="r">Saldo</th></tr></thead>
        <tbody>${linhas.slice().reverse().map((x) => html`<tr><td class="small">${dataHora(x.created_at)}</td><td><span class="badge ${TIPOS[x.tipo][1]}">${TIPOS[x.tipo][0]}</span></td>
          <td class="small">${x.observacao || ""}${x.forma ? ` · ${x.forma}` : ""}${x.vencimento && x.valor > 0 ? ` · vence ${dataBR(x.vencimento)}` : ""}${x.usuario?.nome ? html`<div class="muted">${x.usuario.nome}</div>` : ""}</td>
          <td class="r num" style="color:${x.valor > 0 ? "var(--danger)" : "var(--ok)"}">${x.valor > 0 ? "+" : "−"}${dinheiro(Math.abs(x.valor))}</td><td class="r"><strong>${dinheiro(x.saldo)}</strong></td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Sem lançamentos.</p></div>`,
      rodape: html`${gestor ? html`<button class="btn" id="ajuste">Ajuste manual</button>` : ""}<span class="grow"></span><button class="btn" id="imp">${icone("imprimir", 'width="18" height="18"')} Imprimir</button><button class="btn primary" data-fechar>Fechar</button>`,
      onPronto: (d, fechar) => {
        d.querySelector("#imp").onclick = () => imprimir([
          { t: "texto", s: estado.empresa.nome_fantasia || estado.empresa.razao_social, align: "centro", bold: true },
          { t: "texto", s: `EXTRATO DO FIADO - ${c.nome}`, align: "centro", bold: true }, { t: "sep" },
          ...linhas.slice(-40).map((x) => ({ t: "cols", esq: `${new Date(x.created_at).toLocaleDateString("pt-BR")} ${TIPOS[x.tipo][0]}`, dir: `${x.valor > 0 ? "+" : "-"}${Math.abs(x.valor).toFixed(2).replace(".", ",")}` })),
          { t: "sep" }, { t: "cols", esq: "SALDO", dir: dinheiro(c.saldo), bold: true, grande: true },
        ]).catch(erro);
        d.querySelector("#ajuste")?.addEventListener("click", () => { fechar(); ajuste(c).catch(erro); });
      },
    });
  }

  async function ajuste(c) {
    const r = await modal({
      titulo: `Ajuste no fiado · ${c.nome}`,
      corpo: html`<form id="fa" class="stack"><p class="small muted">Use para lançar dívida antiga (do caderno) ou corrigir erro. Fica no registro de atividades.</p>
        <div class="grid-2"><label class="field"><span>Tipo</span><select class="input" name="t"><option value="1">Aumentar a dívida</option><option value="-1">Diminuir a dívida</option></select></label>
        <label class="field"><span>Valor</span><input class="input" name="v" inputmode="decimal" autofocus></label></div>
        <label class="field"><span>Motivo</span><input class="input" name="m" required placeholder="Ex.: saldo do caderno até 30/09"></label></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="fa">Lançar</button>`,
      onPronto: (d, f) => (d.querySelector("form").onsubmit = (e) => { e.preventDefault(); f({ v: lerNumero(e.target.v.value) * Number(e.target.t.value), m: e.target.m.value.trim() }); }),
    });
    if (!r) return;
    await rpc("ajustar_fiado", { p_cliente: c.id, p_valor: r.v, p_motivo: r.m });
    toast("Ajuste lançado", "ok"); carregar();
  }

  async function limite(c) {
    const r = await modal({
      titulo: `Limite do fiado · ${c.nome}`,
      corpo: html`<form id="fl" class="stack"><div class="grid-2">
        <label class="field"><span>Limite (R$)</span><input class="input" name="l" inputmode="decimal" value="${c.limite == null ? "" : String(c.limite).replace(".", ",")}" placeholder="vazio = sem limite"></label>
        <label class="field"><span>Prazo para pagar (dias)</span><input class="input" name="p" inputmode="numeric" value="${c.prazo}"></label></div>
        <label class="check"><input type="checkbox" name="b" ${c.bloqueado ? "checked" : ""}> Bloquear novas compras no fiado</label>
        <p class="small muted">O caixa não consegue passar do limite nem vender para cliente bloqueado. Gerente e administrador podem liberar na hora.</p></form>`,
      rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="fl">Salvar</button>`,
      onPronto: (d, f) => (d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const x = e.target; f({ l: x.l.value.trim() === "" ? null : lerNumero(x.l.value), p: Number(x.p.value) || 30, b: x.b.checked }); }),
    });
    if (!r) return;
    await rpc("fiado_config_cliente", { p_cliente: c.id, p_limite: r.l, p_prazo: r.p, p_bloqueado: r.b });
    toast("Limite salvo", "ok"); carregar();
  }

  await carregar();
}
