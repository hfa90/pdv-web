-- =====================================================================
-- Mesas (app do garçom), delivery com cardápio digital, PIX e tempo real
-- =====================================================================

-- ---------- Loja: PIX, delivery e módulos ----------
alter table public.empresas
  add column slug text,
  add column pix_tipo text check (pix_tipo in ('cpf','cnpj','email','telefone','aleatoria')),
  add column pix_chave text,
  add column pix_nome text,
  add column pix_cidade text,
  add column delivery_ativo boolean not null default false,
  add column delivery_aberto boolean not null default true,
  add column delivery_config jsonb not null default '{}'::jsonb,
  add column modulos jsonb not null default '{}'::jsonb;
create unique index empresas_slug_uk on public.empresas(lower(slug)) where slug is not null;
alter table public.empresas add constraint empresas_slug_formato check (slug is null or slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$');
grant update (slug, pix_tipo, pix_chave, pix_nome, pix_cidade, delivery_ativo, delivery_aberto, delivery_config)
  on public.empresas to authenticated;

-- ---------- Produtos no cardápio ----------
alter table public.produtos
  add column no_cardapio boolean not null default false,
  add column descricao text check (descricao is null or length(descricao) <= 300),
  add column imagem_url text;
grant update (no_cardapio, descricao, imagem_url) on public.produtos to authenticated;

-- ---------- Mesas ----------
create table public.mesas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  numero int not null check (numero between 1 and 9999),
  nome text not null check (length(nome) between 1 and 30),
  area text not null default 'Salão' check (length(area) between 1 and 30),
  lugares smallint not null default 4 check (lugares between 1 and 50),
  formato text not null default 'quadrada' check (formato in ('quadrada','redonda','retangular')),
  pos_x smallint not null default 0 check (pos_x between 0 and 60),
  pos_y smallint not null default 0 check (pos_y between 0 and 60),
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (empresa_id, numero)
);
create index mesas_empresa_idx on public.mesas(empresa_id, area);
alter table public.mesas enable row level security;
create policy mesas_ler on public.mesas for select to authenticated
  using (empresa_id = (select private.empresa_id()));
create policy mesas_inserir on public.mesas for insert to authenticated
  with check (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));
create policy mesas_editar on public.mesas for update to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')))
  with check (empresa_id = (select private.empresa_id()));
create policy mesas_excluir on public.mesas for delete to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));
revoke all on public.mesas from anon;

-- ---------- Vendas: canal, mesa, delivery ----------
alter table public.vendas
  add column canal text not null default 'balcao' check (canal in ('balcao','mesa','delivery','retirada')),
  add column mesa_id uuid references public.mesas(id) on delete set null,
  add column pessoas smallint,
  add column conta_pedida_em timestamptz,
  add column alterado_em timestamptz not null default now(),
  add column status_pedido text check (status_pedido in ('recebido','preparando','pronto','saiu','entregue','cancelado')),
  add column status_historico jsonb not null default '[]'::jsonb,
  add column cliente_nome text,
  add column cliente_telefone text,
  add column endereco jsonb,
  add column taxa_entrega numeric(10,2) not null default 0,
  add column forma_prevista text check (forma_prevista in ('pix','dinheiro','cartao')),
  add column troco_para numeric(10,2),
  add column pagamento_status text check (pagamento_status in ('pendente','pago','recusado')),
  add column pagamento_ref text,
  add column pago_em timestamptz,
  add column token_publico uuid;
create unique index vendas_mesa_aberta_uk on public.vendas(mesa_id) where status = 'aberta' and mesa_id is not null;
create unique index vendas_token_uk on public.vendas(token_publico) where token_publico is not null;
create index vendas_canal_idx on public.vendas(empresa_id, canal, status);

alter table public.venda_itens
  add column criado_em timestamptz not null default now(),
  add column criado_por uuid references public.perfis(id) on delete set null;
create index venda_itens_criado_por_idx on public.venda_itens(criado_por);

-- ---------- Credenciais do Mercado Pago (cobrança PIX automática) ----------
create table public.integracoes_pagamento (
  empresa_id uuid primary key references public.empresas(id) on delete cascade,
  mp_access_token text,
  updated_at timestamptz not null default now()
);
alter table public.integracoes_pagamento enable row level security;   -- sem políticas: só o servidor lê
revoke all on public.integracoes_pagamento from anon, authenticated;

