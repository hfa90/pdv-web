-- =====================================================================
-- 023 · Mudar o setor (segmento) de uma loja
--
--   Ex.: Supermercado → Restaurante. Os produtos e categorias da loja são
--   trocados pelos de exemplo do novo setor (os mesmos que uma loja nova
--   recebe) e, no caso de restaurante, as mesas e o app do garçom já ficam
--   liberados.
--
--   Fluxo (o cliente é avisado e é OBRIGADO a baixar o backup):
--     1. O superusuário pede a mudança (Plataforma › Lojas › Gerenciar),
--        escolhendo o que será apagado:
--          - 'catalogo': produtos, categorias, estoque, lotes, promoções;
--          - 'tudo':     a loja volta "zerada" — catálogo, vendas, caixa,
--                        clientes, fiado, financeiro, compras, fornecedores,
--                        mesas, cozinha…; ficam só os usuários, os dados da
--                        empresa, as configurações (fiscal, PIX, pagamentos,
--                        aparelhos) e a assinatura/licenças.
--     2. O administrador da loja, ao entrar, vê o aviso com tudo o que será
--        apagado e só consegue confirmar DEPOIS de baixar o backup completo
--        (um único arquivo .json com todos os dados da loja). O download fica
--        registrado.
--     3. Ele digita APAGAR e confirma. O banco ainda guarda uma cópia
--        ("Antes de mudar o setor") e aplica a mudança.
--   O superusuário pode cancelar o pedido enquanto estiver pendente.
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

create table if not exists public.segmento_mudancas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  de text,
  para text not null check (para in ('padaria', 'mercadinho', 'supermercado', 'lanchonete', 'cafe', 'restaurante')),
  escopo text not null default 'catalogo' check (escopo in ('catalogo', 'tudo')),
  mensagem text,
  status text not null default 'pendente' check (status in ('pendente', 'concluida', 'cancelada')),
  solicitado_por text,
  solicitado_em timestamptz not null default now(),
  baixado_em timestamptz,
  baixado_por text,
  backup_id uuid,
  concluido_em timestamptz,
  concluido_por text,
  resultado jsonb
);
create unique index if not exists segmento_mudancas_pendente_uk on public.segmento_mudancas(empresa_id) where status = 'pendente';
alter table public.segmento_mudancas enable row level security;   -- só funções do servidor
revoke all on public.segmento_mudancas from anon, authenticated;

-- Fica fora do backup (é um registro da plataforma, não um dado da loja)
create or replace function private.backup_excluidas()
returns text[] language sql immutable set search_path = '' as $$
  select array['backups', 'backup_config', 'diagnostico_eventos', 'dispositivos_eventos', 'suporte_acessos',
               'suporte_chamados', 'avisos_plataforma', 'leads', 'testes_gratis', 'superusuario_log',
               'senha_aprovacao_tentativas', 'segmento_mudancas']
$$;

create or replace function private.nome_segmento(p text)
returns text language sql immutable set search_path = '' as $$
  select case p when 'padaria' then 'Padaria' when 'mercadinho' then 'Mercadinho' when 'supermercado' then 'Supermercado'
    when 'mercado' then 'Mercado' when 'lanchonete' then 'Lanchonete' when 'cafe' then 'Café / cafeteria'
    when 'restaurante' then 'Restaurante' else coalesce(p, '—') end
$$;

