-- =====================================================================
-- PDV — Regras de negócio (funções RPC seguras)
-- Toda escrita sensível passa por aqui: preços vêm do banco, nunca do navegador.
-- =====================================================================

-- Itens retirados de comandas ficam registrados em vez de apagados
alter table public.venda_itens add column removido boolean not null default false;
alter table public.venda_itens add column removido_em timestamptz;
alter table public.venda_itens add column removido_por uuid references public.perfis(id);
create index venda_itens_ativos_idx on public.venda_itens(venda_id) where not removido;

-- ---------- Onboarding: cria empresa + usuário admin ----------
create or replace function public.criar_empresa(
  p_razao_social text, p_nome_fantasia text default null, p_cnpj text default null,
  p_segmento text default null, p_nome_usuario text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_emp uuid; v_email text;
begin
  if v_uid is null then raise exception 'Não autenticado'; end if;
  if exists (select 1 from public.perfis where id = v_uid) then
    raise exception 'Este usuário já está vinculado a uma empresa';
  end if;
  if coalesce(length(trim(p_razao_social)),0) < 2 then raise exception 'Informe o nome da empresa'; end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.empresas (razao_social, nome_fantasia, cnpj, segmento)
  values (trim(p_razao_social), nullif(trim(coalesce(p_nome_fantasia,'')),''),
          nullif(regexp_replace(coalesce(p_cnpj,''), '\D', '', 'g'),''), p_segmento)
  returning id into v_emp;

  insert into public.perfis (id, empresa_id, nome, email, papel)
  values (v_uid, v_emp, coalesce(nullif(trim(p_nome_usuario),''), split_part(v_email,'@',1)), v_email, 'admin');

  insert into public.config_fiscal (empresa_id) values (v_emp);
  insert into public.fiscal_credenciais (empresa_id) values (v_emp);

  insert into public.categorias (empresa_id, nome, cor, ordem)
  select v_emp, c.nome, c.cor, c.ordem
  from (
    select * from (values
      ('padaria','Pães','#b45309',1),('padaria','Bolos e Doces','#db2777',2),('padaria','Salgados','#ea580c',3),
      ('padaria','Frios','#0891b2',4),('padaria','Bebidas','#2563eb',5),
      ('lanchonete','Lanches','#ea580c',1),('lanchonete','Porções','#b45309',2),('lanchonete','Bebidas','#2563eb',3),('lanchonete','Sobremesas','#db2777',4),
      ('cafe','Cafés','#78350f',1),('cafe','Salgados','#ea580c',2),('cafe','Doces','#db2777',3),('cafe','Bebidas','#2563eb',4),
      ('restaurante','Pratos','#16a34a',1),('restaurante','Porções','#b45309',2),('restaurante','Bebidas','#2563eb',3),('restaurante','Sobremesas','#db2777',4),
      ('mercado','Mercearia','#b45309',1),('mercado','Bebidas','#2563eb',2),('mercado','Hortifruti','#16a34a',3),
      ('mercado','Frios e Laticínios','#0891b2',4),('mercado','Açougue','#dc2626',5),('mercado','Limpeza','#7c3aed',6),('mercado','Higiene','#0d9488',7)
    ) t(seg, nome, cor, ordem)
  ) c
  where c.seg = case
      when p_segmento in ('mercadinho','supermercado','mercado') then 'mercado'
      when p_segmento in ('padaria','lanchonete','cafe','restaurante') then p_segmento
      else 'lanchonete' end;

  perform private.auditar(v_emp, 'empresa.criar', 'empresas', v_emp::text, null);
  return v_emp;
end $$;

-- ---------- Caixa ----------
create or replace function public.abrir_caixa(p_valor numeric default 0, p_terminal text default null)
returns public.caixa_sessoes language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); r public.caixa_sessoes;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente,caixa}') then
    raise exception 'Sem permissão para abrir caixa';
  end if;
  if coalesce(p_valor,0) < 0 then raise exception 'Valor de abertura inválido'; end if;
  if exists (select 1 from public.caixa_sessoes where operador_id = auth.uid() and status = 'aberto') then
    raise exception 'Você já possui um caixa aberto';
  end if;
  insert into public.caixa_sessoes (empresa_id, operador_id, terminal, valor_abertura)
  values (v_emp, auth.uid(), left(p_terminal, 40), round(coalesce(p_valor,0),2))
  returning * into r;
  perform private.auditar(v_emp, 'caixa.abrir', 'caixa_sessoes', r.id::text, jsonb_build_object('valor', r.valor_abertura));
  return r;
