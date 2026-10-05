-- =====================================================================
-- 011 · Ferramentas de gestão para o dono
--   1. Entrada de mercadoria pelo XML da NF-e (fornecedores, custo, margem, contas a pagar)
--   2. Resumo do dia por e-mail (dados + agendamento)
--   3. Alertas antifraude por operador
--   4. Fiado (contas a receber) com limite e cobrança
--   5. Resultado (lucro real), contas a pagar, taxas e fluxo de caixa
--   6. Conferência de PIX/cartão com extrato e maquininha
--   7. Sugestão de compra, curva ABC e produtos parados
--   8. Validade (lotes) e perdas
--  10. Promoções programadas aplicadas no servidor
-- =====================================================================

-- ---------- Configurações gerais da loja ----------
alter table public.empresas add column if not exists fuso text not null default 'America/Sao_Paulo';
alter table public.empresas add column if not exists taxas_pagamento jsonb not null default '{}'::jsonb;
alter table public.empresas add column if not exists resumo_config jsonb not null default '{}'::jsonb;
alter table public.empresas add column if not exists resumo_enviado_em date;

/** Data/hora local da loja. */
create or replace function private.agora_local(p_emp uuid)
returns timestamp language sql stable security definer set search_path = '' as $$
  select now() at time zone coalesce((select fuso from public.empresas where id = p_emp), 'America/Sao_Paulo')
$$;
create or replace function private.fuso(p_emp uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select fuso from public.empresas where id = p_emp), 'America/Sao_Paulo')
$$;

-- Custo do item no momento da venda (lucro real não muda quando o custo muda depois)
alter table public.venda_itens add column if not exists custo_unitario numeric(14,4);
alter table public.venda_itens add column if not exists promocao text;
create or replace function private.venda_item_custo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.custo_unitario is null then
    select preco_custo into new.custo_unitario from public.produtos where id = new.produto_id;
  end if;
  return new;
end $$;
drop trigger if exists t_venda_item_custo on public.venda_itens;
create trigger t_venda_item_custo before insert on public.venda_itens
  for each row execute function private.venda_item_custo();

-- =====================================================================
-- 1. Fornecedores e notas de entrada
-- =====================================================================
create table if not exists public.fornecedores (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  cnpj text,
  nome text not null,
  telefone text,
  email text,
  created_at timestamptz not null default now()
);
create unique index if not exists fornecedores_cnpj_uk on public.fornecedores(empresa_id, cnpj) where cnpj is not null;
alter table public.fornecedores enable row level security;
revoke all on public.fornecedores from anon, authenticated;
grant select, insert, update, delete on public.fornecedores to authenticated;
drop policy if exists fornecedores_ler on public.fornecedores;
create policy fornecedores_ler on public.fornecedores for select to authenticated
  using (empresa_id = (select private.empresa_id()));
drop policy if exists fornecedores_escrever on public.fornecedores;
create policy fornecedores_escrever on public.fornecedores for all to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')))
  with check (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

create table if not exists public.produto_fornecedor (
  fornecedor_id uuid not null references public.fornecedores(id) on delete cascade,
  codigo text not null,                      -- código do produto na nota do fornecedor (cProd)
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete cascade,
  fator numeric(12,4) not null default 1 check (fator > 0),  -- unidades da loja por unidade da nota (ex.: caixa com 12)
  ultimo_custo numeric(14,4),
  atualizado_em timestamptz not null default now(),
  primary key (fornecedor_id, codigo)
);
create index if not exists produto_fornecedor_prod_idx on public.produto_fornecedor(produto_id, atualizado_em desc);
alter table public.produto_fornecedor enable row level security;
revoke all on public.produto_fornecedor from anon, authenticated;
grant select on public.produto_fornecedor to authenticated;
drop policy if exists produto_fornecedor_ler on public.produto_fornecedor;
create policy produto_fornecedor_ler on public.produto_fornecedor for select to authenticated
  using (empresa_id = (select private.empresa_id()));

create table if not exists public.notas_entrada (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  fornecedor_id uuid references public.fornecedores(id) on delete set null,
  chave text,
  numero text, serie text,
  emitida_em timestamptz,
  valor_total numeric(14,2) not null default 0,
  itens int not null default 0,
  usuario_id uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists notas_entrada_chave_uk on public.notas_entrada(empresa_id, chave) where chave is not null;
alter table public.notas_entrada enable row level security;
revoke all on public.notas_entrada from anon, authenticated;
grant select on public.notas_entrada to authenticated;
drop policy if exists notas_entrada_ler on public.notas_entrada;
create policy notas_entrada_ler on public.notas_entrada for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

-- =====================================================================
-- 5. Contas a pagar (criadas também pelas duplicatas da NF-e)
-- =====================================================================
create table if not exists public.contas_pagar (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  descricao text not null,
  categoria text not null default 'Outros',
  fornecedor_id uuid references public.fornecedores(id) on delete set null,
  nota_id uuid references public.notas_entrada(id) on delete set null,
  valor numeric(14,2) not null check (valor > 0),
  vencimento date not null,
  pago_em date,
  valor_pago numeric(14,2),
  forma text,
  observacao text,
  usuario_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists contas_pagar_venc_idx on public.contas_pagar(empresa_id, vencimento);
alter table public.contas_pagar enable row level security;
revoke all on public.contas_pagar from anon, authenticated;
grant select, insert, update, delete on public.contas_pagar to authenticated;
drop policy if exists contas_pagar_tudo on public.contas_pagar;
create policy contas_pagar_tudo on public.contas_pagar for all to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')))
  with check (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

-- =====================================================================
-- 8. Lotes (validade) e perdas
-- =====================================================================
create table if not exists public.lotes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete cascade,
  lote text,
  validade date not null,
  quantidade numeric(14,3) not null check (quantidade > 0),
  saldo numeric(14,3) not null,
  status text not null default 'ativo' check (status in ('ativo','esgotado','baixado')),
  nota_id uuid references public.notas_entrada(id) on delete set null,
  usuario_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists lotes_validade_idx on public.lotes(empresa_id, status, validade);
create index if not exists lotes_produto_idx on public.lotes(produto_id, status, validade);
alter table public.lotes enable row level security;
revoke all on public.lotes from anon, authenticated;
grant select on public.lotes to authenticated;
drop policy if exists lotes_ler on public.lotes;
create policy lotes_ler on public.lotes for select to authenticated using (empresa_id = (select private.empresa_id()));

create table if not exists public.perdas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete cascade,
  lote_id uuid references public.lotes(id) on delete set null,
  quantidade numeric(14,3) not null check (quantidade > 0),
  custo_unitario numeric(14,4) not null default 0,
  valor numeric(14,2) not null default 0,
  motivo text not null check (motivo in ('vencido','avariado','quebra','consumo','furto','sobra','outro')),
  observacao text,
  usuario_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists perdas_emp_idx on public.perdas(empresa_id, created_at desc);
alter table public.perdas enable row level security;
revoke all on public.perdas from anon, authenticated;
grant select on public.perdas to authenticated;
drop policy if exists perdas_ler on public.perdas;
create policy perdas_ler on public.perdas for select to authenticated using (empresa_id = (select private.empresa_id()));

/** Vendas consomem os lotes mais próximos do vencimento primeiro (PEPS). */
create or replace function private.consumir_lotes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_falta numeric := -new.quantidade; l record; v_usa numeric;
begin
  if new.tipo <> 'venda' or new.quantidade >= 0 then return new; end if;
  for l in select id, saldo from public.lotes
           where produto_id = new.produto_id and status = 'ativo' order by validade, created_at for update loop
    exit when v_falta <= 0;
    v_usa := least(l.saldo, v_falta);
    update public.lotes set saldo = saldo - v_usa, status = case when saldo - v_usa <= 0 then 'esgotado' else status end where id = l.id;
    v_falta := v_falta - v_usa;
  end loop;
  return new;
end $$;
drop trigger if exists t_consumir_lotes on public.estoque_movimentos;
create trigger t_consumir_lotes after insert on public.estoque_movimentos
  for each row execute function private.consumir_lotes();

/** Registra um lote com validade (opcionalmente dando entrada no estoque). */
create or replace function public.registrar_lote(p_produto uuid, p_lote text, p_validade date, p_quantidade numeric, p_entrada boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_id uuid; pr public.produtos;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p_validade is null then raise exception 'Informe a validade'; end if;
  if coalesce(p_quantidade,0) <= 0 then raise exception 'Quantidade inválida'; end if;
  select * into pr from public.produtos where id = p_produto and empresa_id = v_emp for update;
  if not found then raise exception 'Produto não encontrado'; end if;
  insert into public.lotes (empresa_id, produto_id, lote, validade, quantidade, saldo)
    values (v_emp, pr.id, nullif(trim(p_lote),''), p_validade, p_quantidade, p_quantidade) returning id into v_id;
  if p_entrada and pr.controla_estoque then
    update public.produtos set estoque_atual = estoque_atual + p_quantidade where id = pr.id;
    insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, saldo_anterior, saldo_posterior, motivo, usuario_id)
      values (v_emp, pr.id, 'entrada', p_quantidade, pr.estoque_atual, pr.estoque_atual + p_quantidade, left('Lote '||coalesce(p_lote,'')||' val. '||to_char(p_validade,'DD/MM/YYYY'),200), auth.uid());
  end if;
  return v_id;
end $$;

/** Perda (vencido, avariado, quebra, sobra do dia…): baixa o estoque e guarda o valor perdido. */
create or replace function public.registrar_perda(p_produto uuid, p_quantidade numeric, p_motivo text, p_obs text default null, p_lote uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); pr public.produtos; v_valor numeric; l public.lotes;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Sem permissão'; end if;
  if coalesce(p_quantidade,0) <= 0 then raise exception 'Quantidade inválida'; end if;
  if p_motivo not in ('vencido','avariado','quebra','consumo','furto','sobra','outro') then raise exception 'Motivo inválido'; end if;
  select * into pr from public.produtos where id = p_produto and empresa_id = v_emp for update;
  if not found then raise exception 'Produto não encontrado'; end if;
  if p_lote is not null then
    select * into l from public.lotes where id = p_lote and empresa_id = v_emp and produto_id = pr.id for update;
    if not found then raise exception 'Lote não encontrado'; end if;
    update public.lotes set saldo = greatest(0, saldo - p_quantidade),
      status = case when saldo - p_quantidade <= 0 then 'baixado' else status end where id = l.id;
  end if;
  v_valor := round(p_quantidade * coalesce(pr.preco_custo, 0), 2);
  insert into public.perdas (empresa_id, produto_id, lote_id, quantidade, custo_unitario, valor, motivo, observacao)
    values (v_emp, pr.id, p_lote, p_quantidade, coalesce(pr.preco_custo,0), v_valor, p_motivo, left(p_obs,300));
  if pr.controla_estoque then
    update public.produtos set estoque_atual = estoque_atual - p_quantidade where id = pr.id;
    insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, saldo_anterior, saldo_posterior, motivo, usuario_id)
      values (v_emp, pr.id, 'saida', -p_quantidade, pr.estoque_atual, pr.estoque_atual - p_quantidade, left('Perda: '||p_motivo||coalesce(' · '||p_obs,''),200), auth.uid());
  end if;
  perform private.auditar(v_emp, 'estoque.perda', 'produtos', pr.id::text,
    jsonb_build_object('produto', pr.nome, 'quantidade', p_quantidade, 'motivo', p_motivo, 'valor', v_valor));
  return jsonb_build_object('valor', v_valor);
end $$;

/** Lotes vencidos ou vencendo nos próximos dias. */
create or replace function public.validade_painel(p_dias int default 15)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_hoje date;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  v_hoje := (private.agora_local(v_emp))::date;
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'produto_id', l.produto_id, 'produto', p.nome, 'unidade', p.unidade,
      'lote', l.lote, 'validade', l.validade, 'dias', l.validade - v_hoje, 'saldo', l.saldo, 'quantidade', l.quantidade,
      'valor', round(l.saldo * coalesce(p.preco_custo,0), 2), 'preco_venda', p.preco_venda) order by l.validade, p.nome)
    from public.lotes l join public.produtos p on p.id = l.produto_id
    where l.empresa_id = v_emp and l.status = 'ativo' and l.saldo > 0 and l.validade <= v_hoje + p_dias), '[]'::jsonb);
