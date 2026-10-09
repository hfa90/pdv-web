-- =====================================================================
-- 021 · Licenças por módulo, backup automático/manual, exportar,
--       importar e excluir lojas (clientes) do banco
--
--   1. Licenças
--      Cada loja tem uma licença por ferramenta: pdv (o sistema/vendas),
--      delivery, garcom (mesas e app do garçom) e fiscal (NFC-e/NF-e).
--      O superusuário renova (+dias, +meses, até uma data, sem prazo) ou
--      expira na hora, de uma loja ou de várias de uma vez.
--        - pdv vencida:      as vendas e a abertura de caixa param (igual ao
--                            fim do teste); os dados continuam lá.
--        - delivery vencida: o cardápio sai do ar.
--        - garcom vencida:   mesas e app do garçom ficam bloqueados.
--        - fiscal vencida:   a Edge Function "fiscal" recusa emitir.
--      Loja sem linha em "licencas" = sem prazo (nada muda para quem já usa).
--
--   2. Backup
--      Cópia completa dos dados de uma loja (todas as tabelas com
--      empresa_id + a própria loja + a lista de logins) guardada em
--      public.backups. Pode ser:
--        - automática: o banco faz sozinho (pg_cron a cada 15 min verifica
--          quem está na hora). Frequência: 6h, 12h, diária ou semanal, no
--          horário escolhido, guardando as N últimas cópias;
--        - manual: botão "Fazer backup agora".
--      A loja configura o próprio backup (admin/gerente) e escolhe quais
--      níveis podem fazer backup manual e baixar o arquivo. Restaurar é só
--      do administrador da loja (ou do superusuário).
--      O superusuário define a regra geral (backup obrigatório, padrão,
--      limite de cópias) e pode fazer backup, baixar, restaurar e apagar
--      cópias de qualquer loja.
--
--   3. Exportar / importar
--      Exportar = baixar um arquivo .json com a cópia na hora.
--      Importar = enviar um arquivo .json; ele vira um backup "importado"
--      e pode ser restaurado (inclusive de uma loja que foi excluída).
--
--   4. Excluir lojas (superusuário)
--      Apaga a loja e TODOS os dados dela, e também os logins dos usuários
--      dela. Antes de apagar, o banco guarda automaticamente uma cópia
--      ("antes_exclusao") por 90 dias (configurável), para desfazer.
--      Nunca apaga a loja do próprio superusuário nem lojas com membros da
--      equipe. O registro antifraude do teste grátis (testes_gratis) é
--      mantido de propósito.
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.licencas (
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  modulo text not null check (modulo in ('pdv', 'delivery', 'garcom', 'fiscal')),
  expira_em timestamptz,                 -- null = sem prazo
  observacao text,
  atualizado_por text,
  updated_at timestamptz not null default now(),
  primary key (empresa_id, modulo)
);
create index if not exists licencas_expira_idx on public.licencas(expira_em);
alter table public.licencas enable row level security;   -- só funções do servidor
revoke all on public.licencas from anon, authenticated;

create table if not exists public.backups (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,               -- sem FK de propósito: a cópia sobrevive à exclusão da loja
  loja text,
  tipo text not null check (tipo in ('automatico', 'manual', 'antes_exclusao', 'antes_restauracao', 'importado')),
  criado_por text,
  observacao text,
  tabelas int,
  registros int,
  tamanho_bytes bigint,
  dados jsonb not null,
  restaurado_em timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists backups_empresa_idx on public.backups(empresa_id, created_at desc);
create index if not exists backups_tipo_idx on public.backups(tipo, created_at);
alter table public.backups enable row level security;
revoke all on public.backups from anon, authenticated;

create table if not exists public.backup_config (
  empresa_id uuid primary key references public.empresas(id) on delete cascade,
  modo text not null default 'automatico' check (modo in ('automatico', 'manual')),
  frequencia text not null default 'diario' check (frequencia in ('6h', '12h', 'diario', 'semanal')),
  hora smallint not null default 3 check (hora between 0 and 23),
  dia_semana smallint not null default 0 check (dia_semana between 0 and 6),   -- 0 = domingo
  manter smallint not null default 7 check (manter between 1 and 90),
  papeis_manual text[] not null default '{admin,gerente}',   -- quem pode "Fazer backup agora" e ver a lista
  papeis_baixar text[] not null default '{admin}',           -- quem pode baixar/exportar o arquivo
  ultimo_backup_em timestamptz,
  proximo_backup_em timestamptz,
  ultimo_erro text,
  atualizado_por text,
  updated_at timestamptz not null default now()
);
alter table public.backup_config enable row level security;
revoke all on public.backup_config from anon, authenticated;

create table if not exists public.plataforma_config (
  id boolean primary key default true check (id),
  backup_obrigatorio boolean not null default true,         -- a loja não pode desligar o automático
  backup_pausado boolean not null default false,            -- pausa geral (manutenção)
  backup_frequencia_padrao text not null default 'diario' check (backup_frequencia_padrao in ('6h', '12h', 'diario', 'semanal')),
  backup_hora_padrao smallint not null default 3 check (backup_hora_padrao between 0 and 23),
  backup_manter_padrao smallint not null default 7 check (backup_manter_padrao between 1 and 90),
  backup_manter_max smallint not null default 30 check (backup_manter_max between 1 and 90),
  backup_exclusao_dias smallint not null default 90 check (backup_exclusao_dias between 1 and 3650),
  atualizado_por text,
  updated_at timestamptz not null default now()
);
insert into public.plataforma_config (id) values (true) on conflict do nothing;
alter table public.plataforma_config enable row level security;
revoke all on public.plataforma_config from anon, authenticated;

-- ---------------------------------------------------------------------
-- Auxiliares
-- ---------------------------------------------------------------------
create or replace function private.quem()
returns text language sql stable security definer set search_path = '' as $$
  select case when private.eh_equipe() then private.nome_equipe() || ' (equipe)'
    else coalesce((select p.nome from public.perfis p where p.id = (select auth.uid())),
                  (select u.email from auth.users u where u.id = (select auth.uid())), 'Sistema') end
$$;

create or replace function private.fuso_loja(p_emp uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(e.fuso, '') from public.empresas e where e.id = p_emp
                   and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = e.fuso)), 'America/Sao_Paulo')
$$;

-- ---------------------------------------------------------------------
-- 1. Licenças
-- ---------------------------------------------------------------------
create or replace function private.licenca_ok(p_emp uuid, p_modulo text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.licencas l
    where l.empresa_id = p_emp and l.modulo = p_modulo and l.expira_em is not null and l.expira_em <= now())
