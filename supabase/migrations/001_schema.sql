-- =====================================================================
-- PDV — Schema base (multiempresa + níveis de acesso + RLS)
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------- Tipos ----------
create type public.papel_usuario   as enum ('admin','gerente','caixa','atendente');
create type public.forma_pagamento as enum ('dinheiro','credito','debito','pix','vale_refeicao','crediario','outros');
create type public.status_venda    as enum ('aberta','finalizada','cancelada');
create type public.tipo_mov_estoque as enum ('entrada','saida','ajuste','venda','cancelamento');
create type public.tipo_mov_caixa  as enum ('sangria','suprimento');
create type public.status_doc_fiscal as enum ('processando','autorizado','rejeitado','cancelado','erro');

-- ---------- Empresas ----------
create table public.empresas (
  id uuid primary key default gen_random_uuid(),
  razao_social text not null check (length(razao_social) between 2 and 120),
  nome_fantasia text,
  cnpj text,
  inscricao_estadual text,
  segmento text,
  telefone text,
  email text,
  cep text, logradouro text, numero text, complemento text, bairro text,
  municipio text, codigo_municipio text, uf char(2),
  regime_tributario smallint not null default 1,         -- 1 Simples Nacional, 3 Regime Normal
  mensagem_cupom text default 'Obrigado pela preferência! Volte sempre.',
  desconto_maximo_caixa numeric(5,2) not null default 10 check (desconto_maximo_caixa between 0 and 100),
  proximo_numero_venda bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Perfis (usuários do sistema) ----------
create table public.perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  nome text not null,
  email text,
  papel public.papel_usuario not null default 'caixa',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index perfis_empresa_idx on public.perfis(empresa_id);

-- ---------- Categorias ----------
create table public.categorias (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  nome text not null check (length(nome) between 1 and 60),
  cor text not null default '#64748b',
  ordem int not null default 0,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (empresa_id, nome)
);

-- ---------- Produtos ----------
create table public.produtos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  categoria_id uuid references public.categorias(id) on delete set null,
  codigo text,
  codigo_barras text,
  nome text not null check (length(nome) between 1 and 120),
  unidade text not null default 'UN' check (unidade in ('UN','KG','G','L','ML','CX','PCT','DZ','M','FD')),
  preco_venda numeric(12,2) not null default 0 check (preco_venda >= 0),
  preco_custo numeric(12,2) not null default 0 check (preco_custo >= 0),
  controla_estoque boolean not null default true,
  estoque_atual numeric(14,3) not null default 0,
  estoque_minimo numeric(14,3) not null default 0,
  -- fiscais
  ncm text, cest text,
  cfop text not null default '5102',
  csosn text not null default '102',
  origem smallint not null default 0,
  favorito boolean not null default false,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index produtos_empresa_idx on public.produtos(empresa_id, ativo);
create index produtos_categoria_idx on public.produtos(categoria_id);
create unique index produtos_barras_uk on public.produtos(empresa_id, codigo_barras) where codigo_barras is not null and codigo_barras <> '';
create unique index produtos_codigo_uk on public.produtos(empresa_id, codigo) where codigo is not null and codigo <> '';

-- ---------- Clientes ----------
create table public.clientes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  nome text not null check (length(nome) between 1 and 120),
  cpf_cnpj text,
  inscricao_estadual text,
  telefone text,
  email text,
  cep text, logradouro text, numero text, complemento text, bairro text,
  municipio text, codigo_municipio text, uf char(2),
  observacoes text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clientes_empresa_idx on public.clientes(empresa_id);

-- ---------- Caixa ----------
create table public.caixa_sessoes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  operador_id uuid not null references public.perfis(id),
  terminal text,
  status text not null default 'aberto' check (status in ('aberto','fechado')),
  aberto_em timestamptz not null default now(),
  fechado_em timestamptz,
  valor_abertura numeric(12,2) not null default 0 check (valor_abertura >= 0),
  valor_esperado numeric(12,2),
  valor_informado numeric(12,2),
  diferenca numeric(12,2),
  observacao text
);
create unique index caixa_um_aberto_por_operador on public.caixa_sessoes(operador_id) where status = 'aberto';
create index caixa_sessoes_empresa_idx on public.caixa_sessoes(empresa_id, aberto_em desc);