end $$;

create or replace function public.resumo_caixa(p_sessao_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_emp uuid := private.empresa_id();
  s public.caixa_sessoes;
  v_formas jsonb; v_qtd int; v_total numeric; v_troco numeric; v_canc int;
  v_sangria numeric; v_suprimento numeric; v_dinheiro numeric;
begin
  select * into s from public.caixa_sessoes where id = p_sessao_id and empresa_id = v_emp;
  if not found then raise exception 'Caixa não encontrado'; end if;
  if s.operador_id <> auth.uid() and not private.tem_papel('{admin,gerente}') then
    raise exception 'Sem permissão';
  end if;

  select count(*), coalesce(sum(total),0), coalesce(sum(troco),0)
    into v_qtd, v_total, v_troco
    from public.vendas where sessao_id = s.id and status = 'finalizada';
  select count(*) into v_canc from public.vendas where sessao_id = s.id and status = 'cancelada';

  select coalesce(jsonb_object_agg(forma, valor), '{}'::jsonb) into v_formas from (
    select pg.forma::text forma,
           sum(pg.valor) - case when pg.forma = 'dinheiro' then v_troco else 0 end valor
    from public.venda_pagamentos pg join public.vendas v on v.id = pg.venda_id
    where v.sessao_id = s.id and v.status = 'finalizada'
    group by pg.forma) x;

  select coalesce(sum(valor) filter (where tipo='sangria'),0), coalesce(sum(valor) filter (where tipo='suprimento'),0)
    into v_sangria, v_suprimento from public.caixa_movimentos where sessao_id = s.id;

  v_dinheiro := coalesce((v_formas->>'dinheiro')::numeric, 0);

  return jsonb_build_object(
    'sessao_id', s.id, 'status', s.status, 'aberto_em', s.aberto_em, 'fechado_em', s.fechado_em,
    'valor_abertura', s.valor_abertura,
    'vendas_qtd', v_qtd, 'vendas_total', v_total, 'canceladas_qtd', v_canc,
    'por_forma', v_formas,
    'sangrias', v_sangria, 'suprimentos', v_suprimento,
    'esperado_dinheiro', s.valor_abertura + v_dinheiro + v_suprimento - v_sangria,
    'valor_informado', s.valor_informado, 'diferenca', s.diferenca);
end $$;

create or replace function public.movimentar_caixa(p_tipo public.tipo_mov_caixa, p_valor numeric, p_motivo text default null)
returns public.caixa_movimentos language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_sessao uuid; r public.caixa_movimentos;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Sem permissão'; end if;
  if coalesce(p_valor,0) <= 0 then raise exception 'Informe um valor maior que zero'; end if;
  select id into v_sessao from public.caixa_sessoes where operador_id = auth.uid() and status = 'aberto';
  if v_sessao is null then raise exception 'Nenhum caixa aberto'; end if;
  insert into public.caixa_movimentos (empresa_id, sessao_id, tipo, valor, motivo, usuario_id)
  values (v_emp, v_sessao, p_tipo, round(p_valor,2), left(p_motivo,200), auth.uid()) returning * into r;
  perform private.auditar(v_emp, 'caixa.'||p_tipo::text, 'caixa_movimentos', r.id::text,
                          jsonb_build_object('valor', r.valor, 'motivo', r.motivo));
  return r;
end $$;

create or replace function public.fechar_caixa(p_valor_informado numeric, p_observacao text default null, p_sessao_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); s public.caixa_sessoes; v_res jsonb; v_esperado numeric;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if p_sessao_id is null then
    select * into s from public.caixa_sessoes where operador_id = auth.uid() and status = 'aberto' for update;
  else
    select * into s from public.caixa_sessoes where id = p_sessao_id and empresa_id = v_emp for update;
    if found and s.operador_id <> auth.uid() and not private.tem_papel('{admin,gerente}') then
      raise exception 'Sem permissão para fechar o caixa de outro operador';
    end if;
  end if;
  if s.id is null or s.status <> 'aberto' then raise exception 'Nenhum caixa aberto'; end if;
  if coalesce(p_valor_informado,-1) < 0 then raise exception 'Informe o valor contado em dinheiro'; end if;

  v_res := public.resumo_caixa(s.id);
  v_esperado := (v_res->>'esperado_dinheiro')::numeric;

  update public.caixa_sessoes set status = 'fechado', fechado_em = now(),
    valor_esperado = v_esperado, valor_informado = round(p_valor_informado,2),
    diferenca = round(p_valor_informado,2) - v_esperado, observacao = left(p_observacao,300)
  where id = s.id;

  perform private.auditar(v_emp, 'caixa.fechar', 'caixa_sessoes', s.id::text,
    jsonb_build_object('esperado', v_esperado, 'informado', p_valor_informado));
  return public.resumo_caixa(s.id);
end $$;

-- ---------- Vendas ----------
-- p = { venda_id?, finalizar, itens:[{produto_id, quantidade, desconto?, observacao?}],
--       pagamentos:[{forma, valor}], desconto?, acrescimo?, cliente_id?, cpf_cnpj?, identificador?, observacao? }
create or replace function public.registrar_venda(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if v_finalizar and v_papel = 'atendente' then raise exception 'Atendentes podem apenas lançar pedidos'; end if;
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
    if v_sessao is null then raise exception 'Abra o caixa antes de finalizar vendas'; end if;
  end if;

  -- cria ou reabre a venda (comanda)
  if v_venda_id is not null then
    select * into v_venda from public.vendas where id = v_venda_id and empresa_id = v_emp for update;
    if not found then raise exception 'Venda não encontrada'; end if;
    if v_venda.status <> 'aberta' then raise exception 'Esta venda já está %', v_venda.status; end if;
    -- itens anteriores da comanda ficam registrados como removidos (trilha antifraude)
    update public.venda_itens set removido = true, removido_em = now(), removido_por = v_uid
      where venda_id = v_venda_id and not removido;
  else
    update public.empresas set proximo_numero_venda = proximo_numero_venda + 1
      where id = v_emp returning proximo_numero_venda - 1 into v_numero;
    insert into public.vendas (empresa_id, numero, operador_id, status)
      values (v_emp, v_numero, v_uid, 'aberta') returning * into v_venda;
    v_venda_id := v_venda.id;
  end if;

  -- itens: preço SEMPRE do cadastro
  for v_item in select * from jsonb_array_elements(p->'itens') loop
    v_n := v_n + 1;
    select * into v_prod from public.produtos
      where id = nullif(v_item->>'produto_id','')::uuid and empresa_id = v_emp;
    if not found then raise exception 'Produto não encontrado (item %)', v_n; end if;
    if not v_prod.ativo then raise exception 'Produto inativo: %', v_prod.nome; end if;

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

    v_subtotal := v_subtotal + v_bruto;
    v_desc_itens := v_desc_itens + v_desc_item;
  end loop;

  v_desconto := v_desconto + v_desc_itens;
  if v_desconto > v_subtotal then raise exception 'Desconto maior que o total'; end if;

  -- limite de desconto para caixa/atendente
  if v_papel in ('caixa','atendente') and v_subtotal > 0 then
    select desconto_maximo_caixa into v_max_desc from public.empresas where id = v_emp;
    if (v_desconto / v_subtotal * 100) > v_max_desc then
      raise exception 'Desconto acima do limite permitido (% %%). Solicite a um gerente.', v_max_desc;
    end if;
  end if;

  v_total := v_subtotal - v_desconto + v_acrescimo;

  update public.vendas set
    cliente_id = v_cliente,
    cpf_cnpj_consumidor = nullif(regexp_replace(coalesce(p->>'cpf_cnpj',''), '\D', '', 'g'),''),
    identificador = nullif(left(trim(coalesce(p->>'identificador','')),30),''),
    observacao = nullif(left(p->>'observacao',300),''),
    subtotal = v_subtotal, desconto = v_desconto, acrescimo = v_acrescimo, total = v_total
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
      valor_pago = v_pago, troco = v_troco, finalizada_em = now()
    where id = v_venda_id;

    -- baixa de estoque (ordem fixa evita deadlock)
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
  end if;

  select * into v_venda from public.vendas where id = v_venda_id;
  return jsonb_build_object('id', v_venda.id, 'numero', v_venda.numero, 'status', v_venda.status,
    'total', v_venda.total, 'troco', v_venda.troco, 'valor_pago', v_venda.valor_pago);
end $$;

create or replace function public.cancelar_venda(p_venda_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v public.vendas; m record; v_saldo numeric;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if coalesce(length(trim(p_motivo)),0) < 3 then raise exception 'Informe o motivo do cancelamento'; end if;
  select * into v from public.vendas where id = p_venda_id and empresa_id = v_emp for update;
  if not found then raise exception 'Venda não encontrada'; end if;
  if v.status = 'cancelada' then raise exception 'Venda já cancelada'; end if;

  if v.status = 'finalizada' then
    if not private.tem_papel('{admin,gerente}') then
      raise exception 'Somente gerente ou administrador pode cancelar vendas finalizadas';
    end if;
    if exists (select 1 from public.documentos_fiscais where venda_id = v.id and status = 'autorizado') then
      raise exception 'Cancele primeiro o documento fiscal desta venda';
    end if;
    for m in
      select vi.produto_id, sum(vi.quantidade) q
      from public.venda_itens vi join public.produtos pr on pr.id = vi.produto_id
      where vi.venda_id = v.id and not vi.removido and pr.controla_estoque
      group by vi.produto_id order by vi.produto_id
    loop
      update public.produtos set estoque_atual = estoque_atual + m.q
        where id = m.produto_id returning estoque_atual into v_saldo;
      insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade,
        saldo_anterior, saldo_posterior, venda_id, usuario_id, motivo)
      values (v_emp, m.produto_id, 'cancelamento', m.q, v_saldo - m.q, v_saldo, v.id, auth.uid(), 'Cancelamento da venda #'||v.numero);
    end loop;
  elsif not private.tem_papel('{admin,gerente,caixa}') then
    raise exception 'Sem permissão para cancelar pedidos';
  end if;

  update public.vendas set status = 'cancelada', cancelada_em = now(), cancelada_por = auth.uid(),
    motivo_cancelamento = left(trim(p_motivo),300) where id = v.id;
  perform private.auditar(v_emp, 'venda.cancelar', 'vendas', v.id::text,
    jsonb_build_object('numero', v.numero, 'total', v.total, 'status_anterior', v.status, 'motivo', p_motivo));
end $$;

-- ---------- Estoque ----------
create or replace function public.ajustar_estoque(p_produto_id uuid, p_tipo text, p_quantidade numeric, p_motivo text default null)
returns numeric language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); pr public.produtos; v_novo numeric; v_delta numeric;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p_tipo not in ('entrada','saida','ajuste') then raise exception 'Tipo inválido'; end if;
  if p_quantidade is null or p_quantidade < 0 or (p_tipo <> 'ajuste' and p_quantidade = 0) then
    raise exception 'Quantidade inválida';
  end if;
  select * into pr from public.produtos where id = p_produto_id and empresa_id = v_emp for update;
  if not found then raise exception 'Produto não encontrado'; end if;

  v_novo := case p_tipo when 'entrada' then pr.estoque_atual + p_quantidade
                        when 'saida'   then pr.estoque_atual - p_quantidade
                        else p_quantidade end;
  v_delta := v_novo - pr.estoque_atual;

  update public.produtos set estoque_atual = v_novo where id = pr.id;
  insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, saldo_anterior, saldo_posterior, motivo, usuario_id)
  values (v_emp, pr.id, p_tipo::public.tipo_mov_estoque, v_delta, pr.estoque_atual, v_novo, left(p_motivo,200), auth.uid());
  return v_novo;
