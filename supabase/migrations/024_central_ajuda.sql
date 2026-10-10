-- =====================================================================
-- 024 · Central de Ajuda
--
--   A Central de Ajuda (menu Ajuda / tecla F1) responde SEM IA: busca nos
--   artigos escritos pela equipe (app/js/ajuda/artigos.js). O banco só:
--     1. guarda os ANEXOS (print, foto, PDF) que a pessoa manda junto com o
--        pedido de ajuda — bucket privado "ajuda-anexos": cada pessoa grava
--        só na pasta dela e só a equipe de suporte (e o dono) consegue ver;
--     2. liga os anexos e o texto lido do print ao chamado (chamado_anexar);
--     3. registra o que as pessoas procuram (ajuda_buscas) para a equipe
--        saber o que falta explicar: buscas sem resultado e artigos que
--        "não ajudaram" (ajuda_relatorio, na Central de suporte).
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- ---------- 1. Anexos ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ajuda-anexos', 'ajuda-anexos', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists ajuda_anexos_enviar on storage.objects;
create policy ajuda_anexos_enviar on storage.objects for insert to authenticated
  with check (bucket_id = 'ajuda-anexos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists ajuda_anexos_ver on storage.objects;
create policy ajuda_anexos_ver on storage.objects for select to authenticated
  using (bucket_id = 'ajuda-anexos' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select private.eh_equipe())));
drop policy if exists ajuda_anexos_apagar on storage.objects;
create policy ajuda_anexos_apagar on storage.objects for delete to authenticated
  using (bucket_id = 'ajuda-anexos' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select private.eh_equipe())));

