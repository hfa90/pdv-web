// Gerado a partir de supabase/migrations: qual migração cria cada função e tabela.
// Serve para o diagnóstico dizer exatamente QUAL arquivo .sql falta rodar no Supabase.
// Ao criar uma migração nova, acrescente aqui as funções/tabelas dela.
export const ARQUIVOS = {
  "001": "001_schema.sql",
  "002": "002_funcoes.sql",
  "003": "003_endurecer_permissoes.sql",
  "004": "004_indices.sql",
  "005": "005_comercial.sql",
  "006": "006_mesas_delivery_pix.sql",
  "007": "007_ajustes_delivery.sql",
  "008": "008_plataforma_modulos.sql",
  "009": "009_assinatura_faturamento.sql",
  "010": "010_contingencia.sql",
  "011": "011_gestao.sql",
  "012": "012_agendar_resumo.sql",
  "013": "013_papel_cozinha.sql",
  "014": "014_restaurante.sql",
  "015": "015_garcom_fecha_conta.sql",
  "016": "016_garcom_acesso_turno.sql",
  "017": "017_diagnostico.sql"
};

const porMigracao = (o) => Object.fromEntries(Object.entries(o).flatMap(([m, nomes]) => nomes.split(" ").map((n) => [n, m])));

/** função pública → número da migração */
export const FUNCOES = porMigracao({
  "002": "abrir_caixa ajustar_estoque cancelar_venda credenciais_fiscais_status criar_empresa fechar_caixa movimentar_caixa produtos_estoque_baixo registrar_venda relatorio_vendas resumo_caixa salvar_credenciais_fiscais",
  "005": "criar_empresa_teste plataforma_atualizar_lead plataforma_atualizar_loja plataforma_leads plataforma_lojas plataforma_resumo situacao_conta sou_admin_plataforma",
  "006": "abrir_mesa acompanhar_pedido adicionar_itens atualizar_pedido cardapio_publico confirmar_pagamento_pedido criar_pedido_delivery mercado_pago_status mesas_painel pedir_conta plataforma_modulos remover_item_pedido salvar_mercado_pago transferir_mesa",
  "007": "delivery_abrir",
  "008": "plataforma_lojas_modulos",
  "009": "cancelar_solicitacao_pacote minha_assinatura plataforma_dia_vencimento plataforma_fatura_acao plataforma_faturamento plataforma_faturas plataforma_financeiro plataforma_gerar_faturas plataforma_loja_vendas plataforma_lojas_vencimento plataforma_nova_fatura plataforma_responder_solicitacao plataforma_solicitacoes solicitar_pacote",
  "010": "assumir_rascunho descartar_rascunho salvar_rascunho",
  "011": "ajustar_fiado curva_abc fiado_clientes fiado_config_cliente fiado_saldo_cliente fluxo_caixa pagamentos_periodo painel_antifraude perdas_resumo produtos_parados receber_fiado registrar_entrada_nfe registrar_gaveta registrar_lote registrar_perda resultado_periodo resumo_do_dia resumo_marcar_enviado resumo_teste_dados resumos_pendentes salvar_resumo_config salvar_taxas sugestao_compra validade_painel",
  "014": "cozinha_aprovar cozinha_avancar cozinha_painel cozinha_recusar definir_taxas_mesa garcom_desempenho garcons_equipe salvar_config_restaurante salvar_meta_garcom transferir_pedido trocar_garcom",
  "015": "caixa_principal_status garcom_fechar_conta salvar_config_fechamento_app",
  "016": "acessos_garcom alterar_meu_pin codigo_garcom_loja definir_acesso_garcom garcom_autenticar garcom_fechar_turno garcom_turno garcons_ao_vivo remover_acesso_garcom",
  "017": "diagnostico_recentes diagnostico_registrar diagnostico_servidor",
});

/** tabela pública → número da migração */
export const TABELAS = porMigracao({
  "001": "auditoria caixa_movimentos caixa_sessoes categorias clientes config_fiscal documentos_fiscais empresas estoque_movimentos fiscal_credenciais perfis produtos venda_itens venda_pagamentos vendas",
  "005": "leads plataforma_admins testes_gratis",
  "006": "integracoes_pagamento mesas",
  "009": "faturas pacotes_solicitacoes",
  "010": "vendas_rascunho",
  "011": "conferencias contas_pagar fiado_lancamentos fornecedores lotes notas_entrada perdas produto_fornecedor promocoes",
  "014": "cozinha_pedidos garcom_metas",
  "016": "garcom_acesso garcom_fechamentos",
  "017": "diagnostico_eventos",
});

/** Edge Functions que o sistema usa (supabase/functions). */
export const EDGE = {
  usuarios: "criar usuários e trocar senhas",
  fiscal: "emitir NFC-e / NF-e",
  pagamentos: "PIX com confirmação automática (Mercado Pago)",
  "garcom-login": "login do garçom por matrícula/CPF",
  teste: "criar loja de teste grátis",
  "resumo-diario": "resumo do dia por e-mail",
};

/** Para uma função/tabela que não existe, devolve o arquivo da migração que a cria. */
export function migracaoDe(nome) {
  const n = String(nome || "").replace(/^public\./, "");
  const m = FUNCOES[n] || TABELAS[n];
  return m ? ARQUIVOS[m] : null;
}