end $$;

create or replace function public.produtos_estoque_baixo()
returns setof public.produtos language sql stable security invoker set search_path = '' as $$
  select * from public.produtos
  where controla_estoque and ativo and estoque_atual <= estoque_minimo
  order by estoque_atual - estoque_minimo, nome
  limit 200
$$;

-- ---------- Relatórios ----------
create or replace function public.relatorio_vendas(p_inicio timestamptz, p_fim timestamptz, p_tz text default 'America/Sao_Paulo')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); r jsonb;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p_fim <= p_inicio or p_fim - p_inicio > interval '400 days' then raise exception 'Período inválido'; end if;

  with fin as (
    select * from public.vendas
    where empresa_id = v_emp and status = 'finalizada' and finalizada_em >= p_inicio and finalizada_em < p_fim
  ), canc as (
    select * from public.vendas
    where empresa_id = v_emp and status = 'cancelada' and cancelada_em >= p_inicio and cancelada_em < p_fim
  ), itens as (
    select vi.*, coalesce(pr.preco_custo,0) custo from public.venda_itens vi
    join fin on fin.id = vi.venda_id left join public.produtos pr on pr.id = vi.produto_id
    where not vi.removido
  )
  select jsonb_build_object(
    'resumo', (select jsonb_build_object(
        'vendas', count(*), 'faturamento', coalesce(sum(total),0),
        'ticket_medio', coalesce(round(avg(total),2),0), 'descontos', coalesce(sum(desconto),0),
        'custo_estimado', (select coalesce(round(sum(quantidade*custo),2),0) from itens),
        'canceladas', (select count(*) from canc), 'canceladas_valor', (select coalesce(sum(total),0) from canc))
      from fin),
    'por_forma', (select coalesce(jsonb_agg(jsonb_build_object('forma', forma, 'valor', valor) order by valor desc),'[]') from (
        select pg.forma::text forma,
               sum(pg.valor) - case when pg.forma='dinheiro' then (select coalesce(sum(troco),0) from fin) else 0 end valor
        from public.venda_pagamentos pg join fin on fin.id = pg.venda_id group by pg.forma) x),
    'por_dia', (select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'vendas', n, 'total', t) order by dia),'[]') from (
        select (finalizada_em at time zone p_tz)::date dia, count(*) n, sum(total) t from fin group by 1) x),
    'por_hora', (select coalesce(jsonb_agg(jsonb_build_object('hora', h, 'vendas', n, 'total', t) order by h),'[]') from (
        select extract(hour from finalizada_em at time zone p_tz)::int h, count(*) n, sum(total) t from fin group by 1) x),
    'top_produtos', (select coalesce(jsonb_agg(jsonb_build_object('produto', descricao, 'quantidade', q, 'total', t) order by t desc),'[]') from (
        select descricao, sum(quantidade) q, sum(total) t from itens group by descricao order by t desc limit 10) x),
    'por_operador', (select coalesce(jsonb_agg(jsonb_build_object('operador', nome, 'vendas', n, 'total', t) order by t desc),'[]') from (
        select coalesce(pf.nome,'—') nome, count(*) n, sum(fin.total) t
        from fin left join public.perfis pf on pf.id = fin.operador_id group by 1) x)
  ) into r;
  return r;