/** Categorias e produtos de exemplo do setor (os mesmos de uma loja nova). */
create or replace function private.catalogo_exemplo(p_emp uuid, p_segmento text)
returns int language plpgsql security definer set search_path = '' as $$
declare v_seg text; n int;
begin
  v_seg := case when p_segmento in ('mercadinho','supermercado','mercado') then 'mercado'
                when p_segmento in ('padaria','lanchonete','cafe','restaurante') then p_segmento
                else 'lanchonete' end;
  insert into public.categorias (empresa_id, nome, cor, ordem)
  select p_emp, c.nome, c.cor, c.ordem from (values
      ('padaria','Pães','#b45309',1),('padaria','Bolos e Doces','#db2777',2),('padaria','Salgados','#ea580c',3),
      ('padaria','Frios','#0891b2',4),('padaria','Bebidas','#2563eb',5),
      ('lanchonete','Lanches','#ea580c',1),('lanchonete','Porções','#b45309',2),('lanchonete','Bebidas','#2563eb',3),('lanchonete','Sobremesas','#db2777',4),
      ('cafe','Cafés','#78350f',1),('cafe','Salgados','#ea580c',2),('cafe','Doces','#db2777',3),('cafe','Bebidas','#2563eb',4),
      ('restaurante','Pratos','#16a34a',1),('restaurante','Porções','#b45309',2),('restaurante','Bebidas','#2563eb',3),('restaurante','Sobremesas','#db2777',4),
      ('mercado','Mercearia','#b45309',1),('mercado','Bebidas','#2563eb',2),('mercado','Hortifruti','#16a34a',3),
      ('mercado','Frios e Laticínios','#0891b2',4),('mercado','Limpeza','#7c3aed',5)
    ) c(seg, nome, cor, ordem)
  where c.seg = v_seg
    and not exists (select 1 from public.categorias x where x.empresa_id = p_emp and x.nome = c.nome);

  insert into public.produtos (empresa_id, categoria_id, nome, preco_venda, preco_custo, unidade, favorito, estoque_atual, estoque_minimo)
  select p_emp, (select id from public.categorias where empresa_id = p_emp and nome = p.cat limit 1),
         p.nome, p.preco, round(p.preco * 0.45, 2), p.un, p.fav, p.est, 5
  from (values
    ('padaria','Pães','Pão francês',0.80,'UN',true,300),('padaria','Pães','Pão de forma',9.90,'UN',false,20),
    ('padaria','Salgados','Pão de queijo',2.50,'UN',true,60),('padaria','Salgados','Coxinha',7.00,'UN',true,40),
    ('padaria','Bolos e Doces','Bolo de cenoura (fatia)',7.50,'UN',true,20),('padaria','Frios','Queijo muçarela',49.90,'KG',false,5),
    ('padaria','Frios','Presunto',39.90,'KG',false,5),('padaria','Bebidas','Café com leite',6.00,'UN',true,100),
    ('padaria','Bebidas','Refrigerante lata',6.00,'UN',false,48),
    ('lanchonete','Lanches','X-Burguer',22.00,'UN',true,50),('lanchonete','Lanches','X-Salada',25.00,'UN',true,50),
    ('lanchonete','Lanches','Misto quente',12.00,'UN',true,50),('lanchonete','Porções','Batata frita',28.00,'UN',true,30),
    ('lanchonete','Bebidas','Refrigerante lata',6.00,'UN',true,48),('lanchonete','Bebidas','Suco natural',10.00,'UN',false,40),
    ('lanchonete','Sobremesas','Açaí 300ml',16.00,'UN',false,30),
    ('cafe','Cafés','Café expresso',6.00,'UN',true,200),('cafe','Cafés','Cappuccino',11.00,'UN',true,100),
    ('cafe','Salgados','Pão na chapa',7.00,'UN',true,80),('cafe','Salgados','Pão de queijo',4.00,'UN',true,80),
    ('cafe','Doces','Bolo do dia (fatia)',9.00,'UN',true,20),('cafe','Bebidas','Suco de laranja',10.00,'UN',false,40),
    ('restaurante','Pratos','Prato feito',25.00,'UN',true,100),('restaurante','Pratos','Comida por quilo',69.90,'KG',true,50),
    ('restaurante','Porções','Fritas',30.00,'UN',false,30),('restaurante','Bebidas','Refrigerante 600ml',9.00,'UN',true,48),
    ('restaurante','Bebidas','Suco natural',10.00,'UN',true,40),('restaurante','Sobremesas','Pudim',10.00,'UN',false,20),
    ('mercado','Mercearia','Arroz 5kg',29.90,'UN',true,30),('mercado','Mercearia','Feijão 1kg',8.90,'UN',true,40),
    ('mercado','Mercearia','Café 500g',24.90,'UN',true,30),('mercado','Bebidas','Refrigerante 2L',10.90,'UN',true,48),
    ('mercado','Hortifruti','Banana',6.99,'KG',true,30),('mercado','Hortifruti','Tomate',8.99,'KG',false,20),
    ('mercado','Frios e Laticínios','Leite 1L',5.49,'UN',true,60),('mercado','Limpeza','Detergente',2.99,'UN',false,40)
  ) p(seg, cat, nome, preco, un, fav, est)
  where p.seg = v_seg;
  get diagnostics n = row_count;
  return n;
