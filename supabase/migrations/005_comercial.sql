-- =====================================================================
-- Comercial: assinatura das lojas, período de teste com antifraude,
-- captação de leads e painel do fornecedor (plataforma).
-- =====================================================================

-- ---------- Situação comercial da loja ----------
alter table public.empresas
  add column status_conta text not null default 'teste'
    check (status_conta in ('teste','ativo','suspenso','cancelado')),
  add column plano text not null default 'teste',
  add column valor_mensal numeric(10,2),
  add column teste_expira_em timestamptz default (now() + interval '7 days'),
  add column ativado_em timestamptz,
  add column observacao_comercial text;

-- O cliente não pode mudar a própria situação comercial
revoke update (status_conta, plano, valor_mensal, teste_expira_em, ativado_em, observacao_comercial)
  on public.empresas from authenticated;

-- ---------- Leads (contatos captados pelo site) ----------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  loja text,
  segmento text,
  whatsapp text,
  email text,
  documento text,
  cidade text,
  interesse text,               -- plano ou combo que chamou atenção
  mensagem text,
  origem text not null default 'site',   -- site | teste | teste_bloqueado | app
  status text not null default 'novo' check (status in ('novo','contatado','negociando','convertido','perdido')),
  empresa_id uuid references public.empresas(id) on delete set null,
  ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_created_idx on public.leads(created_at desc);
create index leads_whatsapp_idx on public.leads(whatsapp);
create index leads_ip_idx on public.leads(ip, created_at);
create index leads_empresa_idx on public.leads(empresa_id);
alter table public.leads enable row level security;   -- sem políticas: só funções do servidor
revoke all on public.leads from anon, authenticated;
create trigger t_upd before update on public.leads for each row execute function private.set_updated_at();

-- ---------- Registro permanente de testes (impede repetir o teste) ----------
-- Não é apagado quando a loja é excluída: é a "memória" do antifraude.
create table public.testes_gratis (
  id bigint generated always as identity primary key,
  documento text not null,
  whatsapp text not null,
  email_normalizado text not null,
  dispositivo text,
  impressao text,
  ip text,
  user_id uuid,
  empresa_id uuid,
  created_at timestamptz not null default now()
);
create unique index testes_documento_uk on public.testes_gratis(documento);
create unique index testes_whatsapp_uk on public.testes_gratis(whatsapp);
create unique index testes_email_uk on public.testes_gratis(email_normalizado);
create index testes_dispositivo_idx on public.testes_gratis(dispositivo);
create index testes_impressao_idx on public.testes_gratis(impressao);
create index testes_ip_idx on public.testes_gratis(ip, created_at);
alter table public.testes_gratis enable row level security;
revoke all on public.testes_gratis from anon, authenticated;

-- ---------- Administradores da plataforma (o fornecedor) ----------
create table public.plataforma_admins (
  email text primary key,
  created_at timestamptz not null default now()
);
alter table public.plataforma_admins enable row level security;
revoke all on public.plataforma_admins from anon, authenticated;
insert into public.plataforma_admins (email) values ('haydenfernandes.ti@gmail.com');

create or replace function private.eh_admin_plataforma()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u join public.plataforma_admins a on lower(a.email) = lower(u.email)
    where u.id = (select auth.uid()) and u.email_confirmed_at is not null)
$$;
grant execute on function private.eh_admin_plataforma() to authenticated;

-- ---------- Regras do período de teste ----------
create or replace function private.conta_liberada(p_emp uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- Retorna null se a loja pode operar; caso contrário, a mensagem de bloqueio.
declare e public.empresas; n int;
begin
  select * into e from public.empresas where id = p_emp;
  if e.status_conta = 'ativo' then return null; end if;
  if e.status_conta in ('suspenso','cancelado') then
    return 'Conta suspensa. Fale com o suporte para reativar.';
  end if;
  if e.teste_expira_em is not null and now() >= e.teste_expira_em then
    return 'Seu período de teste terminou. Contrate um plano para continuar vendendo — seus dados estão guardados.';
  end if;
  select count(*) into n from public.vendas where empresa_id = p_emp and status = 'finalizada';
  if n >= 200 then
    return 'Limite de 200 vendas do período de teste atingido. Contrate um plano para continuar.';
  end if;
  return null;
end $$;

create or replace function public.situacao_conta()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', e.status_conta, 'plano', e.plano, 'teste_expira_em', e.teste_expira_em,
    'bloqueio', private.conta_liberada(e.id),
    'vendas_teste', (select count(*) from public.vendas v where v.empresa_id = e.id and v.status = 'finalizada'),
    'admin_plataforma', private.eh_admin_plataforma())
  from public.empresas e where e.id = private.empresa_id()
