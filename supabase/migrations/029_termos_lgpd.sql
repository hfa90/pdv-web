-- =====================================================================
-- 029 · Termos de Uso, Política de Privacidade e LGPD
--
--   - Versões dos documentos legais e registro do aceite (quem, quando,
--     IP e navegador) como prova da contratação.
--   - O administrador de cada loja aceita a versão vigente ao entrar.
--   - Data do cancelamento da loja (prazo de 90 dias para excluir os dados).
--   - Limpeza diária que cumpre os prazos da Política de Privacidade:
--     contatos e testes não convertidos (2 anos), diagnósticos e avisos de
--     cobrança (12 meses).
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Versões e aceites
-- ---------------------------------------------------------------------
create table if not exists public.termos_versoes (
  versao text primary key,
  publicada_em timestamptz not null default now(),
  resumo text                         -- o que mudou (mostrado ao pedir o novo aceite)
);
insert into public.termos_versoes (versao, publicada_em, resumo)
values ('1.0', '2026-10-12 00:00-03', 'Primeira versão dos Termos de Uso, da Política de Privacidade e do Acordo de Tratamento de Dados.')
on conflict (versao) do nothing;
alter table public.termos_versoes enable row level security;
revoke all on public.termos_versoes from anon, authenticated;
grant select on public.termos_versoes to anon, authenticated;
drop policy if exists termos_versoes_ler on public.termos_versoes;
create policy termos_versoes_ler on public.termos_versoes for select to anon, authenticated using (true);

create table if not exists public.termos_aceites (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references public.empresas(id) on delete set null,
  usuario_id uuid references auth.users(id) on delete set null,
  nome text, email text,
  versao text not null references public.termos_versoes(versao),
  documentos text[] not null default array['termos','privacidade','tratamento_de_dados'],
  ip text, navegador text,
  aceito_em timestamptz not null default now()
);
create index if not exists termos_aceites_empresa_idx on public.termos_aceites(empresa_id, aceito_em desc);
alter table public.termos_aceites enable row level security;
revoke all on public.termos_aceites from anon, authenticated;
grant select on public.termos_aceites to authenticated;
drop policy if exists termos_aceites_ler on public.termos_aceites;
create policy termos_aceites_ler on public.termos_aceites for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin}')));

create or replace function private.termos_vigente()
returns text language sql stable security definer set search_path = '' as $$
  select versao from public.termos_versoes where publicada_em <= now() order by publicada_em desc limit 1
$$;