-- ---------- Regras de módulo ----------
create or replace function private.modulo_garcom(p_emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(e.segmento = 'restaurante' or (e.modulos->>'garcom')::boolean, false)
  from public.empresas e where e.id = p_emp
$$;

create or replace function private.delivery_liberado(p_emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(e.delivery_ativo
    and private.conta_liberada(e.id) is null
    and (e.status_conta = 'teste' or e.plano = 'interno' or coalesce((e.modulos->>'delivery')::boolean, false)), false)
  from public.empresas e where e.id = p_emp
$$;

create or replace function public.situacao_conta()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', e.status_conta, 'plano', e.plano, 'teste_expira_em', e.teste_expira_em,
    'bloqueio', private.conta_liberada(e.id),
    'vendas_teste', (select count(*) from public.vendas v where v.empresa_id = e.id and v.status = 'finalizada'),
    'admin_plataforma', private.eh_admin_plataforma(),
    'garcom', private.modulo_garcom(e.id),
    'delivery_contratado', (e.status_conta = 'teste' or e.plano = 'interno' or coalesce((e.modulos->>'delivery')::boolean, false)),
    'delivery_ativo', e.delivery_ativo)
  from public.empresas e where e.id = private.empresa_id()
$$;

-- ---------- Recalcula totais de um pedido aberto ----------
create or replace function private.recalcular_venda(p_venda uuid)
returns void language sql security definer set search_path = '' as $$
  update public.vendas v set
    subtotal = s.subtotal,
    desconto = s.desc_itens,
    total = s.subtotal - s.desc_itens + v.acrescimo,
    alterado_em = now()
  from (select coalesce(sum(round(quantidade * preco_unitario, 2)), 0) subtotal, coalesce(sum(desconto), 0) desc_itens
        from public.venda_itens where venda_id = p_venda and not removido) s
  where v.id = p_venda
$$;

-- Insere itens (preço sempre do cadastro) — usado pelo garçom e pelo delivery
create or replace function private.inserir_itens(p_venda uuid, p_emp uuid, p_itens jsonb, p_usuario uuid, p_so_cardapio boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare v_item jsonb; v_prod public.produtos; v_qtd numeric; v_n int; v_qtd_itens int := 0;
begin
  if jsonb_typeof(p_itens) is distinct from 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Adicione ao menos um item';
  end if;
  if jsonb_array_length(p_itens) > 100 then raise exception 'Muitos itens de uma vez'; end if;
  select coalesce(max(item), 0) into v_n from public.venda_itens where venda_id = p_venda;
  for v_item in select * from jsonb_array_elements(p_itens) loop
    select * into v_prod from public.produtos
      where id = nullif(v_item->>'produto_id','')::uuid and empresa_id = p_emp and ativo
        and (not p_so_cardapio or no_cardapio);
    if not found then raise exception 'Produto indisponível'; end if;
    v_qtd := round((v_item->>'quantidade')::numeric, 3);
    if v_qtd is null or v_qtd <= 0 or v_qtd > 999 then raise exception 'Quantidade inválida: %', v_prod.nome; end if;
    if v_prod.unidade in ('UN','CX','PCT','DZ','FD') and v_qtd <> trunc(v_qtd) then
      raise exception 'Quantidade deve ser inteira: %', v_prod.nome;
    end if;
    v_n := v_n + 1; v_qtd_itens := v_qtd_itens + 1;
    insert into public.venda_itens (venda_id, empresa_id, produto_id, item, descricao, unidade,
      quantidade, preco_unitario, desconto, total, observacao, criado_por)
    values (p_venda, p_emp, v_prod.id, v_n, v_prod.nome, v_prod.unidade, v_qtd, v_prod.preco_venda, 0,
      round(v_qtd * v_prod.preco_venda, 2), nullif(left(trim(coalesce(v_item->>'observacao','')), 140), ''), p_usuario);
  end loop;
  return v_qtd_itens;
end $$;

-- =====================================================================
-- MESAS (PDV e app do garçom)
-- =====================================================================
create or replace function public.mesas_painel()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'numero', m.numero, 'nome', m.nome, 'area', m.area, 'lugares', m.lugares,
    'formato', m.formato, 'pos_x', m.pos_x, 'pos_y', m.pos_y,
    'venda_id', v.id, 'venda_numero', v.numero, 'aberta_em', v.created_at, 'total', v.total,
    'pessoas', v.pessoas, 'conta_pedida', v.conta_pedida_em is not null, 'alterado_em', v.alterado_em,
    'garcom', p.nome,
    'itens', (select count(*) from public.venda_itens i where i.venda_id = v.id and not i.removido)
  ) order by m.area, m.numero), '[]'::jsonb)
  from public.mesas m
  left join public.vendas v on v.mesa_id = m.id and v.status = 'aberta'
  left join public.perfis p on p.id = v.operador_id
  where m.empresa_id = private.empresa_id() and m.ativo
