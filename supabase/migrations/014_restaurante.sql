-- =====================================================================
-- Restaurante: cozinha com aprovação, taxa de serviço/couvert opcionais,
-- garçom responsável pela mesa (metas e comissão), transferência de itens
-- entre mesas e comandas e tempo de ocupação.
-- Depende da 013 (nível "cozinha").
-- =====================================================================

-- ---------- Configuração do restaurante (escolhas do dono) ----------
alter table public.empresas add column if not exists config_restaurante jsonb not null default '{}'::jsonb;

-- Padrões + o que a loja escolheu. servico_modo: nao | sugerir (só aparece na conta) | cobrar (entra no total)
create or replace function private.cfg_restaurante(p_emp uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
      'servico_modo', 'sugerir', 'servico_percentual', 10,
      'couvert_ativo', false, 'couvert_valor', 0, 'couvert_nome', 'Couvert artístico',
      'comissao_percentual', 10, 'comissao_base', 'consumo', 'meta_mensal_padrao', 0,
      'aprovacao_cozinha', true, 'preparo_alvo_min', 20,
      'tempo_alerta_min', 60, 'tempo_critico_min', 120, 'ocioso_min', 25)
    || coalesce((select e.config_restaurante from public.empresas e where e.id = p_emp), '{}'::jsonb)
$$;

-- Categorias que não passam pela cozinha (ex.: bebidas prontas)
alter table public.categorias add column if not exists envia_cozinha boolean not null default true;

-- ---------- Vendas: garçom responsável, taxa de serviço e couvert ----------
alter table public.vendas
  add column if not exists garcom_id uuid references public.perfis(id) on delete set null,
  add column if not exists servico_pct numeric(5,2) check (servico_pct is null or servico_pct between 0 and 30),
  add column if not exists couvert_unit numeric(10,2) check (couvert_unit is null or couvert_unit >= 0),
  add column if not exists taxa_servico numeric(10,2) not null default 0,
  add column if not exists couvert numeric(10,2) not null default 0;
create index if not exists vendas_garcom_idx on public.vendas(empresa_id, garcom_id, finalizada_em) where garcom_id is not null;

-- Histórico: quem atendeu cada mesa (o caixa que fecha vira o operador, o garçom fica aqui)
update public.vendas v set garcom_id = coalesce(
    (select i.criado_por from public.venda_itens i where i.venda_id = v.id and i.criado_por is not null order by i.criado_em limit 1),
    case when v.status = 'aberta' then v.operador_id end)
where v.canal = 'mesa' and v.garcom_id is null;

-- ---------- Metas e comissão por garçom ----------
create table if not exists public.garcom_metas (
  perfil_id uuid primary key references public.perfis(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  meta_mensal numeric(12,2) check (meta_mensal is null or meta_mensal >= 0),          -- null = meta padrão da loja
  comissao_percentual numeric(5,2) check (comissao_percentual is null or comissao_percentual between 0 and 100), -- null = padrão
  updated_at timestamptz not null default now()
);
create index if not exists garcom_metas_empresa_idx on public.garcom_metas(empresa_id);
alter table public.garcom_metas enable row level security;
drop policy if exists garcom_metas_ler on public.garcom_metas;
create policy garcom_metas_ler on public.garcom_metas for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (perfil_id = (select auth.uid()) or (select private.tem_papel('{admin,gerente}'))));
revoke all on public.garcom_metas from anon;
revoke insert, update, delete on public.garcom_metas from authenticated;

-- ---------- Pedidos da cozinha (KDS) ----------
-- Cada envio do garçom vira um pedido com cópia dos itens. Fluxo:
-- aguardando (aprovação do caixa/gerente) → novo → preparando → pronto → entregue
-- (ou recusado / cancelado). O delivery entra direto como "novo" ao ser aceito.
create table if not exists public.cozinha_pedidos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  venda_id uuid not null references public.vendas(id) on delete cascade,
  origem text not null check (origem in ('mesa','balcao','delivery','retirada')),
  identificador text,
  numero_venda bigint,
  garcom_id uuid references public.perfis(id) on delete set null,
  status text not null default 'novo' check (status in ('aguardando','novo','preparando','pronto','entregue','recusado','cancelado')),
  itens jsonb not null default '[]'::jsonb,
  criado_em timestamptz not null default now(),
  aprovado_em timestamptz,
  aprovado_por uuid references public.perfis(id) on delete set null,
  preparo_em timestamptz,
  pronto_em timestamptz,
  entregue_em timestamptz,
  entregue_por uuid references public.perfis(id) on delete set null,
  recusado_motivo text,
  atualizado_em timestamptz not null default now()
);
create index if not exists cozinha_pedidos_ativos_idx on public.cozinha_pedidos(empresa_id, status, criado_em);
create index if not exists cozinha_pedidos_venda_idx on public.cozinha_pedidos(venda_id);
create index if not exists cozinha_pedidos_garcom_idx on public.cozinha_pedidos(garcom_id);
alter table public.cozinha_pedidos enable row level security;
drop policy if exists cozinha_pedidos_ler on public.cozinha_pedidos;
create policy cozinha_pedidos_ler on public.cozinha_pedidos for select to authenticated
  using (empresa_id = (select private.empresa_id()));
revoke all on public.cozinha_pedidos from anon;
revoke insert, update, delete on public.cozinha_pedidos from authenticated;

do $$ begin
  alter publication supabase_realtime add table public.cozinha_pedidos;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- =====================================================================
