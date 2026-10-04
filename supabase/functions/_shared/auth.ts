import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Perfil = { id: string; empresa_id: string; nome: string; papel: string; ativo: boolean };

/** Valida o JWT do chamador e devolve o perfil + cliente administrativo. */
export async function autenticar(req: Request): Promise<{ admin: SupabaseClient; perfil: Perfil }> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Não autenticado");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: u, error } = await admin.auth.getUser(token);
  if (error || !u?.user) throw new HttpError(401, "Sessão inválida");

  const { data: perfil } = await admin.from("perfis").select("*").eq("id", u.user.id).single();
  if (!perfil || !perfil.ativo) throw new HttpError(403, "Usuário sem acesso");
  return { admin, perfil };
}

export function exigirPapel(perfil: Perfil, papeis: string[]) {
  if (!papeis.includes(perfil.papel)) throw new HttpError(403, "Sem permissão para esta ação");
}

export async function auditar(admin: SupabaseClient, perfil: Perfil, acao: string, entidade: string, entidade_id: string, detalhes: unknown) {
  await admin.from("auditoria").insert({
    empresa_id: perfil.empresa_id, usuario_id: perfil.id, acao, entidade, entidade_id, detalhes,
  });
}
