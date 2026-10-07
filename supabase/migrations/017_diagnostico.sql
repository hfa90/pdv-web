-- =====================================================================
-- 017 · Diagnóstico
--   Os aparelhos enviam seus erros para cá (diagnostico_registrar).
--   O fornecedor vê os erros de todas as lojas e o gerente os da sua loja
--   (diagnostico_recentes), no painel Diagnóstico › Lojas.
--   diagnostico_servidor() devolve a hora do servidor e o que existe no banco,
--   para o check-up conferir o relógio do aparelho e as migrações aplicadas.
-- Pode rodar mais de uma vez.
-- =====================================================================

create table if not exists public.diagnostico_eventos (
  id bigint generated always as identity primary key,
  empresa_id uuid references public.empresas(id) on delete cascade,
  usuario_id uuid,
  aparelho text,
  aparelho_nome text,
  ocorrido_em timestamptz not null,
  recebido_em timestamptz not null default now(),
  problema text,          -- id do catálogo (app/js/diagnostico/catalogo.js), ex.: "rede-sem-internet"
  gravidade text,         -- critica | alta | media | baixa
  origem text,            -- js | banco | funcao | impressora | balanca | fila | rede | inicio ...
  mensagem text not null,
  vezes int not null default 1,
  rota text,
  versao_app text,
  navegador text,
  tecnico jsonb not null default '{}'::jsonb,
  trilha jsonb not null default '[]'::jsonb
);
create index if not exists diagnostico_eventos_emp_idx on public.diagnostico_eventos(empresa_id, recebido_em desc);
create index if not exists diagnostico_eventos_rec_idx on public.diagnostico_eventos(recebido_em desc);

alter table public.diagnostico_eventos enable row level security;
revoke all on public.diagnostico_eventos from anon, authenticated;
-- Leitura só pelas funções abaixo (security definer); gravação só por diagnostico_registrar.

/** Recebe até 30 eventos de um aparelho. Limite de 300 por usuário por hora. */
create or replace function public.diagnostico_registrar(p_eventos jsonb, p_aparelho text default null, p_aparelho_nome text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_emp uuid := private.empresa_id();
  v_n int := 0;
  e jsonb;
begin
  if v_uid is null then raise exception 'Não autenticado'; end if;
  if jsonb_typeof(p_eventos) <> 'array' then return 0; end if;
  if (select count(*) from public.diagnostico_eventos
       where usuario_id = v_uid and recebido_em > now() - interval '1 hour') > 300 then
    return 0; -- aparelho em loop de erro: não enche o banco
  end if;
  for e in select * from jsonb_array_elements(p_eventos) limit 30 loop
    insert into public.diagnostico_eventos(empresa_id, usuario_id, aparelho, aparelho_nome, ocorrido_em, problema, gravidade,
      origem, mensagem, vezes, rota, versao_app, navegador, tecnico, trilha)
    values (v_emp, v_uid, left(p_aparelho, 80), left(p_aparelho_nome, 80),
      least(coalesce((e->>'ocorrido_em')::timestamptz, now()), now() + interval '5 minutes'),
      left(e->>'problema', 60), left(e->>'gravidade', 10), left(e->>'origem', 20),
      left(coalesce(e->>'mensagem', '?'), 500), greatest(1, least(coalesce((e->>'vezes')::int, 1), 100000)),
      left(e->>'rota', 80), left(e->>'versao_app', 20), left(e->>'navegador', 40),
      case when octet_length(coalesce(e->'tecnico', '{}'::jsonb)::text) <= 8000 then coalesce(e->'tecnico', '{}'::jsonb) else '{"cortado":true}'::jsonb end,
      case when octet_length(coalesce(e->'trilha', '[]'::jsonb)::text) <= 4000 then coalesce(e->'trilha', '[]'::jsonb) else '[]'::jsonb end);
    v_n := v_n + 1;
  end loop;
  -- Faxina de vez em quando: guarda 45 dias
  if random() < 0.02 then
    delete from public.diagnostico_eventos where recebido_em < now() - interval '45 days';
  end if;
  return v_n;
end $$;

/** Erros recentes: fornecedor vê todas as lojas; admin/gerente vê a própria loja. */
create or replace function public.diagnostico_recentes(p_horas int default 24, p_empresa uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_plat boolean := private.eh_admin_plataforma();
  v_emp uuid := private.empresa_id();
begin
  if not v_plat and not private.tem_papel('{admin,gerente}') then raise exception 'Acesso restrito'; end if;
  return coalesce((
    select jsonb_agg(x order by x.ocorrido_em desc) from (
      select d.id, d.ocorrido_em, d.problema, d.gravidade, d.origem, d.mensagem, d.vezes, d.rota, d.versao_app, d.navegador,
             d.aparelho_nome, d.tecnico, d.trilha,
             coalesce(e.nome_fantasia, e.razao_social, 'Sem loja') as loja,
             p.nome as usuario
      from public.diagnostico_eventos d
      left join public.empresas e on e.id = d.empresa_id
      left join public.perfis p on p.id = d.usuario_id
      where d.recebido_em > now() - make_interval(hours => greatest(1, least(coalesce(p_horas, 24), 720)))
        and (case when v_plat then (p_empresa is null or d.empresa_id = p_empresa) else d.empresa_id = v_emp end)
      order by d.ocorrido_em desc
      limit 500
    ) x), '[]'::jsonb);
end $$;

/** Hora do servidor e nomes das funções/tabelas públicas (para o check-up). */
create or replace function public.diagnostico_servidor()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'agora', now(),
    'funcoes', (select coalesce(jsonb_agg(distinct p.proname), '[]'::jsonb) from pg_catalog.pg_proc p
                join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
    'tabelas', (select coalesce(jsonb_agg(c.relname), '[]'::jsonb) from pg_catalog.pg_class c
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v'))
  )
$$;

revoke execute on function public.diagnostico_registrar(jsonb, text, text), public.diagnostico_recentes(int, uuid), public.diagnostico_servidor() from public, anon;
grant execute on function public.diagnostico_registrar(jsonb, text, text), public.diagnostico_recentes(int, uuid), public.diagnostico_servidor() to authenticated;

notify pgrst, 'reload schema';