/** Liga os anexos (já enviados ao bucket) e o que a pessoa procurou ao chamado. */
create or replace function public.chamado_anexar(p_id uuid, p_segredo text, p_anexos jsonb default '[]'::jsonb, p_extra jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.suporte_chamados;
  v_uid uuid := (select auth.uid());
  v_lista jsonb := '[]'::jsonb;
  a jsonb;
  v_extra jsonb := '{}'::jsonb;
begin
  if v_uid is null then raise exception 'Entre no sistema para enviar anexos.'; end if;
  select * into r from public.suporte_chamados where id = p_id and segredo = p_segredo;
  if r.id is null then raise exception 'Chamado não encontrado.'; end if;
  if r.status not in ('aguardando', 'em_atendimento') then raise exception 'Este chamado já terminou. Abra um novo.'; end if;
  if jsonb_typeof(coalesce(p_anexos, '[]'::jsonb)) <> 'array' then raise exception 'Anexos inválidos.'; end if;
  for a in select value from jsonb_array_elements(coalesce(p_anexos, '[]'::jsonb)) limit 5 loop
    -- só arquivos da pasta da própria pessoa
    if coalesce(a->>'caminho', '') not like v_uid::text || '/%' or (a->>'caminho') like '%..%' then
      raise exception 'Anexo inválido.';
    end if;
    v_lista := v_lista || jsonb_build_array(jsonb_build_object(
      'caminho', left(a->>'caminho', 300), 'nome', left(coalesce(a->>'nome', 'arquivo'), 120),
      'tipo', left(coalesce(a->>'tipo', ''), 100), 'tamanho', case when (a->>'tamanho') ~ '^\d{1,12}$' then (a->>'tamanho')::bigint else 0 end));
  end loop;
  -- o que a pessoa procurou na Ajuda e o texto lido do print (ajuda o suporte a entender rápido)
  if jsonb_typeof(p_extra) = 'object' then
    v_extra := jsonb_strip_nulls(jsonb_build_object(
      'busca', left(p_extra->>'busca', 300),
      'texto_lido', left(p_extra->>'texto_lido', 2000),
      'problema_reconhecido', left(p_extra->>'problema_reconhecido', 120),
      'artigos_vistos', case when jsonb_typeof(p_extra->'artigos_vistos') = 'array' then p_extra->'artigos_vistos' end));
  end if;
  update public.suporte_chamados
     set info = coalesce(info, '{}'::jsonb) || v_extra
              || jsonb_build_object('anexos', coalesce(info->'anexos', '[]'::jsonb) || v_lista)
   where id = r.id;
  return jsonb_build_object('ok', true, 'anexos', jsonb_array_length(v_lista));
end $$;

-- ---------- 2. O que as pessoas procuram ----------
create table if not exists public.ajuda_buscas (
  id bigint generated always as identity primary key,
  empresa_id uuid references public.empresas(id) on delete cascade,
  usuario_id uuid,
  papel text,
  origem text not null default 'busca' check (origem in ('busca', 'anexo', 'artigo', 'tela')),
  termo text,
  resultados int,
  artigo text,
  util boolean,
  criado_em timestamptz not null default now()
);
create index if not exists ajuda_buscas_data_idx on public.ajuda_buscas(criado_em desc);
create index if not exists ajuda_buscas_usuario_idx on public.ajuda_buscas(usuario_id, criado_em desc);
alter table public.ajuda_buscas enable row level security;
revoke all on public.ajuda_buscas from anon, authenticated;

/** Registra uma busca, um artigo aberto ou o "isso ajudou?". Nunca atrapalha quem está usando. */
create or replace function public.ajuda_registrar(p_origem text default 'busca', p_termo text default null, p_resultados int default null,
  p_artigo text default null, p_util boolean default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then return; end if;
  if (select count(*) from public.ajuda_buscas where usuario_id = v_uid and criado_em > now() - interval '1 hour') >= 300 then return; end if;
  insert into public.ajuda_buscas(empresa_id, usuario_id, papel, origem, termo, resultados, artigo, util)
  values (private.empresa_id(), v_uid, private.papel(),
    case when p_origem in ('busca', 'anexo', 'artigo', 'tela') then p_origem else 'busca' end,
    left(nullif(trim(lower(coalesce(p_termo, ''))), ''), 200), p_resultados, left(p_artigo, 80), p_util);
  -- guarda só os últimos 12 meses
  if random() < 0.01 then delete from public.ajuda_buscas where criado_em < now() - interval '12 months'; end if;
end $$;

/** Relatório para a equipe: o que procuram e não acham, e o que não ajudou. */
create or replace function public.ajuda_relatorio(p_dias int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_desde timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_dias, 30), 365)));
begin
  if not private.eh_equipe() then raise exception 'Acesso restrito à equipe de suporte'; end if;
  return jsonb_build_object(
    'buscas', (select count(*) from public.ajuda_buscas where criado_em >= v_desde and origem in ('busca', 'anexo')),
    'sem_resultado_total', (select count(*) from public.ajuda_buscas where criado_em >= v_desde and origem in ('busca', 'anexo') and resultados = 0),
    'pessoas', (select count(distinct usuario_id) from public.ajuda_buscas where criado_em >= v_desde),
    'sem_resultado', coalesce((select jsonb_agg(x) from (
        select termo, count(*) as vezes, count(distinct empresa_id) as lojas, max(criado_em) as ultima
        from public.ajuda_buscas where criado_em >= v_desde and origem in ('busca', 'anexo') and resultados = 0 and termo is not null
        group by termo order by count(*) desc, max(criado_em) desc limit 40) x), '[]'::jsonb),
    'mais_buscados', coalesce((select jsonb_agg(x) from (
        select termo, count(*) as vezes from public.ajuda_buscas
        where criado_em >= v_desde and origem = 'busca' and termo is not null
        group by termo order by count(*) desc limit 30) x), '[]'::jsonb),
    'artigos', coalesce((select jsonb_agg(x) from (
        select artigo, count(*) filter (where origem in ('artigo', 'tela') and util is null) as aberturas,
          count(*) filter (where util) as ajudou, count(*) filter (where util = false) as nao_ajudou
        from public.ajuda_buscas where criado_em >= v_desde and artigo is not null
        group by artigo order by count(*) filter (where util = false) desc, count(*) desc limit 60) x), '[]'::jsonb),
    'por_papel', coalesce((select jsonb_object_agg(coalesce(papel, '?'), n) from (
        select papel, count(*) as n from public.ajuda_buscas where criado_em >= v_desde group by papel) x), '{}'::jsonb));
end $$;

-- ---------- Permissões ----------
revoke execute on function public.chamado_anexar(uuid, text, jsonb, jsonb), public.ajuda_registrar(text, text, int, text, boolean),
  public.ajuda_relatorio(int) from public, anon;
grant execute on function public.chamado_anexar(uuid, text, jsonb, jsonb), public.ajuda_registrar(text, text, int, text, boolean),
  public.ajuda_relatorio(int) to authenticated;

notify pgrst, 'reload schema';
