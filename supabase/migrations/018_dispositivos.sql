-- =====================================================================
-- 018 · Acesso vinculado ao aparelho
--   Cada usuário só usa o sistema nos aparelhos liberados para ele.
--   - Limite por nível (padrão): administrador 2, gerente 2, caixa 1, cozinha 1,
--     atendente/garçom livre (0 = sem limite). Só o fornecedor muda os limites.
--   - O primeiro acesso num aparelho vincula sozinho (enquanto houver vaga).
--     Sem vaga, o aparelho é recusado e a tentativa fica registrada.
--   - A loja pode trocar aparelhos (desvincular um para liberar a vaga) até
--     3 vezes em 30 dias; depois disso só o fornecedor.
--   - O aparelho recebe uma chave secreta; o servidor guarda só o hash.
--     Toda venda, abertura/fechamento de caixa e movimento de caixa confere
--     a chave enviada nos cabeçalhos x-lis-aparelho / x-lis-token (gatilhos).
--   - Uso da mesma chave em dois lugares ao mesmo tempo (IPs diferentes em
--     menos de 2 minutos) e "impressão" do navegador diferente ficam marcados
--     como suspeitos para o fornecedor ver.
-- Pode rodar mais de uma vez.
-- =====================================================================

alter table public.empresas add column if not exists config_dispositivos jsonb not null default '{}'::jsonb;

create table if not exists public.dispositivos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  usuario_id uuid not null references public.perfis(id) on delete cascade,
  aparelho text not null,             -- código aleatório gerado no navegador (assets/dispositivo.js)
  nome text not null,
  token_hash text not null,
  impressao text,                     -- resumo das características do navegador/tela
  info jsonb not null default '{}'::jsonb,
  status text not null default 'ativo' check (status in ('ativo', 'revogado')),
  criado_em timestamptz not null default now(),
  ultimo_uso timestamptz,
  ultimo_ip text,
  suspeitas int not null default 0,
  revogado_em timestamptz,
  revogado_por uuid,
  revogado_pela_plataforma boolean not null default false,
  motivo text
);
create unique index if not exists dispositivos_ativo_uk on public.dispositivos(usuario_id, aparelho) where status = 'ativo';
create index if not exists dispositivos_emp_idx on public.dispositivos(empresa_id, status);

create table if not exists public.dispositivos_eventos (
  id bigint generated always as identity primary key,
  empresa_id uuid references public.empresas(id) on delete cascade,
  usuario_id uuid,
  aparelho text,
  aparelho_nome text,
  tipo text not null,   -- vinculado | recusado | conflito | chave_renovada | desvinculado | renomeado | uso_simultaneo | outro_navegador | config
  detalhes jsonb not null default '{}'::jsonb,
  ip text,
  criado_em timestamptz not null default now()
);
create index if not exists dispositivos_eventos_emp_idx on public.dispositivos_eventos(empresa_id, criado_em desc);

alter table public.dispositivos enable row level security;
alter table public.dispositivos_eventos enable row level security;
revoke all on public.dispositivos, public.dispositivos_eventos from anon, authenticated;
-- Acesso só pelas funções abaixo.

-- ---------- Auxiliares ----------
create or replace function private.cfg_dispositivos(p_emp uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ativo', true, 'trocas_mes', 3,
           'limites', jsonb_build_object('admin', 2, 'gerente', 2, 'caixa', 1, 'cozinha', 1, 'atendente', 0))
         || coalesce((select e.config_dispositivos - 'limites' from public.empresas e where e.id = p_emp), '{}'::jsonb)
         || jsonb_build_object('limites',
              jsonb_build_object('admin', 2, 'gerente', 2, 'caixa', 1, 'cozinha', 1, 'atendente', 0)
              || coalesce((select e.config_dispositivos->'limites' from public.empresas e where e.id = p_emp), '{}'::jsonb))
$$;

/** 0 = sem limite (não vincula). */
create or replace function private.limite_dispositivos(p_emp uuid, p_papel text)
returns int language sql stable security definer set search_path = '' as $$
  select case when coalesce((c->>'ativo')::boolean, true) then coalesce((c->'limites'->>p_papel)::int, 1) else 0 end
  from (select private.cfg_dispositivos(p_emp) as c) x
$$;

create or replace function private.cabecalho(p_nome text)
returns text language sql stable set search_path = '' as $$
  select nullif(current_setting('request.headers', true), '')::json ->> p_nome
$$;