-- Totais do pedido (agora com taxa de serviço e couvert)
-- =====================================================================
drop function if exists private.recalcular_venda(uuid);
create or replace function private.recalcular_venda(p_venda uuid, p_desc_manual numeric default 0)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.vendas; v_sub numeric; v_desc numeric; v_taxa numeric := 0; v_couv numeric := 0; v_acr numeric;
begin
  select * into v from public.vendas where id = p_venda;
  if not found then return; end if;
  select coalesce(sum(round(quantidade * preco_unitario, 2)), 0), coalesce(sum(desconto), 0) into v_sub, v_desc
    from public.venda_itens where venda_id = p_venda and not removido;
  v_desc := least(v_desc + greatest(coalesce(p_desc_manual, 0), 0), v_sub);
  if coalesce(v.servico_pct, 0) > 0 then v_taxa := round((v_sub - v_desc) * v.servico_pct / 100, 2); end if;
  if coalesce(v.couvert_unit, 0) > 0 then v_couv := round(v.couvert_unit * greatest(coalesce(v.pessoas, 1), 1), 2); end if;
  -- Na mesa o acréscimo é sempre serviço + couvert; delivery (taxa de entrega) e comandas mantêm o seu
  v_acr := case when v.canal = 'mesa' then v_taxa + v_couv else v.acrescimo end;
  update public.vendas set subtotal = v_sub, desconto = v_desc, taxa_servico = v_taxa, couvert = v_couv,
    acrescimo = v_acr, total = v_sub - v_desc + v_acr, alterado_em = now()
  where id = p_venda;
end $$;

-- Desconto que não veio dos itens (manual do caixa), para não perder ao recalcular
create or replace function private.desconto_manual(p_venda uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select greatest(v.desconto - coalesce((select sum(i.desconto) from public.venda_itens i where i.venda_id = v.id and not i.removido), 0), 0)
  from public.vendas v where v.id = p_venda
$$;

-- Ao fechar a conta: separa quanto do acréscimo foi couvert e quanto foi serviço (relatórios e comissão)
create or replace function private.venda_taxas_finalizar()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_couv numeric := 0; v_taxa numeric := 0;
begin
  if new.status = 'finalizada' and old.status = 'aberta' then
    if coalesce(new.couvert_unit, 0) > 0 then v_couv := round(new.couvert_unit * greatest(coalesce(new.pessoas, 1), 1), 2); end if;
    if coalesce(new.servico_pct, 0) > 0 then v_taxa := round((new.subtotal - new.desconto) * new.servico_pct / 100, 2); end if;
    new.couvert := least(v_couv, greatest(new.acrescimo, 0));
    new.taxa_servico := least(v_taxa, greatest(new.acrescimo - new.couvert, 0));
  end if;
  return new;
end $$;
drop trigger if exists t_venda_taxas on public.vendas;
create trigger t_venda_taxas before update of status on public.vendas
  for each row execute function private.venda_taxas_finalizar();

-- =====================================================================
-- Cozinha
-- =====================================================================
-- Itens de uma venda que vão para a cozinha (cópia para o KDS)
create or replace function private.itens_cozinha(p_venda uuid, p_apos int default 0)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('id', i.id, 'descricao', i.descricao, 'quantidade', i.quantidade,
           'unidade', i.unidade, 'observacao', i.observacao) order by i.item)
  from public.venda_itens i
  left join public.produtos p on p.id = i.produto_id
  left join public.categorias c on c.id = p.categoria_id
  where i.venda_id = p_venda and i.item > p_apos and not i.removido and coalesce(c.envia_cozinha, true)
$$;

create or replace function private.criar_pedido_cozinha(p_venda uuid, p_apos int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v public.vendas; v_itens jsonb; v_id uuid; cfg jsonb; v_status text;
begin
  select * into v from public.vendas where id = p_venda;
  v_itens := private.itens_cozinha(p_venda, p_apos);
  if v_itens is null then return null; end if;
  cfg := private.cfg_restaurante(v.empresa_id);
  -- Garçom envia → aguarda o caixa/gerente aprovar. Quem aprova já lança aprovado.
  v_status := case when coalesce((cfg->>'aprovacao_cozinha')::boolean, true) and not private.tem_papel('{admin,gerente,caixa}')
                   then 'aguardando' else 'novo' end;
  insert into public.cozinha_pedidos (empresa_id, venda_id, origem, identificador, numero_venda, garcom_id, status, itens, aprovado_em, aprovado_por)
  values (v.empresa_id, v.id, v.canal, coalesce(v.identificador, 'Pedido ' || v.numero), v.numero, auth.uid(), v_status, v_itens,
          case when v_status = 'novo' then now() end, case when v_status = 'novo' then auth.uid() end)
  returning id into v_id;
  return v_id;
end $$;

-- Delivery aceito vira pedido da cozinha; pedido pronto/cancelado atualiza a cozinha
create or replace function private.vendas_sync_cozinha()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_itens jsonb;
begin
  if new.canal in ('delivery','retirada') and new.status_pedido is distinct from old.status_pedido then
    if new.status_pedido = 'preparando' and not exists (select 1 from public.cozinha_pedidos where venda_id = new.id) then
      v_itens := private.itens_cozinha(new.id, 0);
      if v_itens is not null then
        insert into public.cozinha_pedidos (empresa_id, venda_id, origem, identificador, numero_venda, status, itens, aprovado_em)
        values (new.empresa_id, new.id, new.canal,
                case when new.canal = 'delivery' then 'Entrega · ' else 'Retirada · ' end || coalesce(new.cliente_nome, '#' || new.numero),
                new.numero, 'novo', v_itens, now());
      end if;
    elsif new.status_pedido = 'pronto' then
      update public.cozinha_pedidos set status = 'pronto', pronto_em = coalesce(pronto_em, now()), atualizado_em = now()
      where venda_id = new.id and status in ('novo','preparando');
    elsif new.status_pedido in ('saiu','entregue') then
      update public.cozinha_pedidos set status = 'entregue', pronto_em = coalesce(pronto_em, now()), entregue_em = now(), atualizado_em = now()
      where venda_id = new.id and status in ('novo','preparando','pronto');
    end if;
  end if;
  if new.status = 'cancelada' and old.status = 'aberta' then
    update public.cozinha_pedidos set status = 'cancelado', atualizado_em = now()
    where venda_id = new.id and status in ('aguardando','novo','preparando');
  end if;
  -- Conta paga no caixa com pedido ainda aguardando: quem recebeu aprovou (o cliente pagou pelos itens)
  if new.status = 'finalizada' and old.status = 'aberta' then
    update public.cozinha_pedidos set status = 'novo', aprovado_em = now(), aprovado_por = auth.uid(), atualizado_em = now()
    where venda_id = new.id and status = 'aguardando';
  end if;
  return null;
exception when others then
  return null; -- a cozinha nunca impede a venda
end $$;
drop trigger if exists t_vendas_cozinha on public.vendas;
create trigger t_vendas_cozinha after update on public.vendas
  for each row execute function private.vendas_sync_cozinha();

create or replace function public.cozinha_painel()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); cfg jsonb;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  cfg := private.cfg_restaurante(v_emp);
  return jsonb_build_object(
    'agora', now(),
    'preparo_alvo_min', (cfg->>'preparo_alvo_min')::int,
    'aprovacao', coalesce((cfg->>'aprovacao_cozinha')::boolean, true),
    'pedidos', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'venda_id', t.venda_id, 'origem', t.origem, 'identificador', t.identificador,
        'numero_venda', t.numero_venda, 'garcom_id', t.garcom_id, 'garcom', g.nome, 'status', t.status, 'itens', t.itens,
        'criado_em', t.criado_em, 'aprovado_em', t.aprovado_em, 'aprovado_por', a.nome, 'preparo_em', t.preparo_em,
        'pronto_em', t.pronto_em, 'entregue_em', t.entregue_em, 'recusado_motivo', t.recusado_motivo,
        'mesa_id', v.mesa_id, 'venda_garcom_id', v.garcom_id) order by t.criado_em), '[]'::jsonb)
      from public.cozinha_pedidos t
      left join public.perfis g on g.id = t.garcom_id
      left join public.perfis a on a.id = t.aprovado_por
      left join public.vendas v on v.id = t.venda_id
      where t.empresa_id = v_emp and t.criado_em > now() - interval '24 hours'
        and (t.status in ('aguardando','novo','preparando','pronto')
             or (t.status in ('entregue','recusado','cancelado') and t.atualizado_em > now() - interval '3 hours'))));
