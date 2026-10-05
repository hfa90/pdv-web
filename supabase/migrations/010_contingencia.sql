-- =====================================================================
-- 010 · Contingência: vendas sem internet, queda de energia e troca de aparelho
--
-- 1) Idempotência: cada venda nasce no navegador com um id_local (UUID).
--    Se a energia cair no meio do envio, ou a venda for reenviada pela fila
--    offline, ou outro aparelho concluir a mesma venda, o servidor devolve a
--    venda já registrada em vez de criar outra (nunca duplica, nunca estorna).
-- 2) Vendas feitas sem internet entram depois com a data/hora real da venda.
--    Se o preço de algum produto mudou nesse intervalo, o total cobrado do
--    cliente prevalece e a diferença vira desconto/acréscimo auditado.
-- 3) Rascunho da venda em andamento (itens + pagamentos já recebidos) guardado
--    no servidor a cada alteração, para continuar em outro computador, tablet
--    ou celular se o aparelho do caixa der pane.
-- =====================================================================

-- ---------- Vendas: identificador local e marca de contingência ----------
alter table public.vendas add column if not exists id_local uuid;
alter table public.vendas add column if not exists offline boolean not null default false;
create unique index if not exists vendas_id_local_uk on public.vendas(empresa_id, id_local) where id_local is not null;