$$;

create or replace function private.licencas_json(p_emp uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_object_agg(m, jsonb_build_object(
    'expira_em', l.expira_em,
    'ok', l.expira_em is null or l.expira_em > now(),
    'controlada', l.empresa_id is not null,
    'observacao', l.observacao))
  from unnest(array['pdv', 'delivery', 'garcom', 'fiscal']) m
  left join public.licencas l on l.empresa_id = p_emp and l.modulo = m
$$;

-- Regra central de "pode vender": agora também olha a licença do PDV
create or replace function private.conta_liberada(p_emp uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- Retorna null se a loja pode operar; caso contrário, a mensagem de bloqueio.
declare e public.empresas; n int; v_exp timestamptz;
begin
  select * into e from public.empresas where id = p_emp;
  select l.expira_em into v_exp from public.licencas l
   where l.empresa_id = p_emp and l.modulo = 'pdv' and l.expira_em is not null and l.expira_em <= now();
  if v_exp is not null then
    return format('A licença do sistema venceu em %s. Fale com o suporte para renovar — seus dados estão guardados.',
      to_char(v_exp at time zone private.fuso_loja(p_emp), 'DD/MM/YYYY'));
  end if;
  if e.status_conta = 'ativo' then return null; end if;
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

create or replace function private.modulo_garcom(p_emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((e.segmento = 'restaurante' or (e.modulos->>'garcom')::boolean) and private.licenca_ok(e.id, 'garcom'), false)
  from public.empresas e where e.id = p_emp
$$;

create or replace function private.delivery_liberado(p_emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(e.delivery_ativo
    and private.conta_liberada(e.id) is null
    and private.licenca_ok(e.id, 'delivery')
    and (e.status_conta = 'teste' or e.plano = 'interno' or coalesce((e.modulos->>'delivery')::boolean, false)), false)
  from public.empresas e where e.id = p_emp
$$;

-- ---------------------------------------------------------------------
-- 2. Backup: o que entra na cópia
-- ---------------------------------------------------------------------
-- Tabelas com empresa_id que NÃO entram (registros técnicos, da plataforma ou do próprio backup)
create or replace function private.backup_excluidas()
returns text[] language sql immutable set search_path = '' as $$
  select array['backups', 'backup_config', 'diagnostico_eventos', 'dispositivos_eventos', 'suporte_acessos',
               'suporte_chamados', 'avisos_plataforma', 'leads', 'testes_gratis', 'superusuario_log',
               'senha_aprovacao_tentativas']
$$;
-- Tabelas comerciais: vão na cópia, mas só o superusuário as restaura
create or replace function private.backup_da_plataforma()
returns text[] language sql immutable set search_path = '' as $$
  select array['faturas', 'pacotes_solicitacoes', 'licencas']
$$;
-- Colunas da loja que só o superusuário restaura (situação comercial)
create or replace function private.backup_colunas_comerciais()
returns text[] language sql immutable set search_path = '' as $$
  select array['id', 'status_conta', 'plano', 'valor_mensal', 'teste_expira_em', 'ativado_em', 'observacao_comercial',
               'modulos', 'dia_vencimento', 'config_dispositivos', 'created_at']
$$;

/**
 * Tabelas da loja em ordem de dependência (quem é referenciado vem antes).
 * Descobre sozinha: tabela nova com empresa_id entra no backup sem mexer aqui.
 */
create or replace function private.backup_tabelas(p_com_plataforma boolean default true)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare v_todas text[]; v_ordem text[] := '{}'; v_falta text[]; t text; v_mudou boolean;
begin
  select coalesce(array_agg(c.relname::text order by c.relname), '{}') into v_todas
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'empresa_id' and not a.attisdropped
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and c.relname <> all (private.backup_excluidas())
    and (p_com_plataforma or c.relname <> all (private.backup_da_plataforma()));
  v_falta := v_todas;
  loop
    v_mudou := false;
    foreach t in array v_falta loop
      if not exists (
        select 1 from pg_catalog.pg_constraint k
        join pg_catalog.pg_class r on r.oid = k.confrelid
        join pg_catalog.pg_namespace rn on rn.oid = r.relnamespace and rn.nspname = 'public'
        where k.contype = 'f' and k.conrelid = format('public.%I', t)::regclass and k.confrelid <> k.conrelid
          and r.relname::text = any (v_todas) and r.relname::text <> all (v_ordem)) then
        v_ordem := v_ordem || t; v_mudou := true;
      end if;
    end loop;
    v_falta := array(select x from unnest(v_todas) x where x <> all (v_ordem));
    exit when cardinality(v_falta) = 0 or not v_mudou;
  end loop;
  return v_ordem || v_falta;   -- dependência circular (não há hoje) vai por último
end $$;

/** Cópia completa de uma loja (não grava nada). */
create or replace function private.backup_snapshot(p_emp uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e public.empresas; t text; v_tabs text[]; v_dados jsonb := '{}'; v_linhas jsonb; v_n int; v_reg int := 0;
begin
  select * into e from public.empresas where id = p_emp;
  if not found then raise exception 'Loja não encontrada'; end if;
  v_tabs := private.backup_tabelas(true);
  foreach t in array v_tabs loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb), count(*)::int from public.%I x where x.empresa_id = $1', t)
      into v_linhas, v_n using p_emp;
    v_dados := v_dados || jsonb_build_object(t, v_linhas);
    v_reg := v_reg + v_n;
  end loop;
  return jsonb_build_object(
    'formato', 'lis-pdv-backup', 'versao', 1, 'gerado_em', now(),
    'empresa_id', e.id, 'loja', coalesce(e.nome_fantasia, e.razao_social),
    'empresa', to_jsonb(e),
    'usuarios', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'nome', p.nome, 'papel', p.papel)), '[]'::jsonb)
                 from public.perfis p join auth.users u on u.id = p.id where p.empresa_id = p_emp),
    'ordem', to_jsonb(v_tabs),
    'contagem', v_reg,
    'tabelas', v_dados);
end $$;