create table public.caixa_movimentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  sessao_id uuid not null references public.caixa_sessoes(id) on delete cascade,
  tipo public.tipo_mov_caixa not null,
  valor numeric(12,2) not null check (valor > 0),
  motivo text,
  usuario_id uuid references public.perfis(id),
  created_at timestamptz not null default now()
);
create index caixa_mov_sessao_idx on public.caixa_movimentos(sessao_id);

-- ---------- Vendas ----------
create table public.vendas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  numero bigint not null,
  status public.status_venda not null default 'aberta',
  sessao_id uuid references public.caixa_sessoes(id),
  operador_id uuid references public.perfis(id),
  cliente_id uuid references public.clientes(id) on delete set null,
  cpf_cnpj_consumidor text,
  identificador text,                   -- mesa / comanda / senha
  subtotal numeric(12,2) not null default 0,
  desconto numeric(12,2) not null default 0,
  acrescimo numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  valor_pago numeric(12,2) not null default 0,
  troco numeric(12,2) not null default 0,
  observacao text,
  created_at timestamptz not null default now(),
  finalizada_em timestamptz,
  cancelada_em timestamptz,
  cancelada_por uuid references public.perfis(id),
  motivo_cancelamento text,
  unique (empresa_id, numero)
);
create index vendas_empresa_data_idx on public.vendas(empresa_id, created_at desc);
create index vendas_status_idx on public.vendas(empresa_id, status);
create index vendas_sessao_idx on public.vendas(sessao_id);