end $$;

-- ---------- Credenciais fiscais (somente escrita) ----------
create or replace function public.salvar_credenciais_fiscais(p_token_homologacao text default null, p_token_producao text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Sem permissão'; end if;
  insert into public.fiscal_credenciais (empresa_id) values (v_emp) on conflict do nothing;
  update public.fiscal_credenciais set
    token_homologacao = coalesce(nullif(trim(p_token_homologacao),''), token_homologacao),
    token_producao    = coalesce(nullif(trim(p_token_producao),''), token_producao),
    updated_at = now()
  where empresa_id = v_emp;
  perform private.auditar(v_emp, 'fiscal.credenciais', 'fiscal_credenciais', v_emp::text, null);
end $$;

create or replace function public.credenciais_fiscais_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('homologacao', token_homologacao is not null, 'producao', token_producao is not null)
  from public.fiscal_credenciais where empresa_id = private.empresa_id()
$$;

-- ---------- Triggers de proteção e auditoria ----------
create or replace function private.produto_estoque_inicial()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.estoque_atual <> 0 then
    insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, saldo_anterior, saldo_posterior, motivo, usuario_id)
    values (new.empresa_id, new.id, 'ajuste', new.estoque_atual, 0, new.estoque_atual, 'Estoque inicial', auth.uid());
  end if;
  return new;
