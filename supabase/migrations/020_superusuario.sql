-- =====================================================================
-- 020 · Superusuário, equipe de suporte, chamados e avisos
--
--   Superusuário (nível "super" em plataforma_admins): o criador do sistema.
--   Tem tudo o que o fornecedor já tinha (Plataforma) e mais:
--
--   1. Entrar em qualquer loja (modo suporte)
--      O superusuário escolhe a loja, o motivo, o tempo e o modo:
--        - leitura: vê tudo como administrador da loja, mas o banco recusa
--          qualquer alteração (transação somente leitura, via pre-request);
--        - total:   age como administrador da loja (configura, cadastra,
--          redefine senhas, corrige dados).
--      private.empresa_id(), private.papel() e private.tem_papel() passam a
--      responder pela loja escolhida, então TODAS as regras (RLS e funções)
--      continuam valendo sem reescrever nada. Entrada, troca de modo e saída
--      ficam no registro de atividades da própria loja e no registro do
--      superusuário. Toda ação auditada feita em modo suporte leva
--      "via_suporte" nos detalhes.
--
--   2. Chamados de ajuda
--      Qualquer pessoa (até na tela de login) pede ajuda e recebe um código
--      de 6 números. A equipe é avisada na hora, assume pelo código e entra
--      na loja do cliente em modo suporte com um clique.
--
--   3. Equipe de suporte: o superusuário cadastra pessoas com nível
--      "suporte" (entram nas lojas e atendem chamados, mas não veem a
--      Plataforma, cobranças, equipe nem avisos).
--
--   4. Avisos para as lojas (todas, um setor ou uma loja): manutenção,
--      novidades, alertas. Aparecem no topo do sistema.
--
--   5. Registro do superusuário (imutável): tudo o que a equipe fez.
--
--   6. A equipe nunca é barrada pelo vínculo de aparelho (018).
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Equipe da plataforma (níveis)
-- ---------------------------------------------------------------------
alter table public.plataforma_admins add column if not exists nome text;
alter table public.plataforma_admins add column if not exists nivel text not null default 'super';
alter table public.plataforma_admins add column if not exists ativo boolean not null default true;
alter table public.plataforma_admins add column if not exists criado_por text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'plataforma_admins_nivel_ck') then
    alter table public.plataforma_admins add constraint plataforma_admins_nivel_ck check (nivel in ('super', 'suporte'));
  end if;
end $$;
-- O criador do sistema é sempre superusuário
insert into public.plataforma_admins (email, nome, nivel, ativo)
values ('haydenfernandes.ti@gmail.com', 'Hayden Fernandes', 'super', true)
on conflict (email) do update set nivel = 'super', ativo = true;

/** Nível do usuário logado na equipe da plataforma: 'super', 'suporte' ou null. */
create or replace function private.equipe_nivel()
returns text language sql stable security definer set search_path = '' as $$
  select a.nivel from auth.users u
  join public.plataforma_admins a on lower(a.email) = lower(u.email)
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null and a.ativo
  limit 1
$$;

create or replace function private.eh_equipe()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.equipe_nivel() is not null
$$;

-- "Admin da plataforma" (Plataforma, cobranças, aparelhos de todas as lojas…) passa a ser só o superusuário
create or replace function private.eh_admin_plataforma()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.equipe_nivel() = 'super', false)
$$;

create or replace function private.nome_equipe()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select nullif(trim(a.nome), '') from auth.users u join public.plataforma_admins a on lower(a.email) = lower(u.email) where u.id = (select auth.uid())),
    (select p.nome from public.perfis p where p.id = (select auth.uid())),
    'Suporte')
$$;

-- ---------------------------------------------------------------------
-- Registro do superusuário (imutável)
-- ---------------------------------------------------------------------
create table if not exists public.superusuario_log (
  id bigint generated always as identity primary key,
  usuario_id uuid,
  email text,
  nome text,
  acao text not null,
  empresa_id uuid,               -- sem FK de propósito: o registro sobrevive à loja
  loja text,
  detalhes jsonb not null default '{}'::jsonb,
  ip text,
  criado_em timestamptz not null default now()
);
create index if not exists superusuario_log_idx on public.superusuario_log(criado_em desc);
create index if not exists superusuario_log_emp_idx on public.superusuario_log(empresa_id, criado_em desc);
alter table public.superusuario_log enable row level security;
revoke all on public.superusuario_log from anon, authenticated;

create or replace function private.trg_log_imutavel()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'O registro do superusuário não pode ser alterado nem apagado';
end $$;
drop trigger if exists t_log_imutavel on public.superusuario_log;
create trigger t_log_imutavel before update or delete on public.superusuario_log
  for each row execute function private.trg_log_imutavel();