create table public.venda_itens (
  id uuid primary key default gen_random_uuid(),
  venda_id uuid not null references public.vendas(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  produto_id uuid references public.produtos(id) on delete set null,
  item smallint not null,
  descricao text not null,
  unidade text not null default 'UN',
  quantidade numeric(14,3) not null check (quantidade > 0),
  preco_unitario numeric(12,2) not null,
  desconto numeric(12,2) not null default 0,
  total numeric(12,2) not null,
  observacao text
);
create index venda_itens_venda_idx on public.venda_itens(venda_id);
create index venda_itens_produto_idx on public.venda_itens(produto_id);

create table public.venda_pagamentos (
  id uuid primary key default gen_random_uuid(),
  venda_id uuid not null references public.vendas(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  forma public.forma_pagamento not null,
  valor numeric(12,2) not null check (valor > 0)
);
create index venda_pag_venda_idx on public.venda_pagamentos(venda_id);

-- ---------- Estoque ----------
create table public.estoque_movimentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete cascade,
  tipo public.tipo_mov_estoque not null,
  quantidade numeric(14,3) not null,
  saldo_anterior numeric(14,3) not null,
  saldo_posterior numeric(14,3) not null,
  motivo text,
  venda_id uuid references public.vendas(id) on delete set null,
  usuario_id uuid references public.perfis(id),
  created_at timestamptz not null default now()
);
create index estoque_mov_produto_idx on public.estoque_movimentos(produto_id, created_at desc);
create index estoque_mov_empresa_idx on public.estoque_movimentos(empresa_id, created_at desc);

-- ---------- Fiscal ----------
create table public.config_fiscal (
  empresa_id uuid primary key references public.empresas(id) on delete cascade,
  habilitado boolean not null default false,
  provedor text not null default 'focusnfe',
  ambiente text not null default 'homologacao' check (ambiente in ('homologacao','producao')),
  serie_nfce int not null default 1,
  serie_nfe int not null default 1,
  emitir_automatico boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Tokens do provedor: NUNCA legíveis pelo cliente (RLS sem políticas)
create table public.fiscal_credenciais (
  empresa_id uuid primary key references public.empresas(id) on delete cascade,
  token_homologacao text,
  token_producao text,
  updated_at timestamptz not null default now()
);

create table public.documentos_fiscais (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  venda_id uuid not null references public.vendas(id) on delete cascade,
  modelo text not null check (modelo in ('65','55')),
  referencia text not null unique,
  ambiente text not null,
  status public.status_doc_fiscal not null default 'processando',
  numero text, serie text, chave text, protocolo text,
  url_xml text, url_danfe text, qrcode_url text, url_consulta text,
  mensagem text,
  resposta jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index doc_fiscal_venda_idx on public.documentos_fiscais(venda_id);
create index doc_fiscal_empresa_idx on public.documentos_fiscais(empresa_id, created_at desc);

-- ---------- Auditoria ----------
create table public.auditoria (
  id bigint generated always as identity primary key,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  usuario_id uuid,
  acao text not null,
  entidade text,
  entidade_id text,
  detalhes jsonb,
  created_at timestamptz not null default now()
);
create index auditoria_empresa_idx on public.auditoria(empresa_id, created_at desc);

-- =====================================================================
-- Funções auxiliares (schema private — não exposto pela API)
-- =====================================================================
create or replace function private.empresa_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select p.empresa_id from public.perfis p where p.id = (select auth.uid()) and p.ativo
$$;

create or replace function private.papel()
returns public.papel_usuario language sql stable security definer set search_path = '' as $$
  select p.papel from public.perfis p where p.id = (select auth.uid()) and p.ativo
$$;

create or replace function private.tem_papel(papeis public.papel_usuario[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.perfis p
                 where p.id = (select auth.uid()) and p.ativo and p.papel = any(papeis))
$$;

create or replace function private.auditar(p_empresa uuid, p_acao text, p_entidade text, p_entidade_id text, p_detalhes jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.auditoria(empresa_id, usuario_id, acao, entidade, entidade_id, detalhes)
  values (p_empresa, (select auth.uid()), p_acao, p_entidade, p_entidade_id, p_detalhes)
$$;

revoke all on all functions in schema private from public, anon;
grant execute on function private.empresa_id(), private.papel(), private.tem_papel(public.papel_usuario[]) to authenticated;

-- updated_at genérico
create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger t_upd before update on public.empresas  for each row execute function private.set_updated_at();
create trigger t_upd before update on public.perfis    for each row execute function private.set_updated_at();
create trigger t_upd before update on public.produtos  for each row execute function private.set_updated_at();
create trigger t_upd before update on public.clientes  for each row execute function private.set_updated_at();
create trigger t_upd before update on public.config_fiscal for each row execute function private.set_updated_at();
create trigger t_upd before update on public.documentos_fiscais for each row execute function private.set_updated_at();

-- =====================================================================
-- RLS
-- =====================================================================
alter table public.empresas           enable row level security;
alter table public.perfis             enable row level security;
alter table public.categorias         enable row level security;
alter table public.produtos           enable row level security;
alter table public.clientes           enable row level security;
alter table public.caixa_sessoes      enable row level security;
alter table public.caixa_movimentos   enable row level security;
alter table public.vendas             enable row level security;
alter table public.venda_itens        enable row level security;
alter table public.venda_pagamentos   enable row level security;
alter table public.estoque_movimentos enable row level security;
alter table public.config_fiscal      enable row level security;
alter table public.fiscal_credenciais enable row level security;
alter table public.documentos_fiscais enable row level security;
alter table public.auditoria          enable row level security;

-- Anônimos não acessam nada
revoke all on all tables in schema public from anon;

-- Empresas
create policy empresa_ler on public.empresas for select to authenticated
  using (id = (select private.empresa_id()));
create policy empresa_editar on public.empresas for update to authenticated
  using (id = (select private.empresa_id()) and (select private.tem_papel('{admin}')))
  with check (id = (select private.empresa_id()));
revoke update on public.empresas from authenticated;
grant update (razao_social, nome_fantasia, cnpj, inscricao_estadual, segmento, telefone, email,
  cep, logradouro, numero, complemento, bairro, municipio, codigo_municipio, uf,
  regime_tributario, mensagem_cupom, desconto_maximo_caixa)
  on public.empresas to authenticated;

-- Perfis
create policy perfis_ler on public.perfis for select to authenticated
  using (empresa_id = (select private.empresa_id()));
create policy perfis_editar on public.perfis for update to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin}')))
  with check (empresa_id = (select private.empresa_id()));
revoke update on public.perfis from authenticated;
grant update (nome, papel, ativo) on public.perfis to authenticated;

-- Categorias e Produtos: todos leem, admin/gerente escrevem
create policy categorias_ler on public.categorias for select to authenticated
  using (empresa_id = (select private.empresa_id()));
create policy categorias_escrever on public.categorias for all to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')))
  with check (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

create policy produtos_ler on public.produtos for select to authenticated
  using (empresa_id = (select private.empresa_id()));
create policy produtos_inserir on public.produtos for insert to authenticated
  with check (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));
create policy produtos_editar on public.produtos for update to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')))
  with check (empresa_id = (select private.empresa_id()));
create policy produtos_excluir on public.produtos for delete to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin}')));
-- Estoque só muda por movimentação (função ajustar_estoque / vendas)
revoke update on public.produtos from authenticated;
grant update (categoria_id, codigo, codigo_barras, nome, unidade, preco_venda, preco_custo,
  controla_estoque, estoque_minimo, ncm, cest, cfop, csosn, origem, favorito, ativo)
  on public.produtos to authenticated;

-- Clientes: todos leem e cadastram; admin/gerente excluem
create policy clientes_ler on public.clientes for select to authenticated
  using (empresa_id = (select private.empresa_id()));
create policy clientes_inserir on public.clientes for insert to authenticated
  with check (empresa_id = (select private.empresa_id()));
create policy clientes_editar on public.clientes for update to authenticated
  using (empresa_id = (select private.empresa_id()))
  with check (empresa_id = (select private.empresa_id()));
create policy clientes_excluir on public.clientes for delete to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

-- Caixa: operador vê o próprio; admin/gerente veem todos. Escrita apenas via funções.
create policy caixa_ler on public.caixa_sessoes for select to authenticated
  using (empresa_id = (select private.empresa_id())
         and (operador_id = (select auth.uid()) or (select private.tem_papel('{admin,gerente}'))));
create policy caixa_mov_ler on public.caixa_movimentos for select to authenticated
  using (empresa_id = (select private.empresa_id()));

-- Vendas: leitura dentro da empresa. Escrita apenas via funções.
create policy vendas_ler on public.vendas for select to authenticated
  using (empresa_id = (select private.empresa_id()));
create policy venda_itens_ler on public.venda_itens for select to authenticated
  using (empresa_id = (select private.empresa_id()));
create policy venda_pag_ler on public.venda_pagamentos for select to authenticated
  using (empresa_id = (select private.empresa_id()));

-- Estoque: admin/gerente
create policy estoque_mov_ler on public.estoque_movimentos for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

-- Fiscal
create policy config_fiscal_ler on public.config_fiscal for select to authenticated
  using (empresa_id = (select private.empresa_id()));
create policy config_fiscal_editar on public.config_fiscal for update to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin}')))
  with check (empresa_id = (select private.empresa_id()));
revoke update on public.config_fiscal from authenticated;
grant update (habilitado, ambiente, serie_nfce, serie_nfe, emitir_automatico) on public.config_fiscal to authenticated;
create policy doc_fiscal_ler on public.documentos_fiscais for select to authenticated
  using (empresa_id = (select private.empresa_id()));
-- fiscal_credenciais: sem políticas => inacessível pela API
revoke all on public.fiscal_credenciais from authenticated;

-- Auditoria
create policy auditoria_ler on public.auditoria for select to authenticated
  using (empresa_id = (select private.empresa_id()) and (select private.tem_papel('{admin,gerente}')));

-- Tabelas escritas só por funções: remove privilégios diretos de escrita
revoke insert, update, delete on public.caixa_sessoes, public.caixa_movimentos,
  public.vendas, public.venda_itens, public.venda_pagamentos,
  public.estoque_movimentos, public.documentos_fiscais, public.auditoria
  from authenticated;
revoke insert, delete on public.empresas, public.perfis, public.config_fiscal from authenticated;
