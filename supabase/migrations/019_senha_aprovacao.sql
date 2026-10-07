-- =====================================================================
-- 019 · Senha de aprovação dos pedidos do garçom
--   Gerente e caixa têm cada um uma senha de 6 números, sorteada pelo servidor,
--   que vale 7 dias corridos e depois é trocada sozinha.
--   Quem não pode aprovar (garçom, cozinha…) aprova um pedido digitando a senha
--   de um gerente ou caixa da loja. O pedido fica registrado como aprovado por
--   esse gerente/caixa, a pedido de quem digitou.
--   5 senhas erradas em 15 minutos bloqueiam novas tentativas por 15 minutos.
-- Pode rodar mais de uma vez.
-- =====================================================================

create table if not exists public.senhas_aprovacao (
  perfil_id uuid primary key references public.perfis(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  codigo text not null,
  valido_de timestamptz not null default now(),
  valido_ate timestamptz not null
);
create index if not exists senhas_aprovacao_emp_idx on public.senhas_aprovacao(empresa_id);

create table if not exists public.senha_aprovacao_tentativas (
  id bigint generated always as identity primary key,
  empresa_id uuid,
  usuario_id uuid not null,
  ok boolean not null,
  criado_em timestamptz not null default now()
);
create index if not exists senha_aprovacao_tent_idx on public.senha_aprovacao_tentativas(usuario_id, criado_em desc);

alter table public.senhas_aprovacao enable row level security;
alter table public.senha_aprovacao_tentativas enable row level security;
revoke all on public.senhas_aprovacao, public.senha_aprovacao_tentativas from anon, authenticated;

alter table public.cozinha_pedidos add column if not exists aprovado_com_senha boolean not null default false;
alter table public.cozinha_pedidos add column if not exists aprovacao_pedida_por uuid references public.perfis(id) on delete set null;

/** Quem tem senha de aprovação. */
create or replace function private.tem_senha_aprovacao(p_papel text)
returns boolean language sql immutable set search_path = '' as $$
  select p_papel in ('gerente', 'caixa')
$$;

/** Senha válida do usuário; sorteia uma nova se não existir, venceu ou p_nova = true. */
create or replace function private.senha_aprovacao(p_perfil uuid, p_nova boolean default false)
returns public.senhas_aprovacao language plpgsql security definer set search_path = '' as $$
declare
  s public.senhas_aprovacao;
  v_emp uuid;
  v_cod text;
  i int := 0;
begin
  select empresa_id into v_emp from public.perfis where id = p_perfil;
  select * into s from public.senhas_aprovacao where perfil_id = p_perfil;
  if found and not p_nova and s.valido_ate > now() then return s; end if;
  loop
    -- 6 números a partir de bytes aleatórios do servidor (gen_random_uuid é criptográfico)
    v_cod := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
    i := i + 1;
    exit when i > 20 or (
      v_cod !~ '^(\d)\1{5}$' and v_cod not in ('123456', '654321', '012345', '543210')
      and v_cod is distinct from s.codigo
      and not exists (select 1 from public.senhas_aprovacao x where x.empresa_id = v_emp and x.codigo = v_cod and x.valido_ate > now()));
  end loop;
  insert into public.senhas_aprovacao(perfil_id, empresa_id, codigo, valido_de, valido_ate)
  values (p_perfil, v_emp, v_cod, now(), now() + interval '7 days')
  on conflict (perfil_id) do update set empresa_id = excluded.empresa_id, codigo = excluded.codigo, valido_de = excluded.valido_de, valido_ate = excluded.valido_ate
  returning * into s;
  return s;
end $$;

/** Gerente/caixa: a própria senha (p_nova = true troca agora, ex.: se alguém viu). */
create or replace function public.minha_senha_aprovacao(p_nova boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_papel text; s public.senhas_aprovacao;
begin
  select papel::text into v_papel from public.perfis where id = v_uid and ativo;
  if v_papel is null or not private.tem_senha_aprovacao(v_papel) then return jsonb_build_object('tem', false); end if;
  s := private.senha_aprovacao(v_uid, coalesce(p_nova, false));
  if p_nova then perform private.auditar(s.empresa_id, 'aprovacao.nova_senha', 'perfis', v_uid::text, '{}'::jsonb); end if;
  return jsonb_build_object('tem', true, 'codigo', s.codigo, 'valido_de', s.valido_de, 'valido_ate', s.valido_ate);
end $$;

/** Administrador vê as senhas de gerentes e caixas; gerente vê a própria e as dos caixas. */
create or replace function public.senhas_aprovacao_loja()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_admin boolean := private.tem_papel('{admin}'); r jsonb := '[]'::jsonb; p record; s public.senhas_aprovacao;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Acesso restrito'; end if;
  for p in select id, nome, papel::text as papel from public.perfis
           where empresa_id = v_emp and ativo and private.tem_senha_aprovacao(papel::text)
             and (v_admin or papel = 'caixa' or id = (select auth.uid())) order by papel, nome loop
    s := private.senha_aprovacao(p.id);
    r := r || jsonb_build_object('perfil_id', p.id, 'nome', p.nome, 'papel', p.papel, 'codigo', s.codigo, 'valido_ate', s.valido_ate);
  end loop;
  return r;
end $$;

/** Administrador (ou o próprio) troca a senha de um gerente/caixa agora. */
create or replace function public.trocar_senha_aprovacao(p_perfil uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_alvo record; s public.senhas_aprovacao;
begin
  select id, empresa_id, papel::text as papel into v_alvo from public.perfis where id = p_perfil;
  if not found or v_alvo.empresa_id is distinct from v_emp or not private.tem_senha_aprovacao(v_alvo.papel) then raise exception 'Usuário sem senha de aprovação'; end if;
  if not (p_perfil = (select auth.uid()) or private.tem_papel('{admin}') or (private.tem_papel('{gerente}') and v_alvo.papel = 'caixa')) then
    raise exception 'Sem permissão';
  end if;
  s := private.senha_aprovacao(p_perfil, true);
  perform private.auditar(v_emp, 'aprovacao.nova_senha', 'perfis', p_perfil::text, '{}'::jsonb);
  return jsonb_build_object('codigo', s.codigo, 'valido_ate', s.valido_ate);
end $$;

/** Quem não pode aprovar (garçom, cozinha…) aprova pedidos com a senha de um gerente ou caixa. */
create or replace function public.cozinha_aprovar_com_senha(p_ids uuid[], p_senha text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_emp uuid := private.empresa_id();
  v_aut record;
  v_erros int;
  n int;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  select count(*) into v_erros from public.senha_aprovacao_tentativas
   where usuario_id = v_uid and not ok and criado_em > now() - interval '15 minutes';
  if v_erros >= 5 then
    return jsonb_build_object('ok', false, 'bloqueado', true, 'erro', 'Muitas senhas erradas. Aguarde 15 minutos ou peça para o caixa aprovar.');
  end if;

  select p.id, p.nome into v_aut
    from public.senhas_aprovacao s join public.perfis p on p.id = s.perfil_id
   where s.empresa_id = v_emp and s.codigo = regexp_replace(coalesce(p_senha, ''), '\D', '', 'g')
     and s.valido_ate > now() and p.ativo and p.empresa_id = v_emp and private.tem_senha_aprovacao(p.papel::text)
   limit 1;
  if not found then
    -- Não usa raise aqui: o registro da tentativa errada precisa ficar gravado
    insert into public.senha_aprovacao_tentativas(empresa_id, usuario_id, ok) values (v_emp, v_uid, false);
    return jsonb_build_object('ok', false, 'erro', format('Senha de aprovação incorreta ou vencida (%s de 5 tentativas).', v_erros + 1), 'restantes', 4 - v_erros);
  end if;
  insert into public.senha_aprovacao_tentativas(empresa_id, usuario_id, ok) values (v_emp, v_uid, true);

  update public.cozinha_pedidos set status = 'novo', aprovado_em = now(), aprovado_por = v_aut.id,
    aprovado_com_senha = true, aprovacao_pedida_por = v_uid, atualizado_em = now()
  where id = any(p_ids) and empresa_id = v_emp and status = 'aguardando';
  get diagnostics n = row_count;
  perform private.auditar(v_emp, 'cozinha.aprovar_com_senha', 'cozinha_pedidos', array_to_string(p_ids, ','),
    jsonb_build_object('autorizado_por', v_aut.nome, 'autorizado_por_id', v_aut.id, 'quantidade', n));
  if random() < 0.05 then delete from public.senha_aprovacao_tentativas where criado_em < now() - interval '30 days'; end if;
  return jsonb_build_object('ok', true, 'aprovados', n, 'autorizado_por', v_aut.nome);
end $$;

revoke execute on function public.minha_senha_aprovacao(boolean), public.senhas_aprovacao_loja(), public.trocar_senha_aprovacao(uuid),
  public.cozinha_aprovar_com_senha(uuid[], text) from public, anon;
grant execute on function public.minha_senha_aprovacao(boolean), public.senhas_aprovacao_loja(), public.trocar_senha_aprovacao(uuid),
  public.cozinha_aprovar_com_senha(uuid[], text) to authenticated;

notify pgrst, 'reload schema';
