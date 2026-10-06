// Gestão de usuários da empresa (precisa da service role, por isso fica no servidor)
import { autenticar, auditar, cors, exigirPapel, HttpError, json } from "../_shared/auth.ts";

const PAPEIS = ["admin", "gerente", "caixa", "atendente", "cozinha"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") throw new HttpError(405, "Método não permitido");
    const { admin, perfil } = await autenticar(req);
    exigirPapel(perfil, ["admin", "gerente"]);
    const body = await req.json().catch(() => ({}));

    // Gerente só gerencia caixas, atendentes (garçons) e cozinha
    const podeGerir = (papel: string) => perfil.papel === "admin" || ["caixa", "atendente", "cozinha"].includes(papel);

    if (body.acao === "criar") {
      let email = String(body.email ?? "").trim().toLowerCase();
      let senha = String(body.senha ?? "");
      const nome = String(body.nome ?? "").trim();
      const papel = String(body.papel ?? "caixa");
      // Garçom pode ser criado sem e-mail: entra no app só com matrícula/CPF e senha numérica
      if (!email && papel === "atendente") {
        email = `garcom.${crypto.randomUUID().slice(0, 12)}.${perfil.empresa_id.slice(0, 8)}@app-garcom.lispdv.com.br`;
        senha = crypto.randomUUID() + crypto.randomUUID();
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "E-mail inválido");
      if (senha.length < 8) throw new HttpError(400, "A senha deve ter ao menos 8 caracteres");
      if (nome.length < 2) throw new HttpError(400, "Informe o nome");
      if (!PAPEIS.includes(papel)) throw new HttpError(400, "Nível de acesso inválido");
      if (!podeGerir(papel)) throw new HttpError(403, "Gerentes só podem criar caixas, garçons e cozinha");

      // Período de teste: até 3 usuários por loja
      const { data: emp } = await admin.from("empresas").select("status_conta").eq("id", perfil.empresa_id).single();
      if (emp?.status_conta !== "ativo") {
        const { count } = await admin.from("perfis").select("id", { count: "exact", head: true }).eq("empresa_id", perfil.empresa_id);
        if ((count ?? 0) >= 3) throw new HttpError(403, "No período de teste a loja pode ter até 3 usuários. Contrate um plano para liberar mais.");
      }

      const { data: criado, error } = await admin.auth.admin.createUser({
        email, password: senha, email_confirm: true, user_metadata: { nome },
      });
      if (error) {
        const msg = /already|registered|exists/i.test(error.message) ? "Este e-mail já está cadastrado" : error.message;
        throw new HttpError(400, msg);
      }
      const { error: e2 } = await admin.from("perfis").insert({
        id: criado.user.id, empresa_id: perfil.empresa_id, nome, papel,
        email: email.endsWith("@app-garcom.lispdv.com.br") ? null : email,
      });
      if (e2) {
        await admin.auth.admin.deleteUser(criado.user.id);
        throw new HttpError(500, "Não foi possível criar o perfil");
      }
      await auditar(admin, perfil, "usuario.criar", "perfis", criado.user.id, { nome, email, papel });
      return json({ id: criado.user.id });
    }

    if (body.acao === "redefinir_senha") {
      const senha = String(body.senha ?? "");
      if (senha.length < 8) throw new HttpError(400, "A senha deve ter ao menos 8 caracteres");
      const { data: alvo } = await admin.from("perfis").select("id, empresa_id, papel, nome")
        .eq("id", body.user_id).single();
      if (!alvo || alvo.empresa_id !== perfil.empresa_id) throw new HttpError(404, "Usuário não encontrado");
      if (!podeGerir(alvo.papel)) throw new HttpError(403, "Sem permissão para este usuário");
      const { error } = await admin.auth.admin.updateUserById(alvo.id, { password: senha });
      if (error) throw new HttpError(400, error.message);
      await auditar(admin, perfil, "usuario.senha", "perfis", alvo.id, { nome: alvo.nome });
      return json({ ok: true });
    }

    throw new HttpError(400, "Ação inválida");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : "Erro inesperado" }, status);
  }
});