$$;

create or replace function public.sou_admin_plataforma()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.eh_admin_plataforma()
$$;

-- Bloqueio nas operações de venda e caixa (encapsula as funções existentes)
create or replace function private.exigir_conta_liberada()
returns void language plpgsql stable security definer set search_path = '' as $$
declare msg text := private.conta_liberada(private.empresa_id());
begin
  if msg is not null then raise exception '%', msg; end if;
end $$;

-- Trigger: impede finalizar venda e abrir caixa com a conta bloqueada
create or replace function private.vendas_conta_liberada()
returns trigger language plpgsql security definer set search_path = '' as $$
declare msg text;
begin
  if new.status = 'finalizada' and (tg_op = 'INSERT' or old.status is distinct from 'finalizada') then
    msg := private.conta_liberada(new.empresa_id);
    if msg is not null then raise exception '%', msg; end if;
  end if;
  return new;
end $$;
create trigger t_conta_liberada before insert or update of status on public.vendas
  for each row execute function private.vendas_conta_liberada();

create or replace function private.caixa_conta_liberada()
returns trigger language plpgsql security definer set search_path = '' as $$
declare msg text := private.conta_liberada(new.empresa_id);
begin
  if msg is not null then raise exception '%', msg; end if;
  return new;
end $$;
create trigger t_conta_liberada before insert on public.caixa_sessoes
  for each row execute function private.caixa_conta_liberada();

-- No teste, nota fiscal só em homologação
create or replace function private.fiscal_teste_homologacao()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.ambiente = 'producao' and exists (
     select 1 from public.empresas where id = new.empresa_id and status_conta <> 'ativo') then
    raise exception 'Durante o teste a nota fiscal funciona só em homologação (sem valor fiscal).';
  end if;
  return new;
end $$;
create trigger t_fiscal_teste before insert or update on public.config_fiscal
  for each row execute function private.fiscal_teste_homologacao();

-- ---------- Criação da loja: agora só pelo servidor (com antifraude) ----------
revoke execute on function public.criar_empresa(text,text,text,text,text) from authenticated;

