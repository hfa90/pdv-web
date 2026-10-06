-- =====================================================================
-- Nível de acesso "Cozinha": usuário que só enxerga a tela da cozinha (KDS).
-- Fica em arquivo separado porque um valor novo de enum só pode ser usado
-- depois que a transação que o criou termina (a 014 já usa 'cozinha').
-- =====================================================================
alter type public.papel_usuario add value if not exists 'cozinha';
