-- =====================================================================
-- Fechar a conta pelo app do garçom: PIX e cartão (débito/crédito na
-- maquininha, sem TEF). O pagamento entra no caixa principal aberto
-- (mesmo resumo e fechamento do caixa), baixa o estoque e libera a mesa.
-- Depende da 014.
-- =====================================================================

-- Quem recebeu e o código da maquininha (NSU/autorização) para conferência
alter table public.venda_pagamentos
  add column if not exists nsu text check (nsu is null or length(nsu) <= 40),
  add column if not exists recebido_por uuid references public.perfis(id) on delete set null;
alter table public.vendas add column if not exists recebido_no_app boolean not null default false;

-- Caixa que recebe os pagamentos do app: o do operador escolhido em Configurações › Restaurante;
-- se ele não estiver com o caixa aberto, o caixa aberto há mais tempo.
create or replace function private.caixa_principal(p_emp uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.id from public.caixa_sessoes s
  where s.empresa_id = p_emp and s.status = 'aberto'
  order by (s.operador_id::text = coalesce(private.cfg_restaurante(p_emp)->>'caixa_principal_id', '')) desc, s.aberto_em
  limit 1
$$;

create or replace function public.caixa_principal_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v_s uuid; cfg jsonb;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  cfg := private.cfg_restaurante(v_emp);
  v_s := private.caixa_principal(v_emp);
  return jsonb_build_object(
    'habilitado', coalesce((cfg->>'garcom_fecha_conta')::boolean, true),
    'aberto', v_s is not null,
    'sessao_id', v_s,
    'operador', (select p.nome from public.caixa_sessoes s join public.perfis p on p.id = s.operador_id where s.id = v_s),
    'principal', (select p.nome from public.perfis p where p.id::text = cfg->>'caixa_principal_id'),
    'pix_automatico', exists (select 1 from public.integracoes_pagamento i where i.empresa_id = v_emp and i.mp_access_token is not null));
end $$;

-- p: { alterado_em, id_local, cpf_cnpj, pagamentos: [{forma: pix|debito|credito, valor, nsu}] }
create or replace function public.garcom_fechar_conta(p_venda uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := private.empresa_id(); v_uid uuid := auth.uid(); v_papel text := private.papel()::text;
  cfg jsonb; v public.vendas; v_sessao uuid; v_id_local uuid := nullif(p->>'id_local','')::uuid;
  v_itens jsonb; v_promos jsonb; v_pr jsonb; v_manual numeric;
  v_pag jsonb; v_valor numeric; v_soma numeric := 0; v_formas jsonb := '[]'::jsonb; m record; v_saldo numeric; v_cpf text;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if v_papel not in ('admin','gerente','caixa','atendente') then raise exception 'Sem permissão para fechar contas'; end if;
  cfg := private.cfg_restaurante(v_emp);
  if v_papel = 'atendente' and not coalesce((cfg->>'garcom_fecha_conta')::boolean, true) then
    raise exception 'O fechamento de conta pelo app do garçom está desligado. Leve a conta ao caixa.';
  end if;

  -- Reenvio (internet caiu depois de cobrar): devolve o que já foi registrado, nunca cobra duas vezes
  if v_id_local is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_emp::text || v_id_local::text, 0));
    select * into v from public.vendas where empresa_id = v_emp and id_local = v_id_local and status = 'finalizada';
    if found then
      return jsonb_build_object('id', v.id, 'numero', v.numero, 'total', v.total, 'ja_registrada', true);
    end if;
  end if;

  select * into v from public.vendas where id = p_venda and empresa_id = v_emp for update;
  if not found then raise exception 'Conta não encontrada'; end if;
  if v.status <> 'aberta' then raise exception 'Esta conta já foi fechada'; end if;
  if v.canal not in ('mesa','balcao') then raise exception 'Pedidos do delivery são concluídos na tela Delivery'; end if;
  if p ? 'alterado_em' and v.alterado_em > (p->>'alterado_em')::timestamptz + interval '1 second' then
    raise exception 'A conta mudou (itens novos ou ajuste) enquanto você cobrava. Confira o novo total.';
  end if;
  if not exists (select 1 from public.venda_itens where venda_id = v.id and not removido) then raise exception 'A conta não tem itens'; end if;

  v_sessao := private.caixa_principal(v_emp);
  if v_sessao is null then raise exception 'Nenhum caixa aberto. Peça para abrirem o caixa principal antes de fechar contas pelo app.'; end if;

  -- Promoções: mesma regra do caixa, só nas linhas sem desconto
  v_manual := private.desconto_manual(v.id);
  select jsonb_agg(jsonb_build_object('i', i.item, 'produto_id', i.produto_id, 'categoria_id', pr.categoria_id,
           'quantidade', i.quantidade, 'preco', i.preco_unitario))
    into v_itens
  from public.venda_itens i left join public.produtos pr on pr.id = i.produto_id
  where i.venda_id = v.id and not i.removido;
  v_promos := private.calcular_promocoes(v_emp, v_itens, now());
  for v_pr in select * from jsonb_array_elements(coalesce(v_promos, '[]'::jsonb)) loop
    update public.venda_itens set desconto = desconto + (v_pr->>'desconto')::numeric, total = total - (v_pr->>'desconto')::numeric,
      promocao = v_pr->>'promocao'
    where venda_id = v.id and item = (v_pr->>'i')::int and not removido and desconto = 0;
  end loop;
  perform private.recalcular_venda(v.id, v_manual);
  select * into v from public.vendas where id = p_venda;

  -- Pagamentos: só PIX e cartão (sem troco)
  if jsonb_typeof(p->'pagamentos') is distinct from 'array' or jsonb_array_length(p->'pagamentos') = 0 then
    raise exception 'Informe o pagamento';
  end if;
  for v_pag in select * from jsonb_array_elements(p->'pagamentos') loop
    if v_pag->>'forma' not in ('pix','debito','credito') then raise exception 'No app do garçom a conta é paga com PIX, débito ou crédito'; end if;
    v_valor := round((v_pag->>'valor')::numeric, 2);
    if v_valor is null or v_valor <= 0 then raise exception 'Valor de pagamento inválido'; end if;
    insert into public.venda_pagamentos (venda_id, empresa_id, forma, valor, nsu, recebido_por)
    values (v.id, v_emp, (v_pag->>'forma')::public.forma_pagamento, v_valor, nullif(left(trim(coalesce(v_pag->>'nsu','')), 40), ''), v_uid);
    v_soma := v_soma + v_valor;
    v_formas := v_formas || jsonb_build_array(jsonb_build_object('forma', v_pag->>'forma', 'valor', v_valor));
  end loop;
  if abs(v_soma - v.total) > 0.009 then
    raise exception 'Os pagamentos somam R$ % e a conta é R$ %. Confira antes de fechar.',
      replace(to_char(v_soma, 'FM999999990.00'), '.', ','), replace(to_char(v.total, 'FM999999990.00'), '.', ',');
  end if;

  v_cpf := nullif(regexp_replace(coalesce(p->>'cpf_cnpj',''), '\D', '', 'g'), '');
  if v_cpf is not null and length(v_cpf) not in (11, 14) then raise exception 'CPF/CNPJ inválido'; end if;

  update public.vendas set status = 'finalizada', sessao_id = v_sessao, operador_id = v_uid, recebido_no_app = true,
    valor_pago = v_soma, troco = 0, finalizada_em = now(), id_local = coalesce(v_id_local, id_local),
    cpf_cnpj_consumidor = coalesce(v_cpf, cpf_cnpj_consumidor), conta_pedida_em = null, alterado_em = now()
  where id = v.id;

  -- Baixa de estoque (mesma regra do caixa)
  for m in
    select vi.produto_id, sum(vi.quantidade) q
    from public.venda_itens vi join public.produtos pr on pr.id = vi.produto_id
    where vi.venda_id = v.id and not vi.removido and pr.controla_estoque
    group by vi.produto_id order by vi.produto_id
  loop
    update public.produtos set estoque_atual = estoque_atual - m.q where id = m.produto_id returning estoque_atual into v_saldo;
    insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, saldo_anterior, saldo_posterior, venda_id, usuario_id)
    values (v_emp, m.produto_id, 'venda', -m.q, v_saldo + m.q, v_saldo, v.id, v_uid);
  end loop;

  perform private.auditar(v_emp, 'mesa.fechar_app', 'vendas', v.id::text,
    jsonb_build_object('mesa', v.identificador, 'total', v.total, 'pagamentos', v_formas, 'caixa', v_sessao));
  return jsonb_build_object('id', v.id, 'numero', v.numero, 'total', v.total, 'sessao_id', v_sessao,
    'caixa', (select p2.nome from public.caixa_sessoes s join public.perfis p2 on p2.id = s.operador_id where s.id = v_sessao));
