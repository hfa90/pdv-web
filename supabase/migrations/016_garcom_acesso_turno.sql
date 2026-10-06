-- =====================================================================
-- App do garçom: login por matrícula/CPF + senha numérica (6+ dígitos),
-- turno do garçom (o que recebeu, comissão e fechamento conferido) e
-- painel ao vivo dos garçons para o administrador. Depende da 015.
-- =====================================================================
create extension if not exists pgcrypto with schema extensions;

-- ---------- Código da loja (vincula o celular do garçom à loja) ----------
alter table public.empresas add column if not exists codigo_garcom text;
update public.empresas set codigo_garcom = upper(substr(md5(random()::text || id::text), 1, 6)) where codigo_garcom is null;
create unique index if not exists empresas_codigo_garcom_uk on public.empresas(upper(codigo_garcom));

create or replace function private.empresa_codigo_garcom()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.codigo_garcom is null then new.codigo_garcom := upper(substr(md5(random()::text || new.id::text), 1, 6)); end if;
  return new;
end $$;
drop trigger if exists t_codigo_garcom on public.empresas;
create trigger t_codigo_garcom before insert on public.empresas for each row execute function private.empresa_codigo_garcom();

-- ---------- Acesso do garçom (só o servidor lê) ----------
create table if not exists public.garcom_acesso (
  perfil_id uuid primary key references public.perfis(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  matricula text not null check (matricula ~ '^[0-9A-Z]{1,12}$'),
  cpf text check (cpf is null or cpf ~ '^[0-9]{11}$'),
  pin_hash text not null,
  tentativas int not null default 0,
  bloqueado_ate timestamptz,
  ultimo_acesso timestamptz,
  atualizado_em timestamptz not null default now(),
  unique (empresa_id, matricula),
  unique (empresa_id, cpf)
);
alter table public.garcom_acesso enable row level security;   -- sem políticas: só funções do banco
revoke all on public.garcom_acesso from anon, authenticated;

create or replace function private.pin_valido(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p ~ '^[0-9]{6,12}$'
    and p !~ '^(.)\1+$'
    and position(p in '01234567890123456789') = 0
    and position(p in '98765432109876543210') = 0
$$;

create or replace function private.cpf_valido(c text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s int; d1 int; d2 int; i int;
begin
  if c !~ '^[0-9]{11}$' or c ~ '^(.)\1+$' then return false; end if;
  s := 0; for i in 1..9 loop s := s + substr(c, i, 1)::int * (11 - i); end loop;
  d1 := (s * 10) % 11 % 10;
  s := 0; for i in 1..10 loop s := s + substr(c, i, 1)::int * (12 - i); end loop;
  d2 := (s * 10) % 11 % 10;
  return d1 = substr(c, 10, 1)::int and d2 = substr(c, 11, 1)::int;
end $$;

-- Gerente define matrícula, CPF e senha numérica do garçom (p_pin nulo mantém a atual)
create or replace function public.definir_acesso_garcom(p_perfil uuid, p_matricula text, p_cpf text, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); g public.perfis; v_mat text := upper(trim(coalesce(p_matricula, '')));
  v_cpf text := nullif(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), ''); v_existe boolean;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  select * into g from public.perfis where id = p_perfil and empresa_id = v_emp;
  if not found then raise exception 'Usuário não encontrado'; end if;
  if g.papel::text = 'cozinha' then raise exception 'O usuário da cozinha não usa o app do garçom'; end if;
  if v_mat !~ '^[0-9A-Z]{1,12}$' then raise exception 'Matrícula: use de 1 a 12 letras ou números'; end if;
  if v_cpf is not null and not private.cpf_valido(v_cpf) then raise exception 'CPF inválido'; end if;
  select true into v_existe from public.garcom_acesso where perfil_id = g.id;
  if p_pin is not null and not private.pin_valido(p_pin) then
    raise exception 'A senha deve ter de 6 a 12 números e não pode ser sequência (123456) nem repetida (111111)';
  end if;
  if p_pin is null and v_existe is null then raise exception 'Defina a senha numérica do garçom'; end if;
  insert into public.garcom_acesso (perfil_id, empresa_id, matricula, cpf, pin_hash)
  values (g.id, v_emp, v_mat, v_cpf, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (perfil_id) do update set matricula = excluded.matricula, cpf = excluded.cpf,
    pin_hash = case when p_pin is null then public.garcom_acesso.pin_hash else excluded.pin_hash end,
    tentativas = 0, bloqueado_ate = null, atualizado_em = now();
  perform private.auditar(v_emp, 'garcom.acesso', 'perfis', g.id::text,
    jsonb_build_object('garcom', g.nome, 'matricula', v_mat, 'senha_alterada', p_pin is not null));
  return jsonb_build_object('matricula', v_mat, 'cpf', v_cpf);
exception when unique_violation then
  raise exception 'Esta matrícula ou CPF já é de outro usuário da loja';
end $$;

create or replace function public.remover_acesso_garcom(p_perfil uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  delete from public.garcom_acesso where perfil_id = p_perfil and empresa_id = v_emp;
  perform private.auditar(v_emp, 'garcom.acesso_removido', 'perfis', p_perfil::text, '{}'::jsonb);
end $$;

create or replace function public.acessos_garcom()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  return jsonb_build_object(
    'codigo_loja', (select codigo_garcom from public.empresas where id = v_emp),
    'acessos', (select coalesce(jsonb_agg(jsonb_build_object('perfil_id', a.perfil_id, 'matricula', a.matricula, 'cpf', a.cpf,
        'bloqueado', a.bloqueado_ate > now(), 'ultimo_acesso', a.ultimo_acesso)), '[]'::jsonb)
      from public.garcom_acesso a where a.empresa_id = v_emp),
    'proxima_matricula', (select coalesce(max(matricula::int), 0) + 1 from public.garcom_acesso
      where empresa_id = v_emp and matricula ~ '^[0-9]{1,9}$'));
end $$;

create or replace function public.codigo_garcom_loja()
returns text language sql stable security definer set search_path = '' as $$
  select codigo_garcom from public.empresas where id = private.empresa_id()
$$;

-- O próprio garçom troca a senha
create or replace function public.alterar_meu_pin(p_atual text, p_novo text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.garcom_acesso;
begin
  select * into a from public.garcom_acesso where perfil_id = auth.uid();
  if not found then raise exception 'Seu acesso por matrícula ainda não foi criado. Fale com o gerente.'; end if;
  if extensions.crypt(coalesce(p_atual, ''), a.pin_hash) <> a.pin_hash then raise exception 'Senha atual incorreta'; end if;
  if not private.pin_valido(p_novo) then raise exception 'A nova senha deve ter de 6 a 12 números, sem sequência ou repetição'; end if;
  update public.garcom_acesso set pin_hash = extensions.crypt(p_novo, extensions.gen_salt('bf', 8)), atualizado_em = now() where perfil_id = a.perfil_id;
  perform private.auditar(a.empresa_id, 'garcom.senha', 'perfis', a.perfil_id::text, '{}'::jsonb);
end $$;

-- Login (chamado só pela Edge Function garcom-login, com service role).
-- Não lança erro na senha errada para gravar a tentativa: 5 erros bloqueiam por 15 minutos.
create or replace function public.garcom_autenticar(p_codigo text, p_login text, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.empresas; a public.garcom_acesso; g public.perfis; v_login text := upper(regexp_replace(coalesce(p_login, ''), '[^0-9A-Za-z]', '', 'g'));
  v_email text; v_resta int;
begin
  select * into e from public.empresas where upper(codigo_garcom) = upper(trim(coalesce(p_codigo, '')));
  if not found then return jsonb_build_object('ok', false, 'erro', 'Código da loja não encontrado'); end if;
  select * into a from public.garcom_acesso where empresa_id = e.id and (matricula = v_login or (length(v_login) = 11 and cpf = v_login));
  if not found then return jsonb_build_object('ok', false, 'erro', 'Matrícula/CPF ou senha incorretos'); end if;
  if a.bloqueado_ate > now() then
    return jsonb_build_object('ok', false, 'erro', 'Acesso bloqueado por tentativas erradas. Tente em ' || greatest(1, ceil(extract(epoch from a.bloqueado_ate - now()) / 60))::int || ' min ou peça ao gerente para liberar.');
  end if;
  select * into g from public.perfis where id = a.perfil_id;
  if not g.ativo then return jsonb_build_object('ok', false, 'erro', 'Seu acesso foi desativado. Fale com o gerente.'); end if;
  if extensions.crypt(coalesce(p_pin, ''), a.pin_hash) <> a.pin_hash then
    update public.garcom_acesso set tentativas = tentativas + 1,
      bloqueado_ate = case when tentativas + 1 >= 5 then now() + interval '15 minutes' end
    where perfil_id = a.perfil_id returning 5 - tentativas into v_resta;
    if v_resta <= 0 then
      update public.garcom_acesso set tentativas = 0 where perfil_id = a.perfil_id;
      insert into public.auditoria (empresa_id, usuario_id, acao, entidade, entidade_id, detalhes)
      values (e.id, a.perfil_id, 'garcom.bloqueado', 'perfis', a.perfil_id::text, jsonb_build_object('matricula', a.matricula));
      return jsonb_build_object('ok', false, 'erro', 'Senha errada 5 vezes: acesso bloqueado por 15 minutos.');
    end if;
    return jsonb_build_object('ok', false, 'erro', 'Matrícula/CPF ou senha incorretos (' || v_resta || ' tentativa(s) antes de bloquear)');
  end if;
  select email into v_email from auth.users where id = a.perfil_id;
  update public.garcom_acesso set tentativas = 0, bloqueado_ate = null, ultimo_acesso = now() where perfil_id = a.perfil_id;
  return jsonb_build_object('ok', true, 'perfil_id', a.perfil_id, 'email', v_email, 'nome', g.nome);
end $$;

-- =====================================================================
-- Turno do garçom: o que recebeu no app, comissão e conferência
-- =====================================================================
create table if not exists public.garcom_fechamentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  perfil_id uuid not null references public.perfis(id) on delete cascade,
  dia date not null,
  sistema jsonb not null,          -- {pix, debito, credito, total} pelo sistema
  informado jsonb not null,        -- o que o garçom contou (maquininha / app do banco)
  diferenca numeric(12,2) not null,
  observacao text check (observacao is null or length(observacao) <= 300),
  criado_em timestamptz not null default now(),
  unique (perfil_id, dia)
);
alter table public.garcom_fechamentos enable row level security;
drop policy if exists garcom_fechamentos_ler on public.garcom_fechamentos;
create policy garcom_fechamentos_ler on public.garcom_fechamentos for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (perfil_id = (select auth.uid()) or (select private.tem_papel('{admin,gerente,caixa}'))));
revoke all on public.garcom_fechamentos from anon;
revoke insert, update, delete on public.garcom_fechamentos from authenticated;

create or replace function public.garcom_turno(p_dia date default null, p_perfil uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_alvo uuid := coalesce(p_perfil, auth.uid()); g public.perfis; cfg jsonb;
  v_fz text; v_dia date; v_a timestamptz; v_b timestamptz; v_pct numeric; v_base text; v_formas jsonb; v_rec jsonb; v_mesas jsonb;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if v_alvo <> auth.uid() and not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Você só pode ver o seu turno'; end if;
  select * into g from public.perfis where id = v_alvo and empresa_id = v_emp;
  if not found then raise exception 'Garçom não encontrado'; end if;
  cfg := private.cfg_restaurante(v_emp); v_fz := private.fuso(v_emp);
  v_dia := coalesce(p_dia, (now() at time zone v_fz)::date);
  v_a := v_dia::timestamp at time zone v_fz; v_b := (v_dia + 1)::timestamp at time zone v_fz;
  select coalesce(gm.comissao_percentual, (cfg->>'comissao_percentual')::numeric) into v_pct
    from (select 1) x left join public.garcom_metas gm on gm.perfil_id = v_alvo;
  v_base := coalesce(cfg->>'comissao_base', 'consumo');

  -- Recebido por ele no app (por forma), com cada conta e NSU
  select jsonb_build_object('pix', coalesce(sum(p.valor) filter (where p.forma = 'pix'), 0),
      'debito', coalesce(sum(p.valor) filter (where p.forma = 'debito'), 0),
      'credito', coalesce(sum(p.valor) filter (where p.forma = 'credito'), 0),
      'total', coalesce(sum(p.valor), 0), 'qtd', count(*))
    into v_formas
  from public.venda_pagamentos p join public.vendas v on v.id = p.venda_id
  where v.empresa_id = v_emp and v.status = 'finalizada' and v.recebido_no_app and p.recebido_por = v_alvo
    and v.finalizada_em >= v_a and v.finalizada_em < v_b;

  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'numero', v.numero, 'mesa', v.identificador, 'hora', v.finalizada_em,
      'total', v.total, 'servico', v.taxa_servico,
      'pagamentos', (select jsonb_agg(jsonb_build_object('forma', p.forma, 'valor', p.valor, 'nsu', p.nsu) order by p.forma)
                     from public.venda_pagamentos p where p.venda_id = v.id)) order by v.finalizada_em desc), '[]'::jsonb)
    into v_rec
  from public.vendas v
  where v.empresa_id = v_emp and v.status = 'finalizada' and v.recebido_no_app and v.operador_id = v_alvo
    and v.finalizada_em >= v_a and v.finalizada_em < v_b;

  -- Mesas que ele atendeu e fecharam no dia (no app ou no caixa): base da comissão
  select coalesce(jsonb_agg(jsonb_build_object('mesa', v.identificador, 'hora', v.finalizada_em, 'consumo', v.subtotal - v.desconto,
      'servico', v.taxa_servico, 'total', v.total, 'no_app', v.recebido_no_app,
      'comissao', round(case when v_base = 'servico' then v.taxa_servico else v.subtotal - v.desconto end * v_pct / 100, 2))
      order by v.finalizada_em desc), '[]'::jsonb)
    into v_mesas
  from public.vendas v
  where v.empresa_id = v_emp and v.status = 'finalizada' and v.garcom_id = v_alvo and v.finalizada_em >= v_a and v.finalizada_em < v_b;

  return jsonb_build_object(
    'dia', v_dia, 'hoje', v_dia = (now() at time zone v_fz)::date,
    'garcom', jsonb_build_object('id', g.id, 'nome', g.nome),
    'comissao_percentual', v_pct, 'comissao_base', v_base,
    'recebido', v_formas, 'recebimentos', v_rec,
    'resumo', private.garcom_metricas(v_emp, v_alvo, v_a, v_b, v_pct, v_base),
    'mesas', v_mesas,
    'abertas', (select jsonb_build_object('mesas', count(*), 'consumo', coalesce(sum(subtotal - desconto), 0),
        'comissao_prevista', round(case when v_base = 'servico' then coalesce(sum(taxa_servico), 0) else coalesce(sum(subtotal - desconto), 0) end * v_pct / 100, 2))
      from public.vendas where empresa_id = v_emp and garcom_id = v_alvo and status = 'aberta'),
    'fechamento', (select to_jsonb(f) from public.garcom_fechamentos f where f.perfil_id = v_alvo and f.dia = v_dia));
end $$;

-- O garçom informa o que conferiu (maquininha e PIX) e registra o fechamento do dia
create or replace function public.garcom_fechar_turno(p_dia date, p_informado jsonb, p_obs text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); t jsonb; v_inf jsonb; v_dif numeric; f public.garcom_fechamentos; k text;
begin
  if v_emp is null or private.papel()::text = 'cozinha' then raise exception 'Acesso negado'; end if;
  t := public.garcom_turno(p_dia, null);
  v_inf := '{}'::jsonb;
  foreach k in array array['pix','debito','credito'] loop
    v_inf := v_inf || jsonb_build_object(k, round(coalesce(nullif(p_informado->>k, '')::numeric, 0), 2));
    if (v_inf->>k)::numeric < 0 then raise exception 'Valor inválido'; end if;
  end loop;
  v_inf := v_inf || jsonb_build_object('total', (v_inf->>'pix')::numeric + (v_inf->>'debito')::numeric + (v_inf->>'credito')::numeric);
  v_dif := (v_inf->>'total')::numeric - (t->'recebido'->>'total')::numeric;
  insert into public.garcom_fechamentos (empresa_id, perfil_id, dia, sistema, informado, diferenca, observacao)
  values (v_emp, auth.uid(), (t->>'dia')::date, t->'recebido', v_inf, v_dif, nullif(left(trim(coalesce(p_obs, '')), 300), ''))
  on conflict (perfil_id, dia) do update set sistema = excluded.sistema, informado = excluded.informado,
    diferenca = excluded.diferenca, observacao = excluded.observacao, criado_em = now()
  returning * into f;
  perform private.auditar(v_emp, 'garcom.fechamento', 'garcom_fechamentos', f.id::text,
    jsonb_build_object('dia', f.dia, 'sistema', f.sistema, 'informado', f.informado, 'diferenca', f.diferenca));
  return to_jsonb(f);
end $$;

-- =====================================================================
-- Painel ao vivo dos garçons (administrador)
-- =====================================================================
create or replace function public.garcons_ao_vivo()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); cfg jsonb; v_fz text; v_hoje date; v_base text; v_r jsonb;
  v_ha timestamptz; v_sa timestamptz; v_ma timestamptz; v_fim timestamptz := now() + interval '1 minute';
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  cfg := private.cfg_restaurante(v_emp); v_fz := private.fuso(v_emp); v_base := coalesce(cfg->>'comissao_base', 'consumo');
  v_hoje := (now() at time zone v_fz)::date;
  v_ha := v_hoje::timestamp at time zone v_fz;
  v_sa := date_trunc('week', v_hoje)::date::timestamp at time zone v_fz;
  v_ma := date_trunc('month', v_hoje)::date::timestamp at time zone v_fz;
  select coalesce(jsonb_agg(x.j), '[]'::jsonb) into v_r from (
    select jsonb_build_object(
      'id', p.id, 'nome', p.nome, 'ativo', p.ativo,
      'meta_mensal', coalesce(gm.meta_mensal, (cfg->>'meta_mensal_padrao')::numeric, 0),
      'hoje', private.garcom_metricas(v_emp, p.id, v_ha, v_fim, coalesce(gm.comissao_percentual, (cfg->>'comissao_percentual')::numeric), v_base),
      'semana', private.garcom_metricas(v_emp, p.id, v_sa, v_fim, coalesce(gm.comissao_percentual, (cfg->>'comissao_percentual')::numeric), v_base),
      'mes', private.garcom_metricas(v_emp, p.id, v_ma, v_fim, coalesce(gm.comissao_percentual, (cfg->>'comissao_percentual')::numeric), v_base),
      'agora', (select jsonb_build_object('mesas', count(*), 'consumo', coalesce(sum(v.subtotal - v.desconto), 0), 'total', coalesce(sum(v.total), 0),
                  'pessoas', coalesce(sum(v.pessoas), 0), 'nomes', coalesce(jsonb_agg(v.identificador order by v.identificador), '[]'::jsonb),
                  'contas_pedidas', count(*) filter (where v.conta_pedida_em is not null))
                from public.vendas v where v.empresa_id = v_emp and v.garcom_id = p.id and v.status = 'aberta'),
      'ultimo_lancamento', (select max(i.criado_em) from public.venda_itens i where i.empresa_id = v_emp and i.criado_por = p.id and i.criado_em >= v_ha),
      'prontos', (select count(*) from public.cozinha_pedidos t join public.vendas v on v.id = t.venda_id
                  where t.empresa_id = v_emp and t.status = 'pronto' and v.garcom_id = p.id)) j
    from public.perfis p
    left join public.garcom_metas gm on gm.perfil_id = p.id
    where p.empresa_id = v_emp
      and ((p.papel::text = 'atendente' and p.ativo)
           or exists (select 1 from public.vendas v where v.empresa_id = v_emp and v.garcom_id = p.id and (v.status = 'aberta' or v.finalizada_em >= v_ma)))) x;
  return jsonb_build_object('agora', now(), 'dia', extract(day from v_hoje)::int,
    'dias_mes', extract(day from (date_trunc('month', v_hoje) + interval '1 month - 1 day'))::int,
    'dia_semana', extract(isodow from v_hoje)::int, 'comissao_base', v_base, 'garcons', v_r);
end $$;

-- ---------- Permissões ----------
revoke execute on all functions in schema private from public, anon;
revoke execute on function public.definir_acesso_garcom(uuid,text,text,text), public.remover_acesso_garcom(uuid), public.acessos_garcom(),
  public.codigo_garcom_loja(), public.alterar_meu_pin(text,text), public.garcom_autenticar(text,text,text),
  public.garcom_turno(date,uuid), public.garcom_fechar_turno(date,jsonb,text), public.garcons_ao_vivo() from public, anon, authenticated;
grant execute on function public.definir_acesso_garcom(uuid,text,text,text), public.remover_acesso_garcom(uuid), public.acessos_garcom(),
  public.codigo_garcom_loja(), public.alterar_meu_pin(text,text),
  public.garcom_turno(date,uuid), public.garcom_fechar_turno(date,jsonb,text), public.garcons_ao_vivo() to authenticated;
grant execute on function public.garcom_autenticar(text,text,text) to service_role;
grant select on public.garcom_fechamentos to authenticated;