$$;

create or replace function public.abrir_mesa(p_mesa uuid, p_pessoas int default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); m public.mesas; v_id uuid; v_num bigint;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if not private.modulo_garcom(v_emp) then raise exception 'O controle de mesas é exclusivo para restaurantes'; end if;
  select * into m from public.mesas where id = p_mesa and empresa_id = v_emp and ativo;
  if not found then raise exception 'Mesa não encontrada'; end if;
  select id into v_id from public.vendas where mesa_id = m.id and status = 'aberta';
  if v_id is not null then return v_id; end if;
  update public.empresas set proximo_numero_venda = proximo_numero_venda + 1
    where id = v_emp returning proximo_numero_venda - 1 into v_num;
  insert into public.vendas (empresa_id, numero, operador_id, status, mesa_id, canal, identificador, pessoas)
  values (v_emp, v_num, auth.uid(), 'aberta', m.id, 'mesa', m.nome, nullif(p_pessoas, 0))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  select id into v_id from public.vendas where mesa_id = p_mesa and status = 'aberta';
  return v_id;
end $$;

create or replace function public.adicionar_itens(p_venda uuid, p_itens jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v public.vendas; n int;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  select * into v from public.vendas where id = p_venda and empresa_id = v_emp for update;
  if not found then raise exception 'Pedido não encontrado'; end if;
  if v.status <> 'aberta' then raise exception 'Esta mesa já foi fechada'; end if;
  n := private.inserir_itens(v.id, v_emp, p_itens, auth.uid(), false);
  update public.vendas set conta_pedida_em = null where id = v.id;
  perform private.recalcular_venda(v.id);
  select * into v from public.vendas where id = p_venda;
  return jsonb_build_object('id', v.id, 'total', v.total, 'itens_adicionados', n);
end $$;

create or replace function public.remover_item_pedido(p_item uuid, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); i public.venda_itens; v public.vendas;
begin
  select * into i from public.venda_itens where id = p_item and empresa_id = v_emp;
  if not found or i.removido then raise exception 'Item não encontrado'; end if;
  select * into v from public.vendas where id = i.venda_id for update;
  if v.status <> 'aberta' then raise exception 'Esta mesa já foi fechada'; end if;
  if not (private.tem_papel('{admin,gerente,caixa}')
          or (i.criado_por = auth.uid() and i.criado_em > now() - interval '5 minutes')) then
    raise exception 'Só o gerente pode tirar itens lançados há mais de 5 minutos';
  end if;
  if coalesce(length(trim(p_motivo)), 0) < 3 then raise exception 'Informe o motivo'; end if;
  update public.venda_itens set removido = true, removido_em = now(), removido_por = auth.uid() where id = i.id;
  perform private.recalcular_venda(v.id);
  perform private.auditar(v_emp, 'mesa.remover_item', 'venda_itens', i.id::text,
    jsonb_build_object('mesa', v.identificador, 'item', i.descricao, 'quantidade', i.quantidade, 'motivo', p_motivo));
end $$;

create or replace function public.transferir_mesa(p_venda uuid, p_mesa_destino uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v public.vendas; m public.mesas; d uuid; v_max int;
begin
  select * into v from public.vendas where id = p_venda and empresa_id = v_emp for update;
  if not found or v.status <> 'aberta' then raise exception 'Mesa de origem não está aberta'; end if;
  select * into m from public.mesas where id = p_mesa_destino and empresa_id = v_emp and ativo;
  if not found then raise exception 'Mesa de destino não encontrada'; end if;
  if v.mesa_id = m.id then return v.id; end if;
  select id into d from public.vendas where mesa_id = m.id and status = 'aberta' for update;
  if d is null then
    update public.vendas set mesa_id = m.id, identificador = m.nome, alterado_em = now() where id = v.id;
    perform private.auditar(v_emp, 'mesa.transferir', 'vendas', v.id::text, jsonb_build_object('de', v.identificador, 'para', m.nome));
    return v.id;
  end if;
  -- Destino ocupado: junta as contas
  select coalesce(max(item), 0) into v_max from public.venda_itens where venda_id = d;
  update public.venda_itens set venda_id = d, item = item + v_max where venda_id = v.id;
  update public.vendas set pessoas = coalesce(pessoas, 0) + coalesce(v.pessoas, 0) where id = d;
  update public.vendas set status = 'cancelada', cancelada_em = now(), cancelada_por = auth.uid(),
    motivo_cancelamento = 'Conta juntada com ' || m.nome, mesa_id = null where id = v.id;
  perform private.recalcular_venda(d);
  perform private.auditar(v_emp, 'mesa.juntar', 'vendas', d::text, jsonb_build_object('de', v.identificador, 'para', m.nome));
  return d;
end $$;

create or replace function public.pedir_conta(p_venda uuid, p_pedida boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.vendas set conta_pedida_em = case when p_pedida then now() end, alterado_em = now()
  where id = p_venda and empresa_id = private.empresa_id() and status = 'aberta';
  if not found then raise exception 'Mesa não encontrada'; end if;
end $$;

-- =====================================================================
-- DELIVERY E CARDÁPIO DIGITAL (acesso público controlado)
-- =====================================================================
create or replace function public.cardapio_publico(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e public.empresas;
begin
  select * into e from public.empresas where lower(slug) = lower(trim(p_slug));
  if not found or not private.delivery_liberado(e.id) then raise exception 'Cardápio não encontrado ou indisponível'; end if;
  return jsonb_build_object(
    'loja', jsonb_build_object(
      'nome', coalesce(e.nome_fantasia, e.razao_social), 'segmento', e.segmento, 'telefone', e.telefone,
      'cidade', e.municipio, 'uf', e.uf, 'bairro', e.bairro, 'logradouro', e.logradouro, 'numero', e.numero,
      'aberto', e.delivery_aberto, 'config', e.delivery_config,
      'pix', case when e.pix_chave is not null then jsonb_build_object('chave', e.pix_chave, 'tipo', e.pix_tipo,
              'nome', coalesce(e.pix_nome, e.nome_fantasia, e.razao_social), 'cidade', coalesce(e.pix_cidade, e.municipio, 'BRASIL')) end,
      'pix_automatico', exists (select 1 from public.integracoes_pagamento i where i.empresa_id = e.id and i.mp_access_token is not null)),
    'categorias', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'cor', c.cor) order by c.ordem, c.nome), '[]')
                   from public.categorias c where c.empresa_id = e.id and c.ativo
                     and exists (select 1 from public.produtos p where p.categoria_id = c.id and p.no_cardapio and p.ativo)),
    'produtos', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nome', p.nome, 'descricao', p.descricao,
                   'preco', p.preco_venda, 'unidade', p.unidade, 'imagem', p.imagem_url, 'categoria_id', p.categoria_id,
                   'destaque', p.favorito) order by p.nome), '[]')
                 from public.produtos p where p.empresa_id = e.id and p.no_cardapio and p.ativo));
