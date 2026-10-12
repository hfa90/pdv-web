-- =====================================================================
-- 026 · Inteligência artificial gerenciada pelo sistema + aprovação automática
--
--   1. IA (Anthropic/Claude) para qualquer recurso do sistema (hoje: pedido por voz):
--      - Plataforma (superusuário): chave da Anthropic do sistema, liga/desliga para as
--        lojas, modelo padrão, preço cobrado por uso, franquia mensal por loja e pacotes
--        de créditos. Vê o consumo de cada loja, dá créditos e bloqueia.
--      - Loja (administrador): ativa/pausa, escolhe usar os créditos do sistema ou a
--        própria chave da Anthropic, compra créditos (vira fatura no sistema de cobrança),
--        modelo, teto mensal e quais recursos usam IA.
--      - As chaves NUNCA saem do servidor: as tabelas não têm acesso pelo navegador; só as
--        Edge Functions (service_role) leem a chave na hora de chamar a Anthropic.
--      - Cada chamada fica registrada (ia_uso) com tokens e custo; o custo sai primeiro da
--        franquia do mês e depois dos créditos comprados.
--
--   2. Aprovação automática dos pedidos do garçom: "aprova sozinho pedidos de até R$ X",
--      opcionalmente só para garçons sem pedido recusado nos últimos 30 dias.
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- =====================================================================
-- 1a. Tabelas da IA (sem acesso direto pelo navegador)
-- =====================================================================
create table if not exists public.ia_plataforma (
  id boolean primary key default true check (id),
  ativo boolean not null default false,                 -- IA do sistema liberada para as lojas
  api_key text,                                         -- chave da Anthropic do sistema (só o servidor lê)
  chave_fim text,                                       -- últimos caracteres, para mostrar
  chave_validada_em timestamptz,
  modelo text not null default 'claude-haiku-5-5',
  preco_entrada numeric(12,4) not null default 10,      -- R$ por 1 milhão de tokens de entrada cobrados da loja
  preco_saida numeric(12,4) not null default 50,        -- R$ por 1 milhão de tokens de saída cobrados da loja
  franquia_mensal numeric(12,2) not null default 0,     -- R$ de IA incluídos por mês em cada loja
  pacotes jsonb not null default '[20, 50, 100]'::jsonb, -- valores (R$) dos pacotes de créditos
  credito_imediato boolean not null default false,      -- libera o crédito ao comprar (a fatura é paga depois)
  atualizado_em timestamptz,
  atualizado_por text
);
insert into public.ia_plataforma (id) values (true) on conflict (id) do nothing;

create table if not exists public.ia_lojas (
  empresa_id uuid primary key references public.empresas(id) on delete cascade,
  ativo boolean not null default true,                  -- o administrador pausa/ativa
  bloqueado boolean not null default false,             -- o superusuário bloqueia
  bloqueio_motivo text,
  fonte text not null default 'sistema' check (fonte in ('sistema','propria')),
  api_key text,                                         -- chave própria da loja (só o servidor lê)
  chave_fim text,
  chave_validada_em timestamptz,
  modelo text,                                          -- null = padrão do sistema
  limite_mensal numeric(12,2),                          -- teto de gasto do mês em R$ (opcional)
  recursos jsonb not null default '{}'::jsonb,          -- {"pedido_voz": false} desliga a IA naquele recurso
  creditos numeric(14,4) not null default 0,            -- créditos comprados (R$)
  atualizado_em timestamptz
);

create table if not exists public.ia_uso (
  id bigserial primary key,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  recurso text not null,
  modelo text,
  fonte text not null check (fonte in ('sistema','propria')),
  tokens_entrada int not null default 0,
  tokens_saida int not null default 0,
  tokens_cache int not null default 0,
  custo numeric(12,4) not null default 0,               -- R$ (com chave própria é só estimativa)
  da_franquia numeric(12,4) not null default 0,
  usuario_id uuid,
  criado_em timestamptz not null default now()
);
create index if not exists ia_uso_emp_idx on public.ia_uso(empresa_id, criado_em desc);

create table if not exists public.ia_compras (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  valor numeric(12,2) not null check (valor > 0),
  status text not null default 'pendente' check (status in ('pendente','pago','cancelado')),
  origem text not null default 'compra' check (origem in ('compra','cortesia')),
  fatura_id uuid references public.faturas(id) on delete set null,
  creditado boolean not null default false,
  observacao text,
  solicitado_por uuid,
  criado_em timestamptz not null default now(),
  pago_em timestamptz
);
create index if not exists ia_compras_emp_idx on public.ia_compras(empresa_id, criado_em desc);
create index if not exists ia_compras_fatura_idx on public.ia_compras(fatura_id);

