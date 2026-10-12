-- =====================================================================
-- 025 · Tela "Hoje" e QR Code na mesa
--
--   1. painel_hoje(): numa chamada só, tudo o que pede atenção do dono/gerente
--      (aprovações, chamados das mesas, delivery parado, conta pedida, caixa
--      esquecido aberto, diferença de caixa, contas a pagar, validade, estoque,
--      fiado vencido, NFC-e com problema, alertas, mensalidade) + o resumo do dia.
--
--   2. QR Code na mesa: o cliente aponta a câmera e, sem login nem app,
--      vê a conta ao vivo, chama o garçom, pede a conta, faz pedidos (que o
--      garçom confirma antes de irem para a cozinha) e paga por PIX.
--        - mesas.qr_token: o código impresso no QR (a loja troca quando quiser).
--        - mesa_chamados: chamar garçom, pedir conta, pedido do cliente, aviso de PIX.
--        - mesa_pagamentos: PIX pago pelo cliente no QR (Mercado Pago). Entra
--          na conta como pagamento PIX quando o garçom ou o caixa fecha a mesa.
--      Segurança: as funções públicas só funcionam com o token da mesa, só
--      devolvem a conta daquela mesa (sem nome de cliente, CPF ou telefone),
--      têm limite de chamados e nunca lançam nada na conta sem um funcionário
--      confirmar.
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- =====================================================================
-- 2a. Estrutura do QR na mesa
-- =====================================================================
alter table public.mesas add column if not exists qr_token uuid not null default gen_random_uuid();
create unique index if not exists mesas_qr_token_uk on public.mesas(qr_token);

create table if not exists public.mesa_chamados (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  mesa_id uuid not null references public.mesas(id) on delete cascade,
  venda_id uuid references public.vendas(id) on delete set null,
  tipo text not null check (tipo in ('garcom','conta','pedido','pix')),
  itens jsonb,                 -- pedido: [{produto_id, nome, quantidade, observacao, preco}]
  valor numeric(12,2),         -- pedido: valor estimado · pix: valor pago/avisado
  automatico boolean not null default false, -- pix confirmado pelo Mercado Pago
  status text not null default 'pendente' check (status in ('pendente','atendido','recusado','cancelado')),
  motivo text,
  criado_em timestamptz not null default now(),
  resolvido_em timestamptz,
  resolvido_por uuid references public.perfis(id) on delete set null
);
create index if not exists mesa_chamados_pend_idx on public.mesa_chamados(empresa_id, status, criado_em);
create index if not exists mesa_chamados_mesa_idx on public.mesa_chamados(mesa_id, criado_em desc);
create index if not exists mesa_chamados_venda_idx on public.mesa_chamados(venda_id) where status = 'pendente';
alter table public.mesa_chamados enable row level security;
revoke all on public.mesa_chamados from anon, authenticated;
grant select on public.mesa_chamados to authenticated;
drop policy if exists mesa_chamados_ler on public.mesa_chamados;
create policy mesa_chamados_ler on public.mesa_chamados for select to authenticated
  using (empresa_id = (select private.empresa_id()));

create table if not exists public.mesa_pagamentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  mesa_id uuid not null references public.mesas(id) on delete cascade,
  venda_id uuid not null references public.vendas(id) on delete cascade,
  valor numeric(12,2) not null check (valor > 0),
  status text not null default 'pendente' check (status in ('pendente','pago','cancelado')),
  mp_id text,
  criado_em timestamptz not null default now(),
  pago_em timestamptz,
  usado_em timestamptz          -- quando a conta foi fechada com este pagamento
);
create index if not exists mesa_pagamentos_venda_idx on public.mesa_pagamentos(venda_id, status);
alter table public.mesa_pagamentos enable row level security;
revoke all on public.mesa_pagamentos from anon, authenticated;
grant select on public.mesa_pagamentos to authenticated;
drop policy if exists mesa_pagamentos_ler on public.mesa_pagamentos;
create policy mesa_pagamentos_ler on public.mesa_pagamentos for select to authenticated
  using (empresa_id = (select private.empresa_id()));

-- Tempo real para o app do garçom e o sistema
do $$ begin
  begin alter publication supabase_realtime add table public.mesa_chamados; exception when others then null; end;
  begin alter publication supabase_realtime add table public.mesa_pagamentos; exception when others then null; end;
end $$;

-- PIX confirmado pelo Mercado Pago vira aviso para o garçom
create or replace function private.mesa_pagamento_aviso()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'pago' and old.status is distinct from 'pago' then
    insert into public.mesa_chamados (empresa_id, mesa_id, venda_id, tipo, valor, automatico)
    values (new.empresa_id, new.mesa_id, new.venda_id, 'pix', new.valor, true);
  end if;
  return new;
end $$;
drop trigger if exists t_mesa_pagamento_aviso on public.mesa_pagamentos;
create trigger t_mesa_pagamento_aviso after update on public.mesa_pagamentos
  for each row execute function private.mesa_pagamento_aviso();

