-- =====================================================================
-- 028 · Cobrança recorrente automática da mensalidade (Asaas)
--
--   - A plataforma configura a conta Asaas no painel (chave guardada só no
--     servidor, nunca volta para o navegador).
--   - Cada loja ativa vira um cliente + uma assinatura mensal no Asaas
--     (PIX, boleto ou cartão: o cliente escolhe na hora de pagar).
--   - As cobranças geradas pelo Asaas viram faturas aqui (avisos conferidos
--     direto na API do Asaas antes de valer).
--   - Bloqueio automático: fatura vencida há mais de N dias (tolerância)
--     pausa as vendas; o pagamento libera na hora.
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Configuração da cobrança (uma linha só; só o servidor lê a chave)
-- ---------------------------------------------------------------------
create table if not exists public.plataforma_cobranca (
  id boolean primary key default true check (id),
  provedor text not null default 'asaas' check (provedor in ('asaas')),
  ambiente text not null default 'producao' check (ambiente in ('producao','teste')),
  api_key text,
  ativo boolean not null default false,
  webhook_token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  cron_token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  dias_tolerancia smallint not null default 7 check (dias_tolerancia between 0 and 60),
  forma_padrao text not null default 'UNDEFINED' check (forma_padrao in ('UNDEFINED','PIX','BOLETO','CREDIT_CARD')),
  multa_pct numeric(5,2) not null default 2 check (multa_pct between 0 and 2),
  juros_mes_pct numeric(5,2) not null default 1 check (juros_mes_pct between 0 and 10),
  atualizado_por text,
  updated_at timestamptz not null default now()
);
insert into public.plataforma_cobranca (id) values (true) on conflict (id) do nothing;
alter table public.plataforma_cobranca enable row level security;   -- sem políticas: só o servidor lê
revoke all on public.plataforma_cobranca from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Assinatura de cada loja no provedor
-- ---------------------------------------------------------------------
create table if not exists public.assinaturas (
  empresa_id uuid primary key references public.empresas(id) on delete cascade,
  provedor text not null default 'asaas',
  cliente_ref text,                 -- cus_...
  assinatura_ref text,              -- sub_...
  valor numeric(10,2),
  status text not null default 'pendente' check (status in ('pendente','ativa','cancelada','erro')),
  erro text,
  sincronizado_em timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists assinaturas_ref_uk on public.assinaturas(assinatura_ref) where assinatura_ref is not null;
alter table public.assinaturas enable row level security;
revoke all on public.assinaturas from anon, authenticated;

-- Avisos recebidos do provedor (idempotência e histórico para conferência)
create table if not exists public.cobranca_eventos (
  id text primary key,              -- id do evento do Asaas
  evento text not null,
  cobranca_ref text,
  empresa_id uuid references public.empresas(id) on delete set null,
  resultado text,
  recebido_em timestamptz not null default now()
);
create index if not exists cobranca_eventos_data_idx on public.cobranca_eventos(recebido_em desc);
alter table public.cobranca_eventos enable row level security;
revoke all on public.cobranca_eventos from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Faturas ligadas às cobranças do provedor
-- ---------------------------------------------------------------------
alter table public.faturas add column if not exists provedor text;            -- asaas | null (manual)
alter table public.faturas add column if not exists cobranca_ref text;        -- pay_...
alter table public.faturas add column if not exists pix_copia_cola text;
alter table public.faturas add column if not exists boleto_url text;
alter table public.faturas add column if not exists situacao_provedor text;   -- PENDING, OVERDUE, RECEIVED...
create unique index if not exists faturas_cobranca_uk on public.faturas(cobranca_ref) where cobranca_ref is not null;

-- ---------------------------------------------------------------------
-- 4. Bloqueio automático por atraso
-- ---------------------------------------------------------------------
/** Fatura em aberto mais antiga e quantos dias faltam para pausar as vendas. */
create or replace function private.fatura_situacao(p_emp uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare f public.faturas; v_tol int; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; e public.empresas;
begin
  select * into e from public.empresas where id = p_emp;
  if e.status_conta <> 'ativo' or e.plano = 'interno' then return null; end if;
  select * into f from public.faturas where empresa_id = p_emp and status = 'pendente' and vencimento < v_hoje
   order by vencimento limit 1;
  if f.id is null then return null; end if;
  select dias_tolerancia into v_tol from public.plataforma_cobranca where id;
  v_tol := coalesce(v_tol, 7);
  return jsonb_build_object('id', f.id, 'valor', f.valor, 'vencimento', f.vencimento, 'descricao', f.descricao,
    'dias_atraso', v_hoje - f.vencimento, 'tolerancia', v_tol,
    'pausa_em', f.vencimento + v_tol + 1, 'pausado', v_hoje > f.vencimento + v_tol);
end $$;

create or replace function private.conta_liberada(p_emp uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- Retorna null se a loja pode operar; caso contrário, a mensagem de bloqueio.
declare e public.empresas; n int; v_exp timestamptz; fs jsonb;
begin
  select * into e from public.empresas where id = p_emp;
  select l.expira_em into v_exp from public.licencas l
   where l.empresa_id = p_emp and l.modulo = 'pdv' and l.expira_em is not null and l.expira_em <= now();
  if v_exp is not null then
    return format('A licença do sistema venceu em %s. Fale com o suporte para renovar — seus dados estão guardados.',
      to_char(v_exp at time zone private.fuso_loja(p_emp), 'DD/MM/YYYY'));
  end if;
  if e.status_conta = 'ativo' then
    -- Mensalidade atrasada além da tolerância (028): pausa as vendas até pagar
    fs := private.fatura_situacao(p_emp);
    if fs is not null and (fs->>'pausado')::boolean then
      return format('Mensalidade vencida em %s (%s). Pague em Minha assinatura: com PIX ou cartão as vendas voltam na hora.',
        to_char((fs->>'vencimento')::date, 'DD/MM/YYYY'), 'R$ ' || replace(to_char((fs->>'valor')::numeric, 'FM999999990.00'), '.', ','));
    end if;
    return null;
  end if;
  if e.status_conta in ('suspenso','cancelado') then
    return 'Conta suspensa. Fale com o suporte para reativar.';
  end if;
  if e.teste_expira_em is not null and now() >= e.teste_expira_em then
    return 'Seu período de teste terminou. Contrate um plano para continuar vendendo — seus dados estão guardados.';
  end if;
  select count(*) into n from public.vendas where empresa_id = p_emp and status = 'finalizada';
  if n >= 200 then
    return 'Limite de 200 vendas do período de teste atingido. Contrate um plano para continuar.';
  end if;
  return null;
end $$;

-- Situação da conta (lida ao abrir o sistema): + aviso de fatura atrasada
do $$ declare d text; begin
  d := pg_get_functiondef('public.situacao_conta()'::regprocedure);
  if position('private.fatura_situacao' in d) = 0 then
    d := replace(d, $x$'bloqueio', private.conta_liberada(e.id),$x$,
                    $x$'bloqueio', private.conta_liberada(e.id), 'fatura_atrasada', private.fatura_situacao(e.id),$x$);
    if position('private.fatura_situacao' in d) = 0 then raise exception 'situacao_conta: trecho não encontrado'; end if;
    execute d;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Painel da plataforma
-- ---------------------------------------------------------------------
create or replace function public.plataforma_cobranca_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.plataforma_cobranca;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  select * into c from public.plataforma_cobranca where id;
  return jsonb_build_object('provedor', c.provedor, 'ambiente', c.ambiente, 'ativo', c.ativo, 'configurado', c.api_key is not null,
    'webhook_token', c.webhook_token, 'dias_tolerancia', c.dias_tolerancia, 'forma_padrao', c.forma_padrao,
    'multa_pct', c.multa_pct, 'juros_mes_pct', c.juros_mes_pct, 'atualizado_por', c.atualizado_por, 'updated_at', c.updated_at,
    'assinaturas', (select jsonb_build_object('ativas', count(*) filter (where status = 'ativa'), 'erro', count(*) filter (where status = 'erro'))
                    from public.assinaturas),
    'ultimos_eventos', (select coalesce(jsonb_agg(jsonb_build_object('evento', evento, 'resultado', resultado, 'em', recebido_em) order by recebido_em desc), '[]')
                        from (select * from public.cobranca_eventos order by recebido_em desc limit 8) x));
end $$;

create or replace function public.plataforma_cobranca_salvar(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_key text := nullif(trim(coalesce(p->>'api_key', '')), '');
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if v_key is not null and v_key !~ '^\$?aact_' then raise exception 'A chave de API do Asaas começa com $aact_'; end if;
  update public.plataforma_cobranca set
    api_key = case when coalesce((p->>'remover_chave')::boolean, false) then null else coalesce(v_key, api_key) end,
    ambiente = coalesce(nullif(p->>'ambiente', ''), ambiente),
    ativo = coalesce((p->>'ativo')::boolean, ativo),
    dias_tolerancia = coalesce((p->>'dias_tolerancia')::smallint, dias_tolerancia),
    forma_padrao = coalesce(nullif(p->>'forma_padrao', ''), forma_padrao),
    multa_pct = coalesce((p->>'multa_pct')::numeric, multa_pct),
    juros_mes_pct = coalesce((p->>'juros_mes_pct')::numeric, juros_mes_pct),
    webhook_token = case when coalesce((p->>'novo_token')::boolean, false)
                         then replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') else webhook_token end,
    atualizado_por = (select email from auth.users where id = auth.uid()), updated_at = now()
  where id;
  if (select ativo and api_key is null from public.plataforma_cobranca where id) then
    raise exception 'Cole a chave de API do Asaas antes de ligar a cobrança automática';
  end if;
  return public.plataforma_cobranca_status();
end $$;

-- Lojas com a situação da assinatura (para a aba Cobranças)
create or replace function public.plataforma_assinaturas()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when private.eh_admin_plataforma() then coalesce(jsonb_agg(jsonb_build_object(
      'empresa_id', e.id, 'loja', coalesce(e.nome_fantasia, e.razao_social), 'status_conta', e.status_conta, 'plano', e.plano,
      'valor_mensal', e.valor_mensal, 'dia_vencimento', e.dia_vencimento, 'tem_documento', length(regexp_replace(coalesce(e.cnpj, ''), '\D', '', 'g')) in (11, 14),
      'assinatura', case when a.empresa_id is not null then jsonb_build_object('status', a.status, 'valor', a.valor, 'erro', a.erro,
                      'sincronizado_em', a.sincronizado_em, 'ref', a.assinatura_ref) end,
      'atraso', private.fatura_situacao(e.id)) order by coalesce(e.nome_fantasia, e.razao_social)), '[]'::jsonb) end
  from public.empresas e left join public.assinaturas a on a.empresa_id = e.id
  where e.status_conta in ('ativo','suspenso') and e.plano <> 'interno'
$$;

-- Mensalidades manuais não duplicam as lojas que já pagam pela assinatura automática
create or replace function public.plataforma_gerar_faturas(p_competencia date default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare c date := date_trunc('month', coalesce(p_competencia, (now() at time zone 'America/Sao_Paulo')::date))::date; n int;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  insert into public.faturas (empresa_id, competencia, descricao, valor, vencimento)
  select e.id, c, 'Mensalidade ' || to_char(c, 'MM/YYYY') || ' · plano ' || e.plano, e.valor_mensal,
         (c + (e.dia_vencimento - 1))
  from public.empresas e
  where e.status_conta = 'ativo' and coalesce(e.valor_mensal,0) > 0 and e.plano <> 'interno'
    and not exists (select 1 from public.assinaturas a where a.empresa_id = e.id and a.status = 'ativa')
    and not exists (select 1 from public.faturas f where f.empresa_id = e.id and f.competencia = c and f.status <> 'cancelado');
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 6. Permissões
-- ---------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon;
revoke execute on function public.plataforma_cobranca_status(), public.plataforma_cobranca_salvar(jsonb), public.plataforma_assinaturas(),
  public.plataforma_gerar_faturas(date) from public, anon;
grant execute on function public.plataforma_cobranca_status(), public.plataforma_cobranca_salvar(jsonb), public.plataforma_assinaturas(),
  public.plataforma_gerar_faturas(date) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Sincronização diária (06:10 de Brasília = 09:10 UTC): pega o que algum aviso possa ter perdido
-- ---------------------------------------------------------------------
do $$ begin
  perform cron.unschedule('cobranca-sincronizar') where exists (select 1 from cron.job where jobname = 'cobranca-sincronizar');
  perform cron.schedule('cobranca-sincronizar', '10 9 * * *', $c$
    select net.http_post(
      url := 'https://bcdoiaojhytxeoullskz.supabase.co/functions/v1/cobranca',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-cron-token', (select cron_token from public.plataforma_cobranca where id)),
      body := '{"acao":"cron"}'::jsonb, timeout_milliseconds := 120000)
  $c$);
exception when others then raise notice 'Agendamento não criado (pg_cron/pg_net): %', sqlerrm;
end $$;