end $$;
create trigger t_estoque_inicial after insert on public.produtos
  for each row execute function private.produto_estoque_inicial();

create or replace function private.produto_auditar_preco()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.preco_venda is distinct from old.preco_venda then
    perform private.auditar(new.empresa_id, 'produto.preco', 'produtos', new.id::text,
      jsonb_build_object('produto', new.nome, 'de', old.preco_venda, 'para', new.preco_venda));
  end if;
  return new;
end $$;
create trigger t_auditar_preco after update of preco_venda on public.produtos
  for each row execute function private.produto_auditar_preco();

create or replace function private.perfil_proteger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.empresa_id <> old.empresa_id then raise exception 'Operação não permitida'; end if;
  if auth.uid() is not null and new.id = auth.uid() and (new.papel <> old.papel or not new.ativo) then
    raise exception 'Você não pode alterar seu próprio nível de acesso';
  end if;
  if old.papel = 'admin' and old.ativo and (new.papel <> 'admin' or not new.ativo) and not exists (
    select 1 from public.perfis where empresa_id = old.empresa_id and papel = 'admin' and ativo and id <> old.id) then
    raise exception 'A empresa precisa de ao menos um administrador ativo';
  end if;
  if new.papel <> old.papel or new.ativo <> old.ativo then
    perform private.auditar(new.empresa_id, 'usuario.alterar', 'perfis', new.id::text,
      jsonb_build_object('nome', new.nome, 'papel', new.papel, 'ativo', new.ativo));
  end if;
  return new;
