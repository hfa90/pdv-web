-- =====================================================================
-- 009 · Assinatura do cliente (faturas, pacotes adicionais) e
--       faturamento consolidado de todas as lojas para o fornecedor.
-- =====================================================================

-- ---------- Dia de vencimento da mensalidade ----------
alter table public.empresas add column if not exists dia_vencimento smallint not null default 10
  check (dia_vencimento between 1 and 28);
revoke update (dia_vencimento) on public.empresas from authenticated;

-- ---------- Faturas (mensalidades e avulsas) ----------
create table if not exists public.faturas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  competencia date,                       -- 1º dia do mês de referência (mensalidade)
  descricao text not null,
  valor numeric(10,2) not null check (valor >= 0),
  vencimento date not null,
  status text not null default 'pendente' check (status in ('pendente','pago','cancelado')),
  pago_em timestamptz,
  forma text,
  link_pagamento text check (link_pagamento is null or link_pagamento ~* '^https://'),
  linha_digitavel text,
  created_at timestamptz not null default now()
);
create unique index if not exists faturas_mensal_uk on public.faturas(empresa_id, competencia) where competencia is not null and status <> 'cancelado';
create index if not exists faturas_empresa_idx on public.faturas(empresa_id, vencimento desc);
create index if not exists faturas_status_idx on public.faturas(status, vencimento);
alter table public.faturas enable row level security;
revoke all on public.faturas from anon, authenticated;
grant select on public.faturas to authenticated;
create policy faturas_ler on public.faturas for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

-- ---------- Pedidos de pacotes adicionais ----------
create table if not exists public.pacotes_solicitacoes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  pacote text not null,
  quantidade int not null default 1 check (quantidade between 1 and 20),
  detalhes text,
  status text not null default 'pendente' check (status in ('pendente','aprovado','recusado','cancelado')),
  solicitado_por uuid references public.perfis(id) on delete set null,
  resposta text,
  respondido_em timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists pacotes_empresa_idx on public.pacotes_solicitacoes(empresa_id, created_at desc);
create index if not exists pacotes_status_idx on public.pacotes_solicitacoes(status, created_at desc);
alter table public.pacotes_solicitacoes enable row level security;
revoke all on public.pacotes_solicitacoes from anon, authenticated;
grant select on public.pacotes_solicitacoes to authenticated;
create policy pacotes_ler on public.pacotes_solicitacoes for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

-- Pacotes que o cliente pode pedir (o preço exibido vem do assets/config.js; aqui só a lista válida)
create or replace function private.pacote_valido(p text)
returns boolean language sql immutable as $$
  select p in ('delivery','garcom','nota_fiscal','caixa_extra','notebook','gaveta','notas_extras','balanca','treinamento','etiquetas',
               'plano_sistema','plano_sistema_nota','plano_combo')
$$;

-- =====================================================================
-- Lado do cliente
-- =====================================================================
create or replace function public.minha_assinatura()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); e public.empresas; r jsonb; v_ini timestamptz;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  select * into e from public.empresas where id = v_emp;
  v_ini := date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
  select jsonb_build_object(
    'status', e.status_conta, 'plano', e.plano, 'valor_mensal', e.valor_mensal,
    'dia_vencimento', e.dia_vencimento, 'teste_expira_em', e.teste_expira_em, 'ativado_em', e.ativado_em,
    'cliente_desde', e.created_at, 'modulos', e.modulos, 'segmento', e.segmento,
    'bloqueio', private.conta_liberada(e.id),
    'garcom', private.modulo_garcom(e.id),
    'delivery', (e.status_conta = 'teste' or e.plano = 'interno' or coalesce((e.modulos->>'delivery')::boolean, false)),
    'proxima_fatura', (select to_jsonb(f) from public.faturas f where f.empresa_id = v_emp and f.status = 'pendente' order by f.vencimento limit 1),
    'em_aberto', (select jsonb_build_object('qtd', count(*), 'valor', coalesce(sum(valor),0),
                    'vencidas', count(*) filter (where vencimento < (now() at time zone 'America/Sao_Paulo')::date))
                  from public.faturas where empresa_id = v_emp and status = 'pendente'),
    'faturas', (select coalesce(jsonb_agg(to_jsonb(f) order by f.vencimento desc), '[]') from
                  (select * from public.faturas where empresa_id = v_emp and status <> 'cancelado' order by vencimento desc limit 24) f),
    'solicitacoes', (select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]') from
                  (select * from public.pacotes_solicitacoes where empresa_id = v_emp order by created_at desc limit 30) s),
    'uso', jsonb_build_object(
      'usuarios', (select count(*) from public.perfis where empresa_id = v_emp and ativo),
      'produtos', (select count(*) from public.produtos where empresa_id = v_emp and ativo),
      'vendas_mes', (select count(*) from public.vendas where empresa_id = v_emp and status = 'finalizada' and finalizada_em >= v_ini),
      'faturamento_mes', (select coalesce(sum(total),0) from public.vendas where empresa_id = v_emp and status = 'finalizada' and finalizada_em >= v_ini),
      'notas_mes', (select count(*) from public.documentos_fiscais where empresa_id = v_emp and status = 'autorizado' and created_at >= v_ini),
      'caixas_abertos', (select count(*) from public.caixa_sessoes where empresa_id = v_emp and status = 'aberto'))
  ) into r;
  return r;