/** A loja já aceitou a versão vigente? (aceite de qualquer administrador da loja vale) */
create or replace function private.termos_situacao(p_emp uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('versao', v.versao, 'resumo', v.resumo,
    'aceito', exists (select 1 from public.termos_aceites a where a.empresa_id = p_emp and a.versao = v.versao))
  from public.termos_versoes v where v.versao = private.termos_vigente()
$$;

/** Registra o aceite do usuário logado (administrador da loja). IP vem do cabeçalho da requisição. */
create or replace function public.aceitar_termos(p_versao text, p_navegador text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_ip text; h json; u auth.users; v_nome text;
begin
  if auth.uid() is null then raise exception 'Entre no sistema'; end if;
  if private.suporte_empresa() is not null then raise exception 'O suporte não pode aceitar os termos em nome da loja'; end if;
  if v_emp is not null and not private.tem_papel('{admin}') then raise exception 'Só o administrador da loja aceita os termos'; end if;
  if not exists (select 1 from public.termos_versoes where versao = p_versao) then raise exception 'Versão dos termos inválida'; end if;
  begin h := current_setting('request.headers', true)::json; exception when others then h := null; end;
  v_ip := left(trim(split_part(coalesce(h->>'cf-connecting-ip', h->>'x-real-ip', h->>'x-forwarded-for', ''), ',', 1)), 64);
  select * into u from auth.users where id = auth.uid();
  select nome into v_nome from public.perfis where id = auth.uid();
  insert into public.termos_aceites (empresa_id, usuario_id, nome, email, versao, ip, navegador)
  values (v_emp, auth.uid(), coalesce(v_nome, u.raw_user_meta_data->>'nome'), u.email, p_versao, nullif(v_ip, ''), left(p_navegador, 300));
  if v_emp is not null then
    perform private.auditar(v_emp, 'termos.aceitar', 'termos_aceites', p_versao, jsonb_build_object('ip', v_ip));
  end if;
  return coalesce(private.termos_situacao(v_emp), jsonb_build_object('versao', p_versao, 'aceito', true));
end $$;

-- Situação da conta (lida ao abrir o sistema): + termos
do $$ declare d text; begin
  d := pg_get_functiondef('public.situacao_conta()'::regprocedure);
  if position('private.termos_situacao' in d) = 0 then
    d := replace(d, $x$'bloqueio', private.conta_liberada(e.id),$x$,
                    $x$'bloqueio', private.conta_liberada(e.id), 'termos', private.termos_situacao(e.id),$x$);
    if position('private.termos_situacao' in d) = 0 then raise exception 'situacao_conta: trecho não encontrado'; end if;
    execute d;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Data do cancelamento da loja
-- ---------------------------------------------------------------------
alter table public.empresas add column if not exists cancelado_em timestamptz;
update public.empresas set cancelado_em = coalesce(cancelado_em, updated_at, now()) where status_conta = 'cancelado' and cancelado_em is null;

create or replace function private.empresa_cancelamento()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status_conta = 'cancelado' and old.status_conta is distinct from 'cancelado' then new.cancelado_em := now();
  elsif new.status_conta <> 'cancelado' then new.cancelado_em := null;
  end if;
  return new;
end $$;
drop trigger if exists t_empresa_cancelamento on public.empresas;
create trigger t_empresa_cancelamento before update of status_conta on public.empresas
  for each row execute function private.empresa_cancelamento();

-- ---------------------------------------------------------------------
-- 3. Painel da plataforma: provas de aceite e pendências LGPD
-- ---------------------------------------------------------------------
create or replace function public.plataforma_lgpd()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return jsonb_build_object(
    'versao_vigente', private.termos_vigente(),
    -- Lojas canceladas há mais de 90 dias: hora de excluir os dados (Política de Privacidade, item 6)
    'excluir', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'loja', coalesce(e.nome_fantasia, e.razao_social),
                 'cancelado_em', e.cancelado_em) order by e.cancelado_em)
               from public.empresas e where e.status_conta = 'cancelado' and e.cancelado_em < now() - interval '90 days'), '[]'::jsonb),
    -- Lojas ativas sem aceite da versão vigente
    'sem_aceite', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'loja', coalesce(e.nome_fantasia, e.razao_social)))
               from public.empresas e where e.status_conta in ('ativo','teste')
                 and not (private.termos_situacao(e.id)->>'aceito')::boolean), '[]'::jsonb),
    'ultimos_aceites', coalesce((select jsonb_agg(x order by x.aceito_em desc) from (
               select a.aceito_em, a.versao, a.nome, a.email, a.ip, coalesce(e.nome_fantasia, e.razao_social) loja
               from public.termos_aceites a left join public.empresas e on e.id = a.empresa_id
               order by a.aceito_em desc limit 30) x), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- 4. Limpeza diária (prazos da Política de Privacidade)
-- ---------------------------------------------------------------------
create or replace function private.lgpd_limpeza()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n_leads int; n_testes int; n_diag int; n_cob int;
begin
  -- Contatos do site que não viraram clientes: 2 anos
  delete from public.leads where status <> 'convertido' and created_at < now() - interval '2 years';
  get diagnostics n_leads = row_count;
  -- Registros antifraude do teste grátis: 2 anos (mantém os de lojas ainda ativas)
  delete from public.testes_gratis t where t.created_at < now() - interval '2 years'
    and not exists (select 1 from public.empresas e where e.id = t.empresa_id and e.status_conta in ('ativo','suspenso','teste'));
  get diagnostics n_testes = row_count;
  -- Diagnósticos de erro (incluem a trilha de navegação): 12 meses
  delete from public.diagnostico_eventos where recebido_em < now() - interval '12 months';
  get diagnostics n_diag = row_count;
  -- Avisos recebidos do provedor de cobrança: 12 meses
  delete from public.cobranca_eventos where recebido_em < now() - interval '12 months';
  get diagnostics n_cob = row_count;
  return jsonb_build_object('leads', n_leads, 'testes', n_testes, 'diagnosticos', n_diag, 'avisos_cobranca', n_cob, 'em', now());
end $$;

do $$ begin
  perform cron.unschedule('lgpd-limpeza') where exists (select 1 from cron.job where jobname = 'lgpd-limpeza');
  perform cron.schedule('lgpd-limpeza', '20 7 * * *', 'select private.lgpd_limpeza()');   -- 04:20 de Brasília
exception when others then raise notice 'Agendamento não criado (pg_cron): %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 5. Permissões
-- ---------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon;
revoke execute on function public.aceitar_termos(text, text), public.plataforma_lgpd() from public, anon;
grant execute on function public.aceitar_termos(text, text), public.plataforma_lgpd() to authenticated;
