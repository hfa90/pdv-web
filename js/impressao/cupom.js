// Monta cupons (não fiscal, DANFE NFC-e, pedido e fechamento de caixa) e imprime
// pelo navegador ou direto na térmica (ESC/POS). O layout é descrito uma vez como
// uma lista de "operações" e renderizado nos dois formatos.
import { sb, q } from "../api.js";
import { estado } from "../estado.js";
import { esc, numero, dataHora, formatarDoc, qtd as fmtQtd } from "../ui.js";
import { Escpos, enviar } from "./escpos.js";

// ---------- Configuração (por terminal, salva no navegador) ----------
const CHAVE = "pdv-impressora";
const PADRAO = { modo: "navegador", largura: 80, autoImprimir: true, abrirGaveta: false, acentos: false, baudRate: 9600, viaPedido: false };
export function configImpressora() {
  try { return { ...PADRAO, ...JSON.parse(localStorage.getItem(CHAVE) || "{}") }; } catch { return { ...PADRAO }; }
}
export function salvarConfigImpressora(c) {
  try { localStorage.setItem(CHAVE, JSON.stringify({ ...configImpressora(), ...c })); } catch { /* armazenamento indisponível */ }
}
const colunas = (cfg) => (cfg.largura === 58 ? 32 : 48);

const FORMAS = { dinheiro: "Dinheiro", credito: "Cartão de crédito", debito: "Cartão de débito", pix: "PIX", vale_refeicao: "Vale-refeição", crediario: "Crediário", outros: "Outros" };
export const nomeForma = (f) => FORMAS[f] || f;
const v2 = (n) => numero(n, 2);

// ---------- Construção do layout ----------
function cabecalhoEmpresa(ops) {
  const e = estado.empresa || {};
  ops.push({ t: "texto", s: e.nome_fantasia || e.razao_social, align: "centro", bold: true, grande: true });
  if (e.nome_fantasia && e.razao_social) ops.push({ t: "texto", s: e.razao_social, align: "centro" });
  if (e.cnpj) ops.push({ t: "texto", s: `CNPJ ${formatarDoc(e.cnpj)}${e.inscricao_estadual ? "  IE " + e.inscricao_estadual : ""}`, align: "centro" });
  const end = [e.logradouro, e.numero, e.bairro].filter(Boolean).join(", ");
  if (end) ops.push({ t: "texto", s: end, align: "centro" });
  if (e.municipio) ops.push({ t: "texto", s: `${e.municipio}${e.uf ? "/" + e.uf : ""}${e.telefone ? "  Tel " + e.telefone : ""}`, align: "centro" });
  ops.push({ t: "sep" });
}