end $$;

create or replace function public.cozinha_aprovar(p_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); n int;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Só o caixa ou o gerente aprova pedidos da cozinha'; end if;
  update public.cozinha_pedidos set status = 'novo', aprovado_em = now(), aprovado_por = auth.uid(), atualizado_em = now()
  where id = any(p_ids) and empresa_id = v_emp and status = 'aguardando';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.cozinha_recusar(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); t public.cozinha_pedidos; v public.vendas; v_manual numeric;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Só o caixa ou o gerente recusa pedidos da cozinha'; end if;
  if coalesce(length(trim(p_motivo)), 0) < 3 then raise exception 'Informe o motivo'; end if;
  select * into t from public.cozinha_pedidos where id = p_id and empresa_id = v_emp for update;
  if not found then raise exception 'Pedido da cozinha não encontrado'; end if;
  if t.status not in ('aguardando','novo') then raise exception 'Este pedido já está %', t.status; end if;
  update public.cozinha_pedidos set status = 'recusado', recusado_motivo = left(trim(p_motivo), 200),
    aprovado_por = auth.uid(), atualizado_em = now() where id = t.id;
  -- Os itens recusados saem da conta
  select * into v from public.vendas where id = t.venda_id for update;
  if found and v.status = 'aberta' then
    v_manual := private.desconto_manual(v.id);
    update public.venda_itens set removido = true, removido_em = now(), removido_por = auth.uid()
    where venda_id = v.id and not removido
      and id in (select (x->>'id')::uuid from jsonb_array_elements(t.itens) x where not coalesce((x->>'cancelado')::boolean, false));
    perform private.recalcular_venda(v.id, v_manual);
  end if;
  perform private.auditar(v_emp, 'cozinha.recusar', 'cozinha_pedidos', t.id::text,
    jsonb_build_object('mesa', t.identificador, 'motivo', p_motivo, 'itens', t.itens));
end $$;

create or replace function public.cozinha_avancar(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); t public.cozinha_pedidos; v_papel text := private.papel()::text;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if p_status not in ('novo','preparando','pronto','entregue') then raise exception 'Situação inválida'; end if;
  select * into t from public.cozinha_pedidos where id = p_id and empresa_id = v_emp for update;
  if not found then raise exception 'Pedido da cozinha não encontrado'; end if;
  if t.status = 'aguardando' then raise exception 'Este pedido ainda precisa ser aprovado pelo caixa'; end if;
  if t.status in ('recusado','cancelado') then raise exception 'Este pedido foi %', t.status; end if;
  if t.status = p_status then return; end if;
  if p_status <> 'entregue' and v_papel not in ('admin','gerente','caixa','cozinha') then
    raise exception 'Só a cozinha altera o preparo';
  end if;
  if p_status = 'entregue' and t.status <> 'pronto' and v_papel not in ('admin','gerente','caixa','cozinha') then
    raise exception 'O pedido ainda não está pronto';
  end if;
  update public.cozinha_pedidos set status = p_status, atualizado_em = now(),
    preparo_em = case when p_status = 'novo' then null when p_status = 'preparando' then coalesce(preparo_em, now()) else coalesce(preparo_em, now()) end,
    pronto_em = case when p_status in ('novo','preparando') then null when p_status = 'pronto' then now() else coalesce(pronto_em, now()) end,
    entregue_em = case when p_status = 'entregue' then now() end,
    entregue_por = case when p_status = 'entregue' then auth.uid() end
  where id = t.id;
  -- Delivery: o cliente vê "pronto" no acompanhamento
  if t.origem in ('delivery','retirada') and p_status = 'pronto' then
    update public.vendas set status_pedido = 'pronto', alterado_em = now(),
      status_historico = status_historico || jsonb_build_array(jsonb_build_object('status','pronto','em',now()))
    where id = t.venda_id and status = 'aberta' and status_pedido = 'preparando';
  end if;
end $$;