-- Dinheiro pago pelo cliente nunca some: não deixa cancelar/juntar a conta antes de fechar com ele
create or replace function private.vendas_qr_proteger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_pago numeric;
begin
  if new.status = 'cancelada' and old.status = 'aberta' then
    select coalesce(sum(valor), 0) into v_pago from public.mesa_pagamentos
    where venda_id = old.id and status = 'pago' and usado_em is null;
    if v_pago > 0 then
      raise exception 'O cliente já pagou R$ % pelo QR da mesa. Feche a conta (o PIX já entra como pagamento) em vez de cancelar ou juntar.',
        replace(to_char(v_pago, 'FM999999990.00'), '.', ',');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists t_vendas_qr_proteger on public.vendas;
create trigger t_vendas_qr_proteger before update of status on public.vendas
  for each row execute function private.vendas_qr_proteger();

-- Conta fechada: os PIX do QR foram usados; chamados abertos da conta se encerram
create or replace function private.vendas_qr_encerrar()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'aberta' and new.status in ('finalizada','cancelada') then
    if new.status = 'finalizada' then
      update public.mesa_pagamentos set usado_em = now() where venda_id = new.id and status = 'pago' and usado_em is null;
    end if;
    update public.mesa_pagamentos set status = 'cancelado' where venda_id = new.id and status = 'pendente';
    update public.mesa_chamados set status = case when tipo = 'pedido' then 'cancelado' else 'atendido' end, resolvido_em = now()
    where venda_id = new.id and status = 'pendente';
  end if;
  return new;
end $$;
drop trigger if exists t_vendas_qr_encerrar on public.vendas;
create trigger t_vendas_qr_encerrar after update of status on public.vendas
  for each row execute function private.vendas_qr_encerrar();

-- =====================================================================
-- 2b. Funções públicas (cliente na mesa, sem login)
-- =====================================================================
/** Mesa pelo token do QR, se a loja tem o módulo de mesas e o QR ligado. */
create or replace function private.mesa_por_token(p_token uuid)
returns public.mesas language plpgsql stable security definer set search_path = '' as $$
declare m public.mesas;
begin
  select * into m from public.mesas where qr_token = p_token and ativo;
  if not found or not private.modulo_garcom(m.empresa_id)
     or coalesce((private.cfg_restaurante(m.empresa_id)->>'qr_ativo')::boolean, true) = false then
    raise exception 'QR Code inválido ou desativado. Chame o garçom.';
  end if;
  return m;
end $$;

/** Produtos que o cliente pode pedir pelo QR: os do cardápio digital (se a loja usa) ou todos os vendidos por unidade. */
create or replace function private.mesa_produtos_qr(p_emp uuid)
returns setof public.produtos language sql stable security definer set search_path = '' as $$
  select p.* from public.produtos p
  where p.empresa_id = p_emp and p.ativo and p.preco_venda > 0 and p.unidade not in ('KG','G','L','ML','M')
    and (p.no_cardapio or not exists (select 1 from public.produtos x where x.empresa_id = p_emp and x.ativo and x.no_cardapio))
$$;

/** Conta ao vivo da mesa (o que o cliente vê). */
create or replace function public.mesa_publica(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare m public.mesas; e public.empresas; v public.vendas; cfg jsonb; r jsonb; v_pago numeric := 0;
begin
  m := private.mesa_por_token(p_token);
  select * into e from public.empresas where id = m.empresa_id;
  cfg := private.cfg_restaurante(m.empresa_id);
  select * into v from public.vendas where mesa_id = m.id and status = 'aberta' and canal = 'mesa' order by created_at desc limit 1;
  if v.id is not null then
    select coalesce(sum(valor), 0) into v_pago from public.mesa_pagamentos where venda_id = v.id and status = 'pago';
  end if;
  r := jsonb_build_object(
    'loja', jsonb_build_object('nome', coalesce(e.nome_fantasia, e.razao_social)),
    'mesa', jsonb_build_object('nome', m.nome, 'numero', m.numero, 'lugares', m.lugares),
    'aberta', v.id is not null,
    'pode_pedir', coalesce((cfg->>'qr_pedir')::boolean, true),
    'pode_pagar', coalesce((cfg->>'qr_pagar')::boolean, true),
    'pix_automatico', exists (select 1 from public.integracoes_pagamento i where i.empresa_id = e.id and i.mp_access_token is not null),
    'pix', case when e.pix_chave is not null then jsonb_build_object('chave', e.pix_chave, 'tipo', e.pix_tipo,
              'nome', coalesce(e.pix_nome, e.nome_fantasia, e.razao_social), 'cidade', coalesce(e.pix_cidade, e.municipio, 'BRASIL')) end,
    -- Chamados e pedidos recentes desta mesa (da conta atual, ou sem conta se a mesa está livre)
    'chamados', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.tipo, 'status', c.status, 'criado_em', c.criado_em,
          'valor', c.valor, 'motivo', c.motivo, 'itens', c.itens) order by c.criado_em desc)
        from public.mesa_chamados c
        where c.mesa_id = m.id and c.criado_em > now() - interval '3 hours'
          and (c.status = 'pendente' or c.tipo = 'pedido')
          and (case when v.id is null then c.venda_id is null and (c.status = 'pendente' or c.criado_em > now() - interval '30 minutes')
                    else c.venda_id = v.id or (c.venda_id is null and c.criado_em >= v.created_at - interval '15 minutes') end)), '[]'::jsonb)
  );
  if v.id is not null then
    r := r || jsonb_build_object('conta', jsonb_build_object(
      'numero', v.numero, 'aberta_em', v.created_at, 'pessoas', v.pessoas,
      'garcom', split_part(coalesce((select nome from public.perfis where id = coalesce(v.garcom_id, v.operador_id)), ''), ' ', 1),
      'subtotal', v.subtotal, 'desconto', v.desconto, 'taxa_servico', v.taxa_servico, 'servico_pct', v.servico_pct,
      'couvert', v.couvert, 'couvert_unit', v.couvert_unit, 'total', v.total,
      'conta_pedida', v.conta_pedida_em is not null,
      'pago', v_pago, 'falta', greatest(0, v.total - v_pago),
      'itens', coalesce((select jsonb_agg(jsonb_build_object('descricao', i.descricao, 'quantidade', i.quantidade, 'unidade', i.unidade,
            'total', i.total, 'observacao', i.observacao,
            'etapa', (select t.status from public.cozinha_pedidos t where t.venda_id = v.id
                      and t.itens @> jsonb_build_array(jsonb_build_object('id', i.id::text)) order by t.criado_em desc limit 1))
          order by i.item) from public.venda_itens i where i.venda_id = v.id and not i.removido), '[]'::jsonb)));
  end if;
  return r;
