-- Mensagem do pedido mínimo no formato brasileiro (R$ 10,00)
create or replace function public.criar_pedido_delivery(p_slug text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.empresas; v_id uuid; v_num bigint; v_token uuid := gen_random_uuid();
  v_tel text := regexp_replace(coalesce(p->>'telefone',''), '\D', '', 'g');
  v_nome text := left(trim(coalesce(p->>'nome','')), 80);
  v_tipo text := coalesce(p->>'tipo','entrega');
  v_pag text := coalesce(p->>'pagamento','pix');
  v_taxa numeric := 0; v_min numeric; v_total numeric; v_cli uuid; n int;
begin
  select * into e from public.empresas where lower(slug) = lower(trim(p_slug)) for update;
  if not found or not private.delivery_liberado(e.id) then raise exception 'Loja indisponível para pedidos'; end if;
  if not e.delivery_aberto then raise exception 'A loja está fechada para pedidos agora'; end if;
  if length(v_nome) < 2 then raise exception 'Informe seu nome'; end if;
  if length(v_tel) not between 10 and 11 then raise exception 'Informe um telefone com DDD'; end if;
  if v_tipo not in ('entrega','retirada') then raise exception 'Escolha entrega ou retirada'; end if;
  if v_tipo = 'entrega' and coalesce((e.delivery_config->>'entrega')::boolean, true) = false then raise exception 'Esta loja não faz entregas'; end if;
  if v_tipo = 'retirada' and coalesce((e.delivery_config->>'retirada')::boolean, true) = false then raise exception 'Esta loja não aceita retirada'; end if;
  if v_pag not in ('pix','dinheiro','cartao') then raise exception 'Forma de pagamento inválida'; end if;
  if v_pag = 'pix' and e.pix_chave is null and not exists (select 1 from public.integracoes_pagamento where empresa_id = e.id and mp_access_token is not null) then
    raise exception 'Esta loja ainda não recebe PIX pelo cardápio';
  end if;
  if v_tipo = 'entrega' then
    if coalesce(length(trim(p->'endereco'->>'logradouro')), 0) < 3 or coalesce(length(trim(p->'endereco'->>'numero')), 0) < 1
       or coalesce(length(trim(p->'endereco'->>'bairro')), 0) < 2 then
      raise exception 'Informe rua, número e bairro para a entrega';
    end if;
    v_taxa := coalesce((e.delivery_config->>'taxa_entrega')::numeric, 0);
  end if;

  -- Proteção contra abuso
  select count(*) into n from public.vendas where empresa_id = e.id and cliente_telefone = v_tel and status = 'aberta' and canal in ('delivery','retirada');
  if n >= 3 then raise exception 'Você já tem pedidos em andamento. Aguarde ou fale com a loja.'; end if;
  select count(*) into n from public.vendas where empresa_id = e.id and canal in ('delivery','retirada') and created_at > now() - interval '10 minutes';
  if n >= 60 then raise exception 'A loja está recebendo muitos pedidos. Tente em alguns minutos.'; end if;

  -- Cliente: encontra pelo telefone ou cadastra
  select id into v_cli from public.clientes where empresa_id = e.id and regexp_replace(coalesce(telefone,''), '\D', '', 'g') = v_tel limit 1;
  if v_cli is null then
    insert into public.clientes (empresa_id, nome, telefone, cep, logradouro, numero, complemento, bairro, municipio)
    values (e.id, v_nome, v_tel, nullif(regexp_replace(coalesce(p->'endereco'->>'cep',''), '\D', '', 'g'), ''),
            p->'endereco'->>'logradouro', p->'endereco'->>'numero', p->'endereco'->>'complemento', p->'endereco'->>'bairro', p->'endereco'->>'cidade')
    returning id into v_cli;
  end if;

  update public.empresas set proximo_numero_venda = proximo_numero_venda + 1 where id = e.id
    returning proximo_numero_venda - 1 into v_num;
  insert into public.vendas (empresa_id, numero, status, canal, identificador, cliente_id, cliente_nome, cliente_telefone,
    endereco, taxa_entrega, acrescimo, forma_prevista, troco_para, pagamento_status, token_publico, observacao,
    status_pedido, status_historico)
  values (e.id, v_num, 'aberta', case when v_tipo = 'entrega' then 'delivery' else 'retirada' end,
    case when v_tipo = 'entrega' then 'Delivery ' else 'Retirada ' end || v_num, v_cli, v_nome, v_tel,
    case when v_tipo = 'entrega' then jsonb_build_object(
      'cep', left(p->'endereco'->>'cep', 9), 'logradouro', left(p->'endereco'->>'logradouro', 120), 'numero', left(p->'endereco'->>'numero', 20),
      'complemento', left(p->'endereco'->>'complemento', 80), 'bairro', left(p->'endereco'->>'bairro', 80),
      'cidade', left(p->'endereco'->>'cidade', 80), 'referencia', left(p->'endereco'->>'referencia', 120)) end,
    v_taxa, v_taxa, v_pag, case when v_pag = 'dinheiro' then nullif(nullif(p->>'troco_para','')::numeric, 0) end,
    'pendente', v_token, nullif(left(trim(coalesce(p->>'observacao','')), 300), ''),
    'recebido', jsonb_build_array(jsonb_build_object('status','recebido','em',now())))
  returning id into v_id;

  perform private.inserir_itens(v_id, e.id, p->'itens', null, true);
  perform private.recalcular_venda(v_id);
  select total into v_total from public.vendas where id = v_id;
  v_min := coalesce((e.delivery_config->>'pedido_minimo')::numeric, 0);
  if v_total - v_taxa < v_min then
    raise exception 'O pedido mínimo é de R$ %', replace(to_char(v_min, 'FM999990.00'), '.', ',');
  end if;
  return jsonb_build_object('token', v_token, 'numero', v_num, 'total', v_total);
end $$;

-- Pausar/retomar pedidos do cardápio (gerente também pode, sem acesso às demais configurações)
create or replace function public.delivery_abrir(p_aberto boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  update public.empresas set delivery_aberto = coalesce(p_aberto, true) where id = v_emp;
end $$;
revoke execute on function public.delivery_abrir(boolean) from anon, public;
grant execute on function public.delivery_abrir(boolean) to authenticated;