-- =====================================================================
-- Mesas
-- =====================================================================
create or replace function public.mesas_painel()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'numero', m.numero, 'nome', m.nome, 'area', m.area, 'lugares', m.lugares,
    'formato', m.formato, 'pos_x', m.pos_x, 'pos_y', m.pos_y,
    'venda_id', v.id, 'venda_numero', v.numero, 'aberta_em', v.created_at, 'total', v.total, 'subtotal', v.subtotal,
    'taxa_servico', v.taxa_servico, 'couvert', v.couvert, 'servico_pct', v.servico_pct, 'couvert_unit', v.couvert_unit,
    'pessoas', v.pessoas, 'conta_pedida', v.conta_pedida_em is not null, 'conta_pedida_em', v.conta_pedida_em,
    'alterado_em', v.alterado_em,
    'garcom', coalesce(g.nome, p.nome), 'garcom_id', coalesce(v.garcom_id, v.operador_id),
    'itens', (select count(*) from public.venda_itens i where i.venda_id = v.id and not i.removido),
    'ultimo_item_em', (select max(i.criado_em) from public.venda_itens i where i.venda_id = v.id and not i.removido),
    'cozinha', case when v.id is not null then (select jsonb_build_object(
        'aguardando', count(*) filter (where t.status = 'aguardando'),
        'preparo', count(*) filter (where t.status in ('novo','preparando')),
        'pronto', count(*) filter (where t.status = 'pronto'))
      from public.cozinha_pedidos t where t.venda_id = v.id) end
  ) order by m.area, m.numero), '[]'::jsonb)
  from public.mesas m
  left join public.vendas v on v.mesa_id = m.id and v.status = 'aberta'
  left join public.perfis p on p.id = v.operador_id
  left join public.perfis g on g.id = v.garcom_id
  where m.empresa_id = private.empresa_id() and m.ativo
$$;

create or replace function public.abrir_mesa(p_mesa uuid, p_pessoas int default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); m public.mesas; v_id uuid; v_num bigint; cfg jsonb;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if private.papel()::text = 'cozinha' then raise exception 'Sem permissão'; end if;
  if not private.modulo_garcom(v_emp) then raise exception 'O controle de mesas é exclusivo para restaurantes'; end if;
  select * into m from public.mesas where id = p_mesa and empresa_id = v_emp and ativo;
  if not found then raise exception 'Mesa não encontrada'; end if;
  select id into v_id from public.vendas where mesa_id = m.id and status = 'aberta';
  if v_id is not null then return v_id; end if;
  cfg := private.cfg_restaurante(v_emp);
  update public.empresas set proximo_numero_venda = proximo_numero_venda + 1
    where id = v_emp returning proximo_numero_venda - 1 into v_num;
  insert into public.vendas (empresa_id, numero, operador_id, garcom_id, status, mesa_id, canal, identificador, pessoas, servico_pct, couvert_unit)
  values (v_emp, v_num, auth.uid(), auth.uid(), 'aberta', m.id, 'mesa', m.nome, nullif(least(greatest(coalesce(p_pessoas, 0), 0), 50), 0),
          case when cfg->>'servico_modo' = 'cobrar' then nullif((cfg->>'servico_percentual')::numeric, 0) end,
          case when coalesce((cfg->>'couvert_ativo')::boolean, false) then nullif((cfg->>'couvert_valor')::numeric, 0) end)
  returning id into v_id;
  perform private.recalcular_venda(v_id);
  return v_id;
exception when unique_violation then
  select id into v_id from public.vendas where mesa_id = p_mesa and status = 'aberta';
  return v_id;
end $$;

create or replace function public.adicionar_itens(p_venda uuid, p_itens jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v public.vendas; n int; v_antes int; v_ticket uuid; v_status text; v_manual numeric;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if private.papel()::text = 'cozinha' then raise exception 'Sem permissão'; end if;
  select * into v from public.vendas where id = p_venda and empresa_id = v_emp for update;
  if not found then raise exception 'Pedido não encontrado'; end if;
  if v.status <> 'aberta' then raise exception 'Esta mesa já foi fechada'; end if;
  v_manual := case when v.canal = 'mesa' then 0 else private.desconto_manual(v.id) end;
  select coalesce(max(item), 0) into v_antes from public.venda_itens where venda_id = v.id;
  n := private.inserir_itens(v.id, v_emp, p_itens, auth.uid(), false);
  update public.vendas set conta_pedida_em = null, garcom_id = coalesce(garcom_id, auth.uid()) where id = v.id;
  perform private.recalcular_venda(v.id, v_manual);
  if v.canal in ('mesa','balcao') then v_ticket := private.criar_pedido_cozinha(v.id, v_antes); end if;
  select status into v_status from public.cozinha_pedidos where id = v_ticket;
  select * into v from public.vendas where id = p_venda;
  return jsonb_build_object('id', v.id, 'total', v.total, 'itens_adicionados', n, 'cozinha', v_status, 'cozinha_id', v_ticket);
end $$;

create or replace function public.remover_item_pedido(p_item uuid, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); i public.venda_itens; v public.vendas; v_manual numeric;
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
  v_manual := case when v.canal = 'mesa' then 0 else private.desconto_manual(v.id) end;
  update public.venda_itens set removido = true, removido_em = now(), removido_por = auth.uid() where id = i.id;
  perform private.recalcular_venda(v.id, v_manual);
  -- A cozinha fica sabendo (item riscado; pedido inteiro cancelado se não sobrar nada)
  update public.cozinha_pedidos t set atualizado_em = now(),
    itens = (select jsonb_agg(case when x->>'id' = i.id::text then x || '{"cancelado": true}'::jsonb else x end) from jsonb_array_elements(t.itens) x)
  where t.venda_id = i.venda_id and t.itens @> jsonb_build_array(jsonb_build_object('id', i.id::text));
  update public.cozinha_pedidos t set status = 'cancelado', atualizado_em = now()
  where t.venda_id = i.venda_id and t.status in ('aguardando','novo')
    and not exists (select 1 from jsonb_array_elements(t.itens) x where not coalesce((x->>'cancelado')::boolean, false));
  perform private.auditar(v_emp, 'mesa.remover_item', 'venda_itens', i.id::text,
    jsonb_build_object('mesa', v.identificador, 'item', i.descricao, 'quantidade', i.quantidade, 'motivo', p_motivo));
end $$;

-- Liga/desliga taxa de serviço e couvert de uma mesa e ajusta o número de pessoas
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
  if v_mudou_taxa and not private.tem_papel('{admin,gerente,caixa}') then
    raise exception 'Só o caixa ou o gerente altera taxa de serviço e couvert';
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

-- Troca o garçom responsável pela mesa (comissão)
create or replace function public.trocar_garcom(p_venda uuid, p_garcom uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); v public.vendas; g public.perfis;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente,caixa}') then raise exception 'Só o caixa ou o gerente troca o garçom da mesa'; end if;
  select * into v from public.vendas where id = p_venda and empresa_id = v_emp for update;
  if not found or v.status <> 'aberta' then raise exception 'Mesa não está aberta'; end if;
  select * into g from public.perfis where id = p_garcom and empresa_id = v_emp and ativo;
  if not found then raise exception 'Garçom não encontrado'; end if;
  update public.vendas set garcom_id = g.id, alterado_em = now() where id = v.id;
  perform private.auditar(v_emp, 'mesa.garcom', 'vendas', v.id::text, jsonb_build_object('mesa', v.identificador, 'garcom', g.nome));