end $$;

/** Cardápio para pedir pela mesa (carregado uma vez). */
create or replace function public.mesa_cardapio(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare m public.mesas;
begin
  m := private.mesa_por_token(p_token);
  return jsonb_build_object(
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'cor', c.cor) order by c.ordem, c.nome)
        from public.categorias c where c.empresa_id = m.empresa_id and c.ativo
          and exists (select 1 from private.mesa_produtos_qr(m.empresa_id) p where p.categoria_id = c.id)), '[]'::jsonb),
    'produtos', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'nome', p.nome, 'descricao', p.descricao, 'preco', p.preco_venda,
          'imagem', p.imagem_url, 'categoria_id', p.categoria_id, 'destaque', p.favorito) order by p.nome)
        from private.mesa_produtos_qr(m.empresa_id) p), '[]'::jsonb));
end $$;

/** Limite contra brincadeira: no máximo 8 chamados/pedidos por mesa a cada 10 minutos. */
create or replace function private.mesa_limite(p_mesa uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.mesa_chamados where mesa_id = p_mesa and criado_em > now() - interval '10 minutes') >= 8 then
    raise exception 'Muitos chamados desta mesa. O garçom já foi avisado, aguarde um instante.';
  end if;
end $$;

/** Chamar garçom, pedir a conta ou avisar que pagou por PIX (chave da loja). */
create or replace function public.mesa_chamar(p_token uuid, p_tipo text, p_valor numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.mesas; v public.vendas; c public.mesa_chamados; v_valor numeric;
begin
  if p_tipo not in ('garcom','conta','pix') then raise exception 'Pedido inválido'; end if;
  m := private.mesa_por_token(p_token);
  perform pg_advisory_xact_lock(hashtextextended('mesa-qr' || m.id::text, 0));
  select * into v from public.vendas where mesa_id = m.id and status = 'aberta' and canal = 'mesa' order by created_at desc limit 1;
  if p_tipo in ('conta','pix') and v.id is null then raise exception 'Esta mesa não tem conta aberta. Chame o garçom.'; end if;
  if p_tipo = 'pix' then
    if coalesce((private.cfg_restaurante(m.empresa_id)->>'qr_pagar')::boolean, true) = false then raise exception 'Pagamento pelo QR desligado. Chame o garçom.'; end if;
    v_valor := round(p_valor, 2);
    if v_valor is null or v_valor < 0.01 or v_valor > v.total + 0.009 then raise exception 'Valor inválido'; end if;
  end if;
  -- Mesmo chamado ainda pendente: não duplica
  select * into c from public.mesa_chamados where mesa_id = m.id and tipo = p_tipo and status = 'pendente'
    and (p_tipo <> 'pix' or valor = v_valor) order by criado_em desc limit 1;
  if found then return jsonb_build_object('id', c.id, 'tipo', c.tipo, 'repetido', true); end if;
  perform private.mesa_limite(m.id);
  insert into public.mesa_chamados (empresa_id, mesa_id, venda_id, tipo, valor)
  values (m.empresa_id, m.id, v.id, p_tipo, v_valor) returning * into c;
  if p_tipo = 'conta' then
    update public.vendas set conta_pedida_em = coalesce(conta_pedida_em, now()) where id = v.id;
  end if;
  return jsonb_build_object('id', c.id, 'tipo', c.tipo, 'repetido', false);
end $$;

/** Pedido feito pelo cliente: fica pendente até um funcionário confirmar (aí vai para a conta e a cozinha). */
create or replace function public.mesa_cliente_pedir(p_token uuid, p_itens jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.mesas; v public.vendas; v_item jsonb; p public.produtos; v_q numeric; v_lista jsonb := '[]'::jsonb; v_total numeric := 0; c public.mesa_chamados;
begin
  m := private.mesa_por_token(p_token);
  if coalesce((private.cfg_restaurante(m.empresa_id)->>'qr_pedir')::boolean, true) = false then
    raise exception 'Esta loja não recebe pedidos pelo QR. Chame o garçom.';
  end if;
  if jsonb_typeof(p_itens) is distinct from 'array' or jsonb_array_length(p_itens) = 0 then raise exception 'Escolha ao menos um item'; end if;
  if jsonb_array_length(p_itens) > 30 then raise exception 'Muitos itens de uma vez'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mesa-qr' || m.id::text, 0));
  if (select count(*) from public.mesa_chamados where mesa_id = m.id and tipo = 'pedido' and status = 'pendente') >= 3 then
    raise exception 'Você já tem pedidos aguardando o garçom confirmar. Aguarde um instante.';
  end if;
  perform private.mesa_limite(m.id);
  for v_item in select * from jsonb_array_elements(p_itens) loop
    select * into p from private.mesa_produtos_qr(m.empresa_id) x where x.id = nullif(v_item->>'produto_id', '')::uuid;
    if not found then raise exception 'Um dos produtos não está mais disponível. Atualize a página.'; end if;
    v_q := (v_item->>'quantidade')::numeric;
    if v_q is null or v_q < 1 or v_q > 20 or v_q <> trunc(v_q) then raise exception 'Quantidade inválida: %', p.nome; end if;
    v_lista := v_lista || jsonb_build_array(jsonb_build_object('produto_id', p.id, 'nome', p.nome, 'quantidade', v_q,
      'observacao', nullif(left(trim(coalesce(v_item->>'observacao', '')), 100), ''), 'preco', p.preco_venda));
    v_total := v_total + v_q * p.preco_venda;
  end loop;
  select * into v from public.vendas where mesa_id = m.id and status = 'aberta' and canal = 'mesa' order by created_at desc limit 1;
  insert into public.mesa_chamados (empresa_id, mesa_id, venda_id, tipo, itens, valor)
  values (m.empresa_id, m.id, v.id, 'pedido', v_lista, round(v_total, 2)) returning * into c;
  return jsonb_build_object('id', c.id, 'valor', c.valor);
end $$;

/** O cliente desiste de um pedido (ou chamado) que ninguém atendeu ainda. */
create or replace function public.mesa_cliente_cancelar(p_token uuid, p_chamado uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare m public.mesas;
begin
  m := private.mesa_por_token(p_token);
  update public.mesa_chamados set status = 'cancelado', resolvido_em = now(), motivo = 'Cancelado pelo cliente'
  where id = p_chamado and mesa_id = m.id and status = 'pendente' and tipo in ('pedido','garcom');
  if not found then raise exception 'Este pedido já foi atendido pelo garçom'; end if;
end $$;

-- =====================================================================
-- 2c. Funções da loja (garçom, caixa, gerente)
-- =====================================================================
/** Chamados pendentes das mesas (aviso no app do garçom e no sistema). */
create or replace function public.mesa_chamados_pendentes()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or private.papel()::text = 'cozinha' then raise exception 'Sem permissão'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.tipo, 'mesa_id', c.mesa_id, 'mesa', m.nome, 'numero', m.numero,
        'venda_id', c.venda_id, 'itens', c.itens, 'valor', c.valor, 'automatico', c.automatico, 'criado_em', c.criado_em,
        'garcom_id', (select coalesce(v.garcom_id, v.operador_id) from public.vendas v where v.id = c.venda_id and v.status = 'aberta'))
      order by c.criado_em)
    from public.mesa_chamados c join public.mesas m on m.id = c.mesa_id
    where c.empresa_id = v_emp and c.status = 'pendente' and c.criado_em > now() - interval '12 hours'), '[]'::jsonb);