-- ---------- Rascunhos (venda em andamento em algum aparelho) ----------
create table if not exists public.vendas_rascunho (
  id uuid primary key,                         -- = id_local da venda
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  operador_id uuid not null,
  operador_nome text,
  aparelho text not null,                      -- aparelho que está com a venda agora
  aparelho_nome text,
  dados jsonb not null,                        -- itens, cliente, desconto, pagamentos parciais
  itens int not null default 0,
  total numeric(12,2) not null default 0,
  pago numeric(12,2) not null default 0,
  versao int not null default 1,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists vendas_rascunho_emp_idx on public.vendas_rascunho(empresa_id, atualizado_em desc);
alter table public.vendas_rascunho enable row level security;
revoke all on public.vendas_rascunho from anon, authenticated;
grant select on public.vendas_rascunho to authenticated;
drop policy if exists rascunho_ler on public.vendas_rascunho;
create policy rascunho_ler on public.vendas_rascunho for select to authenticated
  using (empresa_id = (select private.empresa_id()));

/** Grava o rascunho. Se outro aparelho assumiu a venda, não sobrescreve e avisa. */
create or replace function public.salvar_rascunho(p_id uuid, p_aparelho text, p_aparelho_nome text, p_dados jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := private.empresa_id();
  v_r public.vendas_rascunho;
  v_v public.vendas;
  v_itens int; v_total numeric; v_pago numeric;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if p_id is null or coalesce(p_aparelho,'') = '' then raise exception 'Rascunho inválido'; end if;
  if octet_length(p_dados::text) > 300000 then raise exception 'Venda grande demais para o rascunho'; end if;

  -- Já concluída (aqui ou em outro aparelho)?
  select * into v_v from public.vendas where empresa_id = v_emp and id_local = p_id and status = 'finalizada';
  if found then
    delete from public.vendas_rascunho where id = p_id and empresa_id = v_emp;
    return jsonb_build_object('situacao', 'finalizada', 'numero', v_v.numero, 'total', v_v.total);
  end if;

  select * into v_r from public.vendas_rascunho where id = p_id for update;
  if found and v_r.empresa_id <> v_emp then raise exception 'Acesso negado'; end if;
  if found and v_r.aparelho <> p_aparelho then
    return jsonb_build_object('situacao', 'assumida', 'aparelho_nome', v_r.aparelho_nome, 'operador_nome', v_r.operador_nome, 'em', v_r.atualizado_em);
  end if;

  v_itens := coalesce(jsonb_array_length(case when jsonb_typeof(p_dados->'itens') = 'array' then p_dados->'itens' end), 0);
  -- Sem itens e sem pagamento: não há o que guardar
  if v_itens = 0 and coalesce(jsonb_array_length(case when jsonb_typeof(p_dados->'pagamentos') = 'array' then p_dados->'pagamentos' end), 0) = 0 then
    delete from public.vendas_rascunho where id = p_id;
    return jsonb_build_object('situacao', 'vazia');
  end if;
  v_total := round(coalesce((p_dados->>'total')::numeric, 0), 2);
  select round(coalesce(sum((x->>'valor')::numeric), 0), 2) into v_pago
    from jsonb_array_elements(case when jsonb_typeof(p_dados->'pagamentos') = 'array' then p_dados->'pagamentos' else '[]'::jsonb end) x;

  insert into public.vendas_rascunho as r (id, empresa_id, operador_id, operador_nome, aparelho, aparelho_nome, dados, itens, total, pago)
  values (p_id, v_emp, auth.uid(), (select nome from public.perfis where id = auth.uid()), p_aparelho, left(p_aparelho_nome, 60), p_dados, v_itens, v_total, v_pago)
  on conflict (id) do update set dados = excluded.dados, itens = excluded.itens, total = excluded.total, pago = excluded.pago,
    aparelho_nome = excluded.aparelho_nome, operador_id = excluded.operador_id, operador_nome = excluded.operador_nome,
    versao = r.versao + 1, atualizado_em = now();

  -- Faxina: rascunhos esquecidos há mais de 3 dias
  delete from public.vendas_rascunho where empresa_id = v_emp and atualizado_em < now() - interval '3 days';
  return jsonb_build_object('situacao', 'ok');
end $$;

/** Traz a venda para este aparelho (o anterior passa a ser avisado e para de gravar). */
create or replace function public.assumir_rascunho(p_id uuid, p_aparelho text, p_aparelho_nome text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := private.empresa_id();
  v_r public.vendas_rascunho;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  select * into v_r from public.vendas_rascunho where id = p_id and empresa_id = v_emp for update;
  if not found then raise exception 'Esta venda não está mais em andamento (foi concluída ou descartada).'; end if;
  update public.vendas_rascunho set aparelho = p_aparelho, aparelho_nome = left(p_aparelho_nome, 60),
    versao = versao + 1, atualizado_em = now()
  where id = p_id;
  perform private.auditar(v_emp, 'venda.trocar_aparelho', 'vendas_rascunho', p_id::text,
    jsonb_build_object('de', v_r.aparelho_nome, 'para', left(p_aparelho_nome, 60), 'total', v_r.total, 'pago', v_r.pago));
  return v_r.dados;
end $$;

/** Descarta o rascunho (venda limpa no aparelho que está com ela, ou por gerente). */
create or replace function public.descartar_rascunho(p_id uuid, p_aparelho text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  delete from public.vendas_rascunho where id = p_id and empresa_id = v_emp
    and (aparelho = p_aparelho or private.tem_papel('{admin,gerente}'));
end $$;

-- ---------- registrar_venda: idempotente e aceita vendas feitas sem internet ----------
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
  -- contingência
  v_id_local uuid := nullif(p->>'id_local','')::uuid;
  v_offline boolean := coalesce((p->>'offline')::boolean, false);
  v_quando timestamptz := now();
  v_total_cliente numeric := round(nullif(p->>'total_cliente','')::numeric, 2);
  v_ajuste numeric := 0;
  v_existente public.vendas;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if v_finalizar and v_papel = 'atendente' then raise exception 'Atendentes podem apenas lançar pedidos'; end if;

  -- Idempotência: a mesma venda (mesmo id_local) nunca é registrada duas vezes
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
    -- Venda feita sem internet: se o caixa já foi fechado, entra no caixa em que foi feita
    if v_sessao is null and v_offline then
      select id into v_sessao from public.caixa_sessoes
        where id = nullif(p->>'sessao_id','')::uuid and operador_id = v_uid and empresa_id = v_emp;
    end if;
    if v_sessao is null then raise exception 'Abra o caixa antes de finalizar vendas'; end if;
    if v_offline then
      v_quando := least(now(), greatest(now() - interval '7 days', coalesce(nullif(p->>'realizada_em','')::timestamptz, now())));
    end if;
  end if;

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
    -- Produto desativado depois de uma venda feita sem internet ainda entra
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

    v_subtotal := v_subtotal + v_bruto;
    v_desc_itens := v_desc_itens + v_desc_item;
  end loop;

  v_desconto := v_desconto + v_desc_itens;
  if v_desconto > v_subtotal then raise exception 'Desconto maior que o total'; end if;

  if v_papel in ('caixa','atendente') and v_subtotal > 0 then
    select desconto_maximo_caixa into v_max_desc from public.empresas where id = v_emp;
    if (v_desconto / v_subtotal * 100) > v_max_desc then
      raise exception 'Desconto acima do limite permitido (% %%). Solicite a um gerente.', v_max_desc;
    end if;
  end if;

  v_total := v_subtotal - v_desconto + v_acrescimo;

  -- Venda sem internet: o cliente já pagou o total da tela. Se o preço mudou no cadastro
  -- entre a venda e o envio, a diferença vira desconto/acréscimo (registrado na auditoria).
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
    'total', v_venda.total, 'troco', v_venda.troco, 'valor_pago', v_venda.valor_pago, 'ajuste', v_ajuste);
end $function$;

revoke execute on function public.registrar_venda(jsonb), public.salvar_rascunho(uuid,text,text,jsonb),
  public.assumir_rascunho(uuid,text,text), public.descartar_rascunho(uuid,text) from public, anon;
grant execute on function public.registrar_venda(jsonb), public.salvar_rascunho(uuid,text,text,jsonb),
  public.assumir_rascunho(uuid,text,text), public.descartar_rascunho(uuid,text) to authenticated;