end $$;
create trigger t_perfil_proteger before update on public.perfis
  for each row execute function private.perfil_proteger();

-- ---------- Permissões de execução ----------
revoke execute on function
  public.criar_empresa(text,text,text,text,text), public.abrir_caixa(numeric,text),
  public.resumo_caixa(uuid), public.movimentar_caixa(public.tipo_mov_caixa,numeric,text),
  public.fechar_caixa(numeric,text,uuid), public.registrar_venda(jsonb),
  public.cancelar_venda(uuid,text), public.ajustar_estoque(uuid,text,numeric,text),
  public.produtos_estoque_baixo(), public.relatorio_vendas(timestamptz,timestamptz,text),
  public.salvar_credenciais_fiscais(text,text), public.credenciais_fiscais_status()
from public, anon;

grant execute on function
  public.criar_empresa(text,text,text,text,text), public.abrir_caixa(numeric,text),
  public.resumo_caixa(uuid), public.movimentar_caixa(public.tipo_mov_caixa,numeric,text),
  public.fechar_caixa(numeric,text,uuid), public.registrar_venda(jsonb),
  public.cancelar_venda(uuid,text), public.ajustar_estoque(uuid,text,numeric,text),
  public.produtos_estoque_baixo(), public.relatorio_vendas(timestamptz,timestamptz,text),
  public.salvar_credenciais_fiscais(text,text), public.credenciais_fiscais_status()
to authenticated;

revoke execute on all functions in schema private from public, anon;
