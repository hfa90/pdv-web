-- =====================================================================
-- 027 · Pagamento na mesa pelo QR: saldo correto, validação do garçom
--       e provedores de pagamento configuráveis pelo próprio sistema
--
--   1. Saldo da mesa sempre correto para o cliente:
--        - "Já paguei" (PIX pela chave da loja) desconta na hora o valor
--          informado ("aguardando o garçom conferir").
--        - O garçom confere: "Confirmar recebimento" registra o PIX como pago
--          (entra sozinho no fechamento da conta); "Não recebi" devolve o valor
--          para o saldo e avisa o cliente.
--        - Antes, dois clientes dividindo em partes iguais tinham o 2º aviso
--          descartado como "repetido". Agora só ignora toque duplo (20 s).
--   2. Cliente pede "validar pagamento": chamado próprio para o garçom.
--   3. Formas de pagamento no QR (só administrador / superusuário):
--        qr_pagar        → liga/desliga todo pagamento pelo QR
--        qr_pagar_chave  → PIX pela chave da loja (garçom confere)
--        qr_pagar_auto   → cobrança automática pelo provedor
--   4. Provedores: Mercado Pago, PagBank (PagSeguro), Getnet e InfinitePay.
--      As credenciais ficam só no servidor (nunca voltam para o navegador).
--      O pagamento só vira "pago" quando o provedor confirma (consulta direta
--      à API do provedor ou aviso com segredo da loja), evitando fraude.
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Estrutura
-- ---------------------------------------------------------------------
alter table public.integracoes_pagamento add column if not exists provedor text;
alter table public.integracoes_pagamento add column if not exists ambiente text not null default 'producao';
alter table public.integracoes_pagamento add column if not exists credenciais jsonb not null default '{}'::jsonb;
alter table public.integracoes_pagamento add column if not exists webhook_segredo text not null
  default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
