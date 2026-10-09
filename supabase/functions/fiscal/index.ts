// Emissão de NFC-e (modelo 65) e NF-e (modelo 55) via provedor Focus NFe.
// O token do provedor fica em public.fiscal_credenciais e nunca chega ao navegador.
// Para trocar de provedor, implemente outro "adaptador" com as mesmas funções.
import { autenticar, auditar, cors, exigirPapel, HttpError, json } from "../_shared/auth.ts";

const BASE = {
  homologacao: "https://homologacao.focusnfe.com.br",
  producao: "https://api.focusnfe.com.br",
};

// Formas de pagamento (tabela SEFAZ - tPag)
const TPAG: Record<string, string> = {
  dinheiro: "01", credito: "03", debito: "04", crediario: "05",
  vale_refeicao: "11", pix: "17", outros: "99",
};

const digitos = (s?: string | null) => (s ?? "").replace(/\D/g, "");
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Distribui um valor (desconto/acréscimo da venda) entre os itens, proporcional ao total de cada um. */
function ratear(valor: number, bases: number[]): number[] {
  const soma = bases.reduce((a, b) => a + b, 0);
  if (!valor || !soma) return bases.map(() => 0);
  const partes = bases.map((b) => r2((valor * b) / soma));
  const dif = r2(valor - partes.reduce((a, b) => a + b, 0));
  partes[partes.length - 1] = r2(partes[partes.length - 1] + dif);
  return partes;
}

async function chamar(base: string, token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: "Basic " + btoa(token + ":"), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await res.text();
  let dados: any;
  try { dados = JSON.parse(texto); } catch { dados = { mensagem: texto }; }
  return { ok: res.ok, status: res.status, dados };
}

function mapearStatus(s?: string): string {
  if (s === "autorizado") return "autorizado";
  if (s === "cancelado") return "cancelado";
  if (s === "erro_autorizacao" || s === "denegado") return "rejeitado";
  if (s?.startsWith("processando")) return "processando";
  return "erro";
}