end $$;

-- Configuração: liga/desliga e escolhe o caixa principal (somadas às regras da 014)
create or replace function public.salvar_config_fechamento_app(p_ligado boolean, p_caixa uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p_caixa is not null and not exists (select 1 from public.perfis where id = p_caixa and empresa_id = v_emp and ativo
       and papel::text in ('admin','gerente','caixa')) then
    raise exception 'Escolha um usuário de caixa, gerente ou administrador';
  end if;
  update public.empresas set config_restaurante = config_restaurante
    || jsonb_build_object('garcom_fecha_conta', coalesce(p_ligado, true), 'caixa_principal_id', p_caixa)
  where id = v_emp;
  perform private.auditar(v_emp, 'restaurante.config', 'empresas', v_emp::text,
    jsonb_build_object('garcom_fecha_conta', p_ligado, 'caixa_principal_id', p_caixa));
  return private.cfg_restaurante(v_emp);
end $$;

create or replace function public.definir_taxas_mesa(p_venda uuid, p_servico boolean default null, p_couvert boolean default null, p_pessoas int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v public.vendas; cfg jsonb; v_manual numeric; v_mudou_taxa boolean;
begin
  if v_emp is null or private.papel()::text = 'cozinha' then raise exception 'Acesso negado'; end if;
  select * into v from public.vendas where id = p_venda and empresa_id = v_emp for update;
  if not found or v.status <> 'aberta' then raise exception 'Mesa não está aberta'; end if;
  if v.canal <> 'mesa' then raise exception 'Taxa de serviço e couvert valem para mesas'; end if;
  cfg := private.cfg_restaurante(v_emp);
  v_mudou_taxa := (p_servico is not null and p_servico is distinct from coalesce(v.servico_pct, 0) > 0)
               or (p_couvert is not null and p_couvert is distinct from coalesce(v.couvert_unit, 0) > 0);
  -- O garçom pode tirar a taxa de serviço a pedido do cliente (a taxa é opcional); pôr taxa ou mexer no couvert, só caixa/gerente
  if v_mudou_taxa and not private.tem_papel('{admin,gerente,caixa}')
     and not (p_servico is false and (p_couvert is null or p_couvert = (coalesce(v.couvert_unit, 0) > 0))) then
    raise exception 'Só o caixa ou o gerente altera o couvert ou põe a taxa de serviço';
  end if;
  if p_pessoas is not null and (p_pessoas < 1 or p_pessoas > 50) then raise exception 'Número de pessoas inválido'; end if;
  if p_servico and coalesce((cfg->>'servico_percentual')::numeric, 0) <= 0 and coalesce(v.servico_pct, 0) <= 0 then
    raise exception 'Defina o percentual da taxa de serviço em Configurações › Restaurante';
  end if;
  if p_couvert and coalesce((cfg->>'couvert_valor')::numeric, 0) <= 0 and coalesce(v.couvert_unit, 0) <= 0 then
    raise exception 'Defina o valor do couvert em Configurações › Restaurante';
  end if;
  v_manual := private.desconto_manual(v.id);
  update public.vendas set
    servico_pct = case when p_servico is null then servico_pct when p_servico then coalesce(nullif(servico_pct, 0), (cfg->>'servico_percentual')::numeric) end,
    couvert_unit = case when p_couvert is null then couvert_unit when p_couvert then coalesce(nullif(couvert_unit, 0), (cfg->>'couvert_valor')::numeric) end,
    pessoas = coalesce(p_pessoas, pessoas)
  where id = v.id;
  perform private.recalcular_venda(v.id, v_manual);
  if v_mudou_taxa then
    perform private.auditar(v_emp, 'mesa.taxas', 'vendas', v.id::text,
      jsonb_build_object('mesa', v.identificador, 'servico', p_servico, 'couvert', p_couvert));
  end if;
  select * into v from public.vendas where id = p_venda;
  return jsonb_build_object('id', v.id, 'subtotal', v.subtotal, 'desconto', v.desconto, 'acrescimo', v.acrescimo, 'total', v.total,
    'taxa_servico', v.taxa_servico, 'couvert', v.couvert, 'servico_pct', v.servico_pct, 'couvert_unit', v.couvert_unit,
    'pessoas', v.pessoas, 'alterado_em', v.alterado_em);
end $$;

-- ---------- Permissões ----------
revoke execute on all functions in schema private from public, anon;
revoke execute on function public.caixa_principal_status(), public.garcom_fechar_conta(uuid,jsonb),
  public.salvar_config_fechamento_app(boolean,uuid), public.definir_taxas_mesa(uuid,boolean,boolean,int) from public, anon;
grant execute on function public.caixa_principal_status(), public.garcom_fechar_conta(uuid,jsonb),
  public.salvar_config_fechamento_app(boolean,uuid), public.definir_taxas_mesa(uuid,boolean,boolean,int) to authenticated;