end $$;

-- =====================================================================
-- Transferência: pedido inteiro ou itens, entre mesas e comandas
-- p_destino: {"mesa_id": uuid} | {"venda_id": uuid} | {"comanda": "texto"}
-- p_itens:   null = tudo | [{"id": uuid, "quantidade": n}] (quantidade parcial divide o item)
-- =====================================================================
create or replace function public.transferir_pedido(p_origem uuid, p_destino jsonb, p_itens jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := private.empresa_id(); o public.vendas; d public.vendas; m public.mesas; cfg jsonb;
  v_todos boolean := p_itens is null; v_nome text; v_num bigint; v_max int; v_n int := 0;
  v_man_o numeric; v_man_d numeric; r jsonb; i public.venda_itens; v_q numeric; v_desc_parte numeric;
  v_mov jsonb := '[]'::jsonb; v_juntou boolean := false;
begin
  if v_emp is null or private.papel()::text = 'cozinha' then raise exception 'Acesso negado'; end if;
  if not v_todos and (jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0) then raise exception 'Escolha os itens'; end if;
  select * into o from public.vendas where id = p_origem and empresa_id = v_emp for update;
  if not found or o.status <> 'aberta' then raise exception 'O pedido de origem não está aberto'; end if;
  if o.canal not in ('mesa','balcao') then raise exception 'Pedidos do delivery não podem ser transferidos'; end if;
  cfg := private.cfg_restaurante(v_emp);
  v_man_o := private.desconto_manual(o.id);

  -- ---------- Destino ----------
  if p_destino ? 'venda_id' then
    select * into d from public.vendas where id = nullif(p_destino->>'venda_id','')::uuid and empresa_id = v_emp for update;
    if not found or d.status <> 'aberta' or d.canal not in ('mesa','balcao') then raise exception 'Comanda de destino não está aberta'; end if;
    if d.id = o.id then raise exception 'Escolha outro destino'; end if;
  elsif p_destino ? 'mesa_id' then
    select * into m from public.mesas where id = nullif(p_destino->>'mesa_id','')::uuid and empresa_id = v_emp and ativo;
    if not found then raise exception 'Mesa de destino não encontrada'; end if;
    if o.mesa_id = m.id then raise exception 'Escolha outra mesa'; end if;
    select * into d from public.vendas where mesa_id = m.id and status = 'aberta' for update;
    if not found then
      if v_todos then
        -- Mesa livre: o pedido inteiro muda de lugar
        update public.vendas set mesa_id = m.id, canal = 'mesa', identificador = m.nome, alterado_em = now(),
          garcom_id = coalesce(garcom_id, auth.uid()),
          servico_pct = case when o.canal = 'mesa' then servico_pct when cfg->>'servico_modo' = 'cobrar' then nullif((cfg->>'servico_percentual')::numeric, 0) end,
          couvert_unit = case when o.canal = 'mesa' then couvert_unit when coalesce((cfg->>'couvert_ativo')::boolean, false) then nullif((cfg->>'couvert_valor')::numeric, 0) end
        where id = o.id;
        perform private.recalcular_venda(o.id, v_man_o);
        update public.cozinha_pedidos set identificador = m.nome, atualizado_em = now() where venda_id = o.id;
        perform private.auditar(v_emp, 'mesa.transferir', 'vendas', o.id::text, jsonb_build_object('de', o.identificador, 'para', m.nome));
        return jsonb_build_object('venda_id', o.id, 'mesa_id', m.id, 'identificador', m.nome, 'juntou', false);
      end if;
      update public.empresas set proximo_numero_venda = proximo_numero_venda + 1 where id = v_emp returning proximo_numero_venda - 1 into v_num;
      insert into public.vendas (empresa_id, numero, operador_id, garcom_id, status, mesa_id, canal, identificador, servico_pct, couvert_unit)
      values (v_emp, v_num, auth.uid(), coalesce(o.garcom_id, auth.uid()), 'aberta', m.id, 'mesa', m.nome,
              case when cfg->>'servico_modo' = 'cobrar' then nullif((cfg->>'servico_percentual')::numeric, 0) end,
              case when coalesce((cfg->>'couvert_ativo')::boolean, false) then nullif((cfg->>'couvert_valor')::numeric, 0) end)
      returning * into d;
    end if;
  elsif p_destino ? 'comanda' then
    v_nome := left(trim(coalesce(p_destino->>'comanda', '')), 30);
    if length(v_nome) < 1 then raise exception 'Informe o nome ou número da comanda'; end if;
    if v_todos then
      update public.vendas set mesa_id = null, canal = 'balcao', identificador = v_nome, servico_pct = null, couvert_unit = null,
        taxa_servico = 0, couvert = 0, acrescimo = case when o.canal = 'mesa' then 0 else acrescimo end, alterado_em = now()
      where id = o.id;
      perform private.recalcular_venda(o.id, v_man_o);
      update public.cozinha_pedidos set identificador = v_nome, atualizado_em = now() where venda_id = o.id;
      perform private.auditar(v_emp, 'mesa.transferir', 'vendas', o.id::text, jsonb_build_object('de', o.identificador, 'para', v_nome));
      return jsonb_build_object('venda_id', o.id, 'mesa_id', null, 'identificador', v_nome, 'juntou', false);
    end if;
    update public.empresas set proximo_numero_venda = proximo_numero_venda + 1 where id = v_emp returning proximo_numero_venda - 1 into v_num;
    insert into public.vendas (empresa_id, numero, operador_id, garcom_id, status, canal, identificador)
    values (v_emp, v_num, auth.uid(), coalesce(o.garcom_id, auth.uid()), 'aberta', 'balcao', v_nome)
    returning * into d;
  else
    raise exception 'Escolha o destino';
  end if;

  v_man_d := private.desconto_manual(d.id);
  select coalesce(max(item), 0) into v_max from public.venda_itens where venda_id = d.id;

  -- ---------- Itens ----------
  if v_todos then
    for i in select * from public.venda_itens where venda_id = o.id and not removido order by item for update loop
      v_max := v_max + 1; v_n := v_n + 1;
      update public.venda_itens set venda_id = d.id, item = v_max where id = i.id;
    end loop;
    if v_n = 0 then raise exception 'Não há itens para transferir'; end if;
    update public.cozinha_pedidos set venda_id = d.id, identificador = coalesce(d.identificador, identificador), atualizado_em = now() where venda_id = o.id;
    update public.vendas set pessoas = nullif(coalesce(pessoas, 0) + coalesce(o.pessoas, 0), 0) where id = d.id;
    update public.vendas set status = 'cancelada', cancelada_em = now(), cancelada_por = auth.uid(),
      motivo_cancelamento = 'Conta juntada com ' || coalesce(d.identificador, 'pedido ' || d.numero), mesa_id = null,
      servico_pct = null, couvert_unit = null
    where id = o.id;
    v_juntou := true;
    v_man_d := v_man_d + v_man_o;
  else
    for r in select * from jsonb_array_elements(p_itens) loop
      select * into i from public.venda_itens where id = nullif(r->>'id','')::uuid and venda_id = o.id and not removido for update;
      if not found then raise exception 'Item não encontrado no pedido de origem'; end if;
      v_q := coalesce(round(nullif(r->>'quantidade','')::numeric, 3), i.quantidade);
      if v_q <= 0 or v_q > i.quantidade then raise exception 'Quantidade inválida: %', i.descricao; end if;
      if i.unidade in ('UN','CX','PCT','DZ','FD') and v_q <> trunc(v_q) then raise exception 'Quantidade deve ser inteira: %', i.descricao; end if;
      v_max := v_max + 1; v_n := v_n + 1;
      if v_q = i.quantidade then
        update public.venda_itens set venda_id = d.id, item = v_max where id = i.id;
      else
        -- Divide o item: parte fica, parte vai (desconto proporcional)
        v_desc_parte := round(i.desconto * v_q / i.quantidade, 2);
        update public.venda_itens set quantidade = quantidade - v_q, desconto = desconto - v_desc_parte,
          total = round((quantidade - v_q) * preco_unitario, 2) - (desconto - v_desc_parte)
        where id = i.id;
        insert into public.venda_itens (venda_id, empresa_id, produto_id, item, descricao, unidade, quantidade, preco_unitario,
          desconto, total, observacao, criado_em, criado_por, custo_unitario, promocao)
        values (d.id, v_emp, i.produto_id, v_max, i.descricao, i.unidade, v_q, i.preco_unitario,
          v_desc_parte, round(v_q * i.preco_unitario, 2) - v_desc_parte, i.observacao, i.criado_em, i.criado_por, i.custo_unitario, i.promocao);
      end if;
      v_mov := v_mov || jsonb_build_array(jsonb_build_object('item', i.descricao, 'quantidade', v_q));
    end loop;
  end if;

  perform private.recalcular_venda(o.id, v_man_o);
  perform private.recalcular_venda(d.id, v_man_d);
  if v_juntou then
    perform private.auditar(v_emp, 'mesa.juntar', 'vendas', d.id::text,
      jsonb_build_object('de', o.identificador, 'para', coalesce(d.identificador, 'pedido ' || d.numero)));
  else
    perform private.auditar(v_emp, 'mesa.transferir_itens', 'vendas', o.id::text,
      jsonb_build_object('de', o.identificador, 'para', coalesce(d.identificador, 'pedido ' || d.numero), 'itens', v_mov));
  end if;
  return jsonb_build_object('venda_id', d.id, 'mesa_id', d.mesa_id, 'identificador', d.identificador, 'juntou', v_juntou, 'itens', v_n);
end $$;

-- =====================================================================
-- Garçons: desempenho, metas e comissão
-- =====================================================================
create or replace function private.garcom_metricas(p_emp uuid, p_garcom uuid, p_a timestamptz, p_b timestamptz, p_pct numeric, p_base text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with v as (
    select * from public.vendas
    where empresa_id = p_emp and garcom_id = p_garcom and status = 'finalizada' and finalizada_em >= p_a and finalizada_em < p_b)
  select jsonb_build_object(
    'mesas', count(*),
    'consumo', coalesce(sum(subtotal - desconto), 0),
    'faturamento', coalesce(sum(total), 0),
    'servico', coalesce(sum(taxa_servico), 0),
    'couvert', coalesce(sum(couvert), 0),
    'pessoas', coalesce(sum(pessoas), 0),
    'ticket_mesa', case when count(*) > 0 then round(sum(subtotal - desconto) / count(*), 2) else 0 end,
    'ticket_pessoa', case when coalesce(sum(pessoas) filter (where pessoas > 0), 0) > 0
                     then round(sum(subtotal - desconto) filter (where pessoas > 0) / sum(pessoas) filter (where pessoas > 0), 2) else 0 end,
    'tempo_medio_min', coalesce(round(avg(extract(epoch from finalizada_em - created_at) / 60)), 0),
    'comissao', round(case when p_base = 'servico' then coalesce(sum(taxa_servico), 0) else coalesce(sum(subtotal - desconto), 0) end
                      * coalesce(p_pct, 0) / 100, 2))
  from v
$$;

create or replace function public.garcom_desempenho(p_ini date, p_fim date, p_perfil uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_emp uuid := private.empresa_id(); v_alvo uuid := coalesce(p_perfil, auth.uid()); g public.perfis;
  cfg jsonb; v_fz text; v_pct numeric; v_base text; v_meta numeric;
  v_a timestamptz; v_b timestamptz; v_hoje date; v_mes_ini date; v_dias_mes int; v_dia int;
  v_mes jsonb; v_cons_mes numeric; v_com_mes numeric; v_rank jsonb; v_abertas jsonb;
begin
  if v_emp is null then raise exception 'Acesso negado'; end if;
  if v_alvo <> auth.uid() and not private.tem_papel('{admin,gerente}') then raise exception 'Você só pode ver o seu próprio desempenho'; end if;
  select * into g from public.perfis where id = v_alvo and empresa_id = v_emp;
  if not found then raise exception 'Garçom não encontrado'; end if;
  if p_ini is null or p_fim is null or p_fim < p_ini or p_fim - p_ini > 400 then raise exception 'Período inválido'; end if;
  cfg := private.cfg_restaurante(v_emp); v_fz := private.fuso(v_emp);
  select coalesce(gm.comissao_percentual, (cfg->>'comissao_percentual')::numeric),
         coalesce(gm.meta_mensal, (cfg->>'meta_mensal_padrao')::numeric, 0)
    into v_pct, v_meta from (select 1) x left join public.garcom_metas gm on gm.perfil_id = v_alvo;
  v_base := coalesce(cfg->>'comissao_base', 'consumo');
  v_a := p_ini::timestamp at time zone v_fz; v_b := (p_fim + 1)::timestamp at time zone v_fz;
  v_hoje := (now() at time zone v_fz)::date;
  v_mes_ini := date_trunc('month', v_hoje)::date;
  v_dias_mes := extract(day from (v_mes_ini + interval '1 month - 1 day'))::int;
  v_dia := extract(day from v_hoje)::int;

  v_mes := private.garcom_metricas(v_emp, v_alvo, v_mes_ini::timestamp at time zone v_fz, (v_hoje + 1)::timestamp at time zone v_fz, v_pct, v_base);
  v_cons_mes := (v_mes->>'consumo')::numeric; v_com_mes := (v_mes->>'comissao')::numeric;

  select jsonb_build_object('posicao', x.pos, 'de', x.de) into v_rank from (
    select garcom_id, rank() over (order by sum(subtotal - desconto) desc) pos, count(*) over () de
    from public.vendas
    where empresa_id = v_emp and status = 'finalizada' and garcom_id is not null
      and finalizada_em >= v_mes_ini::timestamp at time zone v_fz
    group by garcom_id) x
  where x.garcom_id = v_alvo;

  select jsonb_build_object('mesas', count(*), 'consumo', coalesce(sum(subtotal - desconto), 0), 'servico', coalesce(sum(taxa_servico), 0),
           'comissao_prevista', round(case when v_base = 'servico' then coalesce(sum(taxa_servico), 0) else coalesce(sum(subtotal - desconto), 0) end * v_pct / 100, 2))
    into v_abertas
  from public.vendas where empresa_id = v_emp and garcom_id = v_alvo and status = 'aberta';

  return jsonb_build_object(
    'perfil', jsonb_build_object('id', g.id, 'nome', g.nome, 'papel', g.papel),
    'comissao_percentual', v_pct, 'comissao_base', v_base, 'meta_mensal', v_meta,
    'periodo', private.garcom_metricas(v_emp, v_alvo, v_a, v_b, v_pct, v_base) || jsonb_build_object(
      'itens', (select coalesce(sum(i.quantidade), 0) from public.venda_itens i join public.vendas v on v.id = i.venda_id
                where v.empresa_id = v_emp and v.garcom_id = v_alvo and v.status = 'finalizada' and v.finalizada_em >= v_a and v.finalizada_em < v_b
                  and not i.removido and i.unidade in ('UN','CX','PCT','DZ','FD')),
      'por_dia', (select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'consumo', consumo, 'mesas', mesas,
                     'comissao', round(case when v_base = 'servico' then servico else consumo end * v_pct / 100, 2)) order by dia), '[]'::jsonb)
                  from (select (finalizada_em at time zone v_fz)::date dia, sum(subtotal - desconto) consumo, sum(taxa_servico) servico, count(*) mesas
                        from public.vendas where empresa_id = v_emp and garcom_id = v_alvo and status = 'finalizada'
                          and finalizada_em >= v_a and finalizada_em < v_b group by 1) d),
      'top_produtos', (select coalesce(jsonb_agg(jsonb_build_object('descricao', descricao, 'quantidade', q, 'total', t) order by t desc), '[]'::jsonb)
                       from (select i.descricao, sum(i.quantidade) q, sum(i.total) t from public.venda_itens i join public.vendas v on v.id = i.venda_id
                             where v.empresa_id = v_emp and v.garcom_id = v_alvo and v.status = 'finalizada'
                               and v.finalizada_em >= v_a and v.finalizada_em < v_b and not i.removido
                             group by i.descricao order by sum(i.total) desc limit 5) tp)),
    'mes', v_mes || jsonb_build_object(
      'dia', v_dia, 'dias_mes', v_dias_mes,
      'projecao_consumo', round(v_cons_mes / greatest(v_dia, 1) * v_dias_mes, 2),
      'projecao_comissao', round(v_com_mes / greatest(v_dia, 1) * v_dias_mes, 2),
      'progresso_meta', case when v_meta > 0 then round(v_cons_mes / v_meta * 100, 1) end,
      'falta_meta', greatest(v_meta - v_cons_mes, 0),
      'por_dia_para_meta', case when v_meta > v_cons_mes then round((v_meta - v_cons_mes) / greatest(v_dias_mes - v_dia + 1, 1), 2) else 0 end,
      'ranking', v_rank),
    'hoje', private.garcom_metricas(v_emp, v_alvo, v_hoje::timestamp at time zone v_fz, (v_hoje + 1)::timestamp at time zone v_fz, v_pct, v_base),
    'abertas', v_abertas);