end $$;

/** O que cada escopo apaga (para mostrar ao cliente). */
create or replace function private.segmento_apaga(p_escopo text)
returns text[] language sql immutable set search_path = '' as $$
  select case when p_escopo = 'tudo' then array[
      'Produtos e categorias', 'Estoque, lotes, validade e perdas', 'Promoções', 'Vendas e cupons', 'Caixas e movimentos de caixa',
      'Clientes e fiado', 'Financeiro (contas a pagar)', 'Compras, notas de entrada e fornecedores', 'Mesas, comandas e pedidos da cozinha',
      'Notas fiscais emitidas (registro no sistema)', 'Registro de atividades']
    else array['Produtos e categorias', 'Estoque, lotes, validade e perdas', 'Promoções', 'Vínculo produto × fornecedor'] end
$$;

create or replace function private.segmento_mantem(p_escopo text)
returns text[] language sql immutable set search_path = '' as $$
  select case when p_escopo = 'tudo' then array[
      'Usuários e senhas', 'Dados da empresa (nome, CNPJ, endereço)', 'Configurações fiscais, PIX e pagamentos', 'Aparelhos autorizados',
      'Assinatura, faturas e licenças']
    else array['Vendas e relatórios (o nome do produto continua em cada venda)', 'Clientes e fiado', 'Caixas', 'Financeiro e compras',
      'Usuários e configurações'] end
$$;

create or replace function private.segmento_json(m public.segmento_mudancas)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'empresa_id', m.empresa_id, 'de', m.de, 'para', m.para,
    'de_nome', private.nome_segmento(m.de), 'para_nome', private.nome_segmento(m.para),
    'escopo', m.escopo, 'mensagem', m.mensagem, 'status', m.status, 'solicitado_por', m.solicitado_por,
    'solicitado_em', m.solicitado_em, 'baixado_em', m.baixado_em, 'baixado_por', m.baixado_por,
    'concluido_em', m.concluido_em, 'concluido_por', m.concluido_por, 'resultado', m.resultado,
    'apaga', to_jsonb(private.segmento_apaga(m.escopo)), 'mantem', to_jsonb(private.segmento_mantem(m.escopo)))
$$;

