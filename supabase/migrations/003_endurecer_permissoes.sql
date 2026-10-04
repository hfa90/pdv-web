revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
comment on table public.fiscal_credenciais is 'Tokens do provedor fiscal. Sem políticas RLS de propósito: acessível apenas pela Edge Function (service role).';