do $$ begin
  alter table public.integracoes_pagamento add constraint integracoes_pagamento_provedor_ck
    check (provedor is null or provedor in ('mercadopago','pagbank','getnet','infinitepay'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.integracoes_pagamento add constraint integracoes_pagamento_ambiente_ck check (ambiente in ('producao','teste'));
exception when duplicate_object then null; end $$;
update public.integracoes_pagamento set provedor = 'mercadopago' where provedor is null and mp_access_token is not null;

alter table public.mesa_pagamentos add column if not exists provedor text;          -- mercadopago | pagbank | getnet | infinitepay | chave
alter table public.mesa_pagamentos add column if not exists origem text not null default 'automatico'; -- automatico | garcom
alter table public.mesa_pagamentos add column if not exists link text;              -- link de checkout (InfinitePay)
alter table public.mesa_pagamentos add column if not exists confirmado_por uuid references public.perfis(id) on delete set null;
alter table public.mesa_pagamentos add column if not exists chamado_id uuid references public.mesa_chamados(id) on delete set null;
update public.mesa_pagamentos set provedor = 'mercadopago' where provedor is null and mp_id is not null;
create index if not exists mesa_pagamentos_mp_idx on public.mesa_pagamentos(mp_id) where mp_id is not null;

alter table public.mesa_chamados drop constraint if exists mesa_chamados_tipo_check;
alter table public.mesa_chamados add constraint mesa_chamados_tipo_check check (tipo in ('garcom','conta','pedido','pix','validar'));

-- Padrões das novas opções
create or replace function private.cfg_restaurante(p_emp uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
      'servico_modo', 'sugerir', 'servico_percentual', 10,
      'couvert_ativo', false, 'couvert_valor', 0, 'couvert_nome', 'Couvert artístico',
      'comissao_percentual', 10, 'comissao_base', 'consumo', 'meta_mensal_padrao', 0,
      'aprovacao_cozinha', true, 'preparo_alvo_min', 20,
      'tempo_alerta_min', 60, 'tempo_critico_min', 120, 'ocioso_min', 25,
      'aprovacao_auto_ate', 0, 'aprovacao_auto_confiavel', true,
      'qr_pagar_chave', true, 'qr_pagar_auto', true)
    || coalesce((select e.config_restaurante from public.empresas e where e.id = p_emp), '{}'::jsonb)
$$;

/** Provedor de cobrança automática pronto para uso (credenciais completas) ou null. */
create or replace function private.pagamento_provedor(p_emp uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case coalesce(i.provedor, case when i.mp_access_token is not null then 'mercadopago' end)
    when 'mercadopago' then case when i.mp_access_token is not null then 'mercadopago' end
    when 'pagbank' then case when nullif(i.credenciais->>'pagbank_token', '') is not null then 'pagbank' end
    when 'getnet' then case when nullif(i.credenciais->>'getnet_client_id', '') is not null and nullif(i.credenciais->>'getnet_client_secret', '') is not null
                              and nullif(i.credenciais->>'getnet_seller_id', '') is not null then 'getnet' end
    when 'infinitepay' then case when nullif(i.credenciais->>'infinitepay_handle', '') is not null then 'infinitepay' end
  end
  from public.integracoes_pagamento i where i.empresa_id = p_emp
$$;

/** Soma dos PIX que o cliente avisou ("Já paguei") e o garçom ainda não conferiu. */
create or replace function private.mesa_pix_informado(p_venda uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(valor), 0) from public.mesa_chamados
  where venda_id = p_venda and tipo = 'pix' and status = 'pendente' and not automatico
$$;

-- ---------------------------------------------------------------------
-- 2. Conta ao vivo (cliente)
-- ---------------------------------------------------------------------
create or replace function public.mesa_publica(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare m public.mesas; e public.empresas; v public.vendas; cfg jsonb; r jsonb; v_pago numeric := 0; v_inf numeric := 0;
  v_prov text; v_pagar boolean; v_auto boolean; v_chave boolean;
begin
  m := private.mesa_por_token(p_token);
  select * into e from public.empresas where id = m.empresa_id;
  cfg := private.cfg_restaurante(m.empresa_id);
  select * into v from public.vendas where mesa_id = m.id and status = 'aberta' and canal = 'mesa' order by created_at desc limit 1;
  if v.id is not null then
    select coalesce(sum(valor), 0) into v_pago from public.mesa_pagamentos where venda_id = v.id and status = 'pago';
    v_inf := private.mesa_pix_informado(v.id);
  end if;
  v_pagar := coalesce((cfg->>'qr_pagar')::boolean, true);
  v_prov := case when v_pagar and coalesce((cfg->>'qr_pagar_auto')::boolean, true) then private.pagamento_provedor(e.id) end;
  v_auto := v_prov is not null;
  v_chave := v_pagar and coalesce((cfg->>'qr_pagar_chave')::boolean, true) and e.pix_chave is not null;
  r := jsonb_build_object(
    'loja', jsonb_build_object('nome', coalesce(e.nome_fantasia, e.razao_social)),
    'mesa', jsonb_build_object('nome', m.nome, 'numero', m.numero, 'lugares', m.lugares),
    'aberta', v.id is not null,
    'pode_pedir', coalesce((cfg->>'qr_pedir')::boolean, true),
    'pode_pagar', v_pagar and (v_auto or v_chave),
    'pix_automatico', v_auto,
    'provedor', v_prov,
    'pag_link', v_prov = 'infinitepay',   -- InfinitePay: página de pagamento (PIX ou cartão)
    'pix', case when v_chave then jsonb_build_object('chave', e.pix_chave, 'tipo', e.pix_tipo,
              'nome', coalesce(e.pix_nome, e.nome_fantasia, e.razao_social), 'cidade', coalesce(e.pix_cidade, e.municipio, 'BRASIL')) end,
    'chamados', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.tipo, 'status', c.status, 'criado_em', c.criado_em,
          'valor', c.valor, 'motivo', c.motivo, 'itens', c.itens, 'automatico', c.automatico) order by c.criado_em desc)
        from public.mesa_chamados c
        where c.mesa_id = m.id and c.criado_em > now() - interval '3 hours'
          and (c.status = 'pendente' or c.tipo in ('pedido','pix'))
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
      'pago', v_pago,                                   -- confirmado (provedor ou garçom)
      'informado', v_inf,                               -- "Já paguei" aguardando o garçom
      'falta', greatest(0, v.total - v_pago - v_inf),   -- o que o cliente ainda precisa pagar
      'itens', coalesce((select jsonb_agg(jsonb_build_object('descricao', i.descricao, 'quantidade', i.quantidade, 'unidade', i.unidade,
            'total', i.total, 'observacao', i.observacao,
            'etapa', (select t.status from public.cozinha_pedidos t where t.venda_id = v.id
                      and t.itens @> jsonb_build_array(jsonb_build_object('id', i.id::text)) order by t.criado_em desc limit 1))
          order by i.item) from public.venda_itens i where i.venda_id = v.id and not i.removido), '[]'::jsonb)));
  end if;
  return r;
end $$;

/** Chamar garçom, pedir a conta, avisar PIX pela chave da loja ou pedir para validar o pagamento. */
create or replace function public.mesa_chamar(p_token uuid, p_tipo text, p_valor numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.mesas; v public.vendas; c public.mesa_chamados; v_valor numeric; v_falta numeric; cfg jsonb;
begin
  if p_tipo not in ('garcom','conta','pix','validar') then raise exception 'Pedido inválido'; end if;
  m := private.mesa_por_token(p_token);
  cfg := private.cfg_restaurante(m.empresa_id);
  perform pg_advisory_xact_lock(hashtextextended('mesa-qr' || m.id::text, 0));
  select * into v from public.vendas where mesa_id = m.id and status = 'aberta' and canal = 'mesa' order by created_at desc limit 1;
  if p_tipo in ('conta','pix') and v.id is null then raise exception 'Esta mesa não tem conta aberta. Chame o garçom.'; end if;
  if p_tipo = 'pix' then
    if coalesce((cfg->>'qr_pagar')::boolean, true) = false or coalesce((cfg->>'qr_pagar_chave')::boolean, true) = false then
      raise exception 'Pagamento pelo QR desligado. Chame o garçom.';
    end if;
    v_valor := round(p_valor, 2);
    -- Toque duplo no mesmo aviso: devolve o que já existe
    select * into c from public.mesa_chamados where venda_id = v.id and tipo = 'pix' and status = 'pendente' and valor = v_valor
      and not automatico and criado_em > now() - interval '20 seconds' order by criado_em desc limit 1;
    if found then return jsonb_build_object('id', c.id, 'tipo', c.tipo, 'repetido', true); end if;
    v_falta := v.total - (select coalesce(sum(valor), 0) from public.mesa_pagamentos where venda_id = v.id and status = 'pago')
                       - private.mesa_pix_informado(v.id);
    if v_valor is null or v_valor < 0.01 then raise exception 'Valor inválido'; end if;
    if v_valor > v_falta + 0.009 then
      raise exception 'Valor maior do que falta pagar (R$ %). Chame o garçom.', replace(to_char(greatest(v_falta, 0), 'FM999999990.00'), '.', ',');
    end if;
  else
    -- Mesmo chamado ainda pendente: não duplica
    select * into c from public.mesa_chamados where mesa_id = m.id and tipo = p_tipo and status = 'pendente' order by criado_em desc limit 1;
    if found then return jsonb_build_object('id', c.id, 'tipo', c.tipo, 'repetido', true); end if;
  end if;
  perform private.mesa_limite(m.id);
  insert into public.mesa_chamados (empresa_id, mesa_id, venda_id, tipo, valor)
  values (m.empresa_id, m.id, v.id, p_tipo, v_valor) returning * into c;
  if p_tipo = 'conta' then
    update public.vendas set conta_pedida_em = coalesce(conta_pedida_em, now()) where id = v.id;
  end if;
  return jsonb_build_object('id', c.id, 'tipo', c.tipo, 'repetido', false);
end $$;

-- ---------------------------------------------------------------------
-- 3. Garçom confere o PIX informado
-- ---------------------------------------------------------------------
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
    if c.tipo = 'pix' and not c.automatico then
      update public.mesa_chamados set status = 'recusado',
        motivo = coalesce(nullif(left(trim(coalesce(p_motivo, '')), 120), ''), 'O garçom não encontrou este PIX'),
        resolvido_em = now(), resolvido_por = auth.uid() where id = c.id;
      perform private.auditar(v_emp, 'mesa.pix_recusado', 'mesa_chamados', c.id::text, jsonb_build_object('mesa', c.mesa_id, 'valor', c.valor));
    elsif c.tipo = 'pedido' then
      update public.mesa_chamados set status = 'recusado', motivo = nullif(left(trim(coalesce(p_motivo, '')), 120), ''),
        resolvido_em = now(), resolvido_por = auth.uid() where id = c.id;
    else
      raise exception 'Ação inválida';
    end if;
  elsif p_acao = 'atender' then
    if c.tipo = 'pedido' then raise exception 'Confirme ou recuse o pedido'; end if;
    -- PIX pela chave da loja conferido pelo garçom: vira pagamento da conta (entra sozinho ao fechar)
    if c.tipo = 'pix' and not c.automatico and c.venda_id is not null
       and exists (select 1 from public.vendas where id = c.venda_id and status = 'aberta') then
      insert into public.mesa_pagamentos (empresa_id, mesa_id, venda_id, valor, status, pago_em, provedor, origem, confirmado_por, chamado_id)
      values (c.empresa_id, c.mesa_id, c.venda_id, c.valor, 'pago', now(), 'chave', 'garcom', auth.uid(), c.id);
      perform private.auditar(v_emp, 'mesa.pix_conferido', 'mesa_chamados', c.id::text, jsonb_build_object('mesa', c.mesa_id, 'valor', c.valor));
    end if;
    update public.mesa_chamados set status = 'atendido', resolvido_em = now(), resolvido_por = auth.uid() where id = c.id;
  else
    raise exception 'Ação inválida';
  end if;
  return r || jsonb_build_object('status', (select status from public.mesa_chamados where id = c.id), 'venda_id', coalesce(v_venda, c.venda_id));
end $$;

-- Fechar a conta encerra também os avisos de PIX não conferidos (o caixa recebe o que faltar)
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

-- ---------------------------------------------------------------------
-- 4. Provedores de pagamento (só administrador; superusuário em modo suporte vale como administrador)
-- ---------------------------------------------------------------------
create or replace function public.pagamento_provedor_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); i public.integracoes_pagamento; cr jsonb;
begin
  if v_emp is null or not private.tem_papel('{admin,gerente}') then raise exception 'Sem permissão'; end if;
  select * into i from public.integracoes_pagamento where empresa_id = v_emp;
  cr := coalesce(i.credenciais, '{}'::jsonb);
  return jsonb_build_object(
    'provedor', coalesce(i.provedor, case when i.mp_access_token is not null then 'mercadopago' end),
    'ativo', private.pagamento_provedor(v_emp),
    'ambiente', coalesce(i.ambiente, 'producao'),
    'configurado', jsonb_build_object(
      'mercadopago', i.mp_access_token is not null,
      'pagbank', nullif(cr->>'pagbank_token', '') is not null,
      'getnet', nullif(cr->>'getnet_client_id', '') is not null and nullif(cr->>'getnet_client_secret', '') is not null and nullif(cr->>'getnet_seller_id', '') is not null,
      'infinitepay', nullif(cr->>'infinitepay_handle', '') is not null),
    -- Dados não secretos (para conferência na tela)
    'infinitepay_handle', cr->>'infinitepay_handle',
    'getnet_seller_id', cr->>'getnet_seller_id',
    -- Segredo do endereço de aviso: só o administrador vê (precisa colar no painel da Getnet)
    'webhook_segredo', case when private.tem_papel('{admin}') then i.webhook_segredo end,
    'empresa_id', v_emp);
end $$;

/**
 * Salva o provedor e as credenciais. Campos vazios mantêm o que já está salvo.
 * p: { provedor, ambiente, mercadopago_token, pagbank_token, getnet_client_id, getnet_client_secret,
 *      getnet_seller_id, infinitepay_handle, remover: 'pagbank' | ... }
 */
create or replace function public.salvar_pagamento_provedor(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); i public.integracoes_pagamento; cr jsonb; v_prov text; v_k text; v_v text;
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Somente o administrador altera os pagamentos'; end if;
  insert into public.integracoes_pagamento (empresa_id) values (v_emp) on conflict (empresa_id) do nothing;
  select * into i from public.integracoes_pagamento where empresa_id = v_emp for update;
  cr := coalesce(i.credenciais, '{}'::jsonb);

  -- Remover as credenciais de um provedor
  if nullif(p->>'remover', '') is not null then
    if p->>'remover' = 'mercadopago' then
      update public.integracoes_pagamento set mp_access_token = null where empresa_id = v_emp;
    elsif p->>'remover' = 'pagbank' then cr := cr - 'pagbank_token';
    elsif p->>'remover' = 'getnet' then cr := cr - 'getnet_client_id' - 'getnet_client_secret' - 'getnet_seller_id';
    elsif p->>'remover' = 'infinitepay' then cr := cr - 'infinitepay_handle';
    else raise exception 'Provedor inválido'; end if;
    update public.integracoes_pagamento set credenciais = cr,
      provedor = case when provedor = p->>'remover' then null else provedor end, updated_at = now() where empresa_id = v_emp;
    perform private.auditar(v_emp, 'pagamento.provedor', 'integracoes_pagamento', v_emp::text, jsonb_build_object('removeu', p->>'remover'));
    return public.pagamento_provedor_status();
  end if;

  -- Credenciais novas (só as preenchidas)
  foreach v_k in array array['pagbank_token','getnet_client_id','getnet_client_secret','getnet_seller_id','infinitepay_handle'] loop
    v_v := nullif(trim(coalesce(p->>v_k, '')), '');
    if v_v is not null then
      if length(v_v) > 4000 then raise exception 'Credencial muito longa'; end if;
      if v_k = 'infinitepay_handle' then
        v_v := lower(regexp_replace(v_v, '^\$', ''));
        if v_v !~ '^[a-z0-9_.-]{2,60}$' then raise exception 'InfiniteTag inválida (use só o nome, sem $)'; end if;
      end if;
      cr := cr || jsonb_build_object(v_k, v_v);
    end if;
  end loop;
  if nullif(trim(coalesce(p->>'mercadopago_token', '')), '') is not null then
    if trim(p->>'mercadopago_token') !~ '^(APP_USR-|TEST-)' then raise exception 'O token do Mercado Pago começa com APP_USR-'; end if;
    update public.integracoes_pagamento set mp_access_token = trim(p->>'mercadopago_token') where empresa_id = v_emp;
  end if;

  v_prov := nullif(p->>'provedor', '');
  if v_prov is not null and v_prov not in ('mercadopago','pagbank','getnet','infinitepay') then raise exception 'Provedor inválido'; end if;
  if coalesce(p->>'ambiente', 'producao') not in ('producao','teste') then raise exception 'Ambiente inválido'; end if;

  update public.integracoes_pagamento set credenciais = cr, provedor = v_prov,
    ambiente = coalesce(nullif(p->>'ambiente', ''), ambiente), updated_at = now() where empresa_id = v_emp;

  if v_prov is not null and private.pagamento_provedor(v_emp) is distinct from v_prov then
    raise exception 'Preencha todas as credenciais do provedor escolhido';
  end if;
  perform private.auditar(v_emp, 'pagamento.provedor', 'integracoes_pagamento', v_emp::text,
    jsonb_build_object('provedor', v_prov, 'ambiente', p->>'ambiente',
      'alterou', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p) k where k not in ('provedor','ambiente') and nullif(p->>k, '') is not null)));
  return public.pagamento_provedor_status();
