// Login do app do garçom: código da loja + matrícula ou CPF + senha numérica.
// A senha é conferida no banco (garcom_autenticar: bcrypt, 5 erros bloqueiam 15 min).
// Com a senha certa o servidor gera a sessão do usuário (link mágico verificado aqui
// mesmo, sem e-mail), então o garçom não precisa de e-mail nem de senha longa.
// Publicar SEM verificação de JWT: supabase functions deploy garcom-login --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json } from "../_shared/auth.ts";

// Freio simples por aparelho/IP (além do bloqueio por conta no banco)
const tentativas = new Map<string, { n: number; ate: number }>();
function frear(chave: string) {
  const agora = Date.now();
  const t = tentativas.get(chave);
  if (!t || t.ate < agora) { tentativas.set(chave, { n: 1, ate: agora + 10 * 60e3 }); return; }
  t.n++;
  if (t.n > 20) throw new Error("Muitas tentativas deste aparelho. Aguarde alguns minutos.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
    const body = await req.json().catch(() => ({}));
    const loja = String(body.loja ?? "").trim().toUpperCase();
    const login = String(body.login ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    const pin = String(body.pin ?? "");
    if (!/^[0-9A-Z]{4,12}$/.test(loja)) return json({ error: "Informe o código da loja" }, 400);
    if (!login || login.length > 14) return json({ error: "Informe a matrícula ou o CPF" }, 400);
    if (!/^[0-9]{6,12}$/.test(pin)) return json({ error: "A senha tem de 6 a 12 números" }, 400);
    try { frear((req.headers.get("x-forwarded-for") ?? "").split(",")[0] + ":" + loja); }
    catch (e) { return json({ error: (e as Error).message }, 429); }

    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: r, error } = await admin.rpc("garcom_autenticar", { p_codigo: loja, p_login: login, p_pin: pin });
    if (error) return json({ error: "Não foi possível entrar agora. Tente de novo." }, 500);
    if (!r?.ok) return json({ error: r?.erro ?? "Matrícula/CPF ou senha incorretos" }, 401);
    if (!r.email) return json({ error: "Usuário sem login configurado. Fale com o gerente." }, 400);

    // Gera e já consome um link mágico: devolve a sessão do garçom
    const { data: link, error: e1 } = await admin.auth.admin.generateLink({ type: "magiclink", email: r.email });
    if (e1 || !link?.properties?.hashed_token) return json({ error: "Não foi possível abrir a sessão" }, 500);
    const pub = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
    let { data: s, error: e2 } = await pub.auth.verifyOtp({ type: "email", token_hash: link.properties.hashed_token });
    if (e2 || !s?.session) ({ data: s, error: e2 } = await pub.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token }));
    if (e2 || !s?.session) return json({ error: "Não foi possível abrir a sessão" }, 500);

    return json({ access_token: s.session.access_token, refresh_token: s.session.refresh_token, nome: r.nome });
  } catch (e) {
    console.error(e);
    return json({ error: "Erro inesperado" }, 500);
  }
});