alter table public.ia_plataforma enable row level security;
alter table public.ia_lojas enable row level security;
alter table public.ia_uso enable row level security;
alter table public.ia_compras enable row level security;
revoke all on public.ia_plataforma, public.ia_lojas, public.ia_uso, public.ia_compras from anon, authenticated;
revoke all on sequence public.ia_uso_id_seq from anon, authenticated;

-- =====================================================================
-- 1b. Regras
-- =====================================================================
create or replace function private.ia_modelo_valido(p text)
returns boolean language sql immutable as $$
  select p in ('claude-haiku-5-5', 'claude-sonnet-5-5')
$$;

/** Situação da IA de uma loja: estado, saldo, franquia e consumo do mês. */
create or replace function private.ia_resumo(p_emp uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare pl public.ia_plataforma; lj public.ia_lojas; v_ini timestamptz; v_custo_mes numeric; v_franq_usada numeric;
  v_franq_rest numeric; v_disp numeric; v_estado text; v_chamadas int; v_custo_propria numeric;
begin
  select * into pl from public.ia_plataforma where id;
  select * into lj from public.ia_lojas where empresa_id = p_emp;
  if lj.empresa_id is null then lj.ativo := true; lj.bloqueado := false; lj.fonte := 'sistema'; lj.creditos := 0; lj.recursos := '{}'::jsonb; end if;
  v_ini := date_trunc('month', private.agora_local(p_emp)) at time zone private.fuso(p_emp);
  select coalesce(sum(custo) filter (where fonte = 'sistema'), 0), coalesce(sum(da_franquia), 0), count(*),
         coalesce(sum(custo) filter (where fonte = 'propria'), 0)
    into v_custo_mes, v_franq_usada, v_chamadas, v_custo_propria
  from public.ia_uso where empresa_id = p_emp and criado_em >= v_ini;
  v_franq_rest := greatest(0, coalesce(pl.franquia_mensal, 0) - v_franq_usada);
  v_disp := v_franq_rest + coalesce(lj.creditos, 0);
  v_estado := case
    when lj.bloqueado then 'bloqueada'
    when not lj.ativo then 'pausada'
    when lj.fonte = 'propria' and lj.api_key is null then 'sem_chave'
    when lj.fonte = 'propria' and lj.limite_mensal is not null and v_custo_propria >= lj.limite_mensal then 'limite'
    when lj.fonte = 'propria' then 'ativa'
    when not coalesce(pl.ativo, false) or pl.api_key is null then 'indisponivel'
    when lj.limite_mensal is not null and v_custo_mes >= lj.limite_mensal then 'limite'
    when v_disp <= 0.0001 then 'sem_creditos'
    else 'ativa' end;
  return jsonb_build_object(
    'estado', v_estado, 'ativo', lj.ativo, 'bloqueado', lj.bloqueado, 'bloqueio_motivo', lj.bloqueio_motivo,
    'fonte', lj.fonte, 'tem_chave', lj.api_key is not null, 'chave_fim', lj.chave_fim, 'chave_validada_em', lj.chave_validada_em,
    'modelo', lj.modelo, 'modelo_efetivo', coalesce(lj.modelo, pl.modelo), 'limite_mensal', lj.limite_mensal, 'recursos', lj.recursos,
    'creditos', round(coalesce(lj.creditos, 0), 2), 'franquia_mensal', coalesce(pl.franquia_mensal, 0),
    'franquia_usada', round(v_franq_usada, 2), 'franquia_restante', round(v_franq_rest, 2), 'disponivel', round(v_disp, 2),
    'custo_mes', round(v_custo_mes, 2), 'custo_mes_propria', round(v_custo_propria, 2), 'chamadas_mes', v_chamadas,
    'sistema_disponivel', coalesce(pl.ativo, false) and pl.api_key is not null);
end $$;

/** Tela Configurações › Inteligência artificial (administrador e gerente). */
create or replace function public.ia_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); pl public.ia_plataforma; v_ini timestamptz;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  select * into pl from public.ia_plataforma where id;
  v_ini := date_trunc('month', private.agora_local(v_emp)) at time zone private.fuso(v_emp);
  return private.ia_resumo(v_emp) || jsonb_build_object(
    'pode_editar', private.tem_papel('{admin}'),
    'pacotes', pl.pacotes, 'credito_imediato', pl.credito_imediato,
    'preco_entrada', pl.preco_entrada, 'preco_saida', pl.preco_saida, 'modelo_padrao', pl.modelo,
    'custo_medio', (select round(avg(custo), 4) from (select custo from public.ia_uso where empresa_id = v_emp and fonte = 'sistema' order by criado_em desc limit 50) x),
    'por_recurso', coalesce((select jsonb_agg(jsonb_build_object('recurso', recurso, 'chamadas', n, 'custo', round(c, 2)) order by c desc)
        from (select recurso, count(*) n, sum(custo) c from public.ia_uso where empresa_id = v_emp and criado_em >= v_ini group by recurso) x), '[]'::jsonb),
    'compras', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'valor', c.valor, 'status', c.status, 'origem', c.origem,
          'creditado', c.creditado, 'criado_em', c.criado_em, 'pago_em', c.pago_em,
          'link_pagamento', f.link_pagamento, 'vencimento', f.vencimento) order by c.criado_em desc)
        from (select * from public.ia_compras where empresa_id = v_emp order by criado_em desc limit 12) c
        left join public.faturas f on f.id = c.fatura_id), '[]'::jsonb));