function camposResposta(base: string, d: any) {
  const abs = (p?: string) => (p ? (p.startsWith("http") ? p : base + p) : null);
  return {
    status: mapearStatus(d?.status),
    numero: d?.numero ?? null,
    serie: d?.serie ?? null,
    chave: d?.chave_nfe ?? null,
    protocolo: d?.protocolo ?? null,
    url_xml: abs(d?.caminho_xml_nota_fiscal),
    url_danfe: abs(d?.caminho_danfe),
    qrcode_url: d?.qrcode_url ?? null,
    url_consulta: d?.url_consulta_nf ?? null,
    mensagem: d?.mensagem_sefaz ?? d?.mensagem ?? (Array.isArray(d?.erros) ? d.erros.map((e: any) => e.mensagem).join("; ") : null),
    resposta: d,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") throw new HttpError(405, "Método não permitido");
    const { admin, perfil } = await autenticar(req);
    const body = await req.json().catch(() => ({}));

    const { data: cfg } = await admin.from("config_fiscal").select("*").eq("empresa_id", perfil.empresa_id).single();
    const { data: cred } = await admin.from("fiscal_credenciais").select("*").eq("empresa_id", perfil.empresa_id).single();
    if (!cfg?.habilitado) throw new HttpError(400, "Emissão fiscal desativada. Ative em Configurações > Fiscal.");
    const ambiente = cfg.ambiente as "homologacao" | "producao";
    const token = ambiente === "producao" ? cred?.token_producao : cred?.token_homologacao;
    if (!token) throw new HttpError(400, `Token do provedor (${ambiente}) não configurado`);
    const base = BASE[ambiente];

    // ---------------- EMITIR ----------------
    if (body.acao === "emitir") {
      // Licença da nota fiscal (migração 021): vencida, não emite
      const { data: lic } = await admin.from("licencas").select("expira_em")
        .eq("empresa_id", perfil.empresa_id).eq("modulo", "fiscal").maybeSingle();
      if (lic?.expira_em && new Date(lic.expira_em) <= new Date()) {
        throw new HttpError(403, `A licença da nota fiscal venceu em ${new Date(lic.expira_em).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}. Fale com o suporte para renovar.`);
      }
      const modelo = body.modelo === "55" ? "55" : "65";
      // O garçom emite a NFC-e só das contas que ele mesmo fechou no app
      const garcomApp = perfil.papel === "atendente" && modelo === "65";
      if (!garcomApp) exigirPapel(perfil, ["admin", "gerente", "caixa"]);
      const recurso = modelo === "55" ? "nfe" : "nfce";

      const { data: venda } = await admin.from("vendas")
        .select("*, cliente:clientes(*), itens:venda_itens(*, produto:produtos(*)), pagamentos:venda_pagamentos(*)")
        .eq("id", body.venda_id).eq("empresa_id", perfil.empresa_id).single();
      if (!venda) throw new HttpError(404, "Venda não encontrada");
      if (venda.status !== "finalizada") throw new HttpError(400, "Apenas vendas finalizadas podem ser emitidas");
      if (garcomApp && (!venda.recebido_no_app || venda.operador_id !== perfil.id)) throw new HttpError(403, "Sem permissão para emitir a nota desta venda");

      const { data: existente } = await admin.from("documentos_fiscais").select("*")
        .eq("venda_id", venda.id).in("status", ["autorizado", "processando"]).maybeSingle();
      if (existente) return json(existente);

      const { data: emp } = await admin.from("empresas").select("*").eq("id", perfil.empresa_id).single();
      if (!digitos(emp.cnpj)) throw new HttpError(400, "Cadastre o CNPJ da empresa em Configurações");

      const itens = (venda.itens as any[]).filter((i) => !i.removido).sort((a, b) => a.item - b.item);
      const brutos = itens.map((i) => r2(Number(i.quantidade) * Number(i.preco_unitario)));
      const descVenda = r2(Number(venda.desconto) - itens.reduce((a, i) => a + Number(i.desconto), 0));
      const descRateio = ratear(descVenda, brutos);
      const acrRateio = ratear(Number(venda.acrescimo), brutos);

      const payload: any = {
        natureza_operacao: "VENDA AO CONSUMIDOR",
        data_emissao: new Date().toISOString(),
        tipo_documento: 1,
        presenca_comprador: 1,
        consumidor_final: 1,
        finalidade_emissao: 1,
        local_destino: 1,
        modalidade_frete: 9,
        cnpj_emitente: digitos(emp.cnpj),
        items: itens.map((i, idx) => {
          const p = i.produto ?? {};
          return {
            numero_item: idx + 1,
            codigo_produto: p.codigo || String(idx + 1),
            codigo_barras_comercial: p.codigo_barras || "SEM GTIN",
            codigo_barras_tributavel: p.codigo_barras || "SEM GTIN",
            descricao: i.descricao,
            codigo_ncm: digitos(p.ncm) || "00000000",
            cest: digitos(p.cest) || undefined,
            cfop: p.cfop || "5102",
            unidade_comercial: i.unidade,
            unidade_tributavel: i.unidade,
            quantidade_comercial: Number(i.quantidade),
            quantidade_tributavel: Number(i.quantidade),
            valor_unitario_comercial: Number(i.preco_unitario),
            valor_unitario_tributavel: Number(i.preco_unitario),
            valor_bruto: brutos[idx],
            valor_desconto: r2(Number(i.desconto) + descRateio[idx]) || undefined,
            valor_outras_despesas: acrRateio[idx] || undefined,
            inclui_no_total: 1,
            icms_origem: p.origem ?? 0,
            icms_situacao_tributaria: p.csosn || "102",
            pis_situacao_tributaria: "49",
            cofins_situacao_tributaria: "49",
          };
        }),
        formas_pagamento: (venda.pagamentos as any[]).map((pg) => ({
          forma_pagamento: TPAG[pg.forma] ?? "99",
          valor_pagamento: Number(pg.valor),
          ...(["credito", "debito", "pix"].includes(pg.forma) ? { tipo_integracao: 2 } : {}),
        })),
      };
      if (Number(venda.troco) > 0) payload.troco = Number(venda.troco);

      const doc = digitos(venda.cpf_cnpj_consumidor || venda.cliente?.cpf_cnpj);
      if (doc.length === 11) payload.cpf_destinatario = doc;
      if (doc.length === 14) payload.cnpj_destinatario = doc;

      if (modelo === "55") {
        const c = venda.cliente;
        if (!c || !doc || !c.logradouro || !c.municipio || !c.uf) {
          throw new HttpError(400, "NF-e exige cliente com CPF/CNPJ e endereço completo");
        }
        Object.assign(payload, {
          natureza_operacao: "VENDA DE MERCADORIA",
          nome_destinatario: c.nome,
          logradouro_destinatario: c.logradouro,
          numero_destinatario: c.numero || "S/N",
          bairro_destinatario: c.bairro || "Centro",
          municipio_destinatario: c.municipio,
          uf_destinatario: c.uf,
          cep_destinatario: digitos(c.cep),
          telefone_destinatario: digitos(c.telefone) || undefined,
          indicador_inscricao_estadual_destinatario: c.inscricao_estadual ? 1 : 9,
          inscricao_estadual_destinatario: c.inscricao_estadual || undefined,
        });
      }

      const referencia = `${perfil.empresa_id.slice(0, 8)}-${venda.numero}-${modelo}-${Date.now()}`;
      const { data: registro, error: eIns } = await admin.from("documentos_fiscais").insert({
        empresa_id: perfil.empresa_id, venda_id: venda.id, modelo, referencia, ambiente, status: "processando",
      }).select().single();
      if (eIns) throw new HttpError(500, "Falha ao registrar documento");

      let campos: Record<string, unknown>;
      try {
        const r = await chamar(base, token, "POST", `/v2/${recurso}?ref=${encodeURIComponent(referencia)}`, payload);
        campos = r.ok ? camposResposta(base, r.dados) : { ...camposResposta(base, r.dados), status: "rejeitado" };
      } catch (_e) {
        campos = { status: "erro", mensagem: "Não foi possível contatar o provedor fiscal. Tente novamente." };
      }
      const { data: atualizado } = await admin.from("documentos_fiscais").update(campos).eq("id", registro.id).select().single();
      await auditar(admin, perfil, "fiscal.emitir", "documentos_fiscais", registro.id, { modelo, venda: venda.numero, status: campos.status });
      return json(atualizado);
    }

    // ---------------- CONSULTAR ----------------
    if (body.acao === "consultar") {
      const { data: d } = await admin.from("documentos_fiscais").select("*")
        .eq("id", body.documento_id).eq("empresa_id", perfil.empresa_id).single();
      if (!d) throw new HttpError(404, "Documento não encontrado");
      const recurso = d.modelo === "55" ? "nfe" : "nfce";
      const r = await chamar(BASE[d.ambiente as "homologacao"], token, "GET", `/v2/${recurso}/${encodeURIComponent(d.referencia)}`);
      if (!r.ok) throw new HttpError(502, r.dados?.mensagem ?? "Falha na consulta");
      const { data: atualizado } = await admin.from("documentos_fiscais")
        .update(camposResposta(BASE[d.ambiente as "homologacao"], r.dados)).eq("id", d.id).select().single();
      return json(atualizado);
    }

    // ---------------- CANCELAR ----------------
    if (body.acao === "cancelar") {
      exigirPapel(perfil, ["admin", "gerente"]);
      const justificativa = String(body.justificativa ?? "").trim();
      if (justificativa.length < 15) throw new HttpError(400, "A justificativa precisa ter ao menos 15 caracteres");
      const { data: d } = await admin.from("documentos_fiscais").select("*")
        .eq("id", body.documento_id).eq("empresa_id", perfil.empresa_id).single();
      if (!d) throw new HttpError(404, "Documento não encontrado");
      if (d.status !== "autorizado") throw new HttpError(400, "Somente documentos autorizados podem ser cancelados");
      const recurso = d.modelo === "55" ? "nfe" : "nfce";
      const r = await chamar(BASE[d.ambiente as "homologacao"], token, "DELETE",
        `/v2/${recurso}/${encodeURIComponent(d.referencia)}`, { justificativa: justificativa.slice(0, 255) });
      const ok = r.ok && (r.dados?.status === "cancelado" || r.dados?.status_sefaz === "135");
      const { data: atualizado } = await admin.from("documentos_fiscais").update({
        status: ok ? "cancelado" : d.status,
        mensagem: r.dados?.mensagem_sefaz ?? r.dados?.mensagem ?? null,
      }).eq("id", d.id).select().single();
      await auditar(admin, perfil, "fiscal.cancelar", "documentos_fiscais", d.id, { ok, justificativa });
      if (!ok) throw new HttpError(400, atualizado?.mensagem ?? "Cancelamento não autorizado");
      return json(atualizado);
    }

    throw new HttpError(400, "Ação inválida");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : "Erro inesperado" }, status);
  }
});