create or replace function private.log_super(p_acao text, p_emp uuid default null, p_det jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.superusuario_log(usuario_id, email, nome, acao, empresa_id, loja, detalhes, ip)
  values ((select auth.uid()), (select u.email from auth.users u where u.id = (select auth.uid())), private.nome_equipe(),
          p_acao, p_emp,
          (select coalesce(e.nome_fantasia, e.razao_social) from public.empresas e where e.id = p_emp),
          coalesce(p_det, '{}'::jsonb), private.ip_requisicao());
end $$;

-- ---------------------------------------------------------------------
-- Sessões de suporte (entrar numa loja)
-- ---------------------------------------------------------------------
create table if not exists public.suporte_acessos (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  modo text not null default 'leitura' check (modo in ('leitura', 'total')),
  motivo text not null,
  chamado_id uuid,
  inicio timestamptz not null default now(),
  expira_em timestamptz not null,
  encerrado_em timestamptz,
  encerrado_motivo text,
  ip text
);
create unique index if not exists suporte_acessos_aberto_uk on public.suporte_acessos(usuario_id) where encerrado_em is null;
create index if not exists suporte_acessos_emp_idx on public.suporte_acessos(empresa_id, inicio desc);
alter table public.suporte_acessos enable row level security;
revoke all on public.suporte_acessos from anon, authenticated;

/** Loja em que o usuário logado está em modo suporte agora (ou null). */
create or replace function private.suporte_empresa()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.empresa_id from public.suporte_acessos s
  where s.usuario_id = (select auth.uid()) and s.encerrado_em is null and s.expira_em > now()
$$;

create or replace function private.suporte_modo()
returns text language sql stable security definer set search_path = '' as $$
  select s.modo from public.suporte_acessos s
  where s.usuario_id = (select auth.uid()) and s.encerrado_em is null and s.expira_em > now()
$$;

-- As três funções que todas as regras do banco usam passam a respeitar o modo suporte.
create or replace function private.empresa_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(private.suporte_empresa(),
    (select p.empresa_id from public.perfis p where p.id = (select auth.uid()) and p.ativo))
$$;

create or replace function private.papel()
returns public.papel_usuario language sql stable security definer set search_path = '' as $$
  select case when private.suporte_empresa() is not null then 'admin'::public.papel_usuario
    else (select p.papel from public.perfis p where p.id = (select auth.uid()) and p.ativo) end
$$;

create or replace function private.tem_papel(papeis public.papel_usuario[])
returns boolean language sql stable security definer set search_path = '' as $$
  select case when private.suporte_empresa() is not null then 'admin'::public.papel_usuario = any(papeis)
    else exists (select 1 from public.perfis p where p.id = (select auth.uid()) and p.ativo and p.papel = any(papeis)) end
$$;

-- Tudo o que for auditado em modo suporte fica marcado
create or replace function private.auditar(p_empresa uuid, p_acao text, p_entidade text, p_entidade_id text, p_detalhes jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.auditoria(empresa_id, usuario_id, acao, entidade, entidade_id, detalhes)
  values (p_empresa, (select auth.uid()), p_acao, p_entidade, p_entidade_id,
    case when private.suporte_empresa() is not null
      then coalesce(p_detalhes, '{}'::jsonb) || jsonb_build_object('via_suporte', true, 'suporte_nome', private.nome_equipe())
      else p_detalhes end)
$$;

grant execute on function private.equipe_nivel(), private.eh_equipe(), private.eh_admin_plataforma(), private.nome_equipe(),
  private.suporte_empresa(), private.suporte_modo(), private.empresa_id(), private.papel(),
  private.tem_papel(public.papel_usuario[]) to authenticated;

-- ---------------------------------------------------------------------
-- Modo somente leitura (pre-request do PostgREST)
--   Roda antes de cada chamada à API. Se o usuário está em modo suporte
--   "leitura", a transação vira somente leitura: qualquer INSERT/UPDATE/
--   DELETE (direto ou dentro de função) é recusado pelo próprio Postgres.
--   As funções do próprio suporte (suporte_*, chamado_*) e o envio do
--   diagnóstico continuam liberados.
--   Sem SET search_path de propósito (um SET na função desfaria o
--   set_config ao sair); todos os nomes são qualificados.
-- ---------------------------------------------------------------------
create or replace function public.lis_pre_request()
returns void language plpgsql security definer as $$
declare v_le boolean := false;
begin
  if auth.uid() is null then return; end if;   -- anônimo, service role, cron
  begin
    select true into v_le from public.suporte_acessos s
     where s.usuario_id = auth.uid() and s.encerrado_em is null and s.expira_em > pg_catalog.now() and s.modo = 'leitura';
  exception when others then return;            -- nunca derruba a API
  end;
  if not coalesce(v_le, false) then return; end if;
  -- Sem o caminho da chamada não dá para liberar "Sair da loja": nesse caso não trava (a tela continua avisando)
  if coalesce(pg_catalog.current_setting('request.path', true), '') = '' then return; end if;
  if pg_catalog.current_setting('request.path', true)
     ~ '^/rpc/(suporte_|chamado_|avisos_ativos|diagnostico_registrar|dispositivo_verificar)' then
    return;
  end if;
  perform pg_catalog.set_config('transaction_read_only', 'on', true);
end $$;
revoke execute on function public.lis_pre_request() from public;
grant execute on function public.lis_pre_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.lis_pre_request';
notify pgrst, 'reload config';

-- ---------------------------------------------------------------------
-- A equipe nunca é barrada pelo vínculo de aparelho (018)
-- ---------------------------------------------------------------------
create or replace function public.dispositivo_verificar(p_aparelho text, p_token text default null, p_nome text default null,
  p_impressao text default null, p_info jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_perfil record;
  v_lim int;
  v_usados int;
  d public.dispositivos;
  v_token text;
  v_ip text := private.ip_requisicao();
  v_lista jsonb;
begin
  if v_uid is null then raise exception 'Não autenticado'; end if;
  if private.eh_equipe() then return jsonb_build_object('status', 'livre', 'equipe', true); end if;
  select p.id, p.empresa_id, p.papel::text as papel, p.nome into v_perfil from public.perfis p where p.id = v_uid and p.ativo;
  if not found or v_perfil.empresa_id is null then return jsonb_build_object('status', 'livre'); end if;
  v_lim := private.limite_dispositivos(v_perfil.empresa_id, v_perfil.papel);
  if v_lim <= 0 then return jsonb_build_object('status', 'livre', 'limite', 0); end if;
  if p_aparelho is null or length(p_aparelho) < 16 or length(p_aparelho) > 80 then raise exception 'Aparelho inválido'; end if;

  select count(*) into v_usados from public.dispositivos where usuario_id = v_uid and status = 'ativo';
  select * into d from public.dispositivos where usuario_id = v_uid and aparelho = p_aparelho and status = 'ativo';

  if found then
    if d.token_hash = private.hash_chave(p_token) then
      if d.impressao is not null and p_impressao is not null and d.impressao <> p_impressao then
        update public.dispositivos set suspeitas = suspeitas + 1 where id = d.id;
        perform private.evento_dispositivo(d.empresa_id, v_uid, p_aparelho, d.nome, 'outro_navegador',
          jsonb_build_object('impressao_antes', d.impressao, 'impressao_agora', p_impressao));
      end if;
      update public.dispositivos set ultimo_uso = now(), ultimo_ip = coalesce(v_ip, ultimo_ip),
        info = coalesce(p_info, '{}'::jsonb), impressao = coalesce(impressao, p_impressao) where id = d.id;
      return jsonb_build_object('status', 'liberado', 'id', d.id, 'nome', d.nome, 'limite', v_lim, 'usados', v_usados);
    end if;
    if d.impressao is not null and d.impressao = p_impressao then
      v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
      update public.dispositivos set token_hash = private.hash_chave(v_token), ultimo_uso = now(), ultimo_ip = coalesce(v_ip, ultimo_ip) where id = d.id;
      perform private.evento_dispositivo(d.empresa_id, v_uid, p_aparelho, d.nome, 'chave_renovada', '{}'::jsonb);
      return jsonb_build_object('status', 'liberado', 'token', v_token, 'id', d.id, 'nome', d.nome, 'limite', v_lim, 'usados', v_usados);
    end if;
    update public.dispositivos set suspeitas = suspeitas + 1 where id = d.id;
    perform private.evento_dispositivo(d.empresa_id, v_uid, p_aparelho, d.nome, 'conflito', jsonb_build_object('nome_informado', p_nome));
    return jsonb_build_object('status', 'conflito', 'nome', d.nome, 'limite', v_lim, 'usados', v_usados);
  end if;

  if v_usados < v_lim then
    v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into public.dispositivos(empresa_id, usuario_id, aparelho, nome, token_hash, impressao, info, ultimo_uso, ultimo_ip)
    values (v_perfil.empresa_id, v_uid, p_aparelho, left(coalesce(nullif(trim(p_nome), ''), 'Aparelho'), 60),
            private.hash_chave(v_token), p_impressao, coalesce(p_info, '{}'::jsonb), now(), v_ip)
    returning * into d;
    perform private.evento_dispositivo(d.empresa_id, v_uid, p_aparelho, d.nome, 'vinculado', '{}'::jsonb);
    return jsonb_build_object('status', 'vinculado', 'token', v_token, 'id', d.id, 'nome', d.nome, 'limite', v_lim, 'usados', v_usados + 1);
  end if;

  perform private.evento_dispositivo(v_perfil.empresa_id, v_uid, p_aparelho, p_nome, 'recusado', jsonb_build_object('limite', v_lim));
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'ultimo_uso', x.ultimo_uso) order by x.ultimo_uso desc nulls last), '[]'::jsonb)
    into v_lista from public.dispositivos x where x.usuario_id = v_uid and x.status = 'ativo';
  return jsonb_build_object('status', 'limite', 'limite', v_lim, 'usados', v_usados, 'aparelhos', v_lista,
    'trocas', (select count(*) from public.dispositivos where empresa_id = v_perfil.empresa_id and status = 'revogado'
               and not revogado_pela_plataforma and revogado_em > now() - interval '30 days'),
    'trocas_mes', (private.cfg_dispositivos(v_perfil.empresa_id)->>'trocas_mes')::int);
