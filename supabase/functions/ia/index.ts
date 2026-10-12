// Chaves da inteligência artificial (migração 026). A chave só passa por aqui: é testada na Anthropic
// e gravada direto no banco pelo servidor; o navegador nunca consegue ler de volta (só os 4 últimos dígitos).
//
// Ações (POST, usuário logado):
//   { acao: "salvar_chave", escopo: "loja" | "plataforma", chave }  → testa e grava (loja: administrador; plataforma: superusuário)
//   { acao: "remover_chave", escopo: "plataforma" }                 → superusuário (a loja remove pela função ia_remover_chave)
//   { acao: "testar", escopo: "loja" | "plataforma" }               → confere se a chave guardada ainda funciona
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { autenticar, cors, HttpError, json, Perfil } from "../_shared/auth.ts";
import { testarChave } from "../_shared/ia.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") throw new HttpError(405, "Método não permitido");
    const body = await req.json().catch(() => ({}));
    const escopo = body.escopo === "plataforma" ? "plataforma" : "loja";
    let admin: SupabaseClient, perfil = null as unknown as Perfil;

    if (escopo === "plataforma") {
      // Superusuário: e-mail confirmado na equipe da plataforma com nível "super" (não precisa ter loja)
      admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!token) throw new HttpError(401, "Não autenticado");
      const { data: u } = await admin.auth.getUser(token);
      const email = u?.user?.email_confirmed_at ? String(u.user.email || "").toLowerCase() : "";
      const { data: eq } = email ? await admin.from("plataforma_admins").select("nivel, ativo").ilike("email", email.replace(/[\\%_]/g, (c) => "\\" + c)).maybeSingle() : { data: null };
      if (!eq?.ativo || eq.nivel !== "super") throw new HttpError(403, "Só o superusuário altera a IA do sistema");
    } else {
      ({ admin, perfil } = await autenticar(req));
      if (perfil.papel !== "admin") throw new HttpError(403, "Só o administrador da loja altera a chave da IA");
    }

    if (body.acao === "salvar_chave") {
      const chave = String(body.chave || "").trim();
      const t = await testarChave(chave);
      if (!t.ok) throw new HttpError(400, t.erro || "Chave inválida");
      const dados = { api_key: chave, chave_fim: chave.slice(-4), chave_validada_em: new Date().toISOString() };
      if (escopo === "plataforma") {
        const { error } = await admin.from("ia_plataforma").update({ ...dados, atualizado_em: new Date().toISOString() }).eq("id", true);
        if (error) throw error;
      } else {
        const { error } = await admin.from("ia_lojas").upsert({ empresa_id: perfil.empresa_id, ...dados, fonte: "propria", atualizado_em: new Date().toISOString() }, { onConflict: "empresa_id" });
        if (error) throw error;
        await admin.from("auditoria").insert({ empresa_id: perfil.empresa_id, usuario_id: perfil.id, acao: "ia.chave", entidade: "ia_lojas", entidade_id: perfil.empresa_id, detalhes: { fim: dados.chave_fim } });
      }
      return json({ ok: true, chave_fim: dados.chave_fim });
    }

    if (body.acao === "remover_chave" && escopo === "plataforma") {
      const { error } = await admin.from("ia_plataforma").update({ api_key: null, chave_fim: null, chave_validada_em: null, ativo: false, atualizado_em: new Date().toISOString() }).eq("id", true);
      if (error) throw error;
      return json({ ok: true });
    }

    if (body.acao === "testar") {
      const tabela = escopo === "plataforma" ? admin.from("ia_plataforma").select("api_key").eq("id", true) : admin.from("ia_lojas").select("api_key").eq("empresa_id", perfil.empresa_id);
      const { data } = await tabela.maybeSingle();
      if (!data?.api_key) throw new HttpError(400, "Nenhuma chave cadastrada");
      const t = await testarChave(data.api_key);
      if (t.ok) {
        const agora = new Date().toISOString();
        if (escopo === "plataforma") await admin.from("ia_plataforma").update({ chave_validada_em: agora }).eq("id", true);
        else await admin.from("ia_lojas").update({ chave_validada_em: agora }).eq("empresa_id", perfil.empresa_id);
      }
      return json(t);
    }
    throw new HttpError(400, "Ação inválida");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: (e as Error).message || "Erro inesperado" }, 500);
  }
});