end $$;

/**
 * Resolve um chamado: 'atender' (garçom, conta, PIX), 'aceitar' (pedido do cliente: abre a mesa se
 * estiver livre e lança os itens pelas regras de sempre) ou 'recusar' (pedido, com motivo para o cliente).
 */
create or replace function public.mesa_chamado_resolver(p_id uuid, p_acao text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); c public.mesa_chamados; v_venda uuid; r jsonb := '{}'::jsonb;
begin
  if v_emp is null or private.papel()::text = 'cozinha' then raise exception 'Sem permissão'; end if;
  select * into c from public.mesa_chamados where id = p_id and empresa_id = v_emp for update;
  if not found then raise exception 'Chamado não encontrado'; end if;
  if c.status <> 'pendente' then
    if c.status = 'cancelado' then raise exception 'O cliente cancelou este pedido'; end if;
    return jsonb_build_object('ja_resolvido', true, 'status', c.status);
  end if;
  if p_acao = 'aceitar' then
    if c.tipo <> 'pedido' then raise exception 'Ação inválida'; end if;
    select id into v_venda from public.vendas where mesa_id = c.mesa_id and status = 'aberta' and canal = 'mesa' order by created_at desc limit 1;
    if v_venda is null then v_venda := public.abrir_mesa(c.mesa_id, null); end if;
    r := public.adicionar_itens(v_venda, (select jsonb_agg(jsonb_build_object('produto_id', x->>'produto_id', 'quantidade', x->'quantidade',
            'observacao', x->>'observacao')) from jsonb_array_elements(c.itens) x));
    update public.mesa_chamados set status = 'atendido', venda_id = v_venda, resolvido_em = now(), resolvido_por = auth.uid() where id = c.id;
    perform private.auditar(v_emp, 'mesa.qr_pedido', 'mesa_chamados', c.id::text, jsonb_build_object('mesa', c.mesa_id, 'itens', c.itens, 'valor', c.valor));
  elsif p_acao = 'recusar' then
    if c.tipo <> 'pedido' then raise exception 'Ação inválida'; end if;
    update public.mesa_chamados set status = 'recusado', motivo = nullif(left(trim(coalesce(p_motivo, '')), 120), ''),
      resolvido_em = now(), resolvido_por = auth.uid() where id = c.id;
  elsif p_acao = 'atender' then
    if c.tipo = 'pedido' then raise exception 'Confirme ou recuse o pedido'; end if;
    update public.mesa_chamados set status = 'atendido', resolvido_em = now(), resolvido_por = auth.uid() where id = c.id;
  else
    raise exception 'Ação inválida';
  end if;
  return r || jsonb_build_object('status', (select status from public.mesa_chamados where id = c.id), 'venda_id', coalesce(v_venda, c.venda_id));