end $$;

create or replace function private.trg_exigir_dispositivo()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_perfil record;
  d public.dispositivos;
  v_ap text; v_ip text;
begin
  if v_uid is null then return coalesce(new, old); end if;
  if nullif(current_setting('request.headers', true), '') is null then return coalesce(new, old); end if;
  if private.eh_equipe() then return coalesce(new, old); end if;   -- equipe da plataforma (inclusive em modo suporte)
  select p.empresa_id, p.papel::text as papel into v_perfil from public.perfis p where p.id = v_uid;
  if not found or private.limite_dispositivos(v_perfil.empresa_id, v_perfil.papel) <= 0 then return coalesce(new, old); end if;

  v_ap := private.cabecalho('x-lis-aparelho');
  select * into d from public.dispositivos
   where usuario_id = v_uid and aparelho = v_ap and status = 'ativo' and token_hash = private.hash_chave(private.cabecalho('x-lis-token'));
  if not found then
    perform private.evento_dispositivo(v_perfil.empresa_id, v_uid, v_ap, null, 'recusado', jsonb_build_object('tabela', tg_table_name));
    raise exception 'Aparelho não autorizado: este computador não está liberado para o seu usuário. Peça ao administrador da loja em Usuários › Aparelhos.';
  end if;

  v_ip := private.ip_requisicao();
  if d.ultimo_ip is not null and v_ip is not null and v_ip <> d.ultimo_ip and d.ultimo_uso > now() - interval '2 minutes' then
    update public.dispositivos set suspeitas = suspeitas + 1 where id = d.id;
    perform private.evento_dispositivo(d.empresa_id, v_uid, v_ap, d.nome, 'uso_simultaneo', jsonb_build_object('ip_antes', d.ultimo_ip, 'ip_agora', v_ip));
  end if;
  if d.ultimo_uso is null or d.ultimo_uso < now() - interval '1 minute' or v_ip is distinct from d.ultimo_ip then
    update public.dispositivos set ultimo_uso = now(), ultimo_ip = coalesce(v_ip, ultimo_ip) where id = d.id;
  end if;
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------
-- Funções do modo suporte
-- ---------------------------------------------------------------------
create or replace function private.json_sessao(s public.suporte_acessos)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when s.id is null then null else jsonb_build_object(
    'id', s.id, 'empresa_id', s.empresa_id, 'modo', s.modo, 'motivo', s.motivo, 'inicio', s.inicio, 'expira_em', s.expira_em,
    'chamado_id', s.chamado_id,
    'loja', (select coalesce(e.nome_fantasia, e.razao_social) from public.empresas e where e.id = s.empresa_id)) end