end $$;

/** Administrador: ativar/pausar, fonte, modelo, teto e recursos. */
create or replace function public.ia_configurar(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); lj public.ia_lojas; v_n numeric; k text;
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Só o administrador da loja altera a inteligência artificial'; end if;
  insert into public.ia_lojas (empresa_id) values (v_emp) on conflict (empresa_id) do nothing;
  select * into lj from public.ia_lojas where empresa_id = v_emp for update;
  if p ? 'ativo' then lj.ativo := coalesce((p->>'ativo')::boolean, lj.ativo); end if;
  if p ? 'fonte' then
    if p->>'fonte' not in ('sistema','propria') then raise exception 'Escolha de onde vem a IA'; end if;
    if p->>'fonte' = 'propria' and lj.api_key is null then raise exception 'Cadastre e teste a sua chave da Anthropic antes'; end if;
    lj.fonte := p->>'fonte';
  end if;
  if p ? 'modelo' then
    if nullif(p->>'modelo', '') is not null and not private.ia_modelo_valido(p->>'modelo') then raise exception 'Modelo inválido'; end if;
    lj.modelo := nullif(p->>'modelo', '');
  end if;
  if p ? 'limite_mensal' then
    v_n := nullif(p->>'limite_mensal', '')::numeric;
    if v_n is not null and (v_n < 0 or v_n > 100000) then raise exception 'Teto mensal inválido'; end if;
    lj.limite_mensal := case when v_n > 0 then round(v_n, 2) end;
  end if;
  if jsonb_typeof(p->'recursos') = 'object' then
    for k in select jsonb_object_keys(p->'recursos') loop
      if k not in ('pedido_voz') then raise exception 'Recurso desconhecido: %', k; end if;
    end loop;
    lj.recursos := lj.recursos || (select jsonb_object_agg(key, coalesce(value::text::boolean, true)) from jsonb_each(p->'recursos'));
  end if;
  update public.ia_lojas set ativo = lj.ativo, fonte = lj.fonte, modelo = lj.modelo, limite_mensal = lj.limite_mensal,
    recursos = lj.recursos, atualizado_em = now() where empresa_id = v_emp;
  perform private.auditar(v_emp, 'ia.config', 'ia_lojas', v_emp::text, p - 'api_key');
  return public.ia_status();
end $$;

create or replace function public.ia_remover_chave()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Só o administrador da loja altera a inteligência artificial'; end if;
  update public.ia_lojas set api_key = null, chave_fim = null, chave_validada_em = null, fonte = 'sistema', atualizado_em = now() where empresa_id = v_emp;
  perform private.auditar(v_emp, 'ia.chave_removida', 'ia_lojas', v_emp::text, '{}'::jsonb);
  return public.ia_status();
end $$;

/** Comprar créditos: gera a fatura no sistema de cobrança (e libera na hora se a plataforma permitir). */
create or replace function public.ia_comprar(p_valor numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); pl public.ia_plataforma; v_fat uuid; v_id uuid; v_valor numeric := round(p_valor, 2);
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Só o administrador da loja compra créditos'; end if;
  select * into pl from public.ia_plataforma where id;
  if not coalesce(pl.ativo, false) or pl.api_key is null then raise exception 'A IA do sistema ainda não está disponível. Fale com o suporte.'; end if;
  if not exists (select 1 from jsonb_array_elements_text(pl.pacotes) x where x::numeric = v_valor) then raise exception 'Escolha um dos pacotes'; end if;
  if (select count(*) from public.ia_compras where empresa_id = v_emp and status = 'pendente') >= 3 then
    raise exception 'Você já tem 3 compras de créditos esperando pagamento. Pague ou cancele uma antes.';
  end if;
  insert into public.faturas (empresa_id, descricao, valor, vencimento)
  values (v_emp, 'Créditos de inteligência artificial', v_valor, ((now() at time zone 'America/Sao_Paulo')::date + 3)) returning id into v_fat;
  insert into public.ia_compras (empresa_id, valor, fatura_id, solicitado_por, creditado)
  values (v_emp, v_valor, v_fat, auth.uid(), pl.credito_imediato) returning id into v_id;
  insert into public.ia_lojas (empresa_id) values (v_emp) on conflict (empresa_id) do nothing;
  if pl.credito_imediato then update public.ia_lojas set creditos = creditos + v_valor where empresa_id = v_emp; end if;
  perform private.auditar(v_emp, 'ia.comprar', 'ia_compras', v_id::text, jsonb_build_object('valor', v_valor, 'fatura', v_fat));
  return jsonb_build_object('id', v_id, 'fatura_id', v_fat, 'creditado', pl.credito_imediato);