/** Apaga as cópias antigas de uma loja conforme o "manter". */
create or replace function private.backup_podar(p_emp uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_manter int; pc public.plataforma_config;
begin
  select * into pc from public.plataforma_config where id;
  select least(coalesce(c.manter, pc.backup_manter_padrao), pc.backup_manter_max) into v_manter
    from public.plataforma_config x left join public.backup_config c on c.empresa_id = p_emp where x.id;
  v_manter := coalesce(v_manter, 7);
  delete from public.backups b where b.empresa_id = p_emp and b.tipo = 'automatico'
    and b.id not in (select id from public.backups where empresa_id = p_emp and tipo = 'automatico' order by created_at desc limit v_manter);
  delete from public.backups b where b.empresa_id = p_emp and b.tipo in ('manual', 'antes_restauracao')
    and b.id not in (select id from public.backups where empresa_id = p_emp and tipo in ('manual', 'antes_restauracao') order by created_at desc limit v_manter);
  delete from public.backups b where b.empresa_id = p_emp and b.tipo = 'importado' and b.created_at < now() - interval '7 days';
  delete from public.backups b where b.tipo = 'antes_exclusao' and b.created_at < now() - make_interval(days => pc.backup_exclusao_dias);
end $$;

/** Grava uma cópia da loja e devolve o id. */
create or replace function private.backup_gravar(p_emp uuid, p_tipo text, p_obs text, p_por text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.backup_snapshot(p_emp); v_id uuid;
begin
  insert into public.backups (empresa_id, loja, tipo, criado_por, observacao, tabelas, registros, tamanho_bytes, dados)
  values (p_emp, v->>'loja', p_tipo, p_por, nullif(trim(coalesce(p_obs, '')), ''),
          (select count(*) from jsonb_object_keys(v->'tabelas')), (v->>'contagem')::int, octet_length(v::text), v)
  returning id into v_id;
  if p_tipo in ('automatico', 'manual') then
    update public.backup_config set ultimo_backup_em = now(), ultimo_erro = null where empresa_id = p_emp;
  end if;
  perform private.backup_podar(p_emp);
  return v_id;
end $$;

/** Próximo horário do backup automático (no fuso da loja). */
create or replace function private.backup_proximo(p_freq text, p_hora int, p_dia int, p_de timestamptz, p_fuso text)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare v_local timestamp; v_alvo timestamp; i int := 0;
begin
  if p_freq = '6h' then return p_de + interval '6 hours'; end if;
  if p_freq = '12h' then return p_de + interval '12 hours'; end if;
  v_local := p_de at time zone p_fuso;
  v_alvo := date_trunc('day', v_local) + make_interval(hours => p_hora);
  while (v_alvo <= v_local or (p_freq = 'semanal' and extract(dow from v_alvo)::int <> p_dia)) and i < 15 loop
    v_alvo := v_alvo + interval '1 day'; i := i + 1;
  end loop;
  return v_alvo at time zone p_fuso;
end $$;

create or replace function private.backup_reagendar(p_emp uuid)
returns void language sql security definer set search_path = '' as $$
  update public.backup_config c set proximo_backup_em =
    private.backup_proximo(c.frequencia, c.hora, c.dia_semana, now(), private.fuso_loja(c.empresa_id))
  where c.empresa_id = p_emp
$$;

-- Toda loja tem configuração de backup (as novas recebem o padrão da plataforma)
create or replace function private.trg_backup_config_nova()
returns trigger language plpgsql security definer set search_path = '' as $$
declare pc public.plataforma_config;
begin
  select * into pc from public.plataforma_config where id;
  insert into public.backup_config (empresa_id, frequencia, hora, manter)
  values (new.id, coalesce(pc.backup_frequencia_padrao, 'diario'), coalesce(pc.backup_hora_padrao, 3), coalesce(pc.backup_manter_padrao, 7))
  on conflict do nothing;
  perform private.backup_reagendar(new.id);
  return new;
end $$;
drop trigger if exists t_backup_config on public.empresas;
create trigger t_backup_config after insert on public.empresas
  for each row execute function private.trg_backup_config_nova();

insert into public.backup_config (empresa_id) select id from public.empresas on conflict do nothing;
update public.backup_config c set proximo_backup_em =
  private.backup_proximo(c.frequencia, c.hora, c.dia_semana, now(), private.fuso_loja(c.empresa_id))
where c.proximo_backup_em is null;

/** Roda os backups automáticos que estão na hora (chamado pelo pg_cron). */
create or replace function private.backup_rodar_agendados(p_max int default 25)
returns int language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; pc public.plataforma_config;
begin
  select * into pc from public.plataforma_config where id;
  if pc.backup_pausado then return 0; end if;
  for r in
    select c.* from public.backup_config c join public.empresas e on e.id = c.empresa_id
    where e.status_conta <> 'cancelado'
      and (c.modo = 'automatico' or pc.backup_obrigatorio)
      and (c.proximo_backup_em is null or c.proximo_backup_em <= now())
    order by c.proximo_backup_em nulls first
    limit greatest(p_max, 1)
  loop
    begin
      perform private.backup_gravar(r.empresa_id, 'automatico', null, 'Backup automático');
      perform private.backup_reagendar(r.empresa_id);
      n := n + 1;
    exception when others then
      update public.backup_config set ultimo_erro = left(sqlerrm, 500), proximo_backup_em = now() + interval '1 hour'
       where empresa_id = r.empresa_id;
    end;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Permissões do backup na loja
--   ver/manual: admin + níveis em papeis_manual
--   baixar:     admin + níveis em papeis_baixar
--   configurar: admin e gerente
--   restaurar:  só admin
--   superusuário: tudo, em qualquer loja
-- ---------------------------------------------------------------------
create or replace function private.backup_pode(p_emp uuid, p_acao text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_papel text; c public.backup_config;
begin
  if private.eh_admin_plataforma() then return true; end if;
  if p_emp is null or p_emp is distinct from private.empresa_id() then return false; end if;
  v_papel := private.papel()::text;
  if v_papel = 'admin' then return true; end if;
  if p_acao = 'restaurar' then return false; end if;
  if p_acao = 'configurar' then return v_papel = 'gerente'; end if;
  select * into c from public.backup_config where empresa_id = p_emp;
  if p_acao in ('ver', 'manual') then return v_papel = any (coalesce(c.papeis_manual, '{admin,gerente}')); end if;
  if p_acao = 'baixar' then return v_papel = any (coalesce(c.papeis_baixar, '{admin}')); end if;
  return false;
end $$;

create or replace function private.backup_meta(b public.backups)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', b.id, 'empresa_id', b.empresa_id, 'loja', b.loja, 'tipo', b.tipo, 'criado_por', b.criado_por,
    'observacao', b.observacao, 'tabelas', b.tabelas, 'registros', b.registros, 'tamanho_bytes', b.tamanho_bytes,
    'restaurado_em', b.restaurado_em, 'created_at', b.created_at)
$$;

create or replace function private.auditar_seguro(p_emp uuid, p_acao text, p_id text, p_det jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.empresas where id = p_emp) then
    perform private.auditar(p_emp, p_acao, 'backups', p_id, p_det);
  end if;
exception when others then null;   -- modo suporte somente leitura: só não registra
end $$;

-- ---------------------------------------------------------------------
-- Funções da loja (o superusuário também usa, passando p_empresa)
-- ---------------------------------------------------------------------
/** Tela Backup: configuração, permissões e lista de cópias. */
create or replace function public.backup_painel(p_empresa uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := coalesce(p_empresa, private.empresa_id()); c public.backup_config; pc public.plataforma_config;
begin
  if not private.backup_pode(v_emp, 'ver') then raise exception 'Você não tem permissão para ver os backups desta loja'; end if;
  select * into c from public.backup_config where empresa_id = v_emp;
  select * into pc from public.plataforma_config where id;
  return jsonb_build_object(
    'empresa_id', v_emp,
    'loja', (select coalesce(e.nome_fantasia, e.razao_social) from public.empresas e where e.id = v_emp),
    'config', to_jsonb(c) - 'empresa_id',
    'plataforma', jsonb_build_object('obrigatorio', pc.backup_obrigatorio, 'pausado', pc.backup_pausado, 'manter_max', pc.backup_manter_max),
    'permissoes', jsonb_build_object('manual', private.backup_pode(v_emp, 'manual'), 'baixar', private.backup_pode(v_emp, 'baixar'),
      'configurar', private.backup_pode(v_emp, 'configurar'), 'restaurar', private.backup_pode(v_emp, 'restaurar'),
      'super', private.eh_admin_plataforma()),
    'backups', (select coalesce(jsonb_agg(private.backup_meta(b) order by b.created_at desc), '[]'::jsonb)
                from public.backups b where b.empresa_id = v_emp),
    'espaco_bytes', (select coalesce(sum(tamanho_bytes), 0) from public.backups where empresa_id = v_emp));
end $$;

create or replace function public.backup_config_salvar(p jsonb, p_empresa uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := coalesce(p_empresa, private.empresa_id()); pc public.plataforma_config; c public.backup_config;
  v_modo text := coalesce(p->>'modo', 'automatico'); v_manual text[]; v_baixar text[];
  v_validos text[] := array['admin', 'gerente', 'caixa', 'atendente', 'cozinha'];
begin
  if not private.backup_pode(v_emp, 'configurar') then raise exception 'Só o administrador ou o gerente configura o backup'; end if;
  select * into pc from public.plataforma_config where id;
  if v_modo = 'manual' and pc.backup_obrigatorio and not private.eh_admin_plataforma() then
    raise exception 'O backup automático é obrigatório nesta plataforma';
  end if;
  v_manual := array(select distinct x from jsonb_array_elements_text(coalesce(p->'papeis_manual', '["admin","gerente"]')) x where x = any (v_validos));
  v_baixar := array(select distinct x from jsonb_array_elements_text(coalesce(p->'papeis_baixar', '["admin"]')) x where x = any (v_validos));
  -- Gerente não amplia o acesso ao arquivo além do que já tinha
  if private.papel()::text = 'gerente' and not private.eh_admin_plataforma() then
    select * into c from public.backup_config where empresa_id = v_emp;
    v_baixar := coalesce(c.papeis_baixar, '{admin}');
  end if;
  insert into public.backup_config as b (empresa_id, modo, frequencia, hora, dia_semana, manter, papeis_manual, papeis_baixar, atualizado_por, updated_at)
  values (v_emp, v_modo, coalesce(p->>'frequencia', 'diario'), coalesce((p->>'hora')::int, 3), coalesce((p->>'dia_semana')::int, 0),
          least(greatest(coalesce((p->>'manter')::int, 7), 1), pc.backup_manter_max), array_append(v_manual, 'admin'), array_append(v_baixar, 'admin'),
          private.quem(), now())
  on conflict (empresa_id) do update set modo = excluded.modo, frequencia = excluded.frequencia, hora = excluded.hora,
    dia_semana = excluded.dia_semana, manter = excluded.manter,
    papeis_manual = array(select distinct unnest(excluded.papeis_manual)),
    papeis_baixar = array(select distinct unnest(excluded.papeis_baixar)),
    atualizado_por = excluded.atualizado_por, updated_at = now();
  perform private.backup_reagendar(v_emp);
  perform private.backup_podar(v_emp);
  perform private.auditar_seguro(v_emp, 'backup.configurar', null, p);
  if private.eh_admin_plataforma() and v_emp is distinct from private.empresa_id() then
    perform private.log_super('backup.configurar', v_emp, p);
  end if;
  return public.backup_painel(v_emp);
end $$;

/** "Fazer backup agora". */
create or replace function public.backup_criar(p_empresa uuid default null, p_obs text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := coalesce(p_empresa, private.empresa_id()); v_id uuid; b public.backups;
begin
  if not private.backup_pode(v_emp, 'manual') then raise exception 'Você não tem permissão para fazer backup desta loja'; end if;
  if exists (select 1 from public.backups where empresa_id = v_emp and tipo = 'manual' and created_at > now() - interval '1 minute') then
    raise exception 'Um backup acabou de ser feito. Aguarde um minuto para fazer outro.';
  end if;
  v_id := private.backup_gravar(v_emp, 'manual', p_obs, private.quem());
  perform private.auditar_seguro(v_emp, 'backup.criar', v_id::text, jsonb_build_object('observacao', p_obs));
  if private.eh_admin_plataforma() and v_emp is distinct from private.empresa_id() then
    perform private.log_super('backup.criar', v_emp, jsonb_build_object('backup', v_id));
  end if;
  select * into b from public.backups where id = v_id;
  return private.backup_meta(b);
end $$;

/** Conteúdo completo de uma cópia guardada (para baixar o arquivo). */
create or replace function public.backup_baixar(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.backups;
begin
  select * into b from public.backups where id = p_id;
  if not found then raise exception 'Backup não encontrado'; end if;
  if not private.backup_pode(b.empresa_id, 'baixar') then raise exception 'Você não tem permissão para baixar este backup'; end if;
  perform private.auditar_seguro(b.empresa_id, 'backup.baixar', b.id::text, '{}'::jsonb);
  return b.dados;
end $$;

/** Exportar: cópia feita na hora, sem guardar (vira o arquivo .json). */
create or replace function public.backup_exportar(p_empresa uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := coalesce(p_empresa, private.empresa_id());
begin
  if not private.backup_pode(v_emp, 'baixar') then raise exception 'Você não tem permissão para exportar os dados desta loja'; end if;
  perform private.auditar_seguro(v_emp, 'backup.exportar', null, '{}'::jsonb);
  return private.backup_snapshot(v_emp);
end $$;

create or replace function public.backup_excluir(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.backups;
begin
  select * into b from public.backups where id = p_id;
  if not found then return; end if;
  if not private.eh_admin_plataforma() then
    if not private.backup_pode(b.empresa_id, 'restaurar') then raise exception 'Só o administrador da loja apaga backups'; end if;
    if b.tipo in ('antes_exclusao', 'antes_restauracao') then raise exception 'Cópias de segurança automáticas só podem ser apagadas pelo suporte'; end if;
  end if;
  delete from public.backups where id = p_id;
  perform private.auditar_seguro(b.empresa_id, 'backup.excluir', b.id::text, jsonb_build_object('tipo', b.tipo, 'de', b.created_at));
  if private.eh_admin_plataforma() then perform private.log_super('backup.excluir', b.empresa_id, private.backup_meta(b)); end if;
end $$;

/** Importar: recebe o conteúdo de um arquivo .json e guarda como backup "importado". */
create or replace function public.backup_importar(p_dados jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; v_id uuid; b public.backups; v_falta int;
begin
  if coalesce(p_dados->>'formato', '') <> 'lis-pdv-backup' or jsonb_typeof(p_dados->'tabelas') <> 'object'
     or jsonb_typeof(p_dados->'empresa') <> 'object' then
    raise exception 'Arquivo inválido: não é um backup do sistema';
  end if;
  v_emp := (p_dados->'empresa'->>'id')::uuid;
  if v_emp is null or v_emp::text <> coalesce(p_dados->>'empresa_id', v_emp::text) then raise exception 'Arquivo de backup corrompido'; end if;
  if not private.eh_admin_plataforma() then
    if v_emp is distinct from private.empresa_id() then raise exception 'Este arquivo é de outra loja. Só é possível importar backups da sua própria loja.'; end if;
    if not private.backup_pode(v_emp, 'restaurar') then raise exception 'Só o administrador da loja importa backups'; end if;
  end if;
  insert into public.backups (empresa_id, loja, tipo, criado_por, observacao, tabelas, registros, tamanho_bytes, dados)
  values (v_emp, coalesce(p_dados->>'loja', p_dados->'empresa'->>'nome_fantasia', p_dados->'empresa'->>'razao_social'), 'importado',
          private.quem(), 'Arquivo de ' || coalesce(to_char((p_dados->>'gerado_em')::timestamptz at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), '?'),
          (select count(*) from jsonb_object_keys(p_dados->'tabelas')), (p_dados->>'contagem')::int, octet_length(p_dados::text), p_dados)
  returning id into v_id;
  select count(*) into v_falta from jsonb_array_elements(coalesce(p_dados->'tabelas'->'perfis', '[]'::jsonb)) x
   where not exists (select 1 from auth.users u where u.id = (x->>'id')::uuid);
  perform private.auditar_seguro(v_emp, 'backup.importar', v_id::text, '{}'::jsonb);
  if private.eh_admin_plataforma() then perform private.log_super('backup.importar', v_emp, jsonb_build_object('backup', v_id)); end if;
  select * into b from public.backups where id = v_id;
  return private.backup_meta(b) || jsonb_build_object('loja_existe', exists (select 1 from public.empresas where id = v_emp), 'usuarios_faltando', v_falta);
end $$;

/** Logins do backup que não existem mais (a Edge Function "backup" recria antes de restaurar). */
create or replace function public.backup_usuarios_faltando(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b public.backups;
begin
  select * into b from public.backups where id = p_id;
  if not found then raise exception 'Backup não encontrado'; end if;
  if not private.backup_pode(b.empresa_id, 'restaurar') then raise exception 'Só o administrador da loja restaura backups'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', x->>'id', 'nome', x->>'nome', 'papel', x->>'papel',
            'email', (select u->>'email' from jsonb_array_elements(coalesce(b.dados->'usuarios', '[]'::jsonb)) u where u->>'id' = x->>'id' limit 1))), '[]'::jsonb)
          from jsonb_array_elements(coalesce(b.dados->'tabelas'->'perfis', '[]'::jsonb)) x
          where not exists (select 1 from auth.users au where au.id = (x->>'id')::uuid));
end $$;

/**
 * Restaura uma cópia: apaga os dados atuais da loja e põe os do backup.
 * Antes, guarda o estado atual como "antes_restauracao" (dá para voltar).
 * p_recriados: logins recriados pela Edge Function (entram desativados,
 * a não ser que p_reativar = true).
 */
create or replace function public.backup_restaurar(p_id uuid, p_reativar boolean default false, p_recriados uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.backups; v jsonb; v_emp uuid; v_super boolean := private.eh_admin_plataforma(); v_existe boolean;
  v_tabs text[]; t text; i int; v_cols text; v_chaves text[]; v_n bigint; v_total bigint := 0; v_seg uuid; v_falta int;
  v_modo text := 'replica'; v_linhas jsonb; v_ident record; v_bloq text[];
begin
  select * into b from public.backups where id = p_id;
  if not found then raise exception 'Backup não encontrado'; end if;
  v := b.dados; v_emp := b.empresa_id;
  if coalesce(v->>'formato', '') <> 'lis-pdv-backup' then raise exception 'Backup inválido'; end if;
  v_existe := exists (select 1 from public.empresas where id = v_emp);
  if not v_super and (not v_existe or not private.backup_pode(v_emp, 'restaurar')) then
    raise exception 'Só o administrador da loja restaura backups';
  end if;

  select count(*) into v_falta from jsonb_array_elements(coalesce(v->'tabelas'->'perfis', '[]'::jsonb)) x
   where not exists (select 1 from auth.users u where u.id = (x->>'id')::uuid);
  if v_falta > 0 then
    raise exception 'FALTAM_USUARIOS: % login(s) deste backup não existem mais e precisam ser recriados antes de restaurar.', v_falta;
  end if;

  -- Cópia de segurança do estado atual (dá para desfazer a restauração)
  if v_existe then
    v_seg := private.backup_gravar(v_emp, 'antes_restauracao',
      'Antes de restaurar o backup de ' || to_char(b.created_at at time zone private.fuso_loja(v_emp), 'DD/MM/YYYY HH24:MI'), private.quem());
  end if;

  -- Gatilhos desligados durante a restauração (senão o estoque seria baixado de novo, vendas bloqueadas etc.)
  v_tabs := private.backup_tabelas(v_super);
  begin
    perform set_config('session_replication_role', 'replica', true);
  exception when others then v_modo := 'alter';
  end;
  if v_modo = 'alter' then
    foreach t in array v_tabs || array['empresas'] loop
      execute format('alter table public.%I disable trigger user', t);
    end loop;
  end if;

  -- Apaga os dados atuais da loja (ordem inversa das dependências)
  for i in reverse cardinality(v_tabs)..1 loop
    execute format('delete from public.%I where empresa_id = $1', v_tabs[i]) using v_emp;
  end loop;

  -- A loja
  v_bloq := case when v_super then array['id'] else private.backup_colunas_comerciais() end;
  select string_agg(format('%1$I = r.%1$I', a.attname), ', ') into v_cols
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.empresas'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     and a.attname::text <> all (v_bloq) and (v->'empresa') ? a.attname::text;
  if v_existe then
    if v_cols is not null then
      execute format('update public.empresas e set %s from jsonb_populate_record(null::public.empresas, $1) r where e.id = $2', v_cols)
        using v->'empresa', v_emp;
    end if;
  else
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.empresas'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and (v->'empresa') ? a.attname::text;
    execute format('insert into public.empresas (%1$s) select %1$s from jsonb_populate_record(null::public.empresas, $1)', v_cols)
      using v->'empresa';
    insert into public.backup_config (empresa_id) values (v_emp) on conflict do nothing;
    perform private.backup_reagendar(v_emp);
  end if;

  -- As tabelas, na ordem das dependências
  foreach t in array v_tabs loop
    v_linhas := v->'tabelas'->t;
    continue when v_linhas is null or jsonb_typeof(v_linhas) <> 'array' or jsonb_array_length(v_linhas) = 0;
    select array_agg(k) into v_chaves from jsonb_object_keys(v_linhas->0) k;
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_catalog.pg_attribute a
     where a.attrelid = format('public.%I', t)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and a.attname::text = any (v_chaves);
    continue when v_cols is null;
    execute format('insert into public.%1$I (%2$s) overriding system value select %2$s from jsonb_populate_recordset(null::public.%1$I, $1) where empresa_id = $2 on conflict do nothing', t, v_cols)
      using v_linhas, v_emp;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    -- Contadores automáticos (identity) continuam depois do maior número restaurado
    for v_ident in select a.attname from pg_catalog.pg_attribute a
                    where a.attrelid = format('public.%I', t)::regclass and a.attidentity <> '' and not a.attisdropped loop
      execute format('select setval(pg_get_serial_sequence(%L, %L), greatest((select coalesce(max(%I), 0) from public.%I), (select last_value from %s)))',
        'public.' || t, v_ident.attname, v_ident.attname, t, pg_get_serial_sequence('public.' || t, v_ident.attname));
    end loop;
  end loop;

  -- Logins recriados: desativados até o administrador conferir (a não ser que peça para reativar)
  if cardinality(p_recriados) > 0 then
    update public.perfis set ativo = coalesce(p_reativar, false) where empresa_id = v_emp and id = any (p_recriados);
  end if;

  if v_modo = 'alter' then
    foreach t in array v_tabs || array['empresas'] loop
      execute format('alter table public.%I enable trigger user', t);
    end loop;
  else
    perform set_config('session_replication_role', 'origin', true);
  end if;

  update public.backups set restaurado_em = now() where id = p_id;
  perform private.auditar_seguro(v_emp, 'backup.restaurar', b.id::text,
    jsonb_build_object('backup_de', b.created_at, 'tipo', b.tipo, 'registros', v_total, 'copia_seguranca', v_seg));
  if v_super then
    perform private.log_super('backup.restaurar', v_emp, jsonb_build_object('backup', b.id, 'backup_de', b.created_at, 'registros', v_total, 'loja_recriada', not v_existe));
  end if;
  return jsonb_build_object('registros', v_total, 'copia_seguranca', v_seg, 'loja_recriada', not v_existe, 'modo', v_modo);
end $$;

-- ---------------------------------------------------------------------
-- Situação da conta (o sistema lê ao abrir): + licenças e permissões de backup
-- ---------------------------------------------------------------------
create or replace function public.situacao_conta()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', e.status_conta, 'plano', e.plano, 'teste_expira_em', e.teste_expira_em,
    'bloqueio', private.conta_liberada(e.id),
    'vendas_teste', (select count(*) from public.vendas v where v.empresa_id = e.id and v.status = 'finalizada'),
    'admin_plataforma', private.eh_admin_plataforma(),
    'garcom', private.modulo_garcom(e.id),
    'delivery_contratado', (e.status_conta = 'teste' or e.plano = 'interno' or coalesce((e.modulos->>'delivery')::boolean, false))
                           and private.licenca_ok(e.id, 'delivery'),
    'delivery_ativo', e.delivery_ativo,
    'licencas', private.licencas_json(e.id),
    'backup', jsonb_build_object('ver', private.backup_pode(e.id, 'ver'), 'baixar', private.backup_pode(e.id, 'baixar'),
                                 'restaurar', private.backup_pode(e.id, 'restaurar')))
  from public.empresas e where e.id = private.empresa_id()
$$;

-- ---------------------------------------------------------------------
-- Superusuário: licenças
-- ---------------------------------------------------------------------
create or replace function public.plataforma_licencas()
returns table (id uuid, loja text, segmento text, status_conta text, plano text, created_at timestamptz, licencas jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return query select e.id, coalesce(e.nome_fantasia, e.razao_social), e.segmento, e.status_conta, e.plano, e.created_at,
    private.licencas_json(e.id) || jsonb_build_object('_modulos', jsonb_build_object(
      'delivery', e.status_conta = 'teste' or e.plano = 'interno' or coalesce((e.modulos->>'delivery')::boolean, false),
      'garcom', e.segmento = 'restaurante' or coalesce((e.modulos->>'garcom')::boolean, false)))
  from public.empresas e order by coalesce(e.nome_fantasia, e.razao_social);
end $$;

/**
 * Renovar / expirar licenças de uma ou várias lojas.
 *   p_acao: 'renovar' (+p_dias a partir do vencimento atual, ou de hoje se já venceu),
 *           'definir' (vence em p_ate), 'expirar' (vence agora), 'sem_prazo'.
 */
create or replace function public.plataforma_licenca_acao(p_ids uuid[], p_modulos text[], p_acao text,
  p_dias int default 30, p_ate timestamptz default null, p_obs text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; m text; n int := 0; v_ant timestamptz; v_nova timestamptz; v_quem text := private.quem();
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if p_acao not in ('renovar', 'definir', 'expirar', 'sem_prazo') then raise exception 'Ação inválida'; end if;
  if p_acao = 'renovar' and coalesce(p_dias, 0) not between 1 and 3660 then raise exception 'Informe de 1 a 3660 dias'; end if;
  if p_acao = 'definir' and p_ate is null then raise exception 'Informe a data de vencimento'; end if;
  if cardinality(coalesce(p_modulos, '{}')) = 0 then raise exception 'Escolha ao menos uma licença'; end if;
  foreach v_emp in array coalesce(p_ids, '{}') loop
    continue when not exists (select 1 from public.empresas where id = v_emp);
    foreach m in array p_modulos loop
      if m not in ('pdv', 'delivery', 'garcom', 'fiscal') then raise exception 'Licença inválida: %', m; end if;
      select expira_em into v_ant from public.licencas where empresa_id = v_emp and modulo = m;
      v_nova := case p_acao
        when 'renovar' then greatest(coalesce(v_ant, now()), now()) + make_interval(days => p_dias)
        when 'definir' then p_ate
        when 'expirar' then now()
        else null end;
      insert into public.licencas as l (empresa_id, modulo, expira_em, observacao, atualizado_por, updated_at)
      values (v_emp, m, v_nova, nullif(trim(coalesce(p_obs, '')), ''), v_quem, now())
      on conflict (empresa_id, modulo) do update set expira_em = excluded.expira_em,
        observacao = coalesce(excluded.observacao, l.observacao), atualizado_por = excluded.atualizado_por, updated_at = now();
      perform private.auditar(v_emp, 'licenca.' || p_acao, 'licencas', m, jsonb_build_object('modulo', m, 'antes', v_ant, 'depois', v_nova, 'observacao', p_obs));
      perform private.log_super('licenca.' || p_acao, v_emp, jsonb_build_object('modulo', m, 'antes', v_ant, 'depois', v_nova, 'observacao', p_obs));
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Superusuário: dados e backup de todas as lojas
-- ---------------------------------------------------------------------
create or replace function public.plataforma_dados_lojas()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare pc public.plataforma_config; v_minha uuid;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  select * into pc from public.plataforma_config where id;
  select p.empresa_id into v_minha from public.perfis p where p.id = (select auth.uid());
  return jsonb_build_object(
    'config', to_jsonb(pc) - 'id',
    'espaco_total', (select coalesce(sum(tamanho_bytes), 0) from public.backups),
    'copias_total', (select count(*) from public.backups),
    'lojas', (select coalesce(jsonb_agg(x order by x->>'loja'), '[]'::jsonb) from (
      select jsonb_build_object(
        'id', e.id, 'loja', coalesce(e.nome_fantasia, e.razao_social), 'documento', e.cnpj, 'segmento', e.segmento,
        'municipio', e.municipio, 'uf', e.uf, 'status_conta', e.status_conta, 'plano', e.plano, 'created_at', e.created_at,
        'usuarios', (select count(*) from public.perfis p where p.empresa_id = e.id),
        'vendas', (select count(*) from public.vendas v where v.empresa_id = e.id and v.status = 'finalizada'),
        'minha', e.id = v_minha,
        'protegida', e.id = v_minha or exists (select 1 from public.perfis p join auth.users u on u.id = p.id
                        join public.plataforma_admins a on lower(a.email) = lower(u.email) where p.empresa_id = e.id),
        'backup', jsonb_build_object('modo', c.modo, 'frequencia', c.frequencia, 'hora', c.hora, 'dia_semana', c.dia_semana,
                    'manter', c.manter, 'ultimo', c.ultimo_backup_em, 'proximo', c.proximo_backup_em, 'erro', c.ultimo_erro),
        'copias', (select count(*) from public.backups b where b.empresa_id = e.id),
        'espaco', (select coalesce(sum(b.tamanho_bytes), 0) from public.backups b where b.empresa_id = e.id),
        'licencas', private.licencas_json(e.id)) x
      from public.empresas e left join public.backup_config c on c.empresa_id = e.id) s));
end $$;

/** Todas as cópias guardadas (inclusive de lojas já excluídas). */
create or replace function public.plataforma_backups(p_empresa uuid default null, p_tipo text default null, p_limite int default 300)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return (select coalesce(jsonb_agg(private.backup_meta(b) || jsonb_build_object('loja_existe', exists (select 1 from public.empresas e where e.id = b.empresa_id))
            order by b.created_at desc), '[]'::jsonb)
          from (select * from public.backups
                where (p_empresa is null or empresa_id = p_empresa) and (p_tipo is null or tipo = p_tipo)
                order by created_at desc limit least(greatest(coalesce(p_limite, 300), 1), 2000)) b);
end $$;

create or replace function public.plataforma_backup_config_salvar(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  update public.plataforma_config set
    backup_obrigatorio = coalesce((p->>'backup_obrigatorio')::boolean, backup_obrigatorio),
    backup_pausado = coalesce((p->>'backup_pausado')::boolean, backup_pausado),
    backup_frequencia_padrao = coalesce(p->>'backup_frequencia_padrao', backup_frequencia_padrao),
    backup_hora_padrao = coalesce((p->>'backup_hora_padrao')::int, backup_hora_padrao),
    backup_manter_padrao = coalesce((p->>'backup_manter_padrao')::int, backup_manter_padrao),
    backup_manter_max = coalesce((p->>'backup_manter_max')::int, backup_manter_max),
    backup_exclusao_dias = coalesce((p->>'backup_exclusao_dias')::int, backup_exclusao_dias),
    atualizado_por = private.quem(), updated_at = now()
  where id;
  perform private.log_super('backup.politica', null, p);
  return (select to_jsonb(x) - 'id' from public.plataforma_config x where x.id);
end $$;

/** Aplica a mesma agenda de backup a várias lojas de uma vez. */
create or replace function public.plataforma_backup_config_lojas(p_ids uuid[], p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; n int := 0; pc public.plataforma_config;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  select * into pc from public.plataforma_config where id;
  foreach v_emp in array coalesce(p_ids, '{}') loop
    continue when not exists (select 1 from public.empresas where id = v_emp);
    insert into public.backup_config as c (empresa_id) values (v_emp) on conflict do nothing;
    update public.backup_config set
      modo = coalesce(p->>'modo', modo), frequencia = coalesce(p->>'frequencia', frequencia),
      hora = coalesce((p->>'hora')::int, hora), dia_semana = coalesce((p->>'dia_semana')::int, dia_semana),
      manter = least(coalesce((p->>'manter')::int, manter), pc.backup_manter_max),
      atualizado_por = private.quem(), updated_at = now()
    where empresa_id = v_emp;
    perform private.backup_reagendar(v_emp);
    perform private.backup_podar(v_emp);
    n := n + 1;
  end loop;
  perform private.log_super('backup.configurar_lojas', null, jsonb_build_object('lojas', n, 'config', p));
  return n;
end $$;

/** Dados gerais da plataforma (para guardar junto da exportação de todas as lojas). */
create or replace function public.plataforma_dados_gerais()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return jsonb_build_object(
    'formato', 'lis-pdv-plataforma', 'versao', 1, 'gerado_em', now(),
    'plataforma_admins', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from public.plataforma_admins a),
    'plataforma_config', (select to_jsonb(c) from public.plataforma_config c where c.id),
    'leads', (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) from public.leads l),
    'avisos_plataforma', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from public.avisos_plataforma a));
end $$;

-- ---------------------------------------------------------------------
-- Superusuário: excluir lojas (clientes) do banco
-- ---------------------------------------------------------------------
create or replace function public.plataforma_excluir_lojas(p_ids uuid[], p_confirmacao text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; v_minha uuid; e public.empresas; v_users uuid[]; v_bk uuid; v_pend uuid[] := '{}';
  v_excl jsonb := '[]'::jsonb; v_quem text := private.quem();
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if coalesce(upper(trim(p_confirmacao)), '') <> 'EXCLUIR' then raise exception 'Digite EXCLUIR para confirmar'; end if;
  select p.empresa_id into v_minha from public.perfis p where p.id = (select auth.uid());
  foreach v_emp in array coalesce(p_ids, '{}') loop
    select * into e from public.empresas where id = v_emp;
    continue when not found;
    if v_emp = v_minha then raise exception 'A loja "%" é a sua própria loja e não pode ser excluída por aqui', coalesce(e.nome_fantasia, e.razao_social); end if;
    if exists (select 1 from public.perfis p join auth.users u on u.id = p.id join public.plataforma_admins a on lower(a.email) = lower(u.email)
               where p.empresa_id = v_emp) then
      raise exception 'A loja "%" tem membros da equipe da plataforma e não pode ser excluída', coalesce(e.nome_fantasia, e.razao_social);
    end if;
    -- Cópia de segurança antes de apagar (guardada por plataforma_config.backup_exclusao_dias)
    v_bk := private.backup_gravar(v_emp, 'antes_exclusao', coalesce(nullif(trim(coalesce(p_motivo, '')), ''), 'Loja excluída'), v_quem);
    select coalesce(array_agg(p.id), '{}') into v_users from public.perfis p where p.empresa_id = v_emp;
    -- Encerra sessões de suporte abertas nesta loja e apaga a loja (todas as tabelas em cascata)
    delete from public.suporte_acessos where empresa_id = v_emp;
    delete from public.empresas where id = v_emp;
    -- Logins dos usuários da loja
    if cardinality(v_users) > 0 then
      begin
        delete from auth.users u where u.id = any (v_users) and not exists (select 1 from public.perfis p where p.id = u.id);
      exception when others then
        v_pend := v_pend || v_users;   -- a Edge Function "backup" (remover_usuarios) termina o serviço
      end;
    end if;
    perform private.log_super('loja.excluir', v_emp, jsonb_build_object('loja', coalesce(e.nome_fantasia, e.razao_social), 'documento', e.cnpj,
      'usuarios', cardinality(v_users), 'backup', v_bk, 'motivo', p_motivo));
    v_excl := v_excl || jsonb_build_object('id', v_emp, 'loja', coalesce(e.nome_fantasia, e.razao_social), 'backup', v_bk, 'usuarios', cardinality(v_users));
  end loop;
  return jsonb_build_object('excluidas', v_excl, 'usuarios_pendentes', to_jsonb(v_pend));
end $$;

/** Logins sem loja (para a Edge Function apagar): nunca inclui a equipe. */
create or replace function public.plataforma_usuarios_orfaos(p_ids uuid[])
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return array(select u.id from auth.users u
    where u.id = any (coalesce(p_ids, '{}'))
      and not exists (select 1 from public.perfis p where p.id = u.id)
      and not exists (select 1 from public.plataforma_admins a where lower(a.email) = lower(u.email))
      and u.id <> (select auth.uid()));
end $$;

-- ---------------------------------------------------------------------
-- Agendamento (pg_cron): a cada 15 minutos roda os backups que estão na hora
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'backup-automatico';
    perform cron.schedule('backup-automatico', '*/15 * * * *', 'select private.backup_rodar_agendados(25)');
  else
    raise notice 'pg_cron não está ativo: ative em Database > Extensions e rode este arquivo de novo para ligar o backup automático.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------
revoke execute on function
  public.backup_painel(uuid), public.backup_config_salvar(jsonb, uuid), public.backup_criar(uuid, text), public.backup_baixar(uuid),
  public.backup_exportar(uuid), public.backup_excluir(uuid), public.backup_importar(jsonb), public.backup_usuarios_faltando(uuid),
  public.backup_restaurar(uuid, boolean, uuid[]), public.situacao_conta(),
  public.plataforma_licencas(), public.plataforma_licenca_acao(uuid[], text[], text, int, timestamptz, text),
  public.plataforma_dados_lojas(), public.plataforma_backups(uuid, text, int), public.plataforma_backup_config_salvar(jsonb),
  public.plataforma_backup_config_lojas(uuid[], jsonb), public.plataforma_dados_gerais(),
  public.plataforma_excluir_lojas(uuid[], text, text), public.plataforma_usuarios_orfaos(uuid[])
  from public, anon;
grant execute on function
  public.backup_painel(uuid), public.backup_config_salvar(jsonb, uuid), public.backup_criar(uuid, text), public.backup_baixar(uuid),
  public.backup_exportar(uuid), public.backup_excluir(uuid), public.backup_importar(jsonb), public.backup_usuarios_faltando(uuid),
  public.backup_restaurar(uuid, boolean, uuid[]), public.situacao_conta(),
  public.plataforma_licencas(), public.plataforma_licenca_acao(uuid[], text[], text, int, timestamptz, text),
  public.plataforma_dados_lojas(), public.plataforma_backups(uuid, text, int), public.plataforma_backup_config_salvar(jsonb),
  public.plataforma_backup_config_lojas(uuid[], jsonb), public.plataforma_dados_gerais(),
  public.plataforma_excluir_lojas(uuid[], text, text), public.plataforma_usuarios_orfaos(uuid[])
  to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.empresa_id(), private.papel(), private.tem_papel(public.papel_usuario[]),
  private.eh_admin_plataforma(), private.licenca_ok(uuid, text) to authenticated;

notify pgrst, 'reload schema';