end $$;

create or replace function public.solicitar_pacote(p_pacote text, p_quantidade int default 1, p_detalhes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_id uuid; e public.empresas; p public.perfis;
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Só o administrador da loja pode contratar pacotes'; end if;
  if not private.pacote_valido(p_pacote) then raise exception 'Pacote inválido'; end if;
  if exists (select 1 from public.pacotes_solicitacoes where empresa_id = v_emp and pacote = p_pacote and status = 'pendente') then
    raise exception 'Já existe um pedido deste pacote aguardando aprovação';
  end if;
  if (select count(*) from public.pacotes_solicitacoes where empresa_id = v_emp and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Muitos pedidos hoje. Fale com o suporte.';
  end if;
  select * into e from public.empresas where id = v_emp;
  select * into p from public.perfis where id = (select auth.uid());
  insert into public.pacotes_solicitacoes (empresa_id, pacote, quantidade, detalhes, solicitado_por)
  values (v_emp, p_pacote, greatest(1, least(coalesce(p_quantidade,1), 20)), left(nullif(trim(coalesce(p_detalhes,'')),''), 500), p.id)
  returning id into v_id;
  -- Aparece também como contato no painel do fornecedor
  insert into public.leads (nome, loja, segmento, whatsapp, email, documento, interesse, mensagem, origem, status, empresa_id)
  values (coalesce(p.nome, 'Cliente'), coalesce(e.nome_fantasia, e.razao_social), e.segmento, e.telefone, coalesce(p.email, e.email), e.cnpj,
          'Pacote adicional: ' || p_pacote, left(nullif(trim(coalesce(p_detalhes,'')),''), 500), 'app', 'novo', v_emp);
  perform private.auditar(v_emp, 'pacote.solicitar', 'pacotes_solicitacoes', v_id::text, jsonb_build_object('pacote', p_pacote));
  return v_id;
end $$;

create or replace function public.cancelar_solicitacao_pacote(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.tem_papel('{admin}') then raise exception 'Sem permissão'; end if;
  update public.pacotes_solicitacoes set status = 'cancelado', respondido_em = now()
  where id = p_id and empresa_id = private.empresa_id() and status = 'pendente';
end $$;

-- =====================================================================
-- Lado do fornecedor (painel Plataforma)
-- =====================================================================

-- Faturamento consolidado de todas as lojas (só leitura, só para o fornecedor)
create or replace function public.plataforma_faturamento(
  p_inicio timestamptz, p_fim timestamptz, p_segmento text default null, p_tz text default 'America/Sao_Paulo')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb; h date := (now() at time zone p_tz)::date;
  t_hoje timestamptz := (h)::timestamp at time zone p_tz;
  t_sem timestamptz := (h - ((extract(isodow from h)::int) - 1))::timestamp at time zone p_tz;
  t_mes timestamptz := date_trunc('month', h)::timestamp at time zone p_tz;
  t_mes_ant timestamptz := (date_trunc('month', h) - interval '1 month')::timestamp at time zone p_tz;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if p_fim <= p_inicio or p_fim - p_inicio > interval '400 days' then raise exception 'Período inválido'; end if;

  with lojas as (
    select e.* from public.empresas e
    where p_segmento is null or e.segmento = p_segmento
       or (p_segmento = 'mercado' and e.segmento in ('mercadinho','supermercado','mercado'))
  ), fin as (
    select v.* from public.vendas v join lojas l on l.id = v.empresa_id
    where v.status = 'finalizada' and v.finalizada_em >= p_inicio and v.finalizada_em < p_fim
  ), ref as (   -- atalhos: hoje, semana, mês e mês anterior (independente do período escolhido)
    select v.total, v.finalizada_em from public.vendas v join lojas l on l.id = v.empresa_id
    where v.status = 'finalizada' and v.finalizada_em >= least(t_mes_ant, t_sem)
  )
  select jsonb_build_object(
    'resumo', (select jsonb_build_object('faturamento', coalesce(sum(total),0), 'vendas', count(*),
                 'ticket_medio', coalesce(round(avg(total),2),0), 'lojas_com_venda', count(distinct empresa_id),
                 'descontos', coalesce(sum(desconto),0)) from fin),
    'atalhos', (select jsonb_build_object(
        'hoje',        coalesce(sum(total) filter (where finalizada_em >= t_hoje),0),
        'hoje_vendas', count(*) filter (where finalizada_em >= t_hoje),
        'semana',      coalesce(sum(total) filter (where finalizada_em >= t_sem),0),
        'semana_vendas', count(*) filter (where finalizada_em >= t_sem),
        'mes',         coalesce(sum(total) filter (where finalizada_em >= t_mes),0),
        'mes_vendas',  count(*) filter (where finalizada_em >= t_mes),
        'mes_anterior',coalesce(sum(total) filter (where finalizada_em >= t_mes_ant and finalizada_em < t_mes),0),
        'mes_anterior_parcial', coalesce(sum(total) filter (where finalizada_em >= t_mes_ant
                          and finalizada_em < t_mes_ant + (now() - t_mes)),0)) from ref),
    'lojas_total', (select count(*) from lojas),
    'por_dia', (select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'vendas', n, 'total', t) order by dia),'[]') from (
        select (finalizada_em at time zone p_tz)::date dia, count(*) n, sum(total) t from fin group by 1) x),
    'por_hora', (select coalesce(jsonb_agg(jsonb_build_object('hora', hh, 'vendas', n, 'total', t) order by hh),'[]') from (
        select extract(hour from finalizada_em at time zone p_tz)::int hh, count(*) n, sum(total) t from fin group by 1) x),
    'por_segmento', (select coalesce(jsonb_agg(jsonb_build_object('segmento', s, 'vendas', n, 'total', t, 'lojas', nl) order by t desc),'[]') from (
        select coalesce(l.segmento,'outros') s, count(f.id) n, coalesce(sum(f.total),0) t, count(distinct l.id) nl
        from lojas l left join fin f on f.empresa_id = l.id group by 1) x),
    'por_forma', (select coalesce(jsonb_agg(jsonb_build_object('forma', forma, 'valor', valor) order by valor desc),'[]') from (
        select pg.forma::text forma, sum(pg.valor) - case when pg.forma = 'dinheiro' then (select coalesce(sum(troco),0) from fin) else 0 end valor
        from public.venda_pagamentos pg join fin on fin.id = pg.venda_id group by pg.forma) x),
    'por_loja', (select coalesce(jsonb_agg(to_jsonb(x) order by x.total desc, x.loja),'[]') from (
        select l.id, coalesce(l.nome_fantasia, l.razao_social) loja, l.segmento, l.status_conta, l.plano, l.municipio, l.uf,
               count(f.id) vendas, coalesce(sum(f.total),0) total, coalesce(round(avg(f.total),2),0) ticket,
               max(f.finalizada_em) ultima_venda,
               (select coalesce(sum(v2.total),0) from public.vendas v2 where v2.empresa_id = l.id and v2.status = 'finalizada' and v2.finalizada_em >= t_hoje) hoje,
               (select coalesce(sum(v2.total),0) from public.vendas v2 where v2.empresa_id = l.id and v2.status = 'finalizada' and v2.finalizada_em >= t_sem) semana,
               (select coalesce(sum(v2.total),0) from public.vendas v2 where v2.empresa_id = l.id and v2.status = 'finalizada' and v2.finalizada_em >= t_mes) mes
        from lojas l left join fin f on f.empresa_id = l.id
        group by l.id, l.nome_fantasia, l.razao_social, l.segmento, l.status_conta, l.plano, l.municipio, l.uf) x)
  ) into r;
  return r;