/** Aplica a mudança (apaga + catálogo de exemplo + novo setor). */
create or replace function private.segmento_aplicar(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.segmento_mudancas; v_emp uuid; v_tabs text[]; i int; t text; v_manter text[]; v_bk uuid; v_prod int; v_apagados bigint := 0; n bigint;
begin
  select * into m from public.segmento_mudancas where id = p_id for update;
  v_emp := m.empresa_id;
  v_bk := private.backup_gravar(v_emp, 'manual', 'Antes de mudar o setor para ' || private.nome_segmento(m.para), private.quem());

  if m.escopo = 'tudo' then
    -- Fica: usuários, configurações, aparelhos, assinatura e licenças
    v_manter := array['perfis', 'config_fiscal', 'fiscal_credenciais', 'integracoes_pagamento', 'dispositivos', 'garcom_acesso',
                      'garcom_metas', 'senhas_aprovacao', 'licencas', 'faturas', 'pacotes_solicitacoes'];
    v_tabs := private.backup_tabelas(true);
    for i in reverse cardinality(v_tabs)..1 loop
      t := v_tabs[i];
      continue when t = any (v_manter);
      execute format('delete from public.%I where empresa_id = $1', t) using v_emp;
      get diagnostics n = row_count; v_apagados := v_apagados + n;
    end loop;
    update public.empresas set proximo_numero_venda = 1 where id = v_emp;
  else
    delete from public.promocoes where empresa_id = v_emp; get diagnostics n = row_count; v_apagados := v_apagados + n;
    delete from public.perdas where empresa_id = v_emp; get diagnostics n = row_count; v_apagados := v_apagados + n;
    delete from public.lotes where empresa_id = v_emp; get diagnostics n = row_count; v_apagados := v_apagados + n;
    delete from public.produto_fornecedor where empresa_id = v_emp; get diagnostics n = row_count; v_apagados := v_apagados + n;
    delete from public.estoque_movimentos where empresa_id = v_emp; get diagnostics n = row_count; v_apagados := v_apagados + n;
    delete from public.produtos where empresa_id = v_emp; get diagnostics n = row_count; v_apagados := v_apagados + n;
    delete from public.categorias where empresa_id = v_emp; get diagnostics n = row_count; v_apagados := v_apagados + n;
  end if;

  update public.empresas set segmento = m.para where id = v_emp;
  v_prod := private.catalogo_exemplo(v_emp, m.para);

  update public.segmento_mudancas set status = 'concluida', concluido_em = now(), concluido_por = private.quem(), backup_id = v_bk,
    resultado = jsonb_build_object('apagados', v_apagados, 'produtos_exemplo', v_prod)
  where id = p_id;
  perform private.auditar(v_emp, 'loja.mudar_setor', 'empresas', v_emp::text,
    jsonb_build_object('de', m.de, 'para', m.para, 'escopo', m.escopo, 'apagados', v_apagados, 'backup', v_bk, 'arquivo_baixado_em', m.baixado_em));
  perform private.log_super('loja.mudar_setor', v_emp,
    jsonb_build_object('de', m.de, 'para', m.para, 'escopo', m.escopo, 'apagados', v_apagados, 'backup', v_bk, 'confirmado_por', private.quem()));
  return jsonb_build_object('apagados', v_apagados, 'produtos_exemplo', v_prod, 'backup', v_bk, 'para', m.para);
end $$;

-- ---------------------------------------------------------------------
-- Superusuário
-- ---------------------------------------------------------------------
create or replace function public.plataforma_segmento_solicitar(p_empresa uuid, p_para text, p_escopo text default 'catalogo', p_mensagem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.empresas; m public.segmento_mudancas;
begin
  if not private.eh_admin_plataforma() then raise exception 'Só o superusuário pode mudar o setor de uma loja'; end if;
  select * into e from public.empresas where id = p_empresa;
  if not found then raise exception 'Loja não encontrada'; end if;
  if p_para is null or p_para = e.segmento then raise exception 'Escolha um setor diferente do atual (%)', private.nome_segmento(e.segmento); end if;
  if p_escopo not in ('catalogo', 'tudo') then raise exception 'Escolha o que será apagado'; end if;
  update public.segmento_mudancas set status = 'cancelada', concluido_em = now(), concluido_por = private.quem()
   where empresa_id = p_empresa and status = 'pendente';
  insert into public.segmento_mudancas (empresa_id, de, para, escopo, mensagem, solicitado_por)
  values (p_empresa, e.segmento, p_para, p_escopo, nullif(trim(coalesce(p_mensagem, '')), ''), private.quem())
  returning * into m;
  perform private.log_super('loja.mudar_setor_pedido', p_empresa, jsonb_build_object('de', e.segmento, 'para', p_para, 'escopo', p_escopo));
  perform private.auditar(p_empresa, 'loja.mudar_setor_pedido', 'empresas', p_empresa::text, jsonb_build_object('de', e.segmento, 'para', p_para, 'escopo', p_escopo));
  return private.segmento_json(m);
end $$;

create or replace function public.plataforma_segmento_cancelar(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare m public.segmento_mudancas;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  update public.segmento_mudancas set status = 'cancelada', concluido_em = now(), concluido_por = private.quem()
   where id = p_id and status = 'pendente' returning * into m;
  if m.id is not null then perform private.log_super('loja.mudar_setor_cancelado', m.empresa_id, jsonb_build_object('para', m.para)); end if;
end $$;

/** Pedidos de uma loja (o último primeiro). */
create or replace function public.plataforma_segmento_pedidos(p_empresa uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return (select coalesce(jsonb_agg(private.segmento_json(m) order by m.solicitado_em desc), '[]'::jsonb)
          from (select * from public.segmento_mudancas where empresa_id = p_empresa order by solicitado_em desc limit 10) m);
end $$;

-- ---------------------------------------------------------------------
-- Loja (administrador)
-- ---------------------------------------------------------------------
/** Pedido pendente da loja de quem está logado (qualquer nível vê; só o admin confirma). */
create or replace function public.segmento_pendente()
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.segmento_json(m) || jsonb_build_object('pode_confirmar', private.papel()::text = 'admin')
  from public.segmento_mudancas m
  where m.empresa_id = private.empresa_id() and m.status = 'pendente'
  limit 1
$$;

/** Registra que o administrador baixou o backup completo (o botão do aviso chama depois de gerar o arquivo). */
create or replace function public.segmento_registrar_download(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.segmento_mudancas;
begin
  update public.segmento_mudancas set baixado_em = now(), baixado_por = private.quem()
   where id = p_id and status = 'pendente' and empresa_id = private.empresa_id() and private.papel()::text = 'admin'
  returning * into m;
  if m.id is null then raise exception 'Pedido de mudança não encontrado'; end if;
  perform private.auditar(m.empresa_id, 'backup.baixar', 'segmento_mudancas', m.id::text, jsonb_build_object('motivo', 'mudança de setor'));
  return private.segmento_json(m);
end $$;

/** Confirma e aplica. Só depois de baixar o backup (nas últimas 24 h). Digite APAGAR. */
create or replace function public.segmento_confirmar(p_id uuid, p_confirmacao text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.segmento_mudancas;
begin
  select * into m from public.segmento_mudancas where id = p_id and empresa_id = private.empresa_id();
  if not found or m.status <> 'pendente' then raise exception 'Pedido de mudança não encontrado ou já resolvido'; end if;
  if private.papel()::text <> 'admin' then raise exception 'Só o administrador da loja confirma a mudança de setor'; end if;
  if m.baixado_em is null or m.baixado_em < now() - interval '24 hours' then
    raise exception 'Baixe o backup completo da loja antes de confirmar (botão "Baixar backup completo").';
  end if;
  if coalesce(upper(trim(p_confirmacao)), '') <> 'APAGAR' then raise exception 'Digite APAGAR para confirmar'; end if;
  return private.segmento_aplicar(p_id);
end $$;

revoke execute on function public.plataforma_segmento_solicitar(uuid, text, text, text), public.plataforma_segmento_cancelar(uuid),
  public.plataforma_segmento_pedidos(uuid), public.segmento_pendente(), public.segmento_registrar_download(uuid),
  public.segmento_confirmar(uuid, text) from public, anon;
grant execute on function public.plataforma_segmento_solicitar(uuid, text, text, text), public.plataforma_segmento_cancelar(uuid),
  public.plataforma_segmento_pedidos(uuid), public.segmento_pendente(), public.segmento_registrar_download(uuid),
  public.segmento_confirmar(uuid, text) to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.empresa_id(), private.papel(), private.tem_papel(public.papel_usuario[]),
  private.eh_admin_plataforma(), private.licenca_ok(uuid, text) to authenticated;

notify pgrst, 'reload schema';