end $$;

-- Equipe (gerente): todos os garçons com período e mês
create or replace function public.garcons_equipe(p_ini date, p_fim date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); cfg jsonb; v_fz text; v_a timestamptz; v_b timestamptz; v_ma timestamptz; v_hoje date; v_base text; v_r jsonb;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  if p_ini is null or p_fim is null or p_fim < p_ini or p_fim - p_ini > 400 then raise exception 'Período inválido'; end if;
  cfg := private.cfg_restaurante(v_emp); v_fz := private.fuso(v_emp); v_base := coalesce(cfg->>'comissao_base', 'consumo');
  v_a := p_ini::timestamp at time zone v_fz; v_b := (p_fim + 1)::timestamp at time zone v_fz;
  v_hoje := (now() at time zone v_fz)::date;
  v_ma := date_trunc('month', v_hoje)::date::timestamp at time zone v_fz;
  select coalesce(jsonb_agg(x.j order by (x.j->'periodo'->>'consumo')::numeric desc, x.j->>'nome'), '[]'::jsonb) into v_r from (
    select jsonb_build_object(
      'id', p.id, 'nome', p.nome, 'papel', p.papel, 'ativo', p.ativo,
      'meta_mensal', coalesce(gm.meta_mensal, (cfg->>'meta_mensal_padrao')::numeric, 0), 'meta_propria', gm.meta_mensal is not null,
      'comissao_percentual', coalesce(gm.comissao_percentual, (cfg->>'comissao_percentual')::numeric), 'comissao_propria', gm.comissao_percentual is not null,
      'periodo', private.garcom_metricas(v_emp, p.id, v_a, v_b, coalesce(gm.comissao_percentual, (cfg->>'comissao_percentual')::numeric), v_base),
      'mes', private.garcom_metricas(v_emp, p.id, v_ma, now() + interval '1 minute', coalesce(gm.comissao_percentual, (cfg->>'comissao_percentual')::numeric), v_base),
      'abertas', (select jsonb_build_object('mesas', count(*), 'consumo', coalesce(sum(v.subtotal - v.desconto), 0))
                  from public.vendas v where v.empresa_id = v_emp and v.garcom_id = p.id and v.status = 'aberta')) j
    from public.perfis p
    left join public.garcom_metas gm on gm.perfil_id = p.id
    where p.empresa_id = v_emp
      and ((p.papel::text = 'atendente' and p.ativo)
           or exists (select 1 from public.vendas v where v.empresa_id = v_emp and v.garcom_id = p.id
                        and (v.status = 'aberta' or v.finalizada_em >= least(v_a, v_ma))))) x;
  return jsonb_build_object('dias_mes', extract(day from (date_trunc('month', v_hoje) + interval '1 month - 1 day'))::int,
    'dia', extract(day from v_hoje)::int, 'comissao_base', v_base, 'garcons', v_r);