end $$;

/** Troca o QR de uma mesa (ou de todas): os QRs impressos antes param de funcionar. */
create or replace function public.mesa_qr_trocar(p_mesa uuid default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); n int;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  update public.mesas set qr_token = gen_random_uuid() where empresa_id = v_emp and (p_mesa is null or id = p_mesa);
  get diagnostics n = row_count;
  perform private.auditar(v_emp, 'mesa.qr_trocar', 'mesas', coalesce(p_mesa::text, 'todas'), jsonb_build_object('mesas', n));
  return n;
end $$;

/** PIX pagos pelo cliente no QR e ainda não usados no fechamento desta conta. */
create or replace function public.mesa_pagamentos_conta(p_venda uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'valor', valor, 'pago_em', pago_em, 'mp_id', mp_id) order by pago_em), '[]'::jsonb)
  from public.mesa_pagamentos
  where venda_id = p_venda and empresa_id = private.empresa_id() and status = 'pago' and usado_em is null
$$;

-- Configurações do QR (junto com as regras do restaurante)
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
-- 1. Tela "Hoje"
-- =====================================================================
create or replace function public.painel_hoje()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_emp uuid := private.empresa_id(); v_tz text; v_hoje date; v_ini timestamptz; v_agora timestamptz := now();
  e public.empresas; cfg jsonb; itens jsonb := '[]'::jsonb; r record; n int; n2 int; v_valor numeric; v_min int;
  v_resumo jsonb;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  select * into e from public.empresas where id = v_emp;
  v_tz := private.fuso(v_emp);
  v_hoje := (v_agora at time zone v_tz)::date;
  v_ini := v_hoje::timestamp at time zone v_tz;
  cfg := private.cfg_restaurante(v_emp);

  -- Pedidos do garçom aguardando aprovação
  select count(*), coalesce(max(extract(epoch from v_agora - criado_em) / 60), 0)::int into n, v_min
  from public.cozinha_pedidos where empresa_id = v_emp and status = 'aguardando';
  if n > 0 then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'aprovacao', 'nivel', case when v_min >= 5 then 'urgente' else 'atencao' end,
      'icone', 'chapeu', 'titulo', n || case when n = 1 then ' pedido do garçom aguarda aprovação' else ' pedidos do garçom aguardam aprovação' end,
      'detalhe', 'O mais antigo há ' || v_min || ' min. A cozinha só começa depois de aprovar.', 'rota', 'cozinha', 'acao', 'Revisar'));
  end if;

  -- Chamados das mesas pelo QR
  for r in select c.*, m.nome mesa from public.mesa_chamados c join public.mesas m on m.id = c.mesa_id
           where c.empresa_id = v_emp and c.status = 'pendente' and c.criado_em > v_agora - interval '12 hours' order by c.criado_em limit 8 loop
    v_min := (extract(epoch from v_agora - r.criado_em) / 60)::int;
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'chamado:' || r.id, 'id', r.id, 'tipo_chamado', r.tipo,
      'nivel', case when v_min >= 3 or r.tipo = 'pedido' then 'urgente' else 'atencao' end, 'icone', case when r.tipo = 'pix' then 'pix' else 'sino' end,
      'titulo', r.mesa || case r.tipo when 'garcom' then ' chamou o garçom' when 'conta' then ' pediu a conta'
                                    when 'pedido' then ' fez um pedido pelo QR'
                                    else case when r.automatico then ' pagou R$ ' else ' avisou que pagou R$ ' end || replace(to_char(r.valor, 'FM999999990.00'), '.', ',') || ' por PIX' end,
      'detalhe', case when r.tipo = 'pedido' then (select string_agg((x->>'quantidade') || '× ' || (x->>'nome'), ', ') from jsonb_array_elements(r.itens) x)
                      when r.tipo = 'pix' and r.automatico then 'Confirmado pelo Mercado Pago. Entra sozinho ao fechar a conta.'
                      when r.tipo = 'pix' then 'Confira o comprovante no celular do cliente.'
                      else 'Há ' || v_min || ' min' end,
      'valor', case when r.tipo in ('pedido','pix') then r.valor end, 'rota', 'mesas',
      'acao', case when r.tipo = 'pedido' then 'Ver pedido' else 'Atendido' end, 'acao_tipo', 'chamado'));
  end loop;

  -- Delivery esperando a loja aceitar
  select count(*), coalesce(max(extract(epoch from v_agora - created_at) / 60), 0)::int into n, v_min
  from public.vendas where empresa_id = v_emp and status = 'aberta' and canal in ('delivery','retirada') and status_pedido = 'recebido';
  if n > 0 then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'delivery', 'nivel', case when v_min >= 5 then 'urgente' else 'atencao' end, 'icone', 'moto',
      'titulo', n || case when n = 1 then ' pedido do delivery esperando aceite' else ' pedidos do delivery esperando aceite' end,
      'detalhe', 'O mais antigo há ' || v_min || ' min. O cliente está acompanhando pelo celular.', 'rota', 'delivery', 'acao', 'Aceitar'));
  end if;

  -- Conta pedida há muito tempo
  for r in select id, identificador, conta_pedida_em, total from public.vendas
           where empresa_id = v_emp and status = 'aberta' and canal = 'mesa' and conta_pedida_em < v_agora - interval '10 minutes'
             and not exists (select 1 from public.mesa_chamados c where c.venda_id = vendas.id and c.tipo = 'conta' and c.status = 'pendente')
           order by conta_pedida_em limit 5 loop
    v_min := (extract(epoch from v_agora - r.conta_pedida_em) / 60)::int;
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'conta:' || r.id || ':' || extract(epoch from r.conta_pedida_em)::bigint,
      'nivel', case when v_min >= 20 then 'urgente' else 'atencao' end,
      'icone', 'conta', 'titulo', coalesce(r.identificador, 'Mesa') || ' pediu a conta há ' || v_min || ' min', 'detalhe', 'Cliente esperando para pagar.',
      'valor', r.total, 'rota', 'mesas', 'acao', 'Ver mesa'));
  end loop;

  -- Pedidos atrasados na cozinha
  select count(*) into n from public.cozinha_pedidos
  where empresa_id = v_emp and status in ('novo','preparando')
    and coalesce(aprovado_em, criado_em) < v_agora - make_interval(mins => greatest(10, round(coalesce((cfg->>'preparo_alvo_min')::numeric, 20) * 1.5)::int));
  if n > 0 then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'cozinha_atraso', 'nivel', 'atencao', 'icone', 'relogio',
      'titulo', n || case when n = 1 then ' pedido atrasado na cozinha' else ' pedidos atrasados na cozinha' end,
      'detalhe', 'Passaram de 1,5× o tempo ideal de preparo (' || coalesce(cfg->>'preparo_alvo_min', '20') || ' min).', 'rota', 'cozinha', 'acao', 'Ver cozinha'));
  end if;

  -- Caixa esquecido aberto
  for r in select s.id, s.aberto_em, p.nome from public.caixa_sessoes s left join public.perfis p on p.id = s.operador_id
           where s.empresa_id = v_emp and s.status = 'aberto' and s.aberto_em < v_agora - interval '16 hours' loop
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'caixa_aberto:' || r.id, 'nivel', 'atencao', 'icone', 'caixa',
      'titulo', 'Caixa de ' || coalesce(split_part(r.nome, ' ', 1), '?') || ' aberto desde ' || to_char(r.aberto_em at time zone v_tz, 'DD/MM "às" HH24:MI'),
      'detalhe', 'Parece que esqueceram de fechar. Feche e confira o dinheiro da gaveta.', 'rota', 'caixa', 'acao', 'Ver caixa'));
  end loop;

  -- Caixas fechados com diferença (ontem e hoje)
  for r in select s.id, s.diferenca, s.fechado_em, p.nome from public.caixa_sessoes s left join public.perfis p on p.id = s.operador_id
           where s.empresa_id = v_emp and s.status = 'fechado' and s.fechado_em >= v_ini - interval '1 day' and abs(coalesce(s.diferenca, 0)) >= 5
           order by s.fechado_em desc limit 5 loop
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'caixa_dif:' || r.id, 'nivel', case when r.diferenca <= -50 then 'urgente' else 'atencao' end, 'icone', 'caixa',
      'titulo', 'Caixa de ' || coalesce(split_part(r.nome, ' ', 1), '?') || ' fechou com ' || case when r.diferenca < 0 then 'falta' else 'sobra' end
        || ' de R$ ' || replace(to_char(abs(r.diferenca), 'FM999999990.00'), '.', ','),
      'detalhe', 'Fechado ' || case when (r.fechado_em at time zone v_tz)::date = v_hoje then 'hoje' else 'ontem' end || ' às ' || to_char(r.fechado_em at time zone v_tz, 'HH24:MI') || '. Converse e confira o registro de atividades.',
      'rota', 'alertas', 'acao', 'Ver alertas'));
  end loop;

  -- Contas a pagar: vencidas e vencendo hoje/amanhã
  for r in select id, descricao, valor, vencimento from public.contas_pagar
           where empresa_id = v_emp and pago_em is null and vencimento <= v_hoje + 1 order by vencimento limit 8 loop
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'conta_pagar:' || r.id, 'id', r.id, 'nivel', case when r.vencimento < v_hoje then 'urgente' else 'atencao' end,
      'icone', 'carteira', 'titulo', r.descricao,
      'detalhe', case when r.vencimento < v_hoje then 'Venceu em ' || to_char(r.vencimento, 'DD/MM') when r.vencimento = v_hoje then 'Vence hoje' else 'Vence amanhã' end,
      'valor', r.valor, 'rota', 'financeiro', 'acao', 'Marcar paga', 'acao_tipo', 'pagar_conta'));
  end loop;

  -- Validade
  select count(*) filter (where validade < v_hoje), count(*) filter (where validade >= v_hoje)
  into n, n2 from public.lotes where empresa_id = v_emp and status = 'ativo' and saldo > 0 and validade <= v_hoje + 3;
  if n > 0 then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'vencidos:' || n, 'nivel', 'urgente', 'icone', 'ampulheta',
      'titulo', n || case when n = 1 then ' lote vencido ainda no estoque' else ' lotes vencidos ainda no estoque' end,
      'detalhe', (select string_agg(nome, ', ') from (select distinct p.nome from public.lotes l join public.produtos p on p.id = l.produto_id
                  where l.empresa_id = v_emp and l.status = 'ativo' and l.saldo > 0 and l.validade < v_hoje limit 3) x) || '. Tire da prateleira e dê baixa como perda.',
      'rota', 'validade', 'acao', 'Dar baixa'));
  end if;
  if n2 > 0 then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'vencendo:' || n2, 'nivel', 'info', 'icone', 'ampulheta',
      'titulo', n2 || case when n2 = 1 then ' lote vence nos próximos 3 dias' else ' lotes vencem nos próximos 3 dias' end,
      'detalhe', (select string_agg(nome, ', ') from (select distinct p.nome from public.lotes l join public.produtos p on p.id = l.produto_id
                  where l.empresa_id = v_emp and l.status = 'ativo' and l.saldo > 0 and l.validade between v_hoje and v_hoje + 3 limit 3) x) || '. Uma promoção ajuda a vender antes.',
      'rota', 'validade', 'acao', 'Ver lotes'));
  end if;

  -- Estoque
  select count(*) filter (where estoque_atual <= 0), count(*) filter (where estoque_atual > 0)
  into n, n2 from public.produtos where empresa_id = v_emp and ativo and controla_estoque and estoque_atual <= estoque_minimo and (estoque_minimo > 0 or estoque_atual <= 0);
  if n + n2 > 0 then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'estoque:' || n || ':' || n2, 'nivel', case when n > 0 then 'atencao' else 'info' end, 'icone', 'estoque',
      'titulo', case when n > 0 then n || case when n = 1 then ' produto acabou' else ' produtos acabaram' end else '' end
        || case when n > 0 and n2 > 0 then ' e ' else '' end
        || case when n2 > 0 then n2 || case when n2 = 1 then ' está abaixo do mínimo' else ' estão abaixo do mínimo' end else '' end,
      'detalhe', (select string_agg(nome, ', ') from (select nome from public.produtos where empresa_id = v_emp and ativo and controla_estoque
                  and estoque_atual <= estoque_minimo and (estoque_minimo > 0 or estoque_atual <= 0) order by estoque_atual - estoque_minimo, nome limit 3) x)
        || case when n + n2 > 3 then '…' else '' end,
      'rota', 'compras', 'acao', 'Sugestão de compra'));
  end if;

  -- Fiado vencido
  select count(*), coalesce(sum((x->>'vencido')::numeric), 0) into n, v_valor
  from jsonb_array_elements(public.fiado_clientes(false)) x where (x->>'vencido')::numeric > 0;
  if n > 0 then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'fiado:' || n, 'nivel', 'info', 'icone', 'caderno',
      'titulo', n || case when n = 1 then ' cliente com fiado vencido' else ' clientes com fiado vencido' end,
      'detalhe', 'Cobre pelo WhatsApp com o PIX pronto, direto da tela Fiado.', 'valor', v_valor, 'rota', 'fiado', 'acao', 'Cobrar'));
  end if;

  -- Nota fiscal com problema (3 dias)
  select count(*) into n from public.documentos_fiscais
  where empresa_id = v_emp and created_at > v_agora - interval '3 days'
    and (status in ('rejeitado','erro') or (status = 'processando' and created_at < v_agora - interval '30 minutes'));
  if n > 0 then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'fiscal:' || n, 'nivel', 'urgente', 'icone', 'nota',
      'titulo', n || case when n = 1 then ' nota fiscal com problema' else ' notas fiscais com problema' end,
      'detalhe', 'Rejeitadas ou presas em processamento. Abra a venda e emita de novo.', 'rota', 'vendas', 'acao', 'Ver vendas'));
  end if;

  -- Alertas de operador (hoje)
  select count(*) into n from jsonb_array_elements(coalesce((private.alertas_antifraude(v_emp, v_ini, v_agora))->'alertas', '[]'::jsonb)) a where a->>'nivel' = 'alto';
  if n > 0 then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'antifraude:' || n, 'nivel', 'atencao', 'icone', 'escudo',
      'titulo', n || case when n = 1 then ' alerta de operador hoje' else ' alertas de operador hoje' end,
      'detalhe', 'Cancelamentos, descontos ou gaveta fora do normal da loja.', 'rota', 'alertas', 'acao', 'Ver alertas'));
  end if;

  -- Mensalidade e teste
  for r in select id, valor, vencimento from public.faturas where empresa_id = v_emp and status = 'pendente' and vencimento <= v_hoje + 3 order by vencimento limit 2 loop
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'fatura:' || r.id, 'nivel', case when r.vencimento < v_hoje then 'urgente' else 'info' end, 'icone', 'assinatura',
      'titulo', 'Mensalidade do sistema ' || case when r.vencimento < v_hoje then 'vencida' when r.vencimento = v_hoje then 'vence hoje' else 'vence em ' || to_char(r.vencimento, 'DD/MM') end,
      'detalhe', 'Pague pelo link na tela Minha assinatura.', 'valor', r.valor, 'rota', 'conta', 'acao', 'Pagar'));
  end loop;
  if e.status_conta = 'teste' and e.teste_expira_em is not null and e.teste_expira_em < v_agora + interval '3 days' then
    itens := itens || jsonb_build_array(jsonb_build_object('k', 'teste', 'nivel', 'atencao', 'icone', 'assinatura',
      'titulo', 'O teste grátis termina ' || case when e.teste_expira_em < v_agora + interval '1 day' then 'hoje' else 'em ' || to_char(e.teste_expira_em at time zone v_tz, 'DD/MM') end,
      'detalhe', 'Escolha um plano para continuar vendendo sem interrupção.', 'rota', 'conta', 'acao', 'Ver planos'));
  end if;

  -- Resumo do dia (comparado com o mesmo dia da semana passada até a mesma hora)
  select jsonb_build_object(
    'faturamento', coalesce(sum(total) filter (where finalizada_em >= v_ini), 0),
    'vendas', count(*) filter (where finalizada_em >= v_ini),
    'ticket', coalesce(round(avg(total) filter (where finalizada_em >= v_ini), 2), 0),
    'semana_passada', coalesce(sum(total) filter (where finalizada_em < v_ini), 0))
  into v_resumo from public.vendas
  where empresa_id = v_emp and status = 'finalizada'
    and ((finalizada_em >= v_ini and finalizada_em < v_agora) or (finalizada_em >= v_ini - interval '7 days' and finalizada_em < v_agora - interval '7 days'));
  v_resumo := v_resumo || jsonb_build_object(
    'abertos', (select count(*) from public.vendas where empresa_id = v_emp and status = 'aberta' and canal in ('mesa','balcao')),
    'abertos_valor', (select coalesce(sum(total), 0) from public.vendas where empresa_id = v_emp and status = 'aberta' and canal in ('mesa','balcao')),
    'caixas', (select count(*) from public.caixa_sessoes where empresa_id = v_emp and status = 'aberto'),
    'delivery_hoje', (select count(*) from public.vendas where empresa_id = v_emp and canal in ('delivery','retirada') and created_at >= v_ini and status <> 'cancelada'));

  return jsonb_build_object('hoje', v_hoje, 'agora', v_agora, 'resumo', v_resumo, 'itens', itens,
    'restaurante', private.modulo_garcom(v_emp));