export function layoutVenda(venda, doc) {
  const ops = [];
  cabecalhoEmpresa(ops);
  const fiscal = doc?.status === "autorizado";
  const aberta = venda.status === "aberta";
  if (fiscal) {
    ops.push({ t: "texto", s: "DANFE NFC-e", align: "centro", bold: true });
    ops.push({ t: "texto", s: "Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica", align: "centro" });
  } else if (aberta) {
    ops.push({ t: "texto", s: venda.identificador ? `PEDIDO · ${venda.identificador}` : "PEDIDO", align: "centro", bold: true, grande: true });
  } else {
    ops.push({ t: "texto", s: "CUPOM NÃO FISCAL", align: "centro", bold: true });
  }
  if (venda.status === "cancelada") ops.push({ t: "texto", s: "*** VENDA CANCELADA ***", align: "centro", bold: true });
  ops.push({ t: "sep" });

  const itens = (venda.itens || []).filter((i) => !i.removido).sort((a, b) => a.item - b.item);
  itens.forEach((i, idx) => {
    ops.push({ t: "texto", s: `${String(idx + 1).padStart(3, "0")} ${i.descricao}` });
    ops.push({ t: "cols", esq: `    ${fmtQtd(i.quantidade, i.unidade)} ${i.unidade} x ${v2(i.preco_unitario)}${Number(i.desconto) ? "  desc " + v2(i.desconto) : ""}`, dir: v2(i.total) });
    if (i.observacao) ops.push({ t: "texto", s: `    obs: ${i.observacao}` });
  });
  ops.push({ t: "sep" });
  ops.push({ t: "cols", esq: "Qtd. de itens", dir: String(itens.length) });
  if (Number(venda.desconto) || Number(venda.acrescimo)) ops.push({ t: "cols", esq: "Subtotal", dir: v2(venda.subtotal) });
  if (Number(venda.desconto)) ops.push({ t: "cols", esq: "Desconto", dir: "-" + v2(venda.desconto) });
  if (Number(venda.acrescimo)) ops.push({ t: "cols", esq: "Acréscimo / serviço", dir: v2(venda.acrescimo) });
  ops.push({ t: "cols", esq: "TOTAL R$", dir: v2(venda.total), bold: true, grande: true });

  if (!aberta && venda.pagamentos?.length) {
    ops.push({ t: "espaco" });
    ops.push({ t: "cols", esq: "FORMA DE PAGAMENTO", dir: "VALOR PAGO" });
    venda.pagamentos.forEach((p) => ops.push({ t: "cols", esq: nomeForma(p.forma), dir: v2(p.valor) }));
    if (Number(venda.troco)) ops.push({ t: "cols", esq: "Troco", dir: v2(venda.troco) });
  }
  ops.push({ t: "sep" });

  if (fiscal) {
    if (doc.ambiente === "homologacao") ops.push({ t: "texto", s: "EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL", align: "centro", bold: true });
    ops.push({ t: "texto", s: `NFC-e nº ${doc.numero || "-"}  Série ${doc.serie || "-"}  ${dataHora(doc.created_at)}`, align: "centro", bold: true });
    ops.push({ t: "texto", s: "Consulte pela chave de acesso em", align: "centro" });
    if (doc.url_consulta) ops.push({ t: "texto", s: doc.url_consulta, align: "centro" });
    if (doc.chave) ops.push({ t: "texto", s: doc.chave.replace(/(\d{4})(?=\d)/g, "$1 "), align: "centro" });
    const consumidor = venda.cpf_cnpj_consumidor || venda.cliente?.cpf_cnpj;
    ops.push({ t: "texto", s: consumidor ? `CONSUMIDOR CPF/CNPJ ${formatarDoc(consumidor)}` : "CONSUMIDOR NÃO IDENTIFICADO", align: "centro" });
    if (doc.protocolo) ops.push({ t: "texto", s: `Protocolo de autorização ${doc.protocolo}`, align: "centro" });
    if (doc.qrcode_url) ops.push({ t: "qr", s: doc.qrcode_url });
  } else {
    const consumidor = venda.cpf_cnpj_consumidor || venda.cliente?.cpf_cnpj;
    if (consumidor) ops.push({ t: "texto", s: `CPF/CNPJ ${formatarDoc(consumidor)}` });
    if (venda.cliente?.nome) ops.push({ t: "texto", s: `Cliente: ${venda.cliente.nome}` });
  }
  ops.push({ t: "texto", s: `Venda nº ${venda.numero}  ${dataHora(venda.finalizada_em || venda.created_at)}` });
  if (venda.operador?.nome) ops.push({ t: "texto", s: `Operador: ${venda.operador.nome}` });
  if (venda.identificador && !aberta) ops.push({ t: "texto", s: `Mesa/Comanda: ${venda.identificador}` });
  if (venda.observacao) ops.push({ t: "texto", s: `Obs: ${venda.observacao}` });
  if (!aberta && estado.empresa?.mensagem_cupom) { ops.push({ t: "espaco" }); ops.push({ t: "texto", s: estado.empresa.mensagem_cupom, align: "centro" }); }
  return ops;
}