end $$;

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

create or replace function public.acompanhar_pedido(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v public.vendas; e public.empresas;
begin
  select * into v from public.vendas where token_publico = p_token;
  if not found then raise exception 'Pedido não encontrado'; end if;
  select * into e from public.empresas where id = v.empresa_id;
  return jsonb_build_object(
    'numero', v.numero, 'tipo', case when v.canal = 'delivery' then 'entrega' else 'retirada' end,
    'status', coalesce(v.status_pedido, 'recebido'), 'historico', v.status_historico,
    'cancelado', v.status = 'cancelada', 'motivo_cancelamento', case when v.status = 'cancelada' then v.motivo_cancelamento end,
    'criado_em', v.created_at, 'cliente', v.cliente_nome, 'endereco', v.endereco,
    'subtotal', v.subtotal, 'taxa_entrega', v.taxa_entrega, 'total', v.total,
    'pagamento', v.forma_prevista, 'pagamento_status', v.pagamento_status, 'troco_para', v.troco_para,
    'observacao', v.observacao,
    'itens', (select coalesce(jsonb_agg(jsonb_build_object('descricao', i.descricao, 'quantidade', i.quantidade, 'unidade', i.unidade,
              'total', i.total, 'observacao', i.observacao) order by i.item), '[]')
              from public.venda_itens i where i.venda_id = v.id and not i.removido),
    'loja', jsonb_build_object('nome', coalesce(e.nome_fantasia, e.razao_social), 'telefone', e.telefone, 'slug', e.slug,
      'tempo', e.delivery_config->>'tempo_estimado',
      'pix', case when e.pix_chave is not null then jsonb_build_object('chave', e.pix_chave, 'tipo', e.pix_tipo,
              'nome', coalesce(e.pix_nome, e.nome_fantasia, e.razao_social), 'cidade', coalesce(e.pix_cidade, e.municipio, 'BRASIL')) end,
      'pix_automatico', exists (select 1 from public.integracoes_pagamento i where i.empresa_id = e.id and i.mp_access_token is not null)));
end $$;

-- Ações da loja sobre o pedido
create or replace function public.atualizar_pedido(p_venda uuid, p_status text, p_motivo text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v public.vendas;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Sem permissão'; end if;
  select * into v from public.vendas where id = p_venda and empresa_id = v_emp for update;
  if not found or v.canal not in ('delivery','retirada') then raise exception 'Pedido não encontrado'; end if;
  if v.status <> 'aberta' then raise exception 'Este pedido já foi encerrado'; end if;
  if p_status not in ('preparando','pronto','saiu','cancelado') then raise exception 'Situação inválida'; end if;
  if p_status = 'saiu' and v.canal <> 'delivery' then raise exception 'Pedido para retirada não sai para entrega'; end if;
  if p_status = 'cancelado' then
    if coalesce(length(trim(p_motivo)), 0) < 3 then raise exception 'Informe o motivo'; end if;
    update public.vendas set status = 'cancelada', status_pedido = 'cancelado', cancelada_em = now(), cancelada_por = auth.uid(),
      motivo_cancelamento = left(trim(p_motivo), 300),
      status_historico = status_historico || jsonb_build_array(jsonb_build_object('status','cancelado','em',now()))
    where id = v.id;
    perform private.auditar(v_emp, 'delivery.cancelar', 'vendas', v.id::text, jsonb_build_object('numero', v.numero, 'motivo', p_motivo));
    return;
  end if;
  update public.vendas set status_pedido = p_status, alterado_em = now(),
    status_historico = status_historico || jsonb_build_array(jsonb_build_object('status', p_status, 'em', now()))
  where id = v.id;
end $$;

create or replace function public.confirmar_pagamento_pedido(p_venda uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Sem permissão'; end if;
  update public.vendas set pagamento_status = 'pago', pago_em = now(), alterado_em = now()
  where id = p_venda and empresa_id = private.empresa_id() and canal in ('delivery','retirada') and status = 'aberta';
  if not found then raise exception 'Pedido não encontrado'; end if;
end $$;

-- Credenciais do Mercado Pago (só escrita)
create or replace function public.salvar_mercado_pago(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Sem permissão'; end if;
  insert into public.integracoes_pagamento (empresa_id, mp_access_token) values (v_emp, nullif(trim(p_token), ''))
  on conflict (empresa_id) do update set mp_access_token = excluded.mp_access_token, updated_at = now();
  perform private.auditar(v_emp, 'pix.mercado_pago', 'integracoes_pagamento', v_emp::text, jsonb_build_object('ativo', nullif(trim(p_token), '') is not null));
end $$;

create or replace function public.mercado_pago_status()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.integracoes_pagamento where empresa_id = private.empresa_id() and mp_access_token is not null)
$$;

-- Plataforma: liberar módulos
create or replace function public.plataforma_modulos(p_id uuid, p_modulos jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  update public.empresas set modulos = coalesce(modulos, '{}'::jsonb) || p_modulos where id = p_id;
end $$;

-- ---------- registrar_venda: conflito com o garçom e conclusão do delivery ----------
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
    -- Outro aparelho (garçom) pode ter lançado itens depois que este caixa abriu o pedido
    if p ? 'alterado_em' and v_venda.alterado_em > (p->>'alterado_em')::timestamptz + interval '1 second' then
      raise exception 'Este pedido recebeu itens novos em outro aparelho. Abra o pedido de novo para conferir antes de receber.';
    end if;
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
      valor_pago = v_pago, troco = v_troco, finalizada_em = now(),
      status_pedido = case when canal in ('delivery','retirada') then 'entregue' else status_pedido end,
      status_historico = case when canal in ('delivery','retirada')
        then coalesce(status_historico,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('status','entregue','em',now()))
        else status_historico end,
      pagamento_status = case when canal in ('delivery','retirada') then 'pago' else pagamento_status end
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


-- =====================================================================
-- Tempo real
-- =====================================================================
-- Cliente do delivery: aviso por canal público cujo nome é o token secreto do pedido
create or replace function private.avisar_pedido()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.token_publico is not null and (
     new.status_pedido is distinct from old.status_pedido or new.pagamento_status is distinct from old.pagamento_status
     or new.status is distinct from old.status) then
    perform realtime.send(jsonb_build_object('status', new.status_pedido, 'pagamento_status', new.pagamento_status, 'venda_status', new.status),
                          'atualizado', 'pedido-' || new.token_publico::text, false);
  end if;
  return new;
exception when others then
  return new;  -- nunca impede a operação por falha no aviso
end $$;
create trigger t_avisar_pedido after update on public.vendas for each row execute function private.avisar_pedido();

alter publication supabase_realtime add table public.vendas, public.venda_itens, public.mesas;

-- ---------- Fotos do cardápio ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cardapio', 'cardapio', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy cardapio_enviar on storage.objects for insert to authenticated
  with check (bucket_id = 'cardapio' and (storage.foldername(name))[1] = (select private.empresa_id())::text
              and (select private.tem_papel('{admin,gerente}')));
create policy cardapio_trocar on storage.objects for update to authenticated
  using (bucket_id = 'cardapio' and (storage.foldername(name))[1] = (select private.empresa_id())::text
         and (select private.tem_papel('{admin,gerente}')));
create policy cardapio_apagar on storage.objects for delete to authenticated
  using (bucket_id = 'cardapio' and (storage.foldername(name))[1] = (select private.empresa_id())::text
         and (select private.tem_papel('{admin,gerente}')));

-- ---------- Permissões ----------
revoke execute on function public.mesas_painel(), public.abrir_mesa(uuid,int), public.adicionar_itens(uuid,jsonb),
  public.remover_item_pedido(uuid,text), public.transferir_mesa(uuid,uuid), public.pedir_conta(uuid,boolean),
  public.atualizar_pedido(uuid,text,text), public.confirmar_pagamento_pedido(uuid), public.salvar_mercado_pago(text),
  public.mercado_pago_status(), public.plataforma_modulos(uuid,jsonb), public.situacao_conta()
  from public, anon;
grant execute on function public.mesas_painel(), public.abrir_mesa(uuid,int), public.adicionar_itens(uuid,jsonb),
  public.remover_item_pedido(uuid,text), public.transferir_mesa(uuid,uuid), public.pedir_conta(uuid,boolean),
  public.atualizar_pedido(uuid,text,text), public.confirmar_pagamento_pedido(uuid), public.salvar_mercado_pago(text),
  public.mercado_pago_status(), public.plataforma_modulos(uuid,jsonb), public.situacao_conta()
  to authenticated;
revoke execute on function public.cardapio_publico(text), public.criar_pedido_delivery(text,jsonb), public.acompanhar_pedido(uuid) from public;
grant execute on function public.cardapio_publico(text), public.criar_pedido_delivery(text,jsonb), public.acompanhar_pedido(uuid) to anon, authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.empresa_id(), private.papel(), private.tem_papel(public.papel_usuario[]),
  private.eh_admin_plataforma() to authenticated;