end $$;

create or replace function public.ia_cancelar_compra(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); c public.ia_compras;
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Sem permissão'; end if;
  select * into c from public.ia_compras where id = p_id and empresa_id = v_emp and status = 'pendente' for update;
  if not found then raise exception 'Compra não encontrada ou já paga'; end if;
  if c.creditado then raise exception 'Estes créditos já foram liberados. Fale com o suporte para cancelar.'; end if;
  update public.ia_compras set status = 'cancelado' where id = c.id;
  update public.faturas set status = 'cancelado' where id = c.fatura_id and status = 'pendente';
end $$;

/** Fatura de créditos paga (ou cancelada) no sistema de cobrança → créditos entram (ou saem). */
create or replace function private.ia_fatura_mudou()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c record;
begin
  for c in select * from public.ia_compras where fatura_id = new.id and status <> 'cancelado' for update loop
    if new.status = 'pago' and old.status is distinct from 'pago' then
      update public.ia_compras set status = 'pago', pago_em = coalesce(new.pago_em, now()), creditado = true where id = c.id;
      if not c.creditado then update public.ia_lojas set creditos = creditos + c.valor where empresa_id = c.empresa_id; end if;
    elsif new.status = 'cancelado' and old.status is distinct from 'cancelado' then
      update public.ia_compras set status = 'cancelado', creditado = false where id = c.id;
      if c.creditado then update public.ia_lojas set creditos = creditos - c.valor where empresa_id = c.empresa_id; end if;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists t_ia_fatura on public.faturas;
create trigger t_ia_fatura after update of status on public.faturas for each row execute function private.ia_fatura_mudou();

