-- =====================================================================
-- 022 · Excluir usuários (só o superusuário)
--
--   O superusuário pode excluir qualquer usuário de qualquer loja, inclusive
--   administradores. Ninguém mais exclui: o administrador da loja continua
--   só bloqueando o acesso (Usuários › Acesso liberado).
--
--   Como funciona:
--     - o LOGIN é apagado (a pessoa não entra mais em lugar nenhum);
--     - se a pessoa nunca vendeu/abriu caixa, o perfil some de vez;
--     - se tem histórico (vendas, caixa, estoque…), o perfil fica só como
--       nome no histórico, marcado "excluído" (excluido_em) — os relatórios
--       continuam mostrando quem fez cada venda;
--     - antes, o banco guarda um backup da loja (dá para desfazer em Backup).
--   Nunca exclui o próprio superusuário nem membros da equipe da plataforma.
--
--   Para isso perfis deixa de ter FK para auth.users (o perfil de quem foi
--   excluído precisa continuar existindo sem login). Um gatilho em auth.users
--   faz a limpeza quando um login é apagado por qualquer caminho (inclusive
--   pelo painel do Supabase).
--
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

alter table public.perfis add column if not exists excluido_em timestamptz;
alter table public.perfis add column if not exists excluido_por text;
create index if not exists perfis_excluido_idx on public.perfis(empresa_id) where excluido_em is null;

-- O perfil de quem foi excluído fica como histórico, sem login
alter table public.perfis drop constraint if exists perfis_id_fkey;

-- Proteções do perfil: a exclusão feita pelo superusuário passa (inclusive do último administrador)
create or replace function private.perfil_proteger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('lis.exclusao_super', true), '') = 'on' then return new; end if;
  if new.empresa_id <> old.empresa_id then raise exception 'Operação não permitida'; end if;
  if old.excluido_em is not null then raise exception 'Este usuário foi excluído'; end if;
  if auth.uid() is not null and new.id = auth.uid() and (new.papel <> old.papel or not new.ativo) then
    raise exception 'Você não pode alterar seu próprio nível de acesso';
  end if;
  if old.papel = 'admin' and old.ativo and (new.papel <> 'admin' or not new.ativo) and not exists (
    select 1 from public.perfis where empresa_id = old.empresa_id and papel = 'admin' and ativo and id <> old.id) then
    raise exception 'A empresa precisa de ao menos um administrador ativo';
  end if;
  if new.papel <> old.papel or new.ativo <> old.ativo then
    perform private.auditar(new.empresa_id, 'usuario.alterar', 'perfis', new.id::text,
      jsonb_build_object('nome', new.nome, 'papel', new.papel, 'ativo', new.ativo));
  end if;
  return new;
end $$;

/** Tira do perfil tudo o que dá acesso (aparelhos, matrícula do garçom, senha de aprovação). */
create or replace function private.perfil_tirar_acessos(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.dispositivos where usuario_id = p_id;
  delete from public.garcom_acesso where perfil_id = p_id;
  delete from public.senhas_aprovacao where perfil_id = p_id;
end $$;

/**
 * Apaga o perfil; se ele tem histórico (vendas, caixa…), marca como excluído.
 * Devolve 'apagado' ou 'historico'.
 */
create or replace function private.perfil_excluir(p_id uuid, p_por text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('lis.exclusao_super', 'on', true);
  begin
    delete from public.perfis where id = p_id;
    perform set_config('lis.exclusao_super', '', true);
    return 'apagado';
  exception when foreign_key_violation then
    perform private.perfil_tirar_acessos(p_id);
    update public.perfis set ativo = false, excluido_em = coalesce(excluido_em, now()), excluido_por = coalesce(excluido_por, p_por)
     where id = p_id;
    perform set_config('lis.exclusao_super', '', true);
    return 'historico';
  end;
end $$;

-- Login apagado por qualquer caminho (painel do Supabase, Edge Function…): limpa o perfil
create or replace function private.trg_login_apagado()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.perfis where id = old.id and excluido_em is null) then
    perform private.perfil_excluir(old.id, 'Login apagado');
  end if;
  return old;
end $$;
drop trigger if exists t_lis_login_apagado on auth.users;
create trigger t_lis_login_apagado after delete on auth.users
  for each row execute function private.trg_login_apagado();

-- ---------------------------------------------------------------------
-- Superusuário: usuários de uma loja e exclusão
-- ---------------------------------------------------------------------
create or replace function public.plataforma_usuarios_loja(p_empresa uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'nome', p.nome, 'email', coalesce(u.email, p.email), 'papel', p.papel, 'ativo', p.ativo,
      'created_at', p.created_at, 'ultimo_acesso', u.last_sign_in_at, 'excluido_em', p.excluido_em, 'excluido_por', p.excluido_por,
      'eu', p.id = (select auth.uid()),
      'equipe', exists (select 1 from public.plataforma_admins a where lower(a.email) = lower(u.email)))
    order by p.excluido_em nulls first, p.ativo desc, p.nome), '[]'::jsonb)
    from public.perfis p left join auth.users u on u.id = p.id
    where p.empresa_id = p_empresa);
