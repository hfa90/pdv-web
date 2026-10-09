// Backup: a parte que precisa da service role (logins do Supabase Auth).
// As regras e os dados ficam no banco (migração 021); aqui só:
//
//   recriar_usuarios {backup_id}  → antes de restaurar uma cópia, recria com o MESMO id os
//                                   logins da loja que não existem mais (ex.: loja excluída).
//                                   Senha aleatória: a pessoa usa "Esqueci a senha" ou o
//                                   administrador define uma nova em Usuários.
//   remover_usuarios {ids}        → apaga logins que ficaram sem loja depois de excluir lojas
//                                   (só se o banco não conseguiu apagar sozinho).
//
// Quem pode cada coisa é decidido pelo banco: a função chama as RPCs com o token de quem pediu
// (backup_usuarios_faltando / plataforma_usuarios_orfaos), que recusam quem não tem permissão.
//
// Publicar: supabase functions deploy backup
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, HttpError, json } from "../_shared/auth.ts";

const emailValido = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") throw new HttpError(405, "Método não permitido");
    const url = Deno.env.get("SUPABASE_URL")!;
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!/^Bearer\s+\S+/i.test(authHeader)) throw new HttpError(401, "Não autenticado");

    // Cliente com o token de quem chamou: as RPCs aplicam as regras de permissão do banco
    const usuario = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false }, global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));

    // ---------------- Recriar logins antes de restaurar ----------------
    if (body.acao === "recriar_usuarios") {
      if (!body.backup_id) throw new HttpError(400, "Informe o backup");
      const { data: faltando, error } = await usuario.rpc("backup_usuarios_faltando", { p_id: body.backup_id });
      if (error) throw new HttpError(403, error.message);
      const recriados: string[] = [];
      const trocados: { nome: string; email_original: string | null; email_novo: string }[] = [];
      for (const u of (faltando ?? []) as { id: string; email: string | null; nome: string | null }[]) {
        const original = String(u.email ?? "").trim().toLowerCase();
        const senha = crypto.randomUUID() + crypto.randomUUID();
        const tentar = (email: string) => admin.auth.admin.createUser({
          id: u.id, email, password: senha, email_confirm: true, user_metadata: { nome: u.nome ?? "", restaurado: true },
        });
        let email = emailValido(original) ? original : `restaurado.${u.id.slice(0, 8)}@restaurado.lispdv.com.br`;
        let { error: e1 } = await tentar(email);
        if (e1 && /already|registered|exists/i.test(e1.message)) {
          // O e-mail agora pertence a outra conta: recria com um e-mail provisório
          email = `restaurado.${u.id.slice(0, 8)}@restaurado.lispdv.com.br`;
          ({ error: e1 } = await tentar(email));
          if (!e1) trocados.push({ nome: u.nome ?? "", email_original: original || null, email_novo: email });
        }
        if (e1) throw new HttpError(400, `Não foi possível recriar o login de ${u.nome ?? u.id}: ${e1.message}`);
        recriados.push(u.id);
      }
      return json({ recriados, trocados });
    }

    // ---------------- Apagar logins que ficaram sem loja ----------------
    if (body.acao === "remover_usuarios") {
      const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 500) : [];
      if (!ids.length) return json({ removidos: 0 });
      const { data: orfaos, error } = await usuario.rpc("plataforma_usuarios_orfaos", { p_ids: ids });
      if (error) throw new HttpError(403, error.message);
      let removidos = 0;
      const falhas: string[] = [];
      for (const id of (orfaos ?? []) as string[]) {
        const { error: e } = await admin.auth.admin.deleteUser(id);
        if (e) falhas.push(`${id}: ${e.message}`); else removidos++;
      }
      return json({ removidos, falhas });
    }

    throw new HttpError(400, "Ação inválida");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : "Erro inesperado" }, status);
  }
});