-- ---------- Servidor (Edge Functions, service_role) ----------
/** Pode usar a IA agora? Devolve a chave e o preço só para o servidor. */
create or replace function public.ia_autorizar(p_emp uuid, p_recurso text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb; pl public.ia_plataforma; lj public.ia_lojas;
begin
  r := private.ia_resumo(p_emp);
  if coalesce((r->'recursos'->>p_recurso)::boolean, true) = false then return jsonb_build_object('ok', false, 'motivo', 'recurso_desligado'); end if;
  if r->>'estado' <> 'ativa' then return jsonb_build_object('ok', false, 'motivo', r->>'estado'); end if;
  select * into pl from public.ia_plataforma where id;
  select * into lj from public.ia_lojas where empresa_id = p_emp;
  return jsonb_build_object('ok', true, 'fonte', r->>'fonte', 'modelo', r->>'modelo_efetivo',
    'chave', case when r->>'fonte' = 'propria' then lj.api_key else pl.api_key end,
    'preco_entrada', pl.preco_entrada, 'preco_saida', pl.preco_saida);
end $$;

/** Registra o consumo e desconta: primeiro a franquia do mês, depois os créditos. */
create or replace function public.ia_registrar_uso(p_emp uuid, p_recurso text, p_modelo text, p_fonte text,
  p_entrada int, p_saida int, p_cache int, p_custo numeric, p_usuario uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_franq numeric := 0; v_custo numeric := greatest(0, coalesce(p_custo, 0));
begin
  perform pg_advisory_xact_lock(hashtextextended('ia-uso' || p_emp::text, 0));
  if p_fonte = 'sistema' then
    r := private.ia_resumo(p_emp);
    v_franq := least(v_custo, (r->>'franquia_restante')::numeric);
    insert into public.ia_lojas (empresa_id) values (p_emp) on conflict (empresa_id) do nothing;
    update public.ia_lojas set creditos = creditos - (v_custo - v_franq) where empresa_id = p_emp;
  end if;
  insert into public.ia_uso (empresa_id, recurso, modelo, fonte, tokens_entrada, tokens_saida, tokens_cache, custo, da_franquia, usuario_id)
  values (p_emp, left(p_recurso, 40), left(p_modelo, 60), p_fonte, greatest(0, coalesce(p_entrada, 0)), greatest(0, coalesce(p_saida, 0)),
          greatest(0, coalesce(p_cache, 0)), v_custo, v_franq, p_usuario);
  return private.ia_resumo(p_emp) - 'recursos';
end $$;

-- ---------- Plataforma (superusuário) ----------
create or replace function public.ia_plataforma_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare pl public.ia_plataforma; v_ini timestamptz := date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  select * into pl from public.ia_plataforma where id;
  return jsonb_build_object(
    'config', jsonb_build_object('ativo', pl.ativo, 'tem_chave', pl.api_key is not null, 'chave_fim', pl.chave_fim, 'chave_validada_em', pl.chave_validada_em,
      'modelo', pl.modelo, 'preco_entrada', pl.preco_entrada, 'preco_saida', pl.preco_saida, 'franquia_mensal', pl.franquia_mensal,
      'pacotes', pl.pacotes, 'credito_imediato', pl.credito_imediato, 'atualizado_em', pl.atualizado_em, 'atualizado_por', pl.atualizado_por),
    'mes', jsonb_build_object(
      'chamadas', (select count(*) from public.ia_uso where criado_em >= v_ini),
      'cobrado', (select coalesce(round(sum(custo) filter (where fonte = 'sistema'), 2), 0) from public.ia_uso where criado_em >= v_ini),
      'tokens_entrada', (select coalesce(sum(tokens_entrada + tokens_cache) filter (where fonte = 'sistema'), 0) from public.ia_uso where criado_em >= v_ini),
      'tokens_saida', (select coalesce(sum(tokens_saida) filter (where fonte = 'sistema'), 0) from public.ia_uso where criado_em >= v_ini),
      'vendido', (select coalesce(sum(valor), 0) from public.ia_compras where origem = 'compra' and status = 'pago' and pago_em >= v_ini)),
    'lojas', coalesce((select jsonb_agg(x order by (x->>'custo_mes')::numeric desc, x->>'loja') from (
        select private.ia_resumo(e.id) - 'recursos' || jsonb_build_object('empresa_id', e.id, 'loja', coalesce(e.nome_fantasia, e.razao_social),
          'pendentes', (select count(*) from public.ia_compras c where c.empresa_id = e.id and c.status = 'pendente')) x
        from public.empresas e where e.status_conta in ('teste','ativo')) t), '[]'::jsonb),
    'compras', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'empresa_id', c.empresa_id, 'loja', coalesce(e.nome_fantasia, e.razao_social),
          'valor', c.valor, 'status', c.status, 'origem', c.origem, 'creditado', c.creditado, 'criado_em', c.criado_em, 'pago_em', c.pago_em, 'fatura_id', c.fatura_id)
        order by c.criado_em desc)
      from (select * from public.ia_compras order by criado_em desc limit 60) c join public.empresas e on e.id = c.empresa_id), '[]'::jsonb));
end $$;