end $$;

/** Formas de pagamento no QR da mesa (só administrador / superusuário). */
create or replace function public.salvar_qr_pagamento(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id(); c jsonb := '{}'::jsonb;
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Somente o administrador altera os pagamentos pelo QR'; end if;
  if p ? 'qr_pagar' then c := c || jsonb_build_object('qr_pagar', coalesce((p->>'qr_pagar')::boolean, true)); end if;
  if p ? 'qr_pagar_chave' then c := c || jsonb_build_object('qr_pagar_chave', coalesce((p->>'qr_pagar_chave')::boolean, true)); end if;
  if p ? 'qr_pagar_auto' then c := c || jsonb_build_object('qr_pagar_auto', coalesce((p->>'qr_pagar_auto')::boolean, true)); end if;
  update public.empresas set config_restaurante = coalesce(config_restaurante, '{}'::jsonb) || c where id = v_emp;
  perform private.auditar(v_emp, 'restaurante.qr_pagamento', 'empresas', v_emp::text, c);
  return private.cfg_restaurante(v_emp);
end $$;

-- Mercado Pago antigo (Configurações › PIX): continua funcionando e passa a marcar o provedor
create or replace function public.salvar_mercado_pago(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := private.empresa_id();
begin
  if v_emp is null or not private.tem_papel('{admin}') then raise exception 'Sem permissão'; end if;
  insert into public.integracoes_pagamento (empresa_id, mp_access_token, provedor) values (v_emp, nullif(trim(p_token), ''), case when nullif(trim(p_token), '') is not null then 'mercadopago' end)
  on conflict (empresa_id) do update set mp_access_token = excluded.mp_access_token,
    provedor = case when excluded.mp_access_token is null and integracoes_pagamento.provedor = 'mercadopago' then null
                    when excluded.mp_access_token is not null and integracoes_pagamento.provedor is null then 'mercadopago'
                    else integracoes_pagamento.provedor end,
    updated_at = now();
  perform private.auditar(v_emp, 'pix.mercado_pago', 'integracoes_pagamento', v_emp::text, jsonb_build_object('ativo', nullif(trim(p_token), '') is not null));
end $$;

-- Regras do restaurante: gerente continua salvando o resto, mas não liga/desliga o pagamento pelo QR
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
  -- Pagamento pelo QR: só o administrador (027 · salvar_qr_pagamento)
  if p ? 'qr_pagar' and private.tem_papel('{admin}') then c := c || jsonb_build_object('qr_pagar', coalesce((p->>'qr_pagar')::boolean, true)); end if;
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

-- Tela "Hoje": título do novo chamado "validar" e textos do PIX (ajuste pontual na função da 025)
do $$ declare d text; d0 text; begin
  d := pg_get_functiondef('public.painel_hoje()'::regprocedure); d0 := d;
  if position('pede para validar o pagamento' in d) = 0 then
    d := replace(d, $x$when 'pedido' then ' fez um pedido pelo QR'$x$, $x$when 'pedido' then ' fez um pedido pelo QR' when 'validar' then ' pede para validar o pagamento'$x$);
    d := replace(d, 'Confirmado pelo Mercado Pago. Entra sozinho ao fechar a conta.', 'Confirmado pela operadora. Entra sozinho ao fechar a conta.');
    d := replace(d, 'Confira o comprovante no celular do cliente.', 'Confira se o PIX caiu na conta da loja e confirme (o cliente já vê o valor descontado).');
    if d = d0 then raise exception 'painel_hoje: trecho não encontrado'; end if;
    execute d;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Permissões
-- ---------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon;
revoke execute on function public.mesa_publica(uuid), public.mesa_chamar(uuid,text,numeric) from public;
grant execute on function public.mesa_publica(uuid), public.mesa_chamar(uuid,text,numeric) to anon, authenticated;
revoke execute on function public.pagamento_provedor_status(), public.salvar_pagamento_provedor(jsonb), public.salvar_qr_pagamento(jsonb),
  public.mesa_chamado_resolver(uuid,text,text), public.salvar_mercado_pago(text) from public, anon;
grant execute on function public.pagamento_provedor_status(), public.salvar_pagamento_provedor(jsonb), public.salvar_qr_pagamento(jsonb),
  public.mesa_chamado_resolver(uuid,text,text), public.salvar_mercado_pago(text) to authenticated;