$$;

/** Quem sou eu na equipe + sessão de suporte aberta + meu perfil de verdade. */
create or replace function public.suporte_eu()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_nivel text := private.equipe_nivel(); s public.suporte_acessos; p record;
begin
  if v_nivel is null then return jsonb_build_object('equipe', null); end if;
  select * into s from public.suporte_acessos where usuario_id = (select auth.uid()) and encerrado_em is null and expira_em > now();
  select x.id, x.empresa_id, x.nome, x.email, x.papel, x.ativo into p from public.perfis x where x.id = (select auth.uid());
  return jsonb_build_object(
    'equipe', jsonb_build_object('nivel', v_nivel, 'nome', private.nome_equipe()),
    'perfil', case when p.id is null then null else jsonb_build_object('id', p.id, 'empresa_id', p.empresa_id, 'nome', p.nome, 'email', p.email, 'papel', p.papel, 'ativo', p.ativo) end,
    'sessao', private.json_sessao(s));
end $$;

/** Lojas para a equipe escolher, com sinais de saúde para o suporte. */
create or replace function public.suporte_lojas(p_busca text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_b text := nullif(lower(trim(coalesce(p_busca, ''))), '');
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  return coalesce((select jsonb_agg(x order by x.ultima_atividade desc nulls last, x.loja) from (
    select e.id, coalesce(e.nome_fantasia, e.razao_social) as loja, e.razao_social, e.cnpj, e.segmento, e.municipio, e.uf,
      e.telefone, e.email, e.status_conta, e.plano, e.teste_expira_em, e.created_at, e.slug,
      private.conta_liberada(e.id) as bloqueio,
      (select count(*) from public.perfis p where p.empresa_id = e.id and p.ativo) as usuarios,
      (select max(v.created_at) from public.vendas v where v.empresa_id = e.id) as ultima_venda,
      (select count(*) from public.vendas v where v.empresa_id = e.id and v.status = 'finalizada'
         and v.created_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') as vendas_hoje,
      (select count(*) from public.caixa_sessoes c where c.empresa_id = e.id and c.status = 'aberto') as caixas_abertos,
      (select count(*) from public.diagnostico_eventos d where d.empresa_id = e.id and d.recebido_em > now() - interval '24 hours'
         and d.gravidade in ('critica', 'alta')) as erros_24h,
      (select max(d.ultimo_uso) from public.dispositivos d where d.empresa_id = e.id) as ultimo_acesso,
      (select coalesce(sum(d.suspeitas), 0) from public.dispositivos d where d.empresa_id = e.id and d.status = 'ativo') as suspeitas,
      (select count(*) from public.suporte_chamados r where r.empresa_id = e.id and r.status = 'aguardando' and r.expira_em > now()) as pedidos_ajuda,
      greatest((select max(v.created_at) from public.vendas v where v.empresa_id = e.id),
               (select max(d.ultimo_uso) from public.dispositivos d where d.empresa_id = e.id)) as ultima_atividade
    from public.empresas e
    where v_b is null
       or lower(coalesce(e.nome_fantasia, '') || ' ' || e.razao_social || ' ' || coalesce(e.municipio, '') || ' ' || coalesce(e.slug, '')) like '%' || v_b || '%'
       or regexp_replace(coalesce(e.cnpj, ''), '\D', '', 'g') like '%' || regexp_replace(v_b, '\D', '', 'g') || '%' and length(regexp_replace(v_b, '\D', '', 'g')) >= 4
       or regexp_replace(coalesce(e.telefone, ''), '\D', '', 'g') like '%' || regexp_replace(v_b, '\D', '', 'g') || '%' and length(regexp_replace(v_b, '\D', '', 'g')) >= 4
    limit 300) x), '[]'::jsonb);
end $$;

/** Entra numa loja como administrador (leitura ou total) por um tempo limitado. */
create or replace function public.suporte_entrar(p_empresa uuid, p_modo text default 'leitura', p_motivo text default null,
  p_minutos int default 60, p_chamado uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.suporte_acessos; v_min int := greatest(5, least(coalesce(p_minutos, 60), 480));
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  if p_modo not in ('leitura', 'total') then raise exception 'Modo inválido'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Escreva o motivo do acesso (fica registrado para a loja)'; end if;
  if not exists (select 1 from public.empresas where id = p_empresa) then raise exception 'Loja não encontrada'; end if;
  -- Fecha a sessão anterior (inclusive vencida)
  for s in select * from public.suporte_acessos where usuario_id = (select auth.uid()) and encerrado_em is null loop
    update public.suporte_acessos set encerrado_em = least(now(), expira_em), encerrado_motivo = 'troca de loja' where id = s.id;
    insert into public.auditoria(empresa_id, usuario_id, acao, entidade, entidade_id, detalhes)
    values (s.empresa_id, (select auth.uid()), 'suporte.saiu', 'suporte_acessos', s.id::text, jsonb_build_object('por', private.nome_equipe(), 'motivo', 'troca de loja'));
  end loop;
  insert into public.suporte_acessos(usuario_id, empresa_id, modo, motivo, chamado_id, expira_em, ip)
  values ((select auth.uid()), p_empresa, p_modo, left(trim(p_motivo), 300), p_chamado, now() + make_interval(mins => v_min), private.ip_requisicao())
  returning * into s;
  insert into public.auditoria(empresa_id, usuario_id, acao, entidade, entidade_id, detalhes)
  values (p_empresa, (select auth.uid()), 'suporte.entrou', 'suporte_acessos', s.id::text,
    jsonb_build_object('por', private.nome_equipe(), 'modo', p_modo, 'motivo', s.motivo, 'ate', s.expira_em, 'via_suporte', true));
  perform private.log_super('suporte.entrar', p_empresa, jsonb_build_object('modo', p_modo, 'motivo', s.motivo, 'minutos', v_min, 'chamado', p_chamado));
  return private.json_sessao(s);
end $$;

create or replace function public.suporte_modo(p_modo text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.suporte_acessos;
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  if p_modo not in ('leitura', 'total') then raise exception 'Modo inválido'; end if;
  update public.suporte_acessos set modo = p_modo
   where usuario_id = (select auth.uid()) and encerrado_em is null and expira_em > now() returning * into s;
  if s.id is null then raise exception 'Nenhum acesso de suporte aberto'; end if;
  insert into public.auditoria(empresa_id, usuario_id, acao, entidade, entidade_id, detalhes)
  values (s.empresa_id, (select auth.uid()), 'suporte.modo', 'suporte_acessos', s.id::text, jsonb_build_object('por', private.nome_equipe(), 'modo', p_modo, 'via_suporte', true));
  perform private.log_super('suporte.modo', s.empresa_id, jsonb_build_object('modo', p_modo));
  return private.json_sessao(s);
end $$;

create or replace function public.suporte_estender(p_minutos int default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.suporte_acessos;
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  update public.suporte_acessos set expira_em = greatest(expira_em, now()) + make_interval(mins => greatest(5, least(coalesce(p_minutos, 30), 240)))
   where usuario_id = (select auth.uid()) and encerrado_em is null and expira_em > now() returning * into s;
  if s.id is null then raise exception 'Nenhum acesso de suporte aberto'; end if;
  if s.expira_em > s.inicio + interval '12 hours' then
    update public.suporte_acessos set expira_em = inicio + interval '12 hours' where id = s.id returning * into s;
  end if;
  perform private.log_super('suporte.estender', s.empresa_id, jsonb_build_object('ate', s.expira_em));
  return private.json_sessao(s);
end $$;

create or replace function public.suporte_sair()
returns void language plpgsql security definer set search_path = '' as $$
declare s public.suporte_acessos;
begin
  for s in select * from public.suporte_acessos where usuario_id = (select auth.uid()) and encerrado_em is null loop
    update public.suporte_acessos set encerrado_em = least(now(), expira_em), encerrado_motivo = case when expira_em <= now() then 'tempo esgotado' else 'saiu' end where id = s.id;
    insert into public.auditoria(empresa_id, usuario_id, acao, entidade, entidade_id, detalhes)
    values (s.empresa_id, (select auth.uid()), 'suporte.saiu', 'suporte_acessos', s.id::text,
      jsonb_build_object('por', private.nome_equipe(), 'minutos', round(extract(epoch from (least(now(), s.expira_em) - s.inicio)) / 60), 'via_suporte', true));
    perform private.log_super('suporte.sair', s.empresa_id, jsonb_build_object('sessao', s.id));
  end loop;
end $$;

/** Histórico de acessos às lojas: o superusuário vê todos; o suporte vê os seus. */
create or replace function public.suporte_sessoes(p_dias int default 30, p_empresa uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_super boolean := private.eh_admin_plataforma();
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  return coalesce((select jsonb_agg(x order by x.inicio desc) from (
    select s.id, s.empresa_id, coalesce(e.nome_fantasia, e.razao_social) as loja, s.modo, s.motivo, s.inicio, s.expira_em,
      s.encerrado_em, s.encerrado_motivo, s.ip, u.email,
      coalesce((select a.nome from public.plataforma_admins a where lower(a.email) = lower(u.email)), u.email) as quem,
      (s.encerrado_em is null and s.expira_em > now()) as aberta
    from public.suporte_acessos s
    join public.empresas e on e.id = s.empresa_id
    left join auth.users u on u.id = s.usuario_id
    where s.inicio > now() - make_interval(days => greatest(1, least(coalesce(p_dias, 30), 365)))
      and (v_super or s.usuario_id = (select auth.uid()))
      and (p_empresa is null or s.empresa_id = p_empresa)
    limit 500) x), '[]'::jsonb);
end $$;

/** Registro do superusuário. */
create or replace function public.super_log(p_limite int default 300, p_empresa uuid default null, p_busca text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_super boolean := private.eh_admin_plataforma();
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  return coalesce((select jsonb_agg(x order by x.criado_em desc) from (
    select l.id, l.criado_em, l.nome, l.email, l.acao, l.empresa_id, l.loja, l.detalhes, l.ip
    from public.superusuario_log l
    where (v_super or l.usuario_id = (select auth.uid()))
      and (p_empresa is null or l.empresa_id = p_empresa)
      and (p_busca is null or (l.acao || ' ' || coalesce(l.loja, '') || ' ' || coalesce(l.nome, '') || ' ' || l.detalhes::text) ilike '%' || p_busca || '%')
    order by l.criado_em desc
    limit greatest(1, least(coalesce(p_limite, 300), 2000))) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- Chamados de ajuda (código de 6 números)
--   O cliente toca em "Pedir ajuda" (até na tela de login), descreve o
--   problema e recebe um código. A equipe vê o chamado na hora (Realtime),
--   atende pelo código e, com um clique, entra na loja em modo suporte.
-- ---------------------------------------------------------------------
create table if not exists public.suporte_chamados (
  id uuid primary key default gen_random_uuid(),
  codigo text not null,
  segredo text not null,               -- só o aparelho que abriu o chamado conhece (consulta e cancela)
  empresa_id uuid references public.empresas(id) on delete set null,
  usuario_id uuid,
  usuario_nome text,
  loja_nome text,
  contato text,
  mensagem text,
  app text,                            -- pdv | garcom
  info jsonb not null default '{}'::jsonb,
  status text not null default 'aguardando' check (status in ('aguardando', 'em_atendimento', 'resolvido', 'cancelado', 'expirado')),
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '2 hours',
  atendido_por uuid,
  atendido_nome text,
  atendido_em timestamptz,
  resolvido_em timestamptz,
  nota text,
  ip text
);
create unique index if not exists suporte_chamados_codigo_uk on public.suporte_chamados(codigo) where status in ('aguardando', 'em_atendimento');
create index if not exists suporte_chamados_idx on public.suporte_chamados(criado_em desc);
create index if not exists suporte_chamados_ip_idx on public.suporte_chamados(ip, criado_em);
alter table public.suporte_chamados enable row level security;
revoke all on public.suporte_chamados from anon, authenticated;
grant select on public.suporte_chamados to authenticated;
drop policy if exists suporte_chamados_equipe on public.suporte_chamados;
create policy suporte_chamados_equipe on public.suporte_chamados for select to authenticated using ((select private.eh_equipe()));

-- Tempo real: a equipe é avisada na hora quando alguém pede ajuda
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'suporte_chamados') then
    alter publication supabase_realtime add table public.suporte_chamados;
  end if;
end $$;

/** Abre um chamado. Funciona logado ou não (tela de login). */
create or replace function public.chamado_abrir(p_app text default 'pdv', p_mensagem text default null, p_contato text default null, p_info jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := private.ip_requisicao();
  v_emp uuid := private.empresa_id();
  v_cod text; r public.suporte_chamados; i int := 0;
begin
  update public.suporte_chamados set status = 'expirado' where status = 'aguardando' and expira_em < now();
  if v_ip is not null and (select count(*) from public.suporte_chamados where ip = v_ip and criado_em > now() - interval '1 hour') >= 10 then
    raise exception 'Muitos pedidos de ajuda seguidos. Aguarde alguns minutos ou chame o suporte pelo WhatsApp.';
  end if;
  if (select auth.uid()) is not null and (select count(*) from public.suporte_chamados where usuario_id = (select auth.uid()) and criado_em > now() - interval '1 hour') >= 10 then
    raise exception 'Muitos pedidos de ajuda seguidos. Aguarde alguns minutos.';
  end if;
  loop
    v_cod := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.suporte_chamados where codigo = v_cod and status in ('aguardando', 'em_atendimento'));
    i := i + 1; if i > 30 then raise exception 'Tente de novo'; end if;
  end loop;
  insert into public.suporte_chamados(codigo, segredo, empresa_id, usuario_id, usuario_nome, loja_nome, contato, mensagem, app, info, ip)
  values (v_cod, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), v_emp, (select auth.uid()),
    (select p.nome from public.perfis p where p.id = (select auth.uid())),
    (select coalesce(e.nome_fantasia, e.razao_social) from public.empresas e where e.id = v_emp),
    left(nullif(trim(coalesce(p_contato, '')), ''), 120), left(nullif(trim(coalesce(p_mensagem, '')), ''), 1000),
    case when p_app in ('pdv', 'garcom') then p_app else 'pdv' end,
    case when octet_length(coalesce(p_info, '{}'::jsonb)::text) <= 4000 then coalesce(p_info, '{}'::jsonb) else '{}'::jsonb end,
    v_ip)
  returning * into r;
  return jsonb_build_object('id', r.id, 'codigo', r.codigo, 'segredo', r.segredo, 'expira_em', r.expira_em);
end $$;

/** Situação do chamado (o aparelho que abriu confere se já foi atendido). */
create or replace function public.chamado_estado(p_id uuid, p_segredo text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', case when r.status = 'aguardando' and r.expira_em < now() then 'expirado' else r.status end,
    'atendido_nome', r.atendido_nome, 'nota', r.nota)
  from public.suporte_chamados r where r.id = p_id and r.segredo = p_segredo
$$;

create or replace function public.chamado_cancelar(p_id uuid, p_segredo text)
returns void language sql security definer set search_path = '' as $$
  update public.suporte_chamados set status = 'cancelado'
  where id = p_id and segredo = p_segredo and status in ('aguardando', 'em_atendimento')
$$;

/** Fila de chamados da equipe. */
create or replace function public.chamado_fila(p_horas int default 24)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  return coalesce((select jsonb_agg(x order by (x.status = 'aguardando') desc, x.criado_em desc) from (
    select r.id, r.codigo, r.empresa_id, coalesce(r.loja_nome, 'Sem login') as loja, r.usuario_nome, r.contato, r.mensagem, r.app, r.info,
      case when r.status = 'aguardando' and r.expira_em < now() then 'expirado' else r.status end as status,
      r.criado_em, r.expira_em, r.atendido_nome, r.atendido_em, r.resolvido_em, r.nota, r.ip
    from public.suporte_chamados r
    where r.criado_em > now() - make_interval(hours => greatest(1, least(coalesce(p_horas, 24), 720)))
    limit 200) x), '[]'::jsonb);
end $$;

/** A equipe assume um chamado (pelo id ou pelo código que o cliente falou). */
create or replace function public.chamado_atender(p_id uuid default null, p_codigo text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.suporte_chamados;
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  if p_id is not null then
    select * into r from public.suporte_chamados where id = p_id;
  else
    select * into r from public.suporte_chamados where codigo = regexp_replace(coalesce(p_codigo, ''), '\D', '', 'g')
      and status in ('aguardando', 'em_atendimento') order by criado_em desc limit 1;
  end if;
  if r.id is null then raise exception 'Código não encontrado. Confira os 6 números com o cliente.'; end if;
  if r.status in ('resolvido', 'cancelado', 'expirado') or (r.status = 'aguardando' and r.expira_em < now()) then
    raise exception 'Este chamado já terminou. Peça ao cliente para gerar um código novo.';
  end if;
  update public.suporte_chamados set status = 'em_atendimento', atendido_por = (select auth.uid()), atendido_nome = private.nome_equipe(),
    atendido_em = coalesce(atendido_em, now()), expira_em = greatest(expira_em, now() + interval '8 hours')
   where id = r.id returning * into r;
  perform private.log_super('chamado.atender', r.empresa_id, jsonb_build_object('codigo', r.codigo, 'usuario', r.usuario_nome, 'chamado', r.id));
  return jsonb_build_object('id', r.id, 'codigo', r.codigo, 'empresa_id', r.empresa_id, 'loja', coalesce(r.loja_nome, 'Sem login'),
    'usuario_nome', r.usuario_nome, 'contato', r.contato, 'mensagem', r.mensagem, 'app', r.app, 'info', r.info, 'atendido_nome', r.atendido_nome);
end $$;

/** Encerra o chamado com uma anotação do que foi feito. */
create or replace function public.chamado_resolver(p_id uuid, p_nota text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.suporte_chamados;
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  update public.suporte_chamados set status = 'resolvido', resolvido_em = now(), nota = left(nullif(trim(coalesce(p_nota, '')), ''), 1000),
    atendido_por = coalesce(atendido_por, (select auth.uid())), atendido_nome = coalesce(atendido_nome, private.nome_equipe())
   where id = p_id returning * into r;
  if r.id is null then raise exception 'Chamado não encontrado'; end if;
  perform private.log_super('chamado.resolver', r.empresa_id, jsonb_build_object('codigo', r.codigo, 'nota', r.nota, 'chamado', r.id));
end $$;

-- ---------------------------------------------------------------------
-- Avisos da plataforma para as lojas
-- ---------------------------------------------------------------------
create table if not exists public.avisos_plataforma (
  id uuid primary key default gen_random_uuid(),
  titulo text not null check (length(titulo) between 2 and 120),
  mensagem text not null check (length(mensagem) between 2 and 1500),
  tipo text not null default 'info' check (tipo in ('info', 'novidade', 'alerta', 'manutencao')),
  empresa_id uuid references public.empresas(id) on delete cascade,   -- null = todas as lojas
  segmento text,                                                     -- null = todos os setores
  papeis text[],                                                     -- null = todos os níveis
  link text,
  inicio timestamptz not null default now(),
  fim timestamptz,
  fixo boolean not null default false,                               -- não pode ser dispensado
  ativo boolean not null default true,
  criado_por uuid,
  criado_em timestamptz not null default now()
);
create index if not exists avisos_plataforma_idx on public.avisos_plataforma(ativo, inicio);
alter table public.avisos_plataforma enable row level security;
revoke all on public.avisos_plataforma from anon, authenticated;

create or replace function public.avisos_ativos()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'titulo', a.titulo, 'mensagem', a.mensagem, 'tipo', a.tipo,
      'link', a.link, 'fixo', a.fixo, 'inicio', a.inicio, 'fim', a.fim) order by a.inicio desc), '[]'::jsonb)
  from public.avisos_plataforma a
  where a.ativo and a.inicio <= now() and (a.fim is null or a.fim > now())
    and (a.empresa_id is null or a.empresa_id = private.empresa_id())
    and (a.segmento is null or a.segmento = (select e.segmento from public.empresas e where e.id = private.empresa_id()))
    and (a.papeis is null or private.papel()::text = any(a.papeis))
$$;

create or replace function public.avisos_listar()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Só o superusuário'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'titulo', a.titulo, 'mensagem', a.mensagem, 'tipo', a.tipo,
      'empresa_id', a.empresa_id, 'loja', coalesce(e.nome_fantasia, e.razao_social), 'segmento', a.segmento, 'papeis', a.papeis,
      'link', a.link, 'inicio', a.inicio, 'fim', a.fim, 'fixo', a.fixo, 'ativo', a.ativo, 'criado_em', a.criado_em,
      'no_ar', a.ativo and a.inicio <= now() and (a.fim is null or a.fim > now())) order by a.criado_em desc)
    from public.avisos_plataforma a left join public.empresas e on e.id = a.empresa_id), '[]'::jsonb);
end $$;

create or replace function public.aviso_salvar(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_papeis text[];
begin
  if not private.eh_admin_plataforma() then raise exception 'Só o superusuário'; end if;
  if jsonb_typeof(p->'papeis') = 'array' and jsonb_array_length(p->'papeis') > 0 then
    select array_agg(x) into v_papeis from jsonb_array_elements_text(p->'papeis') x where x in ('admin', 'gerente', 'caixa', 'atendente', 'cozinha');
  end if;
  if coalesce(p->>'link', '') <> '' and p->>'link' !~ '^https://' then raise exception 'O link precisa começar com https://'; end if;
  if v_id is null then
    insert into public.avisos_plataforma(titulo, mensagem, tipo, empresa_id, segmento, papeis, link, inicio, fim, fixo, ativo, criado_por)
    values (trim(p->>'titulo'), trim(p->>'mensagem'), coalesce(nullif(p->>'tipo', ''), 'info'), nullif(p->>'empresa_id', '')::uuid,
      nullif(p->>'segmento', ''), v_papeis, nullif(p->>'link', ''), coalesce(nullif(p->>'inicio', '')::timestamptz, now()),
      nullif(p->>'fim', '')::timestamptz, coalesce((p->>'fixo')::boolean, false), coalesce((p->>'ativo')::boolean, true), (select auth.uid()))
    returning id into v_id;
  else
    update public.avisos_plataforma set titulo = trim(p->>'titulo'), mensagem = trim(p->>'mensagem'), tipo = coalesce(nullif(p->>'tipo', ''), 'info'),
      empresa_id = nullif(p->>'empresa_id', '')::uuid, segmento = nullif(p->>'segmento', ''), papeis = v_papeis, link = nullif(p->>'link', ''),
      inicio = coalesce(nullif(p->>'inicio', '')::timestamptz, inicio), fim = nullif(p->>'fim', '')::timestamptz,
      fixo = coalesce((p->>'fixo')::boolean, false), ativo = coalesce((p->>'ativo')::boolean, true)
    where id = v_id;
    if not found then raise exception 'Aviso não encontrado'; end if;
  end if;
  perform private.log_super('aviso.salvar', nullif(p->>'empresa_id', '')::uuid, jsonb_build_object('aviso', v_id, 'titulo', p->>'titulo', 'tipo', p->>'tipo'));
  return v_id;
end $$;

create or replace function public.aviso_excluir(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.avisos_plataforma;
begin
  if not private.eh_admin_plataforma() then raise exception 'Só o superusuário'; end if;
  delete from public.avisos_plataforma where id = p_id returning * into a;
  perform private.log_super('aviso.excluir', a.empresa_id, jsonb_build_object('titulo', a.titulo));
end $$;

-- ---------------------------------------------------------------------
-- Equipe de suporte (só o superusuário gerencia)
-- ---------------------------------------------------------------------
create or replace function public.equipe_listar()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Só o superusuário'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('email', a.email, 'nome', a.nome, 'nivel', a.nivel, 'ativo', a.ativo,
      'criado_em', a.created_at, 'criado_por', a.criado_por,
      'tem_conta', u.id is not null, 'confirmado', u.email_confirmed_at is not null, 'ultimo_login', u.last_sign_in_at,
      'eu', u.id = (select auth.uid()),
      'em_loja', (select coalesce(e.nome_fantasia, e.razao_social) from public.suporte_acessos s join public.empresas e on e.id = s.empresa_id
                  where s.usuario_id = u.id and s.encerrado_em is null and s.expira_em > now()),
      'acessos_30d', (select count(*) from public.suporte_acessos s where s.usuario_id = u.id and s.inicio > now() - interval '30 days'))
      order by a.nivel desc, a.nome nulls last, a.email)
    from public.plataforma_admins a left join auth.users u on lower(u.email) = lower(a.email)), '[]'::jsonb);