create or replace function public.ia_plataforma_config(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n numeric; v_pac jsonb;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if p ? 'ativo' then
    if coalesce((p->>'ativo')::boolean, false) and (select api_key is null from public.ia_plataforma where id) then
      raise exception 'Cadastre e teste a chave da Anthropic antes de ativar';
    end if;
    update public.ia_plataforma set ativo = coalesce((p->>'ativo')::boolean, false) where id;
  end if;
  if p ? 'modelo' then
    if not private.ia_modelo_valido(p->>'modelo') then raise exception 'Modelo inválido'; end if;
    update public.ia_plataforma set modelo = p->>'modelo' where id;
  end if;
  if p ? 'preco_entrada' then
    v_n := (p->>'preco_entrada')::numeric;
    if v_n is null or v_n < 0 or v_n > 100000 then raise exception 'Preço de entrada inválido'; end if;
    update public.ia_plataforma set preco_entrada = v_n where id;
  end if;
  if p ? 'preco_saida' then
    v_n := (p->>'preco_saida')::numeric;
    if v_n is null or v_n < 0 or v_n > 100000 then raise exception 'Preço de saída inválido'; end if;
    update public.ia_plataforma set preco_saida = v_n where id;
  end if;
  if p ? 'franquia_mensal' then
    v_n := (p->>'franquia_mensal')::numeric;
    if v_n is null or v_n < 0 or v_n > 10000 then raise exception 'Franquia inválida'; end if;
    update public.ia_plataforma set franquia_mensal = round(v_n, 2) where id;
  end if;
  if p ? 'pacotes' then
    if jsonb_typeof(p->'pacotes') <> 'array' or jsonb_array_length(p->'pacotes') not between 1 and 6 then raise exception 'Informe de 1 a 6 pacotes'; end if;
    select jsonb_agg(distinct round(x::numeric, 2) order by round(x::numeric, 2)) into v_pac from jsonb_array_elements_text(p->'pacotes') x;
    if exists (select 1 from jsonb_array_elements_text(v_pac) x where x::numeric < 1 or x::numeric > 10000) then raise exception 'Cada pacote deve ficar entre R$ 1 e R$ 10.000'; end if;
    update public.ia_plataforma set pacotes = v_pac where id;
  end if;
  if p ? 'credito_imediato' then update public.ia_plataforma set credito_imediato = coalesce((p->>'credito_imediato')::boolean, false) where id; end if;
  update public.ia_plataforma set atualizado_em = now(),
    atualizado_por = (select email from auth.users where id = auth.uid()) where id;
  return public.ia_plataforma_status();
end $$;

/** Superusuário: bloquear/desbloquear a IA de uma loja e dar créditos de cortesia. */
create or replace function public.ia_plataforma_loja(p_emp uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n numeric;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if not exists (select 1 from public.empresas where id = p_emp) then raise exception 'Loja não encontrada'; end if;
  insert into public.ia_lojas (empresa_id) values (p_emp) on conflict (empresa_id) do nothing;
  if p ? 'bloqueado' then
    update public.ia_lojas set bloqueado = coalesce((p->>'bloqueado')::boolean, false),
      bloqueio_motivo = case when coalesce((p->>'bloqueado')::boolean, false) then nullif(left(trim(coalesce(p->>'motivo', '')), 200), '') end,
      atualizado_em = now() where empresa_id = p_emp;
  end if;
  if p ? 'cortesia' then
    v_n := round((p->>'cortesia')::numeric, 2);
    if v_n is null or v_n = 0 or abs(v_n) > 10000 then raise exception 'Valor de créditos inválido'; end if;
    insert into public.ia_compras (empresa_id, valor, status, origem, creditado, observacao, pago_em)
    values (p_emp, abs(v_n), 'pago', 'cortesia', true, nullif(left(trim(coalesce(p->>'motivo', '')), 200), ''), now());
    update public.ia_lojas set creditos = creditos + v_n where empresa_id = p_emp;
  end if;
  return private.ia_resumo(p_emp);
end $$;

/** Superusuário: libera os créditos de uma compra (marca a fatura como paga). */
create or replace function public.ia_plataforma_liberar(p_compra uuid, p_forma text default 'manual')
returns void language plpgsql security definer set search_path = '' as $$
declare c public.ia_compras;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  select * into c from public.ia_compras where id = p_compra and status = 'pendente' for update;
  if not found then raise exception 'Compra não encontrada ou já resolvida'; end if;
  if c.fatura_id is not null then
    update public.faturas set status = 'pago', pago_em = now(), forma = coalesce(nullif(p_forma, ''), 'manual') where id = c.fatura_id;
  end if;
  -- sem fatura (ou se o gatilho não creditou): credita aqui
  select * into c from public.ia_compras where id = p_compra;
  if c.status = 'pendente' then
    update public.ia_compras set status = 'pago', pago_em = now(), creditado = true where id = c.id;
    if not c.creditado then update public.ia_lojas set creditos = creditos + c.valor where empresa_id = c.empresa_id; end if;
  end if;
end $$;

-- =====================================================================
-- 2. Aprovação automática dos pedidos do garçom
-- =====================================================================
alter table public.cozinha_pedidos add column if not exists aprovado_auto boolean not null default false;

/** O pedido do garçom pode ir direto para a cozinha pelas regras da loja? */
create or replace function private.aprovacao_automatica(p_emp uuid, p_garcom uuid, p_valor numeric)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare cfg jsonb := private.cfg_restaurante(p_emp); v_lim numeric;
begin
  v_lim := coalesce((cfg->>'aprovacao_auto_ate')::numeric, 0);
  if v_lim <= 0 or p_valor > v_lim then return false; end if;
  if coalesce((cfg->>'aprovacao_auto_confiavel')::boolean, true) and exists (
      select 1 from public.cozinha_pedidos where empresa_id = p_emp and garcom_id = p_garcom and status = 'recusado'
        and criado_em > now() - interval '30 days') then
    return false;
  end if;
  return true;
end $$;

create or replace function private.criar_pedido_cozinha(p_venda uuid, p_apos int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v public.vendas; v_itens jsonb; v_id uuid; cfg jsonb; v_status text; v_auto boolean := false; v_valor numeric;
begin
  select * into v from public.vendas where id = p_venda;
  v_itens := private.itens_cozinha(p_venda, p_apos);
  if v_itens is null then return null; end if;
  cfg := private.cfg_restaurante(v.empresa_id);
  -- Garçom envia → aguarda o caixa/gerente aprovar. Quem aprova já lança aprovado.
  -- Regra automática (026): pedido pequeno de garçom sem recusa recente vai direto.
  v_status := case when coalesce((cfg->>'aprovacao_cozinha')::boolean, true) and not private.tem_papel('{admin,gerente,caixa}')
                   then 'aguardando' else 'novo' end;
  if v_status = 'aguardando' then
    select coalesce(sum(total), 0) into v_valor from public.venda_itens where venda_id = p_venda and item > p_apos and not removido;
    if private.aprovacao_automatica(v.empresa_id, auth.uid(), v_valor) then v_status := 'novo'; v_auto := true; end if;
  end if;
  insert into public.cozinha_pedidos (empresa_id, venda_id, origem, identificador, numero_venda, garcom_id, status, itens, aprovado_em, aprovado_por, aprovado_auto)
  values (v.empresa_id, v.id, v.canal, coalesce(v.identificador, 'Pedido ' || v.numero), v.numero, auth.uid(), v_status, v_itens,
          case when v_status = 'novo' then now() end, case when v_status = 'novo' and not v_auto then auth.uid() end, v_auto)
  returning id into v_id;
  return v_id;
end $$;

-- Novas escolhas do restaurante: aprovação automática
create or replace function private.cfg_restaurante(p_emp uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
      'servico_modo', 'sugerir', 'servico_percentual', 10,
      'couvert_ativo', false, 'couvert_valor', 0, 'couvert_nome', 'Couvert artístico',
      'comissao_percentual', 10, 'comissao_base', 'consumo', 'meta_mensal_padrao', 0,
      'aprovacao_cozinha', true, 'preparo_alvo_min', 20,
      'tempo_alerta_min', 60, 'tempo_critico_min', 120, 'ocioso_min', 25,
      'aprovacao_auto_ate', 0, 'aprovacao_auto_confiavel', true)
    || coalesce((select e.config_restaurante from public.empresas e where e.id = p_emp), '{}'::jsonb)
$$;

create or replace function public.salvar_config_restaurante(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); c jsonb := '{}'::jsonb; v_n numeric;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p ? 'servico_modo' then
    if p->>'servico_modo' not in ('nao','sugerir','cobrar') then raise exception 'Escolha como tratar a taxa de serviço'; end if;
    c := c || jsonb_build_object('servico_modo', p->>'servico_modo');
  end if;
  if p ? 'servico_percentual' then
    v_n := round((p->>'servico_percentual')::numeric, 2);
    if v_n is null or v_n < 0 or v_n > 30 then raise exception 'A taxa de serviço deve ficar entre 0 e 30%%'; end if;
    c := c || jsonb_build_object('servico_percentual', v_n);
  end if;
  if p ? 'couvert_ativo' then c := c || jsonb_build_object('couvert_ativo', coalesce((p->>'couvert_ativo')::boolean, false)); end if;
  if p ? 'couvert_valor' then
    v_n := round((p->>'couvert_valor')::numeric, 2);
    if v_n is null or v_n < 0 or v_n > 1000 then raise exception 'Valor de couvert inválido'; end if;
    c := c || jsonb_build_object('couvert_valor', v_n);
  end if;
  if p ? 'couvert_nome' then c := c || jsonb_build_object('couvert_nome', coalesce(nullif(left(trim(p->>'couvert_nome'), 40), ''), 'Couvert')); end if;
  if p ? 'comissao_percentual' then
    v_n := round((p->>'comissao_percentual')::numeric, 2);
    if v_n is null or v_n < 0 or v_n > 100 then raise exception 'Comissão deve ficar entre 0 e 100%%'; end if;
    c := c || jsonb_build_object('comissao_percentual', v_n);
  end if;
  if p ? 'comissao_base' then
    if p->>'comissao_base' not in ('consumo','servico') then raise exception 'Base da comissão inválida'; end if;
    c := c || jsonb_build_object('comissao_base', p->>'comissao_base');
  end if;
  if p ? 'meta_mensal_padrao' then
    v_n := round((p->>'meta_mensal_padrao')::numeric, 2);
    if v_n is null or v_n < 0 then raise exception 'Meta inválida'; end if;
    c := c || jsonb_build_object('meta_mensal_padrao', v_n);
  end if;
  if p ? 'aprovacao_cozinha' then c := c || jsonb_build_object('aprovacao_cozinha', coalesce((p->>'aprovacao_cozinha')::boolean, true)); end if;
  if p ? 'preparo_alvo_min' then
    v_n := (p->>'preparo_alvo_min')::int;
    if v_n is null or v_n < 3 or v_n > 240 then raise exception 'Tempo de preparo deve ficar entre 3 e 240 minutos'; end if;
    c := c || jsonb_build_object('preparo_alvo_min', v_n);
  end if;
  if p ? 'tempo_alerta_min' then
    v_n := (p->>'tempo_alerta_min')::int;
    if v_n is null or v_n < 5 or v_n > 720 then raise exception 'Tempo de alerta inválido'; end if;
    c := c || jsonb_build_object('tempo_alerta_min', v_n);
  end if;
  if p ? 'tempo_critico_min' then
    v_n := (p->>'tempo_critico_min')::int;
    if v_n is null or v_n < 10 or v_n > 1440 then raise exception 'Tempo crítico inválido'; end if;
    c := c || jsonb_build_object('tempo_critico_min', v_n);
  end if;
  if p ? 'ocioso_min' then
    v_n := (p->>'ocioso_min')::int;
    if v_n is null or v_n < 5 or v_n > 240 then raise exception 'Tempo sem pedir inválido'; end if;
    c := c || jsonb_build_object('ocioso_min', v_n);
  end if;
  -- QR Code na mesa (025)
  if p ? 'qr_ativo' then c := c || jsonb_build_object('qr_ativo', coalesce((p->>'qr_ativo')::boolean, true)); end if;
  if p ? 'qr_pedir' then c := c || jsonb_build_object('qr_pedir', coalesce((p->>'qr_pedir')::boolean, true)); end if;
  if p ? 'qr_pagar' then c := c || jsonb_build_object('qr_pagar', coalesce((p->>'qr_pagar')::boolean, true)); end if;
  -- Aprovação automática (026)
  if p ? 'aprovacao_auto_ate' then
    v_n := round(coalesce(nullif(p->>'aprovacao_auto_ate', '')::numeric, 0), 2);
    if v_n < 0 or v_n > 100000 then raise exception 'Valor da aprovação automática inválido'; end if;
    c := c || jsonb_build_object('aprovacao_auto_ate', v_n);
  end if;
  if p ? 'aprovacao_auto_confiavel' then c := c || jsonb_build_object('aprovacao_auto_confiavel', coalesce((p->>'aprovacao_auto_confiavel')::boolean, true)); end if;
  update public.empresas set config_restaurante = config_restaurante || c where id = v_emp;
  if (private.cfg_restaurante(v_emp)->>'tempo_critico_min')::int <= (private.cfg_restaurante(v_emp)->>'tempo_alerta_min')::int then
    raise exception 'O tempo crítico deve ser maior que o tempo de alerta';
  end if;
  if jsonb_typeof(p->'categorias_fora_cozinha') = 'array' then
    update public.categorias set envia_cozinha = not (id::text in (select jsonb_array_elements_text(p->'categorias_fora_cozinha')))
    where empresa_id = v_emp;
  end if;
  perform private.auditar(v_emp, 'restaurante.config', 'empresas', v_emp::text, c);
  return private.cfg_restaurante(v_emp);
end $$;

-- =====================================================================
-- Permissões (o Supabase dá EXECUTE ao anon direto: revogar explicitamente)
-- =====================================================================
revoke execute on all functions in schema private from public, anon;
revoke execute on function public.ia_status(), public.ia_configurar(jsonb), public.ia_remover_chave(), public.ia_comprar(numeric),
  public.ia_cancelar_compra(uuid), public.ia_autorizar(uuid,text), public.ia_registrar_uso(uuid,text,text,text,int,int,int,numeric,uuid),
  public.ia_plataforma_status(), public.ia_plataforma_config(jsonb), public.ia_plataforma_loja(uuid,jsonb), public.ia_plataforma_liberar(uuid,text),
  public.salvar_config_restaurante(jsonb) from public, anon, authenticated;
grant execute on function public.ia_status(), public.ia_configurar(jsonb), public.ia_remover_chave(), public.ia_comprar(numeric),
  public.ia_cancelar_compra(uuid), public.ia_plataforma_status(), public.ia_plataforma_config(jsonb), public.ia_plataforma_loja(uuid,jsonb),
  public.ia_plataforma_liberar(uuid,text), public.salvar_config_restaurante(jsonb) to authenticated;
-- Só o servidor (Edge Functions) autoriza o uso e registra o consumo
grant execute on function public.ia_autorizar(uuid,text), public.ia_registrar_uso(uuid,text,text,text,int,int,int,numeric,uuid) to service_role;
-- Correção da 025: funções da equipe não ficam liberadas para visitante sem login
revoke execute on function public.mesa_chamados_pendentes(), public.mesa_chamado_resolver(uuid,text,text), public.mesa_qr_trocar(uuid),
  public.mesa_pagamentos_conta(uuid), public.painel_hoje() from anon;