end $$;

-- Detalhe de uma loja para o fornecedor (por dia, formas, produtos)
create or replace function public.plataforma_loja_vendas(p_id uuid, p_inicio timestamptz, p_fim timestamptz, p_tz text default 'America/Sao_Paulo')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if p_fim <= p_inicio or p_fim - p_inicio > interval '400 days' then raise exception 'Período inválido'; end if;
  with fin as (
    select * from public.vendas where empresa_id = p_id and status = 'finalizada' and finalizada_em >= p_inicio and finalizada_em < p_fim
  )
  select jsonb_build_object(
    'resumo', (select jsonb_build_object('faturamento', coalesce(sum(total),0), 'vendas', count(*), 'ticket_medio', coalesce(round(avg(total),2),0)) from fin),
    'por_dia', (select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'vendas', n, 'total', t) order by dia),'[]') from (
        select (finalizada_em at time zone p_tz)::date dia, count(*) n, sum(total) t from fin group by 1) x),
    'por_forma', (select coalesce(jsonb_agg(jsonb_build_object('forma', forma, 'valor', valor) order by valor desc),'[]') from (
        select pg.forma::text forma, sum(pg.valor) - case when pg.forma = 'dinheiro' then (select coalesce(sum(troco),0) from fin) else 0 end valor
        from public.venda_pagamentos pg join fin on fin.id = pg.venda_id group by pg.forma) x),
    'top_produtos', (select coalesce(jsonb_agg(jsonb_build_object('produto', descricao, 'quantidade', q, 'total', t) order by t desc),'[]') from (
        select vi.descricao, sum(vi.quantidade) q, sum(vi.total) t from public.venda_itens vi join fin on fin.id = vi.venda_id
        where not vi.removido group by vi.descricao order by t desc limit 10) x)
  ) into r;
  return r;