create or replace function private.ip_requisicao()
returns text language sql stable set search_path = '' as $$
  select left(trim(split_part(coalesce(private.cabecalho('x-forwarded-for'), private.cabecalho('x-real-ip'), ''), ',', 1)), 60)
$$;

create or replace function private.hash_chave(p text)
returns text language sql immutable set search_path = '' as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

create or replace function private.evento_dispositivo(p_emp uuid, p_uid uuid, p_ap text, p_nome text, p_tipo text, p_det jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Não repete o mesmo aviso do mesmo aparelho em menos de 10 minutos
  if p_tipo in ('recusado', 'conflito', 'uso_simultaneo', 'outro_navegador') and exists (
    select 1 from public.dispositivos_eventos where usuario_id = p_uid and aparelho is not distinct from p_ap
      and tipo = p_tipo and criado_em > now() - interval '10 minutes') then
    return;
  end if;
  insert into public.dispositivos_eventos(empresa_id, usuario_id, aparelho, aparelho_nome, tipo, detalhes, ip)
  values (p_emp, p_uid, left(p_ap, 80), left(p_nome, 80), p_tipo, coalesce(p_det, '{}'::jsonb), private.ip_requisicao());
end $$;

-- ---------- Verificação ao entrar no sistema ----------
/**
 * Chamada pelo sistema logo depois do login.
 * status: livre | liberado | vinculado (token novo) | limite | conflito
 */
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
    -- Mesmo código de aparelho com chave errada: se o navegador é o mesmo (chave apagada), renova;
    -- se não, alguém copiou o código para outro aparelho.
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

-- ---------- Conferência em toda venda e movimento de caixa ----------
create or replace function private.trg_exigir_dispositivo()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_perfil record;
  d public.dispositivos;
  v_ap text; v_ip text;
begin
  if v_uid is null then return coalesce(new, old); end if;                         -- servidor, cron, cardápio público
  if nullif(current_setting('request.headers', true), '') is null then return coalesce(new, old); end if; -- chamada interna
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

drop trigger if exists t_dispositivo_vendas on public.vendas;
create trigger t_dispositivo_vendas before insert on public.vendas
  for each row execute function private.trg_exigir_dispositivo();
drop trigger if exists t_dispositivo_caixa on public.caixa_sessoes;
create trigger t_dispositivo_caixa before insert or update on public.caixa_sessoes
  for each row execute function private.trg_exigir_dispositivo();
drop trigger if exists t_dispositivo_movimentos on public.caixa_movimentos;
create trigger t_dispositivo_movimentos before insert on public.caixa_movimentos
  for each row execute function private.trg_exigir_dispositivo();

-- ---------- Gestão (loja e fornecedor) ----------
create or replace function private.pode_gerir_dispositivos(p_emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.eh_admin_plataforma() or (p_emp = private.empresa_id() and private.tem_papel('{admin,gerente}'))
$$;

/** Aparelhos da loja por usuário, limites, trocas e últimos avisos. */
create or replace function public.dispositivos_listar(p_empresa uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_emp uuid := case when private.eh_admin_plataforma() and p_empresa is not null then p_empresa else private.empresa_id() end;
  v_cfg jsonb;
begin
  if v_emp is null or not private.pode_gerir_dispositivos(v_emp) then raise exception 'Acesso restrito'; end if;
  v_cfg := private.cfg_dispositivos(v_emp);
  return jsonb_build_object(
    'config', v_cfg,
    'plataforma', private.eh_admin_plataforma(),
    'trocas', (select count(*) from public.dispositivos where empresa_id = v_emp and status = 'revogado'
               and not revogado_pela_plataforma and revogado_em > now() - interval '30 days'),
    'usuarios', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'nome', p.nome, 'papel', p.papel, 'ativo', p.ativo,
        'limite', private.limite_dispositivos(v_emp, p.papel::text),
        'aparelhos', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'nome', d.nome, 'aparelho', left(d.aparelho, 6),
            'criado_em', d.criado_em, 'ultimo_uso', d.ultimo_uso, 'ultimo_ip', d.ultimo_ip, 'suspeitas', d.suspeitas, 'info', d.info)
            order by d.ultimo_uso desc nulls last) from public.dispositivos d where d.usuario_id = p.id and d.status = 'ativo'), '[]'::jsonb))
        order by p.ativo desc, p.nome) from public.perfis p where p.empresa_id = v_emp), '[]'::jsonb),
    'eventos', coalesce((select jsonb_agg(x order by x.criado_em desc) from (
        select e.tipo, e.criado_em, e.aparelho_nome, left(e.aparelho, 6) as aparelho, e.ip, e.detalhes, p.nome as usuario
        from public.dispositivos_eventos e left join public.perfis p on p.id = e.usuario_id
        where e.empresa_id = v_emp order by e.criado_em desc limit 60) x), '[]'::jsonb));