end $$;

create or replace function private.fechar_sessoes_de(p_email text, p_motivo text)
returns void language sql security definer set search_path = '' as $$
  update public.suporte_acessos s set encerrado_em = least(now(), s.expira_em), encerrado_motivo = p_motivo
  from auth.users u where u.id = s.usuario_id and lower(u.email) = lower(p_email) and s.encerrado_em is null
$$;

create or replace function public.equipe_salvar(p_email text, p_nome text, p_nivel text default 'suporte', p_ativo boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not private.eh_admin_plataforma() then raise exception 'Só o superusuário'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'E-mail inválido'; end if;
  if p_nivel not in ('super', 'suporte') then raise exception 'Nível inválido'; end if;
  insert into public.plataforma_admins(email, nome, nivel, ativo, criado_por)
  values (v_email, nullif(trim(p_nome), ''), p_nivel, coalesce(p_ativo, true), (select u.email from auth.users u where u.id = (select auth.uid())))
  on conflict (email) do update set nome = excluded.nome, nivel = excluded.nivel, ativo = excluded.ativo;
  if not exists (select 1 from public.plataforma_admins where nivel = 'super' and ativo) then
    raise exception 'Precisa existir ao menos um superusuário ativo';
  end if;
  if not coalesce(p_ativo, true) then perform private.fechar_sessoes_de(v_email, 'acesso da equipe desativado'); end if;
  perform private.log_super('equipe.salvar', null, jsonb_build_object('email', v_email, 'nivel', p_nivel, 'ativo', p_ativo));
end $$;

create or replace function public.equipe_remover(p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Só o superusuário'; end if;
  delete from public.plataforma_admins where lower(email) = lower(trim(p_email));
  if not exists (select 1 from public.plataforma_admins where nivel = 'super' and ativo) then
    raise exception 'Precisa existir ao menos um superusuário ativo';
  end if;
  perform private.fechar_sessoes_de(p_email, 'removido da equipe');
  perform private.log_super('equipe.remover', null, jsonb_build_object('email', lower(trim(p_email))));
end $$;

-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------
revoke execute on function public.suporte_eu(), public.suporte_lojas(text), public.suporte_entrar(uuid, text, text, int, uuid),
  public.suporte_modo(text), public.suporte_estender(int), public.suporte_sair(), public.suporte_sessoes(int, uuid),
  public.super_log(int, uuid, text), public.chamado_fila(int), public.chamado_atender(uuid, text), public.chamado_resolver(uuid, text),
  public.avisos_ativos(), public.avisos_listar(), public.aviso_salvar(jsonb), public.aviso_excluir(uuid),
  public.equipe_listar(), public.equipe_salvar(text, text, text, boolean), public.equipe_remover(text),
  public.chamado_abrir(text, text, text, jsonb), public.chamado_estado(uuid, text), public.chamado_cancelar(uuid, text) from public, anon;
grant execute on function public.suporte_eu(), public.suporte_lojas(text), public.suporte_entrar(uuid, text, text, int, uuid),
  public.suporte_modo(text), public.suporte_estender(int), public.suporte_sair(), public.suporte_sessoes(int, uuid),
  public.super_log(int, uuid, text), public.chamado_fila(int), public.chamado_atender(uuid, text), public.chamado_resolver(uuid, text),
  public.avisos_ativos(), public.avisos_listar(), public.aviso_salvar(jsonb), public.aviso_excluir(uuid),
  public.equipe_listar(), public.equipe_salvar(text, text, text, boolean), public.equipe_remover(text),
  public.chamado_abrir(text, text, text, jsonb), public.chamado_estado(uuid, text), public.chamado_cancelar(uuid, text) to authenticated;
-- Pedir ajuda funciona até na tela de login
grant execute on function public.chamado_abrir(text, text, text, jsonb), public.chamado_estado(uuid, text), public.chamado_cancelar(uuid, text) to anon;
revoke execute on function private.log_super(text, uuid, jsonb), private.fechar_sessoes_de(text, text), private.json_sessao(public.suporte_acessos) from public, anon, authenticated;

notify pgrst, 'reload schema';