end $$;

-- =====================================================================
-- Permissões
-- =====================================================================
revoke execute on all functions in schema private from public, anon;
revoke execute on function public.mesa_publica(uuid), public.mesa_cardapio(uuid), public.mesa_chamar(uuid,text,numeric),
  public.mesa_cliente_pedir(uuid,jsonb), public.mesa_cliente_cancelar(uuid,uuid), public.mesa_chamados_pendentes(),
  public.mesa_chamado_resolver(uuid,text,text), public.mesa_qr_trocar(uuid), public.mesa_pagamentos_conta(uuid),
  public.painel_hoje(), public.salvar_config_restaurante(jsonb) from public;
-- Funções da equipe: nunca para visitante sem login (o Supabase concede ao anon diretamente)
revoke execute on function public.mesa_chamados_pendentes(), public.mesa_chamado_resolver(uuid,text,text), public.mesa_qr_trocar(uuid),
  public.mesa_pagamentos_conta(uuid), public.painel_hoje(), public.salvar_config_restaurante(jsonb) from anon;
grant execute on function public.mesa_publica(uuid), public.mesa_cardapio(uuid), public.mesa_chamar(uuid,text,numeric),
  public.mesa_cliente_pedir(uuid,jsonb), public.mesa_cliente_cancelar(uuid,uuid) to anon, authenticated;
grant execute on function public.mesa_chamados_pendentes(), public.mesa_chamado_resolver(uuid,text,text), public.mesa_qr_trocar(uuid),
  public.mesa_pagamentos_conta(uuid), public.painel_hoje(), public.salvar_config_restaurante(jsonb) to authenticated;