end $$;

/** Tira um aparelho do usuário (libera a vaga). A loja tem um limite de trocas por mês. */
create or replace function public.dispositivo_desvincular(p_id uuid, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d public.dispositivos;
  v_plat boolean := private.eh_admin_plataforma();
  v_trocas int; v_max int;
begin
  select * into d from public.dispositivos where id = p_id and status = 'ativo';
  if not found then raise exception 'Aparelho não encontrado'; end if;
  if not private.pode_gerir_dispositivos(d.empresa_id) then raise exception 'Acesso restrito'; end if;
  if not v_plat then
    v_max := coalesce((private.cfg_dispositivos(d.empresa_id)->>'trocas_mes')::int, 3);
    select count(*) into v_trocas from public.dispositivos where empresa_id = d.empresa_id and status = 'revogado'
      and not revogado_pela_plataforma and revogado_em > now() - interval '30 days';
    if v_trocas >= v_max then
      raise exception 'Limite de % trocas de aparelho em 30 dias atingido. Fale com o suporte para liberar.', v_max;
    end if;
  end if;
  update public.dispositivos set status = 'revogado', revogado_em = now(), revogado_por = (select auth.uid()),
    revogado_pela_plataforma = v_plat, motivo = left(p_motivo, 200) where id = d.id;
  perform private.evento_dispositivo(d.empresa_id, d.usuario_id, d.aparelho, d.nome, 'desvinculado',
    jsonb_build_object('por', (select nome from public.perfis where id = (select auth.uid())), 'plataforma', v_plat, 'motivo', p_motivo));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.dispositivo_renomear(p_id uuid, p_nome text)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.dispositivos;
begin
  select * into d from public.dispositivos where id = p_id and status = 'ativo';
  if not found then raise exception 'Aparelho não encontrado'; end if;
  if not private.pode_gerir_dispositivos(d.empresa_id) then raise exception 'Acesso restrito'; end if;
  if length(trim(coalesce(p_nome, ''))) < 2 then raise exception 'Informe um nome'; end if;
  update public.dispositivos set nome = left(trim(p_nome), 60) where id = p_id;
  perform private.evento_dispositivo(d.empresa_id, d.usuario_id, d.aparelho, left(trim(p_nome), 60), 'renomeado', jsonb_build_object('antes', d.nome));
end $$;

/** Só o fornecedor: liga/desliga o vínculo e define limites e trocas da loja. */
create or replace function public.plataforma_config_dispositivos(p_empresa uuid, p_config jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := '{}'::jsonb; k text;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if p_config ? 'ativo' then v := v || jsonb_build_object('ativo', (p_config->>'ativo')::boolean); end if;
  if p_config ? 'trocas_mes' then v := v || jsonb_build_object('trocas_mes', greatest(0, least((p_config->>'trocas_mes')::int, 50))); end if;
  if jsonb_typeof(p_config->'limites') = 'object' then
    v := v || jsonb_build_object('limites', '{}'::jsonb);
    for k in select jsonb_object_keys(p_config->'limites') loop
      if k in ('admin', 'gerente', 'caixa', 'cozinha', 'atendente') then
        v := jsonb_set(v, array['limites', k], to_jsonb(greatest(0, least((p_config->'limites'->>k)::int, 50))));
      end if;
    end loop;
  end if;
  update public.empresas set config_dispositivos = v where id = p_empresa;
  perform private.evento_dispositivo(p_empresa, (select auth.uid()), null, null, 'config', v);
  return private.cfg_dispositivos(p_empresa);
end $$;

revoke execute on function public.dispositivo_verificar(text, text, text, text, jsonb), public.dispositivos_listar(uuid),
  public.dispositivo_desvincular(uuid, text), public.dispositivo_renomear(uuid, text), public.plataforma_config_dispositivos(uuid, jsonb) from public, anon;
grant execute on function public.dispositivo_verificar(text, text, text, text, jsonb), public.dispositivos_listar(uuid),
  public.dispositivo_desvincular(uuid, text), public.dispositivo_renomear(uuid, text), public.plataforma_config_dispositivos(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