export function layoutFechamento(r, operador) {
  const ops = [];
  cabecalhoEmpresa(ops);
  ops.push({ t: "texto", s: r.status === "fechado" ? "FECHAMENTO DE CAIXA" : "RESUMO DE CAIXA (PARCIAL)", align: "centro", bold: true });
  ops.push({ t: "sep" });
  ops.push({ t: "texto", s: `Operador: ${operador || "-"}` });
  ops.push({ t: "texto", s: `Abertura: ${dataHora(r.aberto_em)}` });
  if (r.fechado_em) ops.push({ t: "texto", s: `Fechamento: ${dataHora(r.fechado_em)}` });
  ops.push({ t: "sep" });
  ops.push({ t: "cols", esq: "Vendas", dir: String(r.vendas_qtd) });
  ops.push({ t: "cols", esq: "Total vendido", dir: v2(r.vendas_total), bold: true });
  ops.push({ t: "cols", esq: "Canceladas", dir: String(r.canceladas_qtd) });
  ops.push({ t: "sep" });
  Object.entries(r.por_forma || {}).forEach(([f, v]) => ops.push({ t: "cols", esq: nomeForma(f), dir: v2(v) }));
  ops.push({ t: "sep" });
  ops.push({ t: "cols", esq: "Fundo de troco", dir: v2(r.valor_abertura) });
  ops.push({ t: "cols", esq: "Suprimentos", dir: v2(r.suprimentos) });
  ops.push({ t: "cols", esq: "Sangrias", dir: "-" + v2(r.sangrias) });
  ops.push({ t: "cols", esq: "Dinheiro esperado", dir: v2(r.esperado_dinheiro), bold: true });
  if (r.valor_informado != null) {
    ops.push({ t: "cols", esq: "Dinheiro contado", dir: v2(r.valor_informado) });
    ops.push({ t: "cols", esq: "Diferença", dir: v2(r.diferenca), bold: true });
  }
  ops.push({ t: "espaco" }); ops.push({ t: "espaco" });
  ops.push({ t: "texto", s: "_______________________________", align: "centro" });
  ops.push({ t: "texto", s: "Assinatura do operador", align: "centro" });
  return ops;
}

// ---------- Renderização ESC/POS ----------
function quebrar(s, n) {
  const out = []; let linha = "";
  for (const palavra of String(s).split(/\s+/)) {
    if ((linha + " " + palavra).trim().length > n) { if (linha) out.push(linha); linha = palavra; while (linha.length > n) { out.push(linha.slice(0, n)); linha = linha.slice(n); } }
    else linha = (linha + " " + palavra).trim();
  }
  if (linha) out.push(linha);
  return out.length ? out : [""];
}

function paraEscpos(ops, cfg) {
  const n = colunas(cfg);
  const p = new Escpos({ acentos: cfg.acentos }).init();
  for (const o of ops) {
    if (o.t === "sep") { p.align("esquerda").linha("-".repeat(n)); continue; }
    if (o.t === "espaco") { p.linha(""); continue; }
    if (o.t === "qr") { p.align("centro").qrcode(o.s, cfg.largura === 58 ? 4 : 5).linha("").align("esquerda"); continue; }
    p.align(o.align || "esquerda").negrito(!!o.bold);
    const larg = o.grande ? n / 2 : n;
    if (o.grande) p.tamanho(2, 2);
    if (o.t === "texto") quebrar(o.s, larg).forEach((l) => p.linha(l));
    if (o.t === "cols") {
      const dir = String(o.dir); const esq = String(o.esq);
      const espaco = larg - dir.length - 1;
      const linhas = quebrar(esq, Math.max(espaco, 8));
      linhas.slice(0, -1).forEach((l) => p.linha(l));
      const ult = linhas[linhas.length - 1];
      p.linha(ult + " ".repeat(Math.max(1, larg - ult.length - dir.length)) + dir);
    }
    if (o.grande) p.tamanho(1, 1);
    p.negrito(false);
  }
  p.align("esquerda").avancar(4).cortar();
  if (cfg.abrirGaveta) p.gaveta();
  return p.bytes();
}