end $$;

create or replace function public.salvar_meta_garcom(p_perfil uuid, p_meta numeric, p_comissao numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); g public.perfis;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  select * into g from public.perfis where id = p_perfil and empresa_id = v_emp;
  if not found then raise exception 'Garçom não encontrado'; end if;
  if p_meta is not null and (p_meta < 0 or p_meta > 99999999) then raise exception 'Meta inválida'; end if;
  if p_comissao is not null and (p_comissao < 0 or p_comissao > 100) then raise exception 'Comissão deve ficar entre 0 e 100%%'; end if;
  insert into public.garcom_metas (perfil_id, empresa_id, meta_mensal, comissao_percentual)
  values (g.id, v_emp, round(p_meta, 2), round(p_comissao, 2))
  on conflict (perfil_id) do update set meta_mensal = excluded.meta_mensal, comissao_percentual = excluded.comissao_percentual, updated_at = now();
  perform private.auditar(v_emp, 'garcom.meta', 'perfis', g.id::text, jsonb_build_object('garcom', g.nome, 'meta', p_meta, 'comissao', p_comissao));
end $$;

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

-- ---------- Permissões ----------
revoke execute on all functions in schema private from public, anon;
revoke execute on function public.cozinha_painel(), public.cozinha_aprovar(uuid[]), public.cozinha_recusar(uuid,text),
  public.cozinha_avancar(uuid,text), public.mesas_painel(), public.abrir_mesa(uuid,int), public.adicionar_itens(uuid,jsonb),
  public.remover_item_pedido(uuid,text), public.definir_taxas_mesa(uuid,boolean,boolean,int), public.trocar_garcom(uuid,uuid),
  public.transferir_pedido(uuid,jsonb,jsonb), public.garcom_desempenho(date,date,uuid), public.garcons_equipe(date,date),
  public.salvar_meta_garcom(uuid,numeric,numeric), public.salvar_config_restaurante(jsonb)
from public, anon;
grant execute on function public.cozinha_painel(), public.cozinha_aprovar(uuid[]), public.cozinha_recusar(uuid,text),
  public.cozinha_avancar(uuid,text), public.mesas_painel(), public.abrir_mesa(uuid,int), public.adicionar_itens(uuid,jsonb),
  public.remover_item_pedido(uuid,text), public.definir_taxas_mesa(uuid,boolean,boolean,int), public.trocar_garcom(uuid,uuid),
  public.transferir_pedido(uuid,jsonb,jsonb), public.garcom_desempenho(date,date,uuid), public.garcons_equipe(date,date),
  public.salvar_meta_garcom(uuid,numeric,numeric), public.salvar_config_restaurante(jsonb)
to authenticated;
grant select on public.cozinha_pedidos, public.garcom_metas to authenticated;
grant update (envia_cozinha) on public.categorias to authenticated;