end $$;

-- Faturas
create or replace function public.plataforma_faturas(p_status text default null)
returns table (id uuid, empresa_id uuid, loja text, competencia date, descricao text, valor numeric, vencimento date,
               status text, pago_em timestamptz, forma text, link_pagamento text, linha_digitavel text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return query select f.id, f.empresa_id, coalesce(e.nome_fantasia, e.razao_social), f.competencia, f.descricao, f.valor, f.vencimento,
      f.status, f.pago_em, f.forma, f.link_pagamento, f.linha_digitavel, f.created_at
    from public.faturas f join public.empresas e on e.id = f.empresa_id
    where p_status is null or f.status = p_status
       or (p_status = 'vencido' and f.status = 'pendente' and f.vencimento < (now() at time zone 'America/Sao_Paulo')::date)
    order by (f.status = 'pendente') desc, f.vencimento desc limit 500;
end $$;

-- Gera as mensalidades do mês para todos os clientes ativos com mensalidade
create or replace function public.plataforma_gerar_faturas(p_competencia date default null)
returns int language plpgsql security definer set search_path = '' as $$
declare c date := date_trunc('month', coalesce(p_competencia, (now() at time zone 'America/Sao_Paulo')::date))::date; n int;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  insert into public.faturas (empresa_id, competencia, descricao, valor, vencimento)
  select e.id, c, 'Mensalidade ' || to_char(c, 'MM/YYYY') || ' · plano ' || e.plano, e.valor_mensal,
         (c + (e.dia_vencimento - 1))
  from public.empresas e
  where e.status_conta = 'ativo' and coalesce(e.valor_mensal,0) > 0 and e.plano <> 'interno'
    and not exists (select 1 from public.faturas f where f.empresa_id = e.id and f.competencia = c and f.status <> 'cancelado');
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.plataforma_nova_fatura(p_empresa uuid, p_descricao text, p_valor numeric, p_vencimento date,
  p_link text default null, p_linha text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if coalesce(trim(p_descricao),'') = '' or p_valor is null or p_valor < 0 then raise exception 'Preencha descrição e valor'; end if;
  insert into public.faturas (empresa_id, descricao, valor, vencimento, link_pagamento, linha_digitavel)
  values (p_empresa, trim(p_descricao), p_valor, p_vencimento, nullif(trim(coalesce(p_link,'')),''), nullif(trim(coalesce(p_linha,'')),''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.plataforma_fatura_acao(p_id uuid, p_acao text, p_forma text default null,
  p_link text default null, p_linha text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if p_acao = 'pagar' then
    update public.faturas set status = 'pago', pago_em = now(), forma = coalesce(nullif(p_forma,''), forma) where id = p_id;
  elsif p_acao = 'reabrir' then
    update public.faturas set status = 'pendente', pago_em = null where id = p_id;
  elsif p_acao = 'cancelar' then
    update public.faturas set status = 'cancelado' where id = p_id;
  elsif p_acao = 'cobranca' then
    update public.faturas set link_pagamento = nullif(trim(coalesce(p_link,'')),''), linha_digitavel = nullif(trim(coalesce(p_linha,'')),'') where id = p_id;
  else raise exception 'Ação inválida';
  end if;
end $$;

create or replace function public.plataforma_dia_vencimento(p_id uuid, p_dia int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  update public.empresas set dia_vencimento = greatest(1, least(p_dia, 28)) where id = p_id;
end $$;

-- Pedidos de pacotes
create or replace function public.plataforma_solicitacoes(p_status text default 'pendente')
returns table (id uuid, empresa_id uuid, loja text, segmento text, telefone text, pacote text, quantidade int, detalhes text,
               status text, resposta text, created_at timestamptz, solicitante text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return query select s.id, s.empresa_id, coalesce(e.nome_fantasia, e.razao_social), e.segmento, e.telefone, s.pacote, s.quantidade,
      s.detalhes, s.status, s.resposta, s.created_at, p.nome
    from public.pacotes_solicitacoes s join public.empresas e on e.id = s.empresa_id left join public.perfis p on p.id = s.solicitado_por
    where p_status is null or s.status = p_status
    order by s.created_at desc limit 300;
end $$;

create or replace function public.plataforma_responder_solicitacao(p_id uuid, p_status text, p_resposta text default null,
  p_acrescimo numeric default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.pacotes_solicitacoes;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if p_status not in ('aprovado','recusado') then raise exception 'Status inválido'; end if;
  update public.pacotes_solicitacoes set status = p_status, resposta = nullif(trim(coalesce(p_resposta,'')),''), respondido_em = now()
  where id = p_id and status = 'pendente' returning * into s;
  if s.id is null then raise exception 'Pedido não encontrado ou já respondido'; end if;
  if p_status = 'aprovado' then
    if s.pacote in ('delivery','garcom') then
      update public.empresas set modulos = coalesce(modulos,'{}'::jsonb) || jsonb_build_object(s.pacote, true) where id = s.empresa_id;
    end if;
    if coalesce(p_acrescimo,0) > 0 then
      update public.empresas set valor_mensal = coalesce(valor_mensal,0) + p_acrescimo where id = s.empresa_id;
    end if;
  end if;
end $$;

-- Resumo do fornecedor ganha contas a receber e pedidos de pacotes
create or replace function public.plataforma_financeiro()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare h date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return jsonb_build_object(
    'a_receber', (select coalesce(sum(valor),0) from public.faturas where status = 'pendente'),
    'vencido', (select coalesce(sum(valor),0) from public.faturas where status = 'pendente' and vencimento < h),
    'vencidas_qtd', (select count(*) from public.faturas where status = 'pendente' and vencimento < h),
    'recebido_mes', (select coalesce(sum(valor),0) from public.faturas where status = 'pago' and pago_em >= date_trunc('month', h)),
    'pacotes_pendentes', (select count(*) from public.pacotes_solicitacoes where status = 'pendente'));
end $$;

-- ---------- Permissões ----------
revoke execute on function public.minha_assinatura(), public.solicitar_pacote(text,int,text), public.cancelar_solicitacao_pacote(uuid),
  public.plataforma_faturamento(timestamptz,timestamptz,text,text), public.plataforma_loja_vendas(uuid,timestamptz,timestamptz,text),
  public.plataforma_faturas(text), public.plataforma_gerar_faturas(date), public.plataforma_nova_fatura(uuid,text,numeric,date,text,text),
  public.plataforma_fatura_acao(uuid,text,text,text,text), public.plataforma_dia_vencimento(uuid,int),
  public.plataforma_solicitacoes(text), public.plataforma_responder_solicitacao(uuid,text,text,numeric), public.plataforma_financeiro()
  from public, anon;
grant execute on function public.minha_assinatura(), public.solicitar_pacote(text,int,text), public.cancelar_solicitacao_pacote(uuid),
  public.plataforma_faturamento(timestamptz,timestamptz,text,text), public.plataforma_loja_vendas(uuid,timestamptz,timestamptz,text),
  public.plataforma_faturas(text), public.plataforma_gerar_faturas(date), public.plataforma_nova_fatura(uuid,text,numeric,date,text,text),
  public.plataforma_fatura_acao(uuid,text,text,text,text), public.plataforma_dia_vencimento(uuid,int),
  public.plataforma_solicitacoes(text), public.plataforma_responder_solicitacao(uuid,text,text,numeric), public.plataforma_financeiro()
  to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.empresa_id(), private.papel(), private.tem_papel(public.papel_usuario[]),
  private.eh_admin_plataforma() to authenticated;

-- Painel do fornecedor: dia de vencimento de cada loja
create or replace function public.plataforma_lojas_vencimento()
returns table (id uuid, dia_vencimento smallint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return query select e.id, e.dia_vencimento from public.empresas e;
end $$;
revoke execute on function public.plataforma_lojas_vencimento() from public, anon;
grant execute on function public.plataforma_lojas_vencimento() to authenticated;

alter function private.pacote_valido(text) set search_path = '';