// ---------- Renderização HTML (impressão pelo navegador) ----------
function paraHtml(ops, cfg) {
  const largura = cfg.largura === 58 ? 48 : 72;
  const corpo = ops.map((o) => {
    const cls = [o.bold ? "b" : "", o.grande ? "g" : "", o.align === "centro" ? "c" : ""].join(" ");
    if (o.t === "sep") return '<hr>';
    if (o.t === "espaco") return '<div class="e"></div>';
    if (o.t === "qr") {
      try {
        const qr = window.qrcode(0, "M"); qr.addData(o.s); qr.make();
        return `<div class="c qr">${qr.createSvgTag({ cellSize: 3, margin: 0 })}</div>`;
      } catch { return ""; }
    }
    if (o.t === "cols") return `<div class="l ${cls}"><span>${esc(o.esq)}</span><span>${esc(o.dir)}</span></div>`;
    return `<div class="${cls}">${esc(o.s)}</div>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${cfg.largura}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 3mm 2mm 6mm; width: ${largura + 4}mm; font: 11px/1.3 "Courier New", ui-monospace, monospace; color: #000; }
    div { word-wrap: break-word; }
    .c { text-align: center; } .b { font-weight: 700; } .g { font-size: 15px; }
    .l { display: flex; justify-content: space-between; gap: 6px; } .l span:last-child { white-space: nowrap; }
    hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
    .e { height: 8px; } .qr svg { width: 34mm; height: 34mm; margin: 4px auto; display: block; }
  </style></head><body>${corpo}</body></html>`;
}

function imprimirNavegador(conteudo) {
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(f);
    f.onload = () => {
      setTimeout(() => {
        f.contentWindow.focus();
        f.contentWindow.print();
        setTimeout(() => { f.remove(); resolve(); }, 1000);
      }, 50);
    };
    f.srcdoc = conteudo;
  });
}

export async function imprimir(ops) {
  const cfg = configImpressora();
  if (cfg.modo === "navegador") return imprimirNavegador(paraHtml(ops, cfg));
  return enviar(cfg.modo, paraEscpos(ops, cfg), { baudRate: cfg.baudRate });
}

export async function abrirGaveta() {
  const cfg = configImpressora();
  if (cfg.modo === "navegador") throw new Error("Abrir gaveta requer impressora conectada por USB ou serial");
  const p = new Escpos().init().gaveta();
  return enviar(cfg.modo, p.bytes(), { baudRate: cfg.baudRate });
}

/** Busca a venda completa e imprime (cupom fiscal se houver NFC-e autorizada). */
export async function imprimirVenda(vendaId) {
  const venda = await q(sb.from("vendas")
    .select("*, cliente:clientes(nome, cpf_cnpj), operador:perfis!vendas_operador_id_fkey(nome), itens:venda_itens(*), pagamentos:venda_pagamentos(*)")
    .eq("id", vendaId).single());
  const doc = await q(sb.from("documentos_fiscais").select("*").eq("venda_id", vendaId).eq("modelo", "65")
    .eq("status", "autorizado").order("created_at", { ascending: false }).limit(1).maybeSingle());
  await imprimir(layoutVenda(venda, doc));
  return { venda, doc };
}

export async function imprimirTeste() {
  const ops = [];
  cabecalhoEmpresa(ops);
  ops.push({ t: "texto", s: "TESTE DE IMPRESSÃO", align: "centro", bold: true, grande: true });
  ops.push({ t: "texto", s: "Acentuação: ação, café, pão, maçã", align: "centro" });
  ops.push({ t: "cols", esq: "Item de exemplo", dir: "12,34" });
  ops.push({ t: "cols", esq: "TOTAL R$", dir: "12,34", bold: true, grande: true });
  ops.push({ t: "qr", s: "https://www.nfce.fazenda.gov.br" });
  return imprimir(ops);
}