end $$;

/** Exclui um usuário (só superusuário). Digite EXCLUIR para confirmar. */
create or replace function public.plataforma_excluir_usuario(p_id uuid, p_confirmacao text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.perfis; v_email text; v_bk uuid; v_modo text := 'sem_perfil'; v_quem text := private.quem(); v_sem_admin boolean := false;
begin
  if not private.eh_admin_plataforma() then raise exception 'Só o superusuário pode excluir usuários'; end if;
  if coalesce(upper(trim(p_confirmacao)), '') <> 'EXCLUIR' then raise exception 'Digite EXCLUIR para confirmar'; end if;
  if p_id = (select auth.uid()) then raise exception 'Você não pode excluir o seu próprio usuário'; end if;
  select * into p from public.perfis where id = p_id;
  select u.email into v_email from auth.users u where u.id = p_id;
  if p.id is null and v_email is null then raise exception 'Usuário não encontrado'; end if;
  if p.excluido_em is not null and v_email is null then raise exception 'Este usuário já foi excluído'; end if;
  if v_email is not null and exists (select 1 from public.plataforma_admins a where lower(a.email) = lower(v_email)) then
    raise exception 'Este usuário é da equipe da plataforma. Tire-o da equipe (Central de suporte › Equipe) antes de excluir.';
  end if;

  if p.id is not null then
    -- Cópia da loja antes (dá para desfazer em Backup)
    v_bk := private.backup_gravar(p.empresa_id, 'manual', 'Antes de excluir o usuário ' || p.nome, v_quem);
    v_modo := private.perfil_excluir(p_id, v_quem);
    v_sem_admin := not exists (select 1 from public.perfis x where x.empresa_id = p.empresa_id and x.papel = 'admin' and x.ativo and x.excluido_em is null);
  end if;
  delete from auth.users where id = p_id;   -- login, sessões e identidades

  if p.id is not null then
    perform private.auditar(p.empresa_id, 'usuario.excluir', 'perfis', p_id::text,
      jsonb_build_object('nome', p.nome, 'papel', p.papel, 'email', v_email, 'modo', v_modo, 'motivo', p_motivo, 'backup', v_bk));
  end if;
  perform private.log_super('usuario.excluir', p.empresa_id,
    jsonb_build_object('usuario', p_id, 'nome', p.nome, 'papel', p.papel, 'email', v_email, 'modo', v_modo, 'motivo', p_motivo, 'backup', v_bk));
  return jsonb_build_object('modo', v_modo, 'backup', v_bk, 'loja_sem_admin', v_sem_admin, 'nome', p.nome);
end $$;

-- ---------------------------------------------------------------------
-- Backup: perfis excluídos não precisam de login para restaurar; a cópia
-- feita antes de excluir não trava o "Fazer backup agora"
-- ---------------------------------------------------------------------
create or replace function public.backup_criar(p_empresa uuid default null, p_obs text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := coalesce(p_empresa, private.empresa_id()); v_id uuid; b public.backups;
begin
  if not private.backup_pode(v_emp, 'manual') then raise exception 'Você não tem permissão para fazer backup desta loja'; end if;
  if exists (select 1 from public.backups where empresa_id = v_emp and tipo = 'manual' and created_at > now() - interval '1 minute'
             and coalesce(observacao, '') not like 'Antes de excluir%') then
    raise exception 'Um backup acabou de ser feito. Aguarde um minuto para fazer outro.';
  end if;
  v_id := private.backup_gravar(v_emp, 'manual', p_obs, private.quem());
  perform private.auditar_seguro(v_emp, 'backup.criar', v_id::text, jsonb_build_object('observacao', p_obs));
  if private.eh_admin_plataforma() and v_emp is distinct from private.empresa_id() then
    perform private.log_super('backup.criar', v_emp, jsonb_build_object('backup', v_id));
  end if;
  select * into b from public.backups where id = v_id;
  return private.backup_meta(b);
end $$;

create or replace function public.backup_importar(p_dados jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid; v_id uuid; b public.backups; v_falta int;
begin
  if coalesce(p_dados->>'formato', '') <> 'lis-pdv-backup' or jsonb_typeof(p_dados->'tabelas') <> 'object'
     or jsonb_typeof(p_dados->'empresa') <> 'object' then
    raise exception 'Arquivo inválido: não é um backup do sistema';
  end if;
  v_emp := (p_dados->'empresa'->>'id')::uuid;
  if v_emp is null or v_emp::text <> coalesce(p_dados->>'empresa_id', v_emp::text) then raise exception 'Arquivo de backup corrompido'; end if;
  if not private.eh_admin_plataforma() then
    if v_emp is distinct from private.empresa_id() then raise exception 'Este arquivo é de outra loja. Só é possível importar backups da sua própria loja.'; end if;
    if not private.backup_pode(v_emp, 'restaurar') then raise exception 'Só o administrador da loja importa backups'; end if;
  end if;
  insert into public.backups (empresa_id, loja, tipo, criado_por, observacao, tabelas, registros, tamanho_bytes, dados)
  values (v_emp, coalesce(p_dados->>'loja', p_dados->'empresa'->>'nome_fantasia', p_dados->'empresa'->>'razao_social'), 'importado',
          private.quem(), 'Arquivo de ' || coalesce(to_char((p_dados->>'gerado_em')::timestamptz at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), '?'),
          (select count(*) from jsonb_object_keys(p_dados->'tabelas')), (p_dados->>'contagem')::int, octet_length(p_dados::text), p_dados)
  returning id into v_id;
  select count(*) into v_falta from jsonb_array_elements(coalesce(p_dados->'tabelas'->'perfis', '[]'::jsonb)) x
   where x->>'excluido_em' is null and not exists (select 1 from auth.users u where u.id = (x->>'id')::uuid);
  perform private.auditar_seguro(v_emp, 'backup.importar', v_id::text, '{}'::jsonb);
  if private.eh_admin_plataforma() then perform private.log_super('backup.importar', v_emp, jsonb_build_object('backup', v_id)); end if;
  select * into b from public.backups where id = v_id;
  return private.backup_meta(b) || jsonb_build_object('loja_existe', exists (select 1 from public.empresas where id = v_emp), 'usuarios_faltando', v_falta);
end $$;

create or replace function public.backup_usuarios_faltando(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b public.backups;
begin
  select * into b from public.backups where id = p_id;
  if not found then raise exception 'Backup não encontrado'; end if;
  if not private.backup_pode(b.empresa_id, 'restaurar') then raise exception 'Só o administrador da loja restaura backups'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', x->>'id', 'nome', x->>'nome', 'papel', x->>'papel',
            'email', (select u->>'email' from jsonb_array_elements(coalesce(b.dados->'usuarios', '[]'::jsonb)) u where u->>'id' = x->>'id' limit 1))), '[]'::jsonb)
          from jsonb_array_elements(coalesce(b.dados->'tabelas'->'perfis', '[]'::jsonb)) x
          where x->>'excluido_em' is null and not exists (select 1 from auth.users au where au.id = (x->>'id')::uuid));