create or replace function public.criar_empresa_teste(
  p_user uuid, p_razao_social text, p_nome_fantasia text, p_documento text,
  p_segmento text, p_nome_usuario text, p_whatsapp text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; v_email text; v_cat record; v_seg text;
begin
  if exists (select 1 from public.perfis where id = p_user) then
    raise exception 'Este usuário já está vinculado a uma loja';
  end if;
  select email into v_email from auth.users where id = p_user;
  if v_email is null then raise exception 'Usuário não encontrado'; end if;

  insert into public.empresas (razao_social, nome_fantasia, cnpj, segmento, telefone, email,
                               status_conta, plano, teste_expira_em)
  values (trim(p_razao_social), nullif(trim(coalesce(p_nome_fantasia,'')),''),
          case when length(p_documento) = 14 then p_documento end,
          p_segmento, p_whatsapp, v_email, 'teste', 'teste', now() + interval '7 days')
  returning id into v_emp;

  insert into public.perfis (id, empresa_id, nome, email, papel)
  values (p_user, v_emp, coalesce(nullif(trim(p_nome_usuario),''), split_part(v_email,'@',1)), v_email, 'admin');
  insert into public.config_fiscal (empresa_id) values (v_emp);
  insert into public.fiscal_credenciais (empresa_id) values (v_emp);

  v_seg := case when p_segmento in ('mercadinho','supermercado','mercado') then 'mercado'
                when p_segmento in ('padaria','lanchonete','cafe','restaurante') then p_segmento
                else 'lanchonete' end;

  -- Categorias e produtos de exemplo: o cliente já vê o sistema funcionando no 1º minuto
  insert into public.categorias (empresa_id, nome, cor, ordem)
  select v_emp, c.nome, c.cor, c.ordem from (values
      ('padaria','Pães','#b45309',1),('padaria','Bolos e Doces','#db2777',2),('padaria','Salgados','#ea580c',3),
      ('padaria','Frios','#0891b2',4),('padaria','Bebidas','#2563eb',5),
      ('lanchonete','Lanches','#ea580c',1),('lanchonete','Porções','#b45309',2),('lanchonete','Bebidas','#2563eb',3),('lanchonete','Sobremesas','#db2777',4),
      ('cafe','Cafés','#78350f',1),('cafe','Salgados','#ea580c',2),('cafe','Doces','#db2777',3),('cafe','Bebidas','#2563eb',4),
      ('restaurante','Pratos','#16a34a',1),('restaurante','Porções','#b45309',2),('restaurante','Bebidas','#2563eb',3),('restaurante','Sobremesas','#db2777',4),
      ('mercado','Mercearia','#b45309',1),('mercado','Bebidas','#2563eb',2),('mercado','Hortifruti','#16a34a',3),
      ('mercado','Frios e Laticínios','#0891b2',4),('mercado','Limpeza','#7c3aed',5)
    ) c(seg, nome, cor, ordem) where c.seg = v_seg;

  insert into public.produtos (empresa_id, categoria_id, nome, preco_venda, preco_custo, unidade, favorito, estoque_atual, estoque_minimo)
  select v_emp, (select id from public.categorias where empresa_id = v_emp and nome = p.cat),
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

  perform private.auditar(v_emp, 'empresa.criar', 'empresas', v_emp::text, jsonb_build_object('origem','teste'));
  return v_emp;
end $$;
revoke execute on function public.criar_empresa_teste(uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.criar_empresa_teste(uuid,text,text,text,text,text,text) to service_role;

-- ---------- Painel do fornecedor ----------
create or replace function public.plataforma_resumo()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  select jsonb_build_object(
    'leads_novos', (select count(*) from public.leads where status = 'novo'),
    'leads_30d', (select count(*) from public.leads where created_at > now() - interval '30 days'),
    'testes_ativos', (select count(*) from public.empresas where status_conta = 'teste' and teste_expira_em > now()),
    'testes_vencidos', (select count(*) from public.empresas where status_conta = 'teste' and teste_expira_em <= now()),
    'clientes_ativos', (select count(*) from public.empresas where status_conta = 'ativo'),
    'mrr', (select coalesce(sum(valor_mensal),0) from public.empresas where status_conta = 'ativo'),
    'bloqueios_30d', (select count(*) from public.leads where origem = 'teste_bloqueado' and created_at > now() - interval '30 days')
  ) into r;
  return r;
end $$;

create or replace function public.plataforma_leads(p_status text default null)
returns setof public.leads language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return query select * from public.leads
    where p_status is null or status = p_status
    order by created_at desc limit 500;
end $$;

create or replace function public.plataforma_lojas()
returns table (id uuid, loja text, documento text, segmento text, telefone text, email text,
               status_conta text, plano text, valor_mensal numeric, teste_expira_em timestamptz,
               created_at timestamptz, vendas bigint, ultima_venda timestamptz, usuarios bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return query
    select e.id, coalesce(e.nome_fantasia, e.razao_social), e.cnpj, e.segmento, e.telefone, e.email,
           e.status_conta, e.plano, e.valor_mensal, e.teste_expira_em, e.created_at,
           (select count(*) from public.vendas v where v.empresa_id = e.id and v.status = 'finalizada'),
           (select max(finalizada_em) from public.vendas v where v.empresa_id = e.id),
           (select count(*) from public.perfis p where p.empresa_id = e.id)
    from public.empresas e order by e.created_at desc;
end $$;

create or replace function public.plataforma_atualizar_lead(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  update public.leads set status = p_status where id = p_id;
end $$;

create or replace function public.plataforma_atualizar_loja(
  p_id uuid, p_acao text, p_plano text default null, p_valor numeric default null, p_dias int default 7)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  if p_acao = 'ativar' then
    update public.empresas set status_conta = 'ativo', plano = coalesce(p_plano, plano),
      valor_mensal = p_valor, ativado_em = coalesce(ativado_em, now()) where id = p_id;
    update public.leads set status = 'convertido' where empresa_id = p_id;
  elsif p_acao = 'estender' then
    update public.empresas set status_conta = 'teste',
      teste_expira_em = greatest(coalesce(teste_expira_em, now()), now()) + make_interval(days => least(greatest(p_dias,1),30))
    where id = p_id;
  elsif p_acao = 'suspender' then
    update public.empresas set status_conta = 'suspenso' where id = p_id;
  elsif p_acao = 'cancelar' then
    update public.empresas set status_conta = 'cancelado' where id = p_id;
  else
    raise exception 'Ação inválida';
  end if;
end $$;

revoke execute on function public.situacao_conta(), public.sou_admin_plataforma(), public.plataforma_resumo(),
  public.plataforma_leads(text), public.plataforma_lojas(), public.plataforma_atualizar_lead(uuid,text),
  public.plataforma_atualizar_loja(uuid,text,text,numeric,int) from public, anon;
grant execute on function public.situacao_conta(), public.sou_admin_plataforma(), public.plataforma_resumo(),
  public.plataforma_leads(text), public.plataforma_lojas(), public.plataforma_atualizar_lead(uuid,text),
  public.plataforma_atualizar_loja(uuid,text,text,numeric,int) to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.empresa_id(), private.papel(), private.tem_papel(public.papel_usuario[]),
  private.eh_admin_plataforma() to authenticated;
