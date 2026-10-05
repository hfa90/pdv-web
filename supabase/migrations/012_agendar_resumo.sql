-- =====================================================================
-- 012 · Agenda o envio do resumo diário por e-mail
-- De hora em hora o banco chama a Edge Function "resumo-diario", que envia o resumo
-- das lojas cujo horário chegou (cada loja recebe no máximo um por dia).
-- Requer: Edge Function resumo-diario publicada e os segredos RESEND_API_KEY / RESEND_FROM.
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'resumo-diario';

-- A chave "anon" é pública (a mesma de assets/config.js); a função só envia o que já estava pendente.
select cron.schedule('resumo-diario', '2 * * * *', $cron$
  select net.http_post(
    url := 'https://bcdoiaojhytxeoullskz.supabase.co/functions/v1/resumo-diario',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjZG9pYW9qaHl0eGVvdWxsc2t6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwNzk1OTEsImV4cCI6MjEwNjY1NTU5MX0.mL1Q86QquCI7FslgdcLNe8Iu9OpsGJb14DDZVVJn8Ng'),
    body := '{"acao":"cron"}'::jsonb,
    timeout_milliseconds := 60000)
$cron$);
