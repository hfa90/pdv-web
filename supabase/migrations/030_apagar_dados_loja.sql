-- =====================================================================
-- 030 · Apagar todos os dados da loja (tela Backup)
--
--   Para recomeçar do zero: apaga produtos, estoque, vendas, caixa, clientes,
--   fiado, financeiro, compras, fornecedores, cozinha e notas emitidas.
--   Ficam: usuários, dados da empresa, configurações (fiscal, PIX, pagamentos),
--   aparelhos, mesas (os QR Codes impressos continuam valendo), assinatura,
--   faturas, licenças, aceites dos termos e o registro de atividades.
--
--   Segurança (só administrador da loja ou superusuário):
--     1. apagar_dados_iniciar(): gera o backup COMPLETO e o devolve para ser
--        baixado. Registra o download e devolve um código de confirmação.
--     2. apagar_dados_confirmar(código, 'APAGAR TUDO'): só funciona até 30 min
--        depois do download. Antes de apagar, o servidor ainda guarda uma cópia.
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- Pedidos de apagamento (coluna loja_id, não empresa_id: fica fora do backup e do próprio apagamento)
create table if not exists public.loja_apagamentos (
  id uuid primary key default gen_random_uuid(),
  loja_id uuid not null references public.empresas(id) on delete cascade,
  baixado_em timestamptz not null default now(),
  baixado_por text,
  registros_no_arquivo bigint,
  concluido_em timestamptz,
  concluido_por text,
  backup_servidor uuid,
  resultado jsonb
);
create index if not exists loja_apagamentos_loja_idx on public.loja_apagamentos(loja_id, baixado_em desc);
alter table public.loja_apagamentos enable row level security;   -- só funções do servidor
revoke all on public.loja_apagamentos from anon, authenticated;

/** O que fica (não é apagado). Usado pela função e mostrado na tela. */
create or replace function private.apagar_dados_mantem()
returns text[] language sql immutable set search_path = '' as $$
  select array['perfis', 'config_fiscal', 'fiscal_credenciais', 'integracoes_pagamento', 'dispositivos', 'garcom_acesso', 'garcom_metas',
               'senhas_aprovacao', 'licencas', 'faturas', 'pacotes_solicitacoes', 'assinaturas', 'termos_aceites',
               'ia_lojas', 'ia_compras', 'ia_uso', 'cobranca_eventos', 'auditoria', 'mesas']
$$;

/** Quem pode: superusuário (qualquer loja) ou administrador da própria loja. */
create or replace function private.apagar_dados_pode(p_emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_emp is not null and (private.eh_admin_plataforma()
    or (p_emp = private.empresa_id() and private.papel()::text = 'admin'))
$$;

/** Passo 1: gera o backup completo (para baixar) e registra. */
create or replace function public.apagar_dados_iniciar(p_empresa uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := coalesce(p_empresa, private.empresa_id()); v_dados jsonb; v_id uuid; v_reg bigint;
begin
  if not private.apagar_dados_pode(v_emp) then raise exception 'Só o administrador da loja ou o superusuário pode apagar os dados'; end if;
  v_dados := private.backup_snapshot(v_emp);
  select coalesce(sum(jsonb_array_length(value)), 0) into v_reg
    from jsonb_each(coalesce(v_dados->'tabelas', '{}'::jsonb)) where jsonb_typeof(value) = 'array';
  insert into public.loja_apagamentos (loja_id, baixado_por, registros_no_arquivo) values (v_emp, private.quem(), v_reg) returning id into v_id;
  perform private.auditar_seguro(v_emp, 'backup.exportar', null, jsonb_build_object('motivo', 'antes de apagar todos os dados'));
  return jsonb_build_object('codigo', v_id, 'registros', v_reg, 'dados', v_dados);
end $$;

/** Passo 2: confirma e apaga. Até 30 minutos depois de baixar o backup. Digite APAGAR TUDO. */
create or replace function public.apagar_dados_confirmar(p_codigo uuid, p_confirmacao text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.loja_apagamentos; v_emp uuid; v_tabs text[]; i int; t text; n bigint; v_total bigint := 0; v_por jsonb := '{}'::jsonb; v_bk uuid;
begin
  select * into a from public.loja_apagamentos where id = p_codigo for update;
  if not found then raise exception 'Baixe o backup antes de apagar'; end if;
  v_emp := a.loja_id;
  if not private.apagar_dados_pode(v_emp) then raise exception 'Só o administrador da loja ou o superusuário pode apagar os dados'; end if;
  if a.concluido_em is not null then raise exception 'Estes dados já foram apagados'; end if;
  if a.baixado_em < now() - interval '30 minutes' then raise exception 'O backup foi baixado há mais de 30 minutos. Baixe de novo para continuar.'; end if;
  if upper(trim(coalesce(p_confirmacao, ''))) <> 'APAGAR TUDO' then raise exception 'Digite APAGAR TUDO para confirmar'; end if;

  -- Cópia de segurança no servidor, além do arquivo baixado
  v_bk := private.backup_gravar(v_emp, 'manual', 'Antes de apagar todos os dados', private.quem());

  -- Apaga das tabelas dependentes para as principais
  v_tabs := private.backup_tabelas(true);
  for i in reverse cardinality(v_tabs)..1 loop
    t := v_tabs[i];
    continue when t = any (private.apagar_dados_mantem());
    execute format('delete from public.%I where empresa_id = $1', t) using v_emp;
    get diagnostics n = row_count;
    if n > 0 then v_por := v_por || jsonb_build_object(t, n); v_total := v_total + n; end if;
  end loop;
  update public.empresas set proximo_numero_venda = 1 where id = v_emp;

  update public.loja_apagamentos set concluido_em = now(), concluido_por = private.quem(), backup_servidor = v_bk,
    resultado = jsonb_build_object('apagados', v_total, 'por_tabela', v_por)
  where id = a.id;
  perform private.auditar(v_emp, 'loja.apagar_dados', 'empresas', v_emp::text,
    jsonb_build_object('apagados', v_total, 'backup_servidor', v_bk, 'arquivo_baixado_em', a.baixado_em, 'arquivo_baixado_por', a.baixado_por));
  if private.eh_admin_plataforma() then
    perform private.log_super('loja.apagar_dados', v_emp, jsonb_build_object('apagados', v_total, 'backup', v_bk));
  end if;
  return jsonb_build_object('apagados', v_total, 'por_tabela', v_por, 'backup_servidor', v_bk);
end $$;

revoke execute on all functions in schema private from public, anon;
revoke execute on function public.apagar_dados_iniciar(uuid), public.apagar_dados_confirmar(uuid, text) from public, anon;
grant execute on function public.apagar_dados_iniciar(uuid), public.apagar_dados_confirmar(uuid, text) to authenticated;
