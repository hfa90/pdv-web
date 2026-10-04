-- Painel do fornecedor: módulos (garçom/delivery) e cardápio de cada loja
create or replace function public.plataforma_lojas_modulos()
returns table (id uuid, modulos jsonb, delivery_ativo boolean, slug text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.eh_admin_plataforma() then raise exception 'Acesso restrito'; end if;
  return query select e.id, e.modulos, e.delivery_ativo, e.slug from public.empresas e;
end $$;
revoke execute on function public.plataforma_lojas_modulos() from public, anon;
grant execute on function public.plataforma_lojas_modulos() to authenticated;