end $$;

create or replace function public.perdas_resumo(p_ini date, p_fim date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_tz text;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  v_tz := private.fuso(v_emp);
  return (with x as (
      select pe.*, p.nome, p.unidade from public.perdas pe join public.produtos p on p.id = pe.produto_id
      where pe.empresa_id = v_emp and (pe.created_at at time zone v_tz)::date between p_ini and p_fim)
    select jsonb_build_object(
      'total', coalesce((select sum(valor) from x), 0),
      'registros', (select count(*) from x),
      'por_motivo', coalesce((select jsonb_agg(jsonb_build_object('motivo', motivo, 'valor', v, 'qtd', n) order by v desc)
         from (select motivo, sum(valor) v, count(*) n from x group by motivo) m), '[]'),
      'por_produto', coalesce((select jsonb_agg(jsonb_build_object('produto', nome, 'unidade', unidade, 'quantidade', q, 'valor', v) order by v desc)
         from (select nome, unidade, sum(quantidade) q, sum(valor) v from x group by nome, unidade order by 4 desc limit 15) m), '[]'),
      'lista', coalesce((select jsonb_agg(jsonb_build_object('quando', created_at, 'produto', nome, 'unidade', unidade, 'quantidade', quantidade,
          'motivo', motivo, 'valor', valor, 'obs', observacao) order by created_at desc) from (select * from x order by created_at desc limit 200) l), '[]')));
end $$;

-- =====================================================================
-- 1. Entrada pelo XML da NF-e
-- =====================================================================
create or replace function public.registrar_entrada_nfe(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := private.empresa_id();
  v_forn uuid; v_nota uuid; v_chave text := nullif(regexp_replace(coalesce(p->>'chave',''), '\D', '', 'g'), '');
  it jsonb; pr public.produtos; v_prod uuid; v_fator numeric; v_qtd numeric; v_custo numeric; v_n int := 0; v_ex public.notas_entrada;
  d jsonb; v_contas int := 0; v_lotes int := 0; v_ean text;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if v_chave is not null then
    if length(v_chave) <> 44 then raise exception 'Chave de acesso inválida'; end if;
    select * into v_ex from public.notas_entrada where empresa_id = v_emp and chave = v_chave;
    if found then raise exception 'Esta nota já foi lançada em %', to_char(v_ex.created_at at time zone private.fuso(v_emp), 'DD/MM/YYYY HH24:MI'); end if;
  end if;

  -- Fornecedor (pelo CNPJ/CPF do emitente)
  if nullif(p#>>'{fornecedor,cnpj}','') is not null then
    insert into public.fornecedores (empresa_id, cnpj, nome, telefone, email)
      values (v_emp, regexp_replace(p#>>'{fornecedor,cnpj}', '\D', '', 'g'), left(coalesce(nullif(p#>>'{fornecedor,nome}',''), 'Fornecedor'),120),
              nullif(p#>>'{fornecedor,telefone}',''), nullif(p#>>'{fornecedor,email}',''))
      on conflict (empresa_id, cnpj) where cnpj is not null do update set nome = excluded.nome,
        telefone = coalesce(public.fornecedores.telefone, excluded.telefone), email = coalesce(public.fornecedores.email, excluded.email)
      returning id into v_forn;
  end if;

  insert into public.notas_entrada (empresa_id, fornecedor_id, chave, numero, serie, emitida_em, valor_total, usuario_id)
    values (v_emp, v_forn, v_chave, nullif(p->>'numero',''), nullif(p->>'serie',''), nullif(p->>'emitida_em','')::timestamptz,
            coalesce((p->>'valor_total')::numeric, 0), auth.uid())
    returning id into v_nota;

  for it in select * from jsonb_array_elements(coalesce(p->'itens','[]'::jsonb)) loop
    v_prod := nullif(it->>'produto_id','')::uuid;
    v_fator := greatest(coalesce((it->>'fator')::numeric, 1), 0.0001);
    v_qtd := round(coalesce((it->>'quantidade')::numeric, 0) * v_fator, 3);
    v_custo := round(coalesce((it->>'custo_unitario')::numeric, 0) / v_fator, 4);

    -- Produto novo a partir da nota
    if v_prod is null and coalesce((it->>'criar')::boolean, false) then
      v_ean := nullif(regexp_replace(coalesce(it->>'ean',''), '\D', '', 'g'), '');
      if v_ean is not null and (length(v_ean) not in (8,12,13,14) or exists (select 1 from public.produtos where empresa_id = v_emp and codigo_barras = v_ean)) then v_ean := null; end if;
      insert into public.produtos (empresa_id, nome, codigo_barras, unidade, preco_custo, preco_venda, ncm, categoria_id, controla_estoque, estoque_atual, ativo)
        values (v_emp, left(coalesce(nullif(it->>'nome',''), it->>'descricao', 'Produto'),120), v_ean,
                coalesce(nullif(it->>'unidade_loja',''), 'UN'), v_custo, coalesce(nullif(it->>'preco_venda','')::numeric, round(v_custo * 1.5, 2)),
                nullif(regexp_replace(coalesce(it->>'ncm',''), '\D', '', 'g'),''), nullif(it->>'categoria_id','')::uuid, true, 0, true)
        returning id into v_prod;
    end if;
    continue when v_prod is null;

    select * into pr from public.produtos where id = v_prod and empresa_id = v_emp for update;
    if not found then raise exception 'Produto não encontrado (item %)', it->>'descricao'; end if;
    v_n := v_n + 1;

    if v_forn is not null and nullif(it->>'codigo','') is not null then
      insert into public.produto_fornecedor (fornecedor_id, codigo, empresa_id, produto_id, fator, ultimo_custo, atualizado_em)
        values (v_forn, it->>'codigo', v_emp, pr.id, v_fator, v_custo, now())
        on conflict (fornecedor_id, codigo) do update set produto_id = excluded.produto_id, fator = excluded.fator,
          ultimo_custo = excluded.ultimo_custo, atualizado_em = now();
    end if;

    if coalesce((it->>'atualizar_custo')::boolean, true) and v_custo > 0 then
      update public.produtos set preco_custo = v_custo where id = pr.id;
    end if;
    if nullif(it->>'novo_preco_venda','')::numeric > 0 then
      update public.produtos set preco_venda = round((it->>'novo_preco_venda')::numeric, 2) where id = pr.id;
    end if;

    if pr.controla_estoque and v_qtd > 0 then
      update public.produtos set estoque_atual = estoque_atual + v_qtd where id = pr.id;
      insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, saldo_anterior, saldo_posterior, motivo, usuario_id)
        values (v_emp, pr.id, 'entrada', v_qtd, pr.estoque_atual, pr.estoque_atual + v_qtd,
                left('NF-e '||coalesce(p->>'numero','')||coalesce(' · '||(p#>>'{fornecedor,nome}'),''),200), auth.uid());
    end if;

    if nullif(it->>'validade','') is not null and v_qtd > 0 then
      insert into public.lotes (empresa_id, produto_id, lote, validade, quantidade, saldo, nota_id)
        values (v_emp, pr.id, nullif(it->>'lote',''), (it->>'validade')::date, v_qtd, v_qtd, v_nota);
      v_lotes := v_lotes + 1;
    end if;
  end loop;

  update public.notas_entrada set itens = v_n where id = v_nota;

  -- Duplicatas viram contas a pagar
  if coalesce((p->>'gerar_contas')::boolean, true) then
    for d in select * from jsonb_array_elements(coalesce(p->'duplicatas','[]'::jsonb)) loop
      continue when coalesce((d->>'valor')::numeric, 0) <= 0 or nullif(d->>'vencimento','') is null;
      insert into public.contas_pagar (empresa_id, descricao, categoria, fornecedor_id, nota_id, valor, vencimento)
        values (v_emp, left('NF '||coalesce(p->>'numero','')||coalesce(' parc. '||(d->>'numero'),'')||coalesce(' · '||(p#>>'{fornecedor,nome}'),''),150),
                'Mercadoria (fornecedor)', v_forn, v_nota, round((d->>'valor')::numeric, 2), (d->>'vencimento')::date);
      v_contas := v_contas + 1;
    end loop;
  end if;

  perform private.auditar(v_emp, 'nfe.entrada', 'notas_entrada', v_nota::text,
    jsonb_build_object('numero', p->>'numero', 'fornecedor', p#>>'{fornecedor,nome}', 'itens', v_n, 'valor', p->>'valor_total'));
  return jsonb_build_object('nota_id', v_nota, 'itens', v_n, 'contas', v_contas, 'lotes', v_lotes);
end $$;

-- =====================================================================
-- 7. Sugestão de compra, curva ABC e parados
-- =====================================================================
create or replace function public.sugestao_compra(p_dias int default 30, p_cobertura int default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  p_dias := least(greatest(p_dias, 7), 180); p_cobertura := least(greatest(p_cobertura, 1), 90);
  return coalesce((with vend as (
      select vi.produto_id, sum(vi.quantidade) q from public.venda_itens vi join public.vendas v on v.id = vi.venda_id
      where v.empresa_id = v_emp and v.status = 'finalizada' and v.finalizada_em >= now() - make_interval(days => p_dias) and not vi.removido
      group by vi.produto_id
    ), forn as (
      select distinct on (pf.produto_id) pf.produto_id, f.id fornecedor_id, f.nome fornecedor, f.telefone, pf.fator, pf.ultimo_custo
      from public.produto_fornecedor pf join public.fornecedores f on f.id = pf.fornecedor_id
      where pf.empresa_id = v_emp order by pf.produto_id, pf.atualizado_em desc
    ), base as (
      select p.id, p.nome, p.unidade, p.estoque_atual, p.estoque_minimo, coalesce(p.preco_custo,0) custo,
        coalesce(vend.q,0) vendido, coalesce(vend.q,0) / p_dias media,
        forn.fornecedor_id, forn.fornecedor, forn.telefone, coalesce(forn.fator,1) fator
      from public.produtos p left join vend on vend.produto_id = p.id left join forn on forn.produto_id = p.id
      where p.empresa_id = v_emp and p.ativo and p.controla_estoque
    ), calc as (
      select *, case when unidade in ('KG','G','L','ML','M') then round(greatest(0, media * p_cobertura + estoque_minimo - estoque_atual), 1)
                     else ceil(greatest(0, media * p_cobertura + estoque_minimo - estoque_atual)) end sugerido,
             case when media > 0 then round(estoque_atual / media, 1) end cobertura_dias
      from base)
    select jsonb_agg(jsonb_build_object('id', id, 'nome', nome, 'unidade', unidade, 'estoque', estoque_atual, 'minimo', estoque_minimo,
        'vendido', vendido, 'media_dia', round(media, 3), 'cobertura_dias', cobertura_dias, 'sugerido', sugerido,
        'custo', custo, 'valor', round(sugerido * custo, 2), 'fornecedor_id', fornecedor_id, 'fornecedor', fornecedor, 'telefone', telefone, 'fator', fator)
      order by fornecedor nulls last, cobertura_dias nulls last, nome)
    from calc where sugerido > 0), '[]'::jsonb);
end $$;

create or replace function public.curva_abc(p_ini timestamptz, p_fim timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  return coalesce((with x as (
      select vi.produto_id, max(vi.descricao) nome, sum(vi.quantidade) q, sum(vi.total) fat,
             sum(vi.total - vi.quantidade * coalesce(vi.custo_unitario, p.preco_custo, 0)) lucro
      from public.venda_itens vi join public.vendas v on v.id = vi.venda_id left join public.produtos p on p.id = vi.produto_id
      where v.empresa_id = v_emp and v.status = 'finalizada' and v.finalizada_em >= p_ini and v.finalizada_em < p_fim and not vi.removido
      group by vi.produto_id
    ), t as (select *, sum(fat) over () tot, sum(fat) over (order by fat desc, nome rows unbounded preceding) acum from x)
    select jsonb_agg(jsonb_build_object('produto_id', produto_id, 'nome', nome, 'quantidade', q, 'faturamento', fat, 'lucro', round(lucro,2),
        'participacao', round(fat / nullif(tot,0) * 100, 2), 'acumulado', round(acum / nullif(tot,0) * 100, 2),
        'classe', case when (acum - fat) / nullif(tot,0) < 0.8 then 'A' when (acum - fat) / nullif(tot,0) < 0.95 then 'B' else 'C' end)
      order by fat desc, nome) from t), '[]'::jsonb);
end $$;

create or replace function public.produtos_parados(p_dias int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  return coalesce((with ult as (
      select vi.produto_id, max(v.finalizada_em) ultima from public.venda_itens vi join public.vendas v on v.id = vi.venda_id
      where v.empresa_id = v_emp and v.status = 'finalizada' and not vi.removido group by vi.produto_id)
    select jsonb_agg(jsonb_build_object('id', p.id, 'nome', p.nome, 'unidade', p.unidade, 'estoque', p.estoque_atual,
        'custo', coalesce(p.preco_custo,0), 'valor_parado', round(p.estoque_atual * coalesce(p.preco_custo,0), 2), 'ultima_venda', ult.ultima)
      order by p.estoque_atual * coalesce(p.preco_custo,0) desc)
    from public.produtos p left join ult on ult.produto_id = p.id
    where p.empresa_id = v_emp and p.ativo and p.controla_estoque and p.estoque_atual > 0
      and (ult.ultima is null or ult.ultima < now() - make_interval(days => p_dias))
      and p.created_at < now() - make_interval(days => p_dias)), '[]'::jsonb);
end $$;

-- =====================================================================
-- 4. Fiado
-- =====================================================================
alter table public.clientes add column if not exists limite_credito numeric(12,2);   -- null = sem limite
alter table public.clientes add column if not exists prazo_dias int not null default 30;
alter table public.clientes add column if not exists fiado_bloqueado boolean not null default false;

create or replace function private.cliente_proteger_credito()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.limite_credito is distinct from old.limite_credito or new.prazo_dias is distinct from old.prazo_dias
      or new.fiado_bloqueado is distinct from old.fiado_bloqueado) and auth.uid() is not null and not private.tem_papel('{admin,gerente}') then
    raise exception 'Só gerente ou administrador altera limite e prazo do fiado';
  end if;
  return new;
end $$;
drop trigger if exists t_cliente_credito on public.clientes;
create trigger t_cliente_credito before update on public.clientes for each row execute function private.cliente_proteger_credito();

create table if not exists public.fiado_lancamentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  tipo text not null check (tipo in ('compra','pagamento','estorno','ajuste')),
  valor numeric(12,2) not null check (valor <> 0),            -- + aumenta a dívida, − diminui
  venda_id uuid references public.vendas(id) on delete set null,
  forma text,
  vencimento date,
  observacao text,
  usuario_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists fiado_cliente_idx on public.fiado_lancamentos(empresa_id, cliente_id, created_at);
alter table public.fiado_lancamentos enable row level security;
revoke all on public.fiado_lancamentos from anon, authenticated;
grant select on public.fiado_lancamentos to authenticated;
drop policy if exists fiado_ler on public.fiado_lancamentos;
create policy fiado_ler on public.fiado_lancamentos for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente,caixa}')));

create or replace function private.fiado_saldo(p_cliente uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(valor), 0) from public.fiado_lancamentos where cliente_id = p_cliente
$$;

/** Venda finalizada com "crediário" vira dívida do cliente; cancelada, vira estorno. */
create or replace function private.venda_fiado()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_valor numeric; c public.clientes; v_saldo numeric; v_hoje date;
begin
  if new.status = 'finalizada' and old.status is distinct from 'finalizada' then
    select coalesce(sum(valor),0) into v_valor from public.venda_pagamentos where venda_id = new.id and forma = 'crediario';
    if v_valor <= 0 then return new; end if;
    if new.cliente_id is null then raise exception 'Para vender no fiado (crediário), identifique o cliente'; end if;
    select * into c from public.clientes where id = new.cliente_id;
    v_saldo := private.fiado_saldo(c.id);
    if not coalesce(new.offline, false) and not private.tem_papel('{admin,gerente}') then
      if c.fiado_bloqueado then raise exception 'Fiado bloqueado para %', c.nome; end if;
      if c.limite_credito is not null and v_saldo + v_valor > c.limite_credito then
        raise exception 'Limite de fiado de % excedido: deve R$ %, limite R$ %. Peça ao gerente.', c.nome,
          to_char(v_saldo, 'FM999G999G990D00'), to_char(c.limite_credito, 'FM999G999G990D00');
      end if;
    end if;
    v_hoje := (private.agora_local(new.empresa_id))::date;
    insert into public.fiado_lancamentos (empresa_id, cliente_id, tipo, valor, venda_id, vencimento, observacao)
      values (new.empresa_id, c.id, 'compra', v_valor, new.id, v_hoje + coalesce(c.prazo_dias, 30), 'Venda nº '||new.numero);
  elsif new.status = 'cancelada' and old.status = 'finalizada' then
    select coalesce(sum(valor),0) into v_valor from public.fiado_lancamentos where venda_id = new.id and tipo in ('compra','estorno');
    if v_valor > 0 then
      insert into public.fiado_lancamentos (empresa_id, cliente_id, tipo, valor, venda_id, observacao)
        select new.empresa_id, cliente_id, 'estorno', -v_valor, new.id, 'Cancelamento da venda nº '||new.numero
        from public.fiado_lancamentos where venda_id = new.id and tipo = 'compra' limit 1;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists t_venda_fiado on public.vendas;
create trigger t_venda_fiado after update of status on public.vendas for each row execute function private.venda_fiado();

/** Recebe um pagamento de fiado. Dinheiro entra no caixa aberto do operador. */
create or replace function public.receber_fiado(p_cliente uuid, p_valor numeric, p_forma text, p_obs text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); c public.clientes; v_sessao uuid; v_saldo numeric;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Sem permissão'; end if;
  p_valor := round(coalesce(p_valor,0), 2);
  if p_valor <= 0 then raise exception 'Informe o valor'; end if;
  if p_forma not in ('dinheiro','pix','debito','credito','outros') then raise exception 'Forma inválida'; end if;
  select * into c from public.clientes where id = p_cliente and empresa_id = v_emp;
  if not found then raise exception 'Cliente não encontrado'; end if;
  v_saldo := private.fiado_saldo(c.id);
  if p_valor > v_saldo + 0.001 then raise exception 'Valor maior que a dívida (R$ %)', to_char(v_saldo, 'FM999G999G990D00'); end if;
  if p_forma = 'dinheiro' then
    select id into v_sessao from public.caixa_sessoes where operador_id = auth.uid() and status = 'aberto';
    if v_sessao is null then raise exception 'Abra o caixa para receber em dinheiro'; end if;
    insert into public.caixa_movimentos (empresa_id, sessao_id, tipo, valor, motivo, usuario_id)
      values (v_emp, v_sessao, 'suprimento', p_valor, left('Recebimento de fiado: '||c.nome,200), auth.uid());
  end if;
  insert into public.fiado_lancamentos (empresa_id, cliente_id, tipo, valor, forma, observacao)
    values (v_emp, c.id, 'pagamento', -p_valor, p_forma, left(p_obs,300));
  perform private.auditar(v_emp, 'fiado.receber', 'clientes', c.id::text, jsonb_build_object('cliente', c.nome, 'valor', p_valor, 'forma', p_forma));
  return jsonb_build_object('saldo', v_saldo - p_valor);
end $$;

create or replace function public.ajustar_fiado(p_cliente uuid, p_valor numeric, p_motivo text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); c public.clientes;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if coalesce(p_valor,0) = 0 then raise exception 'Informe o valor'; end if;
  if coalesce(length(trim(p_motivo)),0) < 3 then raise exception 'Informe o motivo'; end if;
  select * into c from public.clientes where id = p_cliente and empresa_id = v_emp;
  if not found then raise exception 'Cliente não encontrado'; end if;
  insert into public.fiado_lancamentos (empresa_id, cliente_id, tipo, valor, vencimento, observacao)
    values (v_emp, c.id, 'ajuste', round(p_valor,2), case when p_valor > 0 then (private.agora_local(v_emp))::date + c.prazo_dias end, left(p_motivo,300));
  perform private.auditar(v_emp, 'fiado.ajuste', 'clientes', c.id::text, jsonb_build_object('cliente', c.nome, 'valor', p_valor, 'motivo', p_motivo));
  return jsonb_build_object('saldo', private.fiado_saldo(c.id));
end $$;

create or replace function public.fiado_config_cliente(p_cliente uuid, p_limite numeric, p_prazo int, p_bloqueado boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  update public.clientes set limite_credito = case when p_limite is null or p_limite < 0 then null else round(p_limite,2) end,
    prazo_dias = least(greatest(coalesce(p_prazo,30),1),365), fiado_bloqueado = coalesce(p_bloqueado,false)
  where id = p_cliente and empresa_id = v_emp;
end $$;

/** Clientes com saldo de fiado (o vencido considera que pagamentos quitam as compras mais antigas). */
create or replace function public.fiado_clientes(p_todos boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_hoje date;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Sem permissão'; end if;
  v_hoje := (private.agora_local(v_emp))::date;
  return coalesce((with s as (
      select f.cliente_id, sum(f.valor) saldo,
        sum(f.valor) filter (where f.valor > 0 and f.vencimento >= v_hoje) a_vencer,
        min(f.vencimento) filter (where f.valor > 0) primeiro_venc,
        max(f.created_at) filter (where f.tipo = 'pagamento') ultimo_pag, max(f.created_at) ultima_mov
      from public.fiado_lancamentos f where f.empresa_id = v_emp group by f.cliente_id)
    select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'telefone', c.telefone, 'cpf_cnpj', c.cpf_cnpj,
        'saldo', coalesce(s.saldo,0), 'vencido', greatest(0, coalesce(s.saldo,0) - coalesce(s.a_vencer,0)),
        'ultimo_pagamento', s.ultimo_pag, 'ultima_mov', s.ultima_mov, 'limite', c.limite_credito, 'prazo', c.prazo_dias, 'bloqueado', c.fiado_bloqueado)
      order by greatest(0, coalesce(s.saldo,0) - coalesce(s.a_vencer,0)) desc, coalesce(s.saldo,0) desc, c.nome)
    from public.clientes c left join s on s.cliente_id = c.id
    where c.empresa_id = v_emp and (coalesce(s.saldo,0) <> 0 or (p_todos and c.ativo))), '[]'::jsonb);
end $$;

create or replace function public.fiado_saldo_cliente(p_cliente uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); c public.clientes;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  select * into c from public.clientes where id = p_cliente and empresa_id = v_emp;
  if not found then return null; end if;
  return jsonb_build_object('saldo', private.fiado_saldo(c.id), 'limite', c.limite_credito, 'bloqueado', c.fiado_bloqueado, 'prazo', c.prazo_dias);
end $$;

-- =====================================================================
-- 5. Taxas, resultado (DRE simples) e fluxo de caixa
-- =====================================================================
create or replace function public.salvar_taxas(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); k text; v_limpo jsonb := '{}'::jsonb;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  for k in select jsonb_object_keys(p) loop
    if k in ('dinheiro','debito','credito','pix','vale_refeicao','crediario','outros') and (p->>k)::numeric between 0 and 30 then
      v_limpo := v_limpo || jsonb_build_object(k, round((p->>k)::numeric, 3));
    end if;
  end loop;
  update public.empresas set taxas_pagamento = v_limpo where id = v_emp;
end $$;

create or replace function public.resultado_periodo(p_ini date, p_fim date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_tz text; v_i timestamptz; v_f timestamptz; v_taxas jsonb; r jsonb;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p_fim < p_ini or p_fim - p_ini > 400 then raise exception 'Período inválido'; end if;
  v_tz := private.fuso(v_emp);
  v_i := p_ini::timestamp at time zone v_tz; v_f := (p_fim + 1)::timestamp at time zone v_tz;
  select taxas_pagamento into v_taxas from public.empresas where id = v_emp;

  with fin as (select * from public.vendas where empresa_id = v_emp and status = 'finalizada' and finalizada_em >= v_i and finalizada_em < v_f),
  itens as (select vi.quantidade, vi.total, coalesce(vi.custo_unitario, p.preco_custo) custo from public.venda_itens vi join fin on fin.id = vi.venda_id
            left join public.produtos p on p.id = vi.produto_id where not vi.removido),
  pags as (select pg.forma::text forma, sum(pg.valor) - case when pg.forma = 'dinheiro' then (select coalesce(sum(troco),0) from fin) else 0 end valor
           from public.venda_pagamentos pg join fin on fin.id = pg.venda_id group by pg.forma),
  tx as (select forma, valor, round(valor * coalesce((v_taxas->>forma)::numeric, 0) / 100, 2) taxa from pags),
  desp as (select categoria, sum(valor) v from public.contas_pagar where empresa_id = v_emp and vencimento between p_ini and p_fim
           and categoria <> 'Mercadoria (fornecedor)' group by categoria),
  per as (select coalesce(sum(valor),0) v from public.perdas where empresa_id = v_emp and created_at >= v_i and created_at < v_f)
  select jsonb_build_object(
    'faturamento', (select coalesce(sum(total),0) from fin),
    'vendas', (select count(*) from fin),
    'descontos', (select coalesce(sum(desconto),0) from fin),
    'cmv', (select coalesce(round(sum(quantidade * coalesce(custo,0)),2),0) from itens),
    'itens_sem_custo', (select count(*) from itens where coalesce(custo,0) = 0),
    'taxas', (select coalesce(sum(taxa),0) from tx),
    'taxas_por_forma', coalesce((select jsonb_agg(jsonb_build_object('forma', forma, 'valor', valor, 'taxa', taxa) order by valor desc) from tx), '[]'),
    'perdas', (select v from per),
    'despesas', (select coalesce(sum(v),0) from desp),
    'despesas_por_categoria', coalesce((select jsonb_agg(jsonb_build_object('categoria', categoria, 'valor', v) order by v desc) from desp), '[]'),
    'compras_mercadoria', (select coalesce(sum(valor),0) from public.contas_pagar where empresa_id = v_emp and vencimento between p_ini and p_fim and categoria = 'Mercadoria (fornecedor)')
  ) into r;
  r := r || jsonb_build_object('lucro_bruto', (r->>'faturamento')::numeric - (r->>'cmv')::numeric);
  r := r || jsonb_build_object('lucro_liquido', (r->>'lucro_bruto')::numeric - (r->>'taxas')::numeric - (r->>'perdas')::numeric - (r->>'despesas')::numeric);
  return r;
end $$;

/** Entradas e saídas de dinheiro por dia + o que vence nos próximos dias. */
create or replace function public.fluxo_caixa(p_ini date, p_fim date, p_projecao int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_tz text; v_hoje date;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p_fim < p_ini or p_fim - p_ini > 400 then raise exception 'Período inválido'; end if;
  v_tz := private.fuso(v_emp); v_hoje := (private.agora_local(v_emp))::date;
  return jsonb_build_object(
    'dias', coalesce((with dias as (select generate_series(p_ini, p_fim, interval '1 day')::date dia),
      ent as (select (v.finalizada_em at time zone v_tz)::date dia,
                coalesce(sum(pg.valor) filter (where pg.forma <> 'crediario'), 0) bruto
              from public.vendas v join public.venda_pagamentos pg on pg.venda_id = v.id
              where v.empresa_id = v_emp and v.status = 'finalizada' and (v.finalizada_em at time zone v_tz)::date between p_ini and p_fim group by 1),
      troco as (select (finalizada_em at time zone v_tz)::date dia, sum(troco) t from public.vendas
              where empresa_id = v_emp and status = 'finalizada' and (finalizada_em at time zone v_tz)::date between p_ini and p_fim group by 1),
      fia as (select (created_at at time zone v_tz)::date dia, -sum(valor) v from public.fiado_lancamentos
              where empresa_id = v_emp and tipo = 'pagamento' and (created_at at time zone v_tz)::date between p_ini and p_fim group by 1),
      sai as (select pago_em dia, sum(coalesce(valor_pago, valor)) v from public.contas_pagar
              where empresa_id = v_emp and pago_em between p_ini and p_fim group by 1)
      select jsonb_agg(jsonb_build_object('dia', d.dia,
          'entradas', coalesce(ent.bruto,0) - coalesce(troco.t,0) + coalesce(fia.v,0), 'saidas', coalesce(sai.v,0)) order by d.dia)
      from dias d left join ent on ent.dia = d.dia left join troco on troco.dia = d.dia left join fia on fia.dia = d.dia left join sai on sai.dia = d.dia), '[]'),
    'a_pagar', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'descricao', descricao, 'categoria', categoria, 'valor', valor, 'vencimento', vencimento,
          'vencida', vencimento < v_hoje) order by vencimento)
      from public.contas_pagar where empresa_id = v_emp and pago_em is null and vencimento <= v_hoje + p_projecao), '[]'),
    'a_receber_fiado', (select coalesce(sum(valor),0) from public.fiado_lancamentos where empresa_id = v_emp));
end $$;

-- =====================================================================
-- 6. Conferência de PIX/cartão
-- =====================================================================
create table if not exists public.conferencias (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  dia date not null,
  forma text not null,
  valor_sistema numeric(14,2) not null,
  valor_conferido numeric(14,2) not null,
  diferenca numeric(14,2) not null,
  origem text,
  detalhes jsonb,
  observacao text,
  usuario_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists conferencias_idx on public.conferencias(empresa_id, dia desc);
alter table public.conferencias enable row level security;
revoke all on public.conferencias from anon, authenticated;
grant select, insert on public.conferencias to authenticated;
drop policy if exists conferencias_ler on public.conferencias;
create policy conferencias_ler on public.conferencias for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));
drop policy if exists conferencias_inserir on public.conferencias;
create policy conferencias_inserir on public.conferencias for insert to authenticated
  with check (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

/** Cada pagamento recebido no período (para bater com extrato/maquininha). */
create or replace function public.pagamentos_periodo(p_ini date, p_fim date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_tz text;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p_fim < p_ini or p_fim - p_ini > 62 then raise exception 'Período de até 2 meses'; end if;
  v_tz := private.fuso(v_emp);
  return coalesce((select jsonb_agg(x order by x->>'quando') from (
      select jsonb_build_object('quando', v.finalizada_em, 'dia', (v.finalizada_em at time zone v_tz)::date, 'forma', pg.forma::text, 'valor', pg.valor,
             'venda', v.numero, 'operador', pf.nome, 'origem', 'venda') x
      from public.venda_pagamentos pg join public.vendas v on v.id = pg.venda_id left join public.perfis pf on pf.id = v.operador_id
      where v.empresa_id = v_emp and v.status = 'finalizada' and pg.forma in ('pix','debito','credito','vale_refeicao')
        and (v.finalizada_em at time zone v_tz)::date between p_ini and p_fim
      union all
      select jsonb_build_object('quando', f.created_at, 'dia', (f.created_at at time zone v_tz)::date, 'forma', f.forma, 'valor', -f.valor,
             'venda', null, 'operador', pf.nome, 'origem', 'fiado')
      from public.fiado_lancamentos f left join public.perfis pf on pf.id = f.usuario_id
      where f.empresa_id = v_emp and f.tipo = 'pagamento' and f.forma in ('pix','debito','credito')
        and (f.created_at at time zone v_tz)::date between p_ini and p_fim) t), '[]'::jsonb);
end $$;

-- =====================================================================
-- 10. Promoções
-- =====================================================================
create table if not exists public.promocoes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  nome text not null,
  tipo text not null check (tipo in ('leve_pague','preco_horario','atacado','combo')),
  ativo boolean not null default true,
  produtos uuid[] not null default '{}',
  categoria_id uuid references public.categorias(id) on delete set null,
  leve int check (leve is null or leve >= 2),
  pague int check (pague is null or pague >= 1),
  preco numeric(12,2) check (preco is null or preco >= 0),
  percentual numeric(5,2) check (percentual is null or (percentual > 0 and percentual < 100)),
  qtd_minima numeric(12,3),
  combo jsonb,                       -- [{"produto_id": "...", "qtd": 1}, ...]
  dias_semana int[],                 -- 0 = domingo … 6 = sábado; vazio/null = todos
  hora_inicio time, hora_fim time,
  data_inicio date, data_fim date,
  created_at timestamptz not null default now()
);
create index if not exists promocoes_emp_idx on public.promocoes(empresa_id) where ativo;
alter table public.promocoes enable row level security;
revoke all on public.promocoes from anon, authenticated;
grant select, insert, update, delete on public.promocoes to authenticated;
drop policy if exists promocoes_ler on public.promocoes;
create policy promocoes_ler on public.promocoes for select to authenticated using (empresa_id = (select private.empresa_id()));
drop policy if exists promocoes_escrever on public.promocoes;
create policy promocoes_escrever on public.promocoes for all to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')))
  with check (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

/**
 * Calcula o desconto de promoção de cada linha. MESMA regra de app/js/promocoes.js (o PDV
 * mostra o total igual ao do servidor, inclusive sem internet). Regras:
 *  - vale a promoção ativa no dia/horário (fuso da loja) que dá o MAIOR desconto para a linha (não acumulam);
 *  - leve_pague e atacado somam a quantidade do mesmo produto em todas as linhas;
 *  - combo: n = quantos conjuntos completos cabem; o desconto se divide pelo valor das linhas.
 * itens: [{"i": n, "produto_id", "categoria_id", "quantidade", "preco"}] → [{"i", "desconto", "promocao"}]
 */
create or replace function private.calcular_promocoes(p_emp uuid, p_itens jsonb, p_quando timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_local timestamp := p_quando at time zone private.fuso(p_emp);
  v_dia date := v_local::date; v_dow int := extract(dow from v_local)::int; v_hora time := v_local::time;
  pr public.promocoes; it jsonb; v_res jsonb := '{}'::jsonb; v_cand numeric; v_unit numeric; v_q numeric; v_total numeric;
  v_n numeric; v_normal numeric; v_lin numeric; v_acum numeric; c jsonb; v_linhas jsonb; v_cnt int; v_k int; v_base numeric;
  v_best jsonb; v_key text;
begin
  if p_itens is null or jsonb_array_length(p_itens) = 0 then return '[]'::jsonb; end if;
  for pr in select * from public.promocoes where empresa_id = p_emp and ativo
      and (data_inicio is null or v_dia >= data_inicio) and (data_fim is null or v_dia <= data_fim)
      and (dias_semana is null or cardinality(dias_semana) = 0 or v_dow = any(dias_semana))
      and (hora_inicio is null or hora_fim is null
           or (hora_inicio <= hora_fim and v_hora >= hora_inicio and v_hora < hora_fim)
           or (hora_inicio > hora_fim and (v_hora >= hora_inicio or v_hora < hora_fim)))
      order by created_at, id loop

    if pr.tipo in ('preco_horario','atacado','leve_pague') then
      for it in select * from jsonb_array_elements(p_itens) loop
        continue when not ((it->>'produto_id')::uuid = any(pr.produtos) or (pr.categoria_id is not null and (it->>'categoria_id')::uuid is not distinct from pr.categoria_id));
        v_cand := 0;
        -- quantidade total do mesmo produto na venda
        select coalesce(sum((x->>'quantidade')::numeric),0) into v_q from jsonb_array_elements(p_itens) x where x->>'produto_id' = it->>'produto_id';
        if pr.tipo in ('preco_horario','atacado') then
          if pr.tipo = 'preco_horario' or v_q >= coalesce(pr.qtd_minima, 0) then
            v_unit := (it->>'preco')::numeric - case when pr.preco is not null then pr.preco else round((it->>'preco')::numeric * (1 - pr.percentual/100), 2) end;
            if v_unit > 0 then v_cand := round((it->>'quantidade')::numeric * v_unit, 2); end if;
          end if;
        elsif pr.leve is not null and pr.pague is not null and pr.pague < pr.leve and v_q = trunc(v_q) then
          v_total := floor(v_q / pr.leve) * (pr.leve - pr.pague) * (it->>'preco')::numeric;      -- desconto do produto
          v_cand := round(v_total * (it->>'quantidade')::numeric / v_q, 2);                     -- parte desta linha
        end if;
        v_key := it->>'i';
        if v_cand > coalesce((v_res->v_key->>'desconto')::numeric, 0) then
          v_res := v_res || jsonb_build_object(v_key, jsonb_build_object('desconto', v_cand, 'promocao', pr.nome));
        end if;
      end loop;

    elsif pr.tipo = 'combo' and jsonb_typeof(pr.combo) = 'array' and jsonb_array_length(pr.combo) > 0 and pr.preco is not null then
      v_n := null; v_normal := 0;
      for c in select * from jsonb_array_elements(pr.combo) loop
        select coalesce(sum((x->>'quantidade')::numeric),0), max((x->>'preco')::numeric) into v_q, v_unit
          from jsonb_array_elements(p_itens) x where x->>'produto_id' = c->>'produto_id';
        v_n := least(coalesce(v_n, 1e9), floor(v_q / greatest((c->>'qtd')::numeric, 1)));
        v_normal := v_normal + coalesce(v_unit, 0) * greatest((c->>'qtd')::numeric, 1);
      end loop;
      continue when coalesce(v_n, 0) < 1 or v_normal <= pr.preco;
      v_total := round(v_n * (v_normal - pr.preco), 2);
      -- divide pelo valor das linhas dos produtos do combo
      select jsonb_agg(x order by (x->>'i')::int), sum((x->>'quantidade')::numeric * (x->>'preco')::numeric) into v_linhas, v_base
        from jsonb_array_elements(p_itens) x where x->>'produto_id' in (select y->>'produto_id' from jsonb_array_elements(pr.combo) y);
      v_cnt := jsonb_array_length(v_linhas); v_acum := 0; v_k := 0;
      for it in select * from jsonb_array_elements(v_linhas) loop
        v_k := v_k + 1;
        v_lin := case when v_k = v_cnt then v_total - v_acum
                      else round(v_total * (it->>'quantidade')::numeric * (it->>'preco')::numeric / nullif(v_base,0), 2) end;
        v_acum := v_acum + v_lin;
        v_key := it->>'i';
        if v_lin > coalesce((v_res->v_key->>'desconto')::numeric, 0) then
          v_res := v_res || jsonb_build_object(v_key, jsonb_build_object('desconto', v_lin, 'promocao', pr.nome));
        end if;
      end loop;
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('i', key::int, 'desconto',
           least((value->>'desconto')::numeric, (select round((x->>'quantidade')::numeric * (x->>'preco')::numeric, 2) from jsonb_array_elements(p_itens) x where x->>'i' = key)),
           'promocao', value->>'promocao') order by key::int), '[]'::jsonb)
    into v_best from jsonb_each(v_res);
  return v_best;
end $$;

-- ---------- registrar_venda: + promoções (sobre a 010) ----------
create or replace function public.registrar_venda(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_uid uuid := auth.uid();
  v_emp uuid := private.empresa_id();
  v_papel public.papel_usuario := private.papel();
  v_finalizar boolean := coalesce((p->>'finalizar')::boolean, false);
  v_venda_id uuid := nullif(p->>'venda_id','')::uuid;
  v_venda public.vendas;
  v_sessao uuid; v_numero bigint;
  v_item jsonb; v_prod public.produtos; v_pag jsonb;
  v_qtd numeric; v_bruto numeric; v_desc_item numeric;
  v_subtotal numeric := 0; v_desc_itens numeric := 0;
  v_desconto numeric := round(coalesce((p->>'desconto')::numeric,0),2);
  v_acrescimo numeric := round(coalesce((p->>'acrescimo')::numeric,0),2);
  v_total numeric; v_pago numeric := 0; v_dinheiro numeric := 0; v_troco numeric := 0; v_valor numeric;
  v_n int := 0; v_max_desc numeric; v_cliente uuid := nullif(p->>'cliente_id','')::uuid;
  m record; v_saldo numeric;
  v_id_local uuid := nullif(p->>'id_local','')::uuid;
  v_offline boolean := coalesce((p->>'offline')::boolean, false);
  v_quando timestamptz := now();
  v_ref timestamptz;
  v_total_cliente numeric := round(nullif(p->>'total_cliente','')::numeric, 2);
  v_ajuste numeric := 0;
  v_existente public.vendas;
  v_itens_promo jsonb := '[]'::jsonb; v_promos jsonb; v_pr jsonb; v_promo_total numeric := 0;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if v_finalizar and v_papel = 'atendente' then raise exception 'Atendentes podem apenas lançar pedidos'; end if;

  if v_finalizar and v_id_local is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_emp::text || v_id_local::text, 0));
    select * into v_existente from public.vendas where empresa_id = v_emp and id_local = v_id_local;
    if found and v_existente.status <> 'aberta' then
      delete from public.vendas_rascunho where id = v_id_local and empresa_id = v_emp;
      return jsonb_build_object('id', v_existente.id, 'numero', v_existente.numero, 'status', v_existente.status,
        'total', v_existente.total, 'troco', v_existente.troco, 'valor_pago', v_existente.valor_pago, 'ja_registrada', true);
    end if;
  end if;

  if jsonb_typeof(p->'itens') is distinct from 'array' or jsonb_array_length(p->'itens') = 0 then
    raise exception 'Adicione ao menos um item';
  end if;
  if jsonb_array_length(p->'itens') > 500 then raise exception 'Limite de 500 itens por venda'; end if;
  if v_desconto < 0 or v_acrescimo < 0 then raise exception 'Desconto/acréscimo inválido'; end if;

  if v_cliente is not null and not exists (select 1 from public.clientes where id = v_cliente and empresa_id = v_emp) then
    raise exception 'Cliente inválido';
  end if;

  if v_finalizar then
    select id into v_sessao from public.caixa_sessoes where operador_id = v_uid and status = 'aberto';
    if v_sessao is null and v_offline then
      select id into v_sessao from public.caixa_sessoes
        where id = nullif(p->>'sessao_id','')::uuid and operador_id = v_uid and empresa_id = v_emp;
    end if;
    if v_sessao is null then raise exception 'Abra o caixa antes de finalizar vendas'; end if;
    if v_offline then
      v_quando := least(now(), greatest(now() - interval '7 days', coalesce(nullif(p->>'realizada_em','')::timestamptz, now())));
    end if;
  end if;
  -- Horário de referência das promoções: o da tela do caixa (até 15 min atrás) ou o da venda offline
  v_ref := case when v_offline then v_quando
                else least(now(), greatest(now() - interval '15 minutes', coalesce(nullif(p->>'realizada_em','')::timestamptz, now()))) end;

  if v_venda_id is not null then
    select * into v_venda from public.vendas where id = v_venda_id and empresa_id = v_emp for update;
    if not found then raise exception 'Venda não encontrada'; end if;
    if v_venda.status <> 'aberta' then raise exception 'Esta venda já está %', v_venda.status; end if;
    if not v_offline and p ? 'alterado_em' and v_venda.alterado_em > (p->>'alterado_em')::timestamptz + interval '1 second' then
      raise exception 'Este pedido recebeu itens novos em outro aparelho. Abra o pedido de novo para conferir antes de receber.';
    end if;
    update public.venda_itens set removido = true, removido_em = now(), removido_por = v_uid
      where venda_id = v_venda_id and not removido;
  else
    update public.empresas set proximo_numero_venda = proximo_numero_venda + 1
      where id = v_emp returning proximo_numero_venda - 1 into v_numero;
    insert into public.vendas (empresa_id, numero, operador_id, status)
      values (v_emp, v_numero, v_uid, 'aberta') returning * into v_venda;
    v_venda_id := v_venda.id;
  end if;

  for v_item in select * from jsonb_array_elements(p->'itens') loop
    v_n := v_n + 1;
    select * into v_prod from public.produtos
      where id = nullif(v_item->>'produto_id','')::uuid and empresa_id = v_emp;
    if not found then raise exception 'Produto não encontrado (item %)', v_n; end if;
    if not v_prod.ativo and not v_offline then raise exception 'Produto inativo: %', v_prod.nome; end if;

    v_qtd := round((v_item->>'quantidade')::numeric, 3);
    if v_qtd is null or v_qtd <= 0 or v_qtd > 99999 then raise exception 'Quantidade inválida: %', v_prod.nome; end if;
    if v_prod.unidade in ('UN','CX','PCT','DZ','FD') and v_qtd <> trunc(v_qtd) then
      raise exception 'Quantidade deve ser inteira: %', v_prod.nome;
    end if;

    v_bruto := round(v_qtd * v_prod.preco_venda, 2);
    v_desc_item := round(coalesce((v_item->>'desconto')::numeric,0),2);
    if v_desc_item < 0 or v_desc_item > v_bruto then raise exception 'Desconto inválido: %', v_prod.nome; end if;

    insert into public.venda_itens (venda_id, empresa_id, produto_id, item, descricao, unidade,
      quantidade, preco_unitario, desconto, total, observacao)
    values (v_venda_id, v_emp, v_prod.id, v_n, v_prod.nome, v_prod.unidade,
      v_qtd, v_prod.preco_venda, v_desc_item, v_bruto - v_desc_item, left(v_item->>'observacao',200));

    v_itens_promo := v_itens_promo || jsonb_build_array(jsonb_build_object('i', v_n, 'produto_id', v_prod.id,
      'categoria_id', v_prod.categoria_id, 'quantidade', v_qtd, 'preco', v_prod.preco_venda));
    v_subtotal := v_subtotal + v_bruto;
    v_desc_itens := v_desc_itens + v_desc_item;
  end loop;

  v_desconto := v_desconto + v_desc_itens;
  if v_desconto > v_subtotal then raise exception 'Desconto maior que o total'; end if;

  -- O limite de desconto do caixa vale para o desconto manual (promoção é autorizada pelo gerente)
  if v_papel in ('caixa','atendente') and v_subtotal > 0 then
    select desconto_maximo_caixa into v_max_desc from public.empresas where id = v_emp;
    if (v_desconto / v_subtotal * 100) > v_max_desc then
      raise exception 'Desconto acima do limite permitido (% %%). Solicite a um gerente.', v_max_desc;
    end if;
  end if;

  -- Promoções (só nas linhas sem desconto manual)
  v_promos := private.calcular_promocoes(v_emp, v_itens_promo, v_ref);
  for v_pr in select * from jsonb_array_elements(v_promos) loop
    update public.venda_itens set desconto = desconto + (v_pr->>'desconto')::numeric, total = total - (v_pr->>'desconto')::numeric,
      promocao = v_pr->>'promocao'
    where venda_id = v_venda_id and item = (v_pr->>'i')::int and not removido and desconto = 0;
    if found then v_promo_total := v_promo_total + (v_pr->>'desconto')::numeric; end if;
  end loop;
  v_desconto := v_desconto + v_promo_total;
  if v_desconto > v_subtotal then raise exception 'Desconto maior que o total'; end if;

  v_total := v_subtotal - v_desconto + v_acrescimo;

  if v_finalizar and v_offline and v_total_cliente is not null and v_total_cliente <> v_total then
    v_ajuste := v_total_cliente - v_total;
    if abs(v_ajuste) > greatest(v_subtotal * 0.3, 1) then
      raise exception 'Preços mudaram muito desde a venda sem internet (diferença de R$ %). Confira com o gerente.', to_char(abs(v_ajuste), 'FM999G999G990D00');
    end if;
    if v_ajuste < 0 then v_desconto := v_desconto - v_ajuste; else v_acrescimo := v_acrescimo + v_ajuste; end if;
    v_total := v_subtotal - v_desconto + v_acrescimo;
  end if;

  update public.vendas set
    cliente_id = v_cliente,
    cpf_cnpj_consumidor = nullif(regexp_replace(coalesce(p->>'cpf_cnpj',''), '\D', '', 'g'),''),
    identificador = nullif(left(trim(coalesce(p->>'identificador','')),30),''),
    observacao = nullif(left(p->>'observacao',300),''),
    subtotal = v_subtotal, desconto = v_desconto, acrescimo = v_acrescimo, total = v_total, alterado_em = now()
  where id = v_venda_id;

  if v_finalizar then
    if jsonb_typeof(p->'pagamentos') = 'array' then
      for v_pag in select * from jsonb_array_elements(p->'pagamentos') loop
        v_valor := round((v_pag->>'valor')::numeric, 2);
        if v_valor is null or v_valor <= 0 then continue; end if;
        insert into public.venda_pagamentos (venda_id, empresa_id, forma, valor)
          values (v_venda_id, v_emp, (v_pag->>'forma')::public.forma_pagamento, v_valor);
        v_pago := v_pago + v_valor;
        if v_pag->>'forma' = 'dinheiro' then v_dinheiro := v_dinheiro + v_valor; end if;
      end loop;
    end if;

    if v_pago < v_total then
      raise exception 'Pagamento insuficiente: faltam R$ %', to_char(v_total - v_pago, 'FM999G999G990D00');
    end if;
    v_troco := v_pago - v_total;
    if v_troco > v_dinheiro then raise exception 'Troco só é permitido em pagamentos em dinheiro'; end if;

    update public.vendas set status = 'finalizada', sessao_id = v_sessao, operador_id = v_uid,
      valor_pago = v_pago, troco = v_troco, finalizada_em = v_quando,
      id_local = coalesce(v_id_local, id_local), offline = v_offline,
      status_pedido = case when canal in ('delivery','retirada') then 'entregue' else status_pedido end,
      status_historico = case when canal in ('delivery','retirada')
        then coalesce(status_historico,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('status','entregue','em',now()))
        else status_historico end,
      pagamento_status = case when canal in ('delivery','retirada') then 'pago' else pagamento_status end
    where id = v_venda_id;

    for m in
      select vi.produto_id, sum(vi.quantidade) q
      from public.venda_itens vi join public.produtos pr on pr.id = vi.produto_id
      where vi.venda_id = v_venda_id and not vi.removido and pr.controla_estoque
      group by vi.produto_id order by vi.produto_id
    loop
      update public.produtos set estoque_atual = estoque_atual - m.q
        where id = m.produto_id returning estoque_atual into v_saldo;
      insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade,
        saldo_anterior, saldo_posterior, venda_id, usuario_id)
      values (v_emp, m.produto_id, 'venda', -m.q, v_saldo + m.q, v_saldo, v_venda_id, v_uid);
    end loop;

    if v_id_local is not null then delete from public.vendas_rascunho where id = v_id_local and empresa_id = v_emp; end if;
    if v_offline then
      perform private.auditar(v_emp, 'venda.contingencia', 'vendas', v_venda_id::text,
        jsonb_build_object('realizada_em', v_quando, 'ajuste_preco', v_ajuste, 'total', v_total));
    end if;
  end if;

  select * into v_venda from public.vendas where id = v_venda_id;
  return jsonb_build_object('id', v_venda.id, 'numero', v_venda.numero, 'status', v_venda.status,
    'total', v_venda.total, 'troco', v_venda.troco, 'valor_pago', v_venda.valor_pago, 'ajuste', v_ajuste, 'promocoes', v_promo_total);
end $function$;

-- =====================================================================
-- 3. Antifraude
-- =====================================================================
/** Gaveta aberta fora de uma venda (botão "Abrir gaveta"). */
create or replace function public.registrar_gaveta(p_motivo text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  perform private.auditar(v_emp, 'gaveta.abrir', 'caixa_sessoes',
    (select id::text from public.caixa_sessoes where operador_id = auth.uid() and status = 'aberto'), jsonb_build_object('motivo', left(p_motivo,200)));
end $$;

create or replace function private.alertas_antifraude(p_emp uuid, p_ini timestamptz, p_fim timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text := private.fuso(p_emp); v_ops jsonb; v_alertas jsonb := '[]'::jsonb; r record;
  v_media_canc numeric; v_media_desc numeric;
begin
  -- Indicadores por operador
  with fin as (select * from public.vendas where empresa_id = p_emp and status = 'finalizada' and finalizada_em >= p_ini and finalizada_em < p_fim),
  canc as (select * from public.vendas where empresa_id = p_emp and status = 'cancelada' and cancelada_em >= p_ini and cancelada_em < p_fim),
  aud as (select * from public.auditoria where empresa_id = p_emp and created_at >= p_ini and created_at < p_fim),
  cx as (select * from public.caixa_sessoes where empresa_id = p_emp and status = 'fechado' and fechado_em >= p_ini and fechado_em < p_fim),
  ops as (select distinct operador_id id from fin union select operador_id from canc union select operador_id from cx
          union select usuario_id from aud where acao in ('mesa.remover_item','gaveta.abrir'))
  select coalesce(jsonb_agg(jsonb_build_object(
      'operador_id', o.id, 'operador', coalesce(pf.nome, '—'),
      'vendas', (select count(*) from fin where operador_id = o.id),
      'faturamento', (select coalesce(sum(total),0) from fin where operador_id = o.id),
      'subtotal', (select coalesce(sum(subtotal),0) from fin where operador_id = o.id),
      'descontos', (select coalesce(sum(v.desconto) - sum((select coalesce(sum(vi.desconto),0) from public.venda_itens vi where vi.venda_id = v.id and vi.promocao is not null and not vi.removido)),0) from fin v where v.operador_id = o.id),
      'cancelamentos', (select count(*) from canc where operador_id = o.id),
      'cancelamentos_valor', (select coalesce(sum(total),0) from canc where operador_id = o.id),
      'itens_removidos', (select count(*) from aud where usuario_id = o.id and acao = 'mesa.remover_item'),
      'gaveta', (select count(*) from aud where usuario_id = o.id and acao = 'gaveta.abrir'),
      'caixas', (select count(*) from cx where operador_id = o.id),
      'caixa_diferenca', (select coalesce(sum(diferenca),0) from cx where operador_id = o.id),
      'caixas_falta', (select count(*) from cx where operador_id = o.id and diferenca <= -1)
    ) order by pf.nome), '[]'::jsonb)
  into v_ops from ops o left join public.perfis pf on pf.id = o.id where o.id is not null;

  select avg(case when (x->>'vendas')::int + (x->>'cancelamentos')::int > 0 then (x->>'cancelamentos')::numeric / ((x->>'vendas')::int + (x->>'cancelamentos')::int) end),
         avg(case when (x->>'subtotal')::numeric > 0 then (x->>'descontos')::numeric / (x->>'subtotal')::numeric end)
    into v_media_canc, v_media_desc from jsonb_array_elements(v_ops) x;

  -- Regras por operador
  for r in select x from jsonb_array_elements(v_ops) x loop
    declare o jsonb := r.x; v_tx numeric; v_dx numeric;
    begin
      v_tx := case when (o->>'vendas')::int + (o->>'cancelamentos')::int > 0 then (o->>'cancelamentos')::numeric / ((o->>'vendas')::int + (o->>'cancelamentos')::int) end;
      if (o->>'cancelamentos')::int >= 3 and v_tx > greatest(2 * coalesce(v_media_canc,0), 0.05) then
        v_alertas := v_alertas || jsonb_build_object('nivel', 'medio', 'tipo', 'cancelamentos', 'operador', o->>'operador',
          'texto', format('%s cancelamentos (%s%% das vendas), acima do normal da loja', o->>'cancelamentos', round(v_tx*100)), 'valor', (o->>'cancelamentos_valor')::numeric);
      end if;
      v_dx := case when (o->>'subtotal')::numeric > 0 then (o->>'descontos')::numeric / (o->>'subtotal')::numeric end;
      if (o->>'descontos')::numeric >= 20 and v_dx > greatest(2 * coalesce(v_media_desc,0), 0.03) then
        v_alertas := v_alertas || jsonb_build_object('nivel', 'medio', 'tipo', 'descontos', 'operador', o->>'operador',
          'texto', format('Descontos de %s%% do valor vendido, acima do normal da loja', round(v_dx*1000)/10), 'valor', (o->>'descontos')::numeric);
      end if;
      if (o->>'itens_removidos')::int >= 5 then
        v_alertas := v_alertas || jsonb_build_object('nivel', 'medio', 'tipo', 'itens_removidos', 'operador', o->>'operador',
          'texto', format('Tirou %s itens já lançados de mesas/comandas', o->>'itens_removidos'), 'valor', null);
      end if;
      if (o->>'gaveta')::int >= 3 then
        v_alertas := v_alertas || jsonb_build_object('nivel', 'medio', 'tipo', 'gaveta', 'operador', o->>'operador',
          'texto', format('Abriu a gaveta %s vezes sem venda', o->>'gaveta'), 'valor', null);
      end if;
      if (o->>'caixas_falta')::int >= 3 then
        v_alertas := v_alertas || jsonb_build_object('nivel', 'alto', 'tipo', 'falta_recorrente', 'operador', o->>'operador',
          'texto', format('Faltou dinheiro em %s fechamentos de caixa (total %s)', o->>'caixas_falta', to_char((o->>'caixa_diferenca')::numeric, 'FM999G990D00')), 'valor', (o->>'caixa_diferenca')::numeric);
      end if;
    end;
  end loop;

  -- Fechamentos com diferença relevante
  for r in select c.*, pf.nome from public.caixa_sessoes c left join public.perfis pf on pf.id = c.operador_id
           where c.empresa_id = p_emp and c.status = 'fechado' and c.fechado_em >= p_ini and c.fechado_em < p_fim and abs(c.diferenca) >= 5
           order by c.fechado_em loop
    v_alertas := v_alertas || jsonb_build_object('nivel', case when abs(r.diferenca) >= 50 then 'alto' else 'medio' end, 'tipo', 'caixa',
      'operador', r.nome, 'quando', r.fechado_em, 'valor', r.diferenca,
      'texto', format('Caixa fechado com %s de R$ %s', case when r.diferenca < 0 then 'falta' else 'sobra' end, to_char(abs(r.diferenca), 'FM999G990D00')));
  end loop;

  -- Venda paga em dinheiro cancelada logo depois (até 30 min)
  for r in select v.*, pf.nome from public.vendas v left join public.perfis pf on pf.id = v.operador_id
           where v.empresa_id = p_emp and v.status = 'cancelada' and v.cancelada_em >= p_ini and v.cancelada_em < p_fim
             and v.finalizada_em is not null and v.cancelada_em - v.finalizada_em <= interval '30 minutes'
             and exists (select 1 from public.venda_pagamentos pg where pg.venda_id = v.id and pg.forma = 'dinheiro')
           order by v.cancelada_em loop
    v_alertas := v_alertas || jsonb_build_object('nivel', 'alto', 'tipo', 'cancelamento_dinheiro', 'operador', r.nome, 'quando', r.cancelada_em, 'valor', r.total,
      'texto', format('Venda nº %s paga em dinheiro cancelada %s min depois (%s)', r.numero,
        greatest(1, round(extract(epoch from r.cancelada_em - r.finalizada_em) / 60)), coalesce(r.motivo_cancelamento, 'sem motivo')));
  end loop;

  -- Vendas sem internet que entraram com ajuste de preço
  for r in select a.*, pf.nome from public.auditoria a left join public.perfis pf on pf.id = a.usuario_id
           where a.empresa_id = p_emp and a.acao = 'venda.contingencia' and a.created_at >= p_ini and a.created_at < p_fim
             and abs(coalesce((a.detalhes->>'ajuste_preco')::numeric,0)) >= 1 loop
    v_alertas := v_alertas || jsonb_build_object('nivel', 'info', 'tipo', 'contingencia', 'operador', r.nome, 'quando', r.created_at,
      'valor', (r.detalhes->>'ajuste_preco')::numeric, 'texto', 'Venda feita sem internet entrou com ajuste de preço');
  end loop;

  return jsonb_build_object('operadores', v_ops, 'alertas', v_alertas,
    'media_cancelamento', round(coalesce(v_media_canc,0) * 100, 1), 'media_desconto', round(coalesce(v_media_desc,0) * 100, 1));
end $$;

create or replace function public.painel_antifraude(p_ini timestamptz, p_fim timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p_fim <= p_ini or p_fim - p_ini > interval '400 days' then raise exception 'Período inválido'; end if;
  return private.alertas_antifraude(v_emp, p_ini, p_fim);
end $$;

-- =====================================================================
-- 2. Resumo do dia
-- =====================================================================
create or replace function private.resumo_dados(p_emp uuid, p_dia date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text := private.fuso(p_emp); v_i timestamptz; v_f timestamptz; r jsonb; e public.empresas; v_hoje date;
begin
  select * into e from public.empresas where id = p_emp;
  v_i := p_dia::timestamp at time zone v_tz; v_f := (p_dia + 1)::timestamp at time zone v_tz;
  v_hoje := (private.agora_local(p_emp))::date;
  with fin as (select * from public.vendas where empresa_id = p_emp and status = 'finalizada' and finalizada_em >= v_i and finalizada_em < v_f),
  ant as (select * from public.vendas where empresa_id = p_emp and status = 'finalizada' and finalizada_em >= v_i - interval '7 days' and finalizada_em < v_f - interval '7 days'),
  itens as (select vi.quantidade, vi.total, vi.descricao, coalesce(vi.custo_unitario, p.preco_custo, 0) custo from public.venda_itens vi join fin on fin.id = vi.venda_id
            left join public.produtos p on p.id = vi.produto_id where not vi.removido)
  select jsonb_build_object(
    'loja', coalesce(e.nome_fantasia, e.razao_social), 'dia', p_dia,
    'faturamento', (select coalesce(sum(total),0) from fin), 'vendas', (select count(*) from fin),
    'ticket', (select coalesce(round(avg(total),2),0) from fin), 'descontos', (select coalesce(sum(desconto),0) from fin),
    'faturamento_semana_passada', (select coalesce(sum(total),0) from ant), 'vendas_semana_passada', (select count(*) from ant),
    'lucro_bruto', (select coalesce(round(sum(total - quantidade * custo),2),0) from itens),
    'itens_sem_custo', (select count(*) from itens where custo = 0),
    'por_forma', coalesce((select jsonb_agg(jsonb_build_object('forma', forma, 'valor', valor) order by valor desc) from (
        select pg.forma::text forma, sum(pg.valor) - case when pg.forma='dinheiro' then (select coalesce(sum(troco),0) from fin) else 0 end valor
        from public.venda_pagamentos pg join fin on fin.id = pg.venda_id group by pg.forma) x), '[]'),
    'top_produtos', coalesce((select jsonb_agg(jsonb_build_object('produto', descricao, 'quantidade', q, 'total', t) order by t desc) from (
        select descricao, sum(quantidade) q, sum(total) t from itens group by descricao order by 3 desc limit 5) x), '[]'),
    'cancelamentos', (select count(*) from public.vendas where empresa_id = p_emp and status = 'cancelada' and cancelada_em >= v_i and cancelada_em < v_f),
    'cancelamentos_valor', (select coalesce(sum(total),0) from public.vendas where empresa_id = p_emp and status = 'cancelada' and cancelada_em >= v_i and cancelada_em < v_f),
    'caixas', coalesce((select jsonb_agg(jsonb_build_object('operador', pf.nome, 'diferenca', c.diferenca, 'status', c.status) order by c.aberto_em)
        from public.caixa_sessoes c left join public.perfis pf on pf.id = c.operador_id
        where c.empresa_id = p_emp and ((c.fechado_em >= v_i and c.fechado_em < v_f) or (c.status = 'aberto'))), '[]'),
    'estoque_baixo', coalesce((select jsonb_agg(jsonb_build_object('produto', nome, 'estoque', estoque_atual, 'minimo', estoque_minimo, 'unidade', unidade) order by estoque_atual - estoque_minimo)
        from (select * from public.produtos where empresa_id = p_emp and ativo and controla_estoque and estoque_atual <= estoque_minimo
              order by estoque_atual - estoque_minimo limit 10) x), '[]'),
    'estoque_baixo_total', (select count(*) from public.produtos where empresa_id = p_emp and ativo and controla_estoque and estoque_atual <= estoque_minimo),
    'vencendo', coalesce((select jsonb_agg(jsonb_build_object('produto', p.nome, 'validade', l.validade, 'saldo', l.saldo, 'unidade', p.unidade) order by l.validade)
        from (select * from public.lotes where empresa_id = p_emp and status = 'ativo' and saldo > 0 and validade <= v_hoje + 7 order by validade limit 10) l
        join public.produtos p on p.id = l.produto_id), '[]'),
    'contas_vencendo', coalesce((select jsonb_agg(jsonb_build_object('descricao', descricao, 'valor', valor, 'vencimento', vencimento) order by vencimento)
        from (select * from public.contas_pagar where empresa_id = p_emp and pago_em is null and vencimento <= v_hoje + 2 order by vencimento limit 10) x), '[]'),
    'fiado_aberto', (select coalesce(sum(valor),0) from public.fiado_lancamentos where empresa_id = p_emp),
    'perdas', (select coalesce(sum(valor),0) from public.perdas where empresa_id = p_emp and created_at >= v_i and created_at < v_f),
    'alertas', (private.alertas_antifraude(p_emp, v_i, v_f))->'alertas'
  ) into r;
  return r;
end $$;

create or replace function public.resumo_do_dia(p_dia date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  return private.resumo_dados(v_emp, coalesce(p_dia, (private.agora_local(v_emp))::date));
end $$;

create or replace function public.salvar_resumo_config(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_emails jsonb := '[]'::jsonb; x text;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  for x in select lower(trim(value)) from jsonb_array_elements_text(coalesce(p->'emails','[]'::jsonb)) loop
    if x ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and not v_emails ? x then v_emails := v_emails || to_jsonb(x); end if;
  end loop;
  if jsonb_array_length(v_emails) > 5 then raise exception 'Até 5 e-mails'; end if;
  if coalesce((p->>'ativo')::boolean, false) and jsonb_array_length(v_emails) = 0 then raise exception 'Informe ao menos um e-mail'; end if;
  if nullif(p->>'fuso','') is not null and not exists (select 1 from pg_timezone_names where name = p->>'fuso') then raise exception 'Fuso horário inválido'; end if;
  update public.empresas set
    resumo_config = jsonb_build_object('ativo', coalesce((p->>'ativo')::boolean, false), 'emails', v_emails,
      'hora', least(greatest(coalesce((p->>'hora')::int, 22), 0), 23),
      'app_url', case when p->>'app_url' ~ '^https?://[^\s"<>]+$' then left(p->>'app_url', 300) end),
    fuso = coalesce(nullif(p->>'fuso',''), fuso)
  where id = v_emp;
end $$;

/** Uso exclusivo da Edge Function (service role): lojas cujo resumo deve sair agora. */
create or replace function public.resumos_pendentes()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb := '[]'::jsonb; e record; v_local timestamp; v_dia date;
begin
  for e in select * from public.empresas where coalesce((resumo_config->>'ativo')::boolean, false)
           and jsonb_array_length(coalesce(resumo_config->'emails','[]'::jsonb)) > 0 loop
    v_local := now() at time zone coalesce(e.fuso, 'America/Sao_Paulo');
    continue when extract(hour from v_local)::int < coalesce((e.resumo_config->>'hora')::int, 22);
    -- antes das 6h o resumo é do dia anterior
    v_dia := case when coalesce((e.resumo_config->>'hora')::int, 22) < 6 then v_local::date - 1 else v_local::date end;
    continue when e.resumo_enviado_em is not null and e.resumo_enviado_em >= v_dia;
    r := r || jsonb_build_object('empresa_id', e.id, 'dia', v_dia, 'emails', e.resumo_config->'emails', 'app_url', e.resumo_config->>'app_url',
      'dados', private.resumo_dados(e.id, v_dia));
  end loop;
  return r;
end $$;

create or replace function public.resumo_marcar_enviado(p_emp uuid, p_dia date)
returns void language sql security definer set search_path = '' as $$
  update public.empresas set resumo_enviado_em = p_dia where id = p_emp;
$$;

create or replace function public.resumo_teste_dados(p_emp uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('emails', resumo_config->'emails', 'app_url', resumo_config->>'app_url', 'dados', private.resumo_dados(id, (now() at time zone fuso)::date))
  from public.empresas where id = p_emp;
$$;

-- ---------- Quem lançou (liga aos perfis para mostrar o nome) ----------
do $$
declare t text;
begin
  foreach t in array array['fiado_lancamentos','conferencias','contas_pagar','lotes','perdas','notas_entrada'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_usuario_fk') then
      execute format('alter table public.%I add constraint %I foreign key (usuario_id) references public.perfis(id) on delete set null', t, t || '_usuario_fk');
    end if;
  end loop;
end $$;

-- ---------- Permissões de execução ----------
revoke execute on all functions in schema private from public, anon;
revoke execute on function public.registrar_lote(uuid,text,date,numeric,boolean), public.registrar_perda(uuid,numeric,text,text,uuid),
  public.validade_painel(int), public.perdas_resumo(date,date), public.registrar_entrada_nfe(jsonb), public.sugestao_compra(int,int),
  public.curva_abc(timestamptz,timestamptz), public.produtos_parados(int), public.receber_fiado(uuid,numeric,text,text),
  public.ajustar_fiado(uuid,numeric,text), public.fiado_config_cliente(uuid,numeric,int,boolean), public.fiado_clientes(boolean),
  public.fiado_saldo_cliente(uuid), public.salvar_taxas(jsonb), public.resultado_periodo(date,date), public.fluxo_caixa(date,date,int),
  public.pagamentos_periodo(date,date), public.registrar_venda(jsonb), public.registrar_gaveta(text), public.painel_antifraude(timestamptz,timestamptz),
  public.resumo_do_dia(date), public.salvar_resumo_config(jsonb), public.resumos_pendentes(), public.resumo_marcar_enviado(uuid,date),
  public.resumo_teste_dados(uuid)
from public, anon;
grant execute on function public.registrar_lote(uuid,text,date,numeric,boolean), public.registrar_perda(uuid,numeric,text,text,uuid),
  public.validade_painel(int), public.perdas_resumo(date,date), public.registrar_entrada_nfe(jsonb), public.sugestao_compra(int,int),
  public.curva_abc(timestamptz,timestamptz), public.produtos_parados(int), public.receber_fiado(uuid,numeric,text,text),
  public.ajustar_fiado(uuid,numeric,text), public.fiado_config_cliente(uuid,numeric,int,boolean), public.fiado_clientes(boolean),
  public.fiado_saldo_cliente(uuid), public.salvar_taxas(jsonb), public.resultado_periodo(date,date), public.fluxo_caixa(date,date,int),
  public.pagamentos_periodo(date,date), public.registrar_venda(jsonb), public.registrar_gaveta(text), public.painel_antifraude(timestamptz,timestamptz),
  public.resumo_do_dia(date), public.salvar_resumo_config(jsonb)
to authenticated;
-- Só a Edge Function (service role) envia resumos
revoke execute on function public.resumos_pendentes(), public.resumo_marcar_enviado(uuid,date), public.resumo_teste_dados(uuid) from authenticated;
grant execute on function public.resumos_pendentes(), public.resumo_marcar_enviado(uuid,date), public.resumo_teste_dados(uuid) to service_role;