end $$;

create or replace function public.backup_restaurar(p_id uuid, p_reativar boolean default false, p_recriados uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.backups; v jsonb; v_emp uuid; v_super boolean := private.eh_admin_plataforma(); v_existe boolean;
  v_tabs text[]; t text; i int; v_cols text; v_chaves text[]; v_n bigint; v_total bigint := 0; v_seg uuid; v_falta int;
  v_modo text := 'replica'; v_linhas jsonb; v_ident record; v_bloq text[];
begin
  select * into b from public.backups where id = p_id;
  if not found then raise exception 'Backup não encontrado'; end if;
  v := b.dados; v_emp := b.empresa_id;
  if coalesce(v->>'formato', '') <> 'lis-pdv-backup' then raise exception 'Backup inválido'; end if;
  v_existe := exists (select 1 from public.empresas where id = v_emp);
  if not v_super and (not v_existe or not private.backup_pode(v_emp, 'restaurar')) then
    raise exception 'Só o administrador da loja restaura backups';
  end if;

  select count(*) into v_falta from jsonb_array_elements(coalesce(v->'tabelas'->'perfis', '[]'::jsonb)) x
   where x->>'excluido_em' is null and not exists (select 1 from auth.users u where u.id = (x->>'id')::uuid);
  if v_falta > 0 then
    raise exception 'FALTAM_USUARIOS: % login(s) deste backup não existem mais e precisam ser recriados antes de restaurar.', v_falta;
  end if;

  -- Cópia de segurança do estado atual (dá para desfazer a restauração)
  if v_existe then
    v_seg := private.backup_gravar(v_emp, 'antes_restauracao',
      'Antes de restaurar o backup de ' || to_char(b.created_at at time zone private.fuso_loja(v_emp), 'DD/MM/YYYY HH24:MI'), private.quem());
  end if;

  -- Gatilhos desligados durante a restauração (senão o estoque seria baixado de novo, vendas bloqueadas etc.)
  v_tabs := private.backup_tabelas(v_super);
  begin
    perform set_config('session_replication_role', 'replica', true);
  exception when others then v_modo := 'alter';
  end;
  if v_modo = 'alter' then
    foreach t in array v_tabs || array['empresas'] loop
      execute format('alter table public.%I disable trigger user', t);
    end loop;
  end if;

  -- Apaga os dados atuais da loja (ordem inversa das dependências)
  for i in reverse cardinality(v_tabs)..1 loop
    execute format('delete from public.%I where empresa_id = $1', v_tabs[i]) using v_emp;
  end loop;

  -- A loja
  v_bloq := case when v_super then array['id'] else private.backup_colunas_comerciais() end;
  select string_agg(format('%1$I = r.%1$I', a.attname), ', ') into v_cols
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.empresas'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     and a.attname::text <> all (v_bloq) and (v->'empresa') ? a.attname::text;
  if v_existe then
    if v_cols is not null then
      execute format('update public.empresas e set %s from jsonb_populate_record(null::public.empresas, $1) r where e.id = $2', v_cols)
        using v->'empresa', v_emp;
    end if;
  else
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.empresas'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and (v->'empresa') ? a.attname::text;
    execute format('insert into public.empresas (%1$s) select %1$s from jsonb_populate_record(null::public.empresas, $1)', v_cols)
      using v->'empresa';
    insert into public.backup_config (empresa_id) values (v_emp) on conflict do nothing;
    perform private.backup_reagendar(v_emp);
  end if;

  -- As tabelas, na ordem das dependências
  foreach t in array v_tabs loop
    v_linhas := v->'tabelas'->t;
    continue when v_linhas is null or jsonb_typeof(v_linhas) <> 'array' or jsonb_array_length(v_linhas) = 0;
    select array_agg(k) into v_chaves from jsonb_object_keys(v_linhas->0) k;
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_catalog.pg_attribute a
     where a.attrelid = format('public.%I', t)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and a.attname::text = any (v_chaves);
    continue when v_cols is null;
    execute format('insert into public.%1$I (%2$s) overriding system value select %2$s from jsonb_populate_recordset(null::public.%1$I, $1) where empresa_id = $2 on conflict do nothing', t, v_cols)
      using v_linhas, v_emp;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    -- Contadores automáticos (identity) continuam depois do maior número restaurado
    for v_ident in select a.attname from pg_catalog.pg_attribute a
                    where a.attrelid = format('public.%I', t)::regclass and a.attidentity <> '' and not a.attisdropped loop
      execute format('select setval(pg_get_serial_sequence(%L, %L), greatest((select coalesce(max(%I), 0) from public.%I), (select last_value from %s)))',
        'public.' || t, v_ident.attname, v_ident.attname, t, pg_get_serial_sequence('public.' || t, v_ident.attname));
    end loop;
  end loop;

  -- Logins recriados: desativados até o administrador conferir (a não ser que peça para reativar)
  if cardinality(p_recriados) > 0 then
    update public.perfis set ativo = coalesce(p_reativar, false) where empresa_id = v_emp and id = any (p_recriados);
  end if;

  if v_modo = 'alter' then
    foreach t in array v_tabs || array['empresas'] loop
      execute format('alter table public.%I enable trigger user', t);
    end loop;
  else
    perform set_config('session_replication_role', 'origin', true);
  end if;

  update public.backups set restaurado_em = now() where id = p_id;
  perform private.auditar_seguro(v_emp, 'backup.restaurar', b.id::text,
    jsonb_build_object('backup_de', b.created_at, 'tipo', b.tipo, 'registros', v_total, 'copia_seguranca', v_seg));
  if v_super then
    perform private.log_super('backup.restaurar', v_emp, jsonb_build_object('backup', b.id, 'backup_de', b.created_at, 'registros', v_total, 'loja_recriada', not v_existe));
  end if;
  return jsonb_build_object('registros', v_total, 'copia_seguranca', v_seg, 'loja_recriada', not v_existe, 'modo', v_modo);
end $$;

revoke execute on function public.plataforma_usuarios_loja(uuid), public.plataforma_excluir_usuario(uuid, text, text) from public, anon;
grant execute on function public.plataforma_usuarios_loja(uuid), public.plataforma_excluir_usuario(uuid, text, text) to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.empresa_id(), private.papel(), private.tem_papel(public.papel_usuario[]),
  private.eh_admin_plataforma(), private.licenca_ok(uuid, text) to authenticated;

notify pgrst, 'reload schema';
