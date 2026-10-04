// Captação de leads e liberação do teste grátis com proteção contra contas falsas.
//
// Ações:
//   contato   (público)  → registra interesse (lead) vindo do site
//   verificar (público)  → registra o lead e diz se o teste está disponível ANTES de criar a conta
//   iniciar   (logado)   → confere tudo de novo no servidor e cria a loja de teste
//
// Uma loja só ganha teste se NENHUM destes já tiver sido usado:
//   CPF/CNPJ · WhatsApp · e-mail normalizado · identificador do aparelho
// e se o mesmo IP não tiver aberto 2+ testes nos últimos 30 dias (ou 1 com a mesma impressão do navegador).
// A mensagem de recusa é propositalmente genérica: não ensina qual regra foi acionada.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
class Erro extends Error { constructor(public status: number, m: string) { super(m); } }

const RECUSA = "Este negócio já utilizou o período de teste grátis. Fale com a nossa equipe: podemos estender seu teste ou montar uma proposta.";

// Domínios de e-mail descartável mais usados para burlar testes
const DESCARTAVEIS = new Set([
  "mailinator.com","yopmail.com","yopmail.net","guerrillamail.com","guerrillamail.net","sharklasers.com","10minutemail.com",
  "10minutemail.net","tempmail.com","temp-mail.org","temp-mail.io","tempmail.net","tempmailo.com","dispostable.com",
  "getnada.com","nada.email","trashmail.com","trashmail.de","maildrop.cc","mintemail.com","throwawaymail.com","fakeinbox.com",
  "mohmal.com","emailondeck.com","mailnesia.com","mytemp.email","tempail.com","tmail.ws","moakt.com","burnermail.io",
  "mail.tm","mailpoof.com","inboxkitten.com","spamgourmet.com","33mail.com","emailfake.com","fakemail.net","tempr.email",
  "discard.email","mailcatch.com","spambox.us","tmpmail.org","tmpmail.net","linshiyouxiang.net","1secmail.com","1secmail.org",
  "1secmail.net","esiix.com","wwjmp.com","xojxe.com","yoggm.com","rteet.com","dpptd.com","kzccv.com","qiott.com","vjuum.com",
  "laafd.com","txcct.com","emltmp.com","minuteinbox.com","luxusmail.org","tempinbox.com","crazymailing.com","harakirimail.com",
]);

const digitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");

function cpfValido(c: string) {
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0; for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}
function cnpjValido(c: string) {
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (n: number) => {
    const p = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const r = p.reduce((a, w, i) => a + Number(c[i]) * w, 0) % 11; return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

function whatsappNormalizado(v: unknown) {
  let d = digitos(v);
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 11 && d.length !== 10) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  if (d.length === 11 && d[2] !== "9") return null;
  if (/^(\d)\1+$/.test(d.slice(2))) return null;
  return d;
}

function emailNormalizado(v: unknown) {
  const e = String(v ?? "").trim().toLowerCase();
  const m = e.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!m) return null;
  let [, local, dominio] = m;
  local = local.split("+")[0];
  if (dominio === "googlemail.com") dominio = "gmail.com";
  if (dominio === "gmail.com") local = local.replace(/\./g, "");
  return { normalizado: `${local}@${dominio}`, dominio };
}

const texto = (v: unknown, max = 120) => String(v ?? "").trim().slice(0, max);
const ipDe = (req: Request) =>
  (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || req.headers.get("x-real-ip") || "").trim();

type Dados = {
  nome: string; loja: string; segmento: string; whatsapp: string | null; email: ReturnType<typeof emailNormalizado>;
  emailOriginal: string; documento: string; dispositivo: string; impressao: string; interesse: string; mensagem: string; cidade: string;
};

function ler(b: any): Dados {
  return {
    nome: texto(b.nome, 80), loja: texto(b.loja, 100), segmento: texto(b.segmento, 30),
    whatsapp: whatsappNormalizado(b.whatsapp), email: emailNormalizado(b.email), emailOriginal: texto(b.email, 120).toLowerCase(),
    documento: digitos(b.documento), dispositivo: texto(b.dispositivo, 64), impressao: texto(b.impressao, 64),
    interesse: texto(b.interesse, 120), mensagem: texto(b.mensagem, 600), cidade: texto(b.cidade, 80),
  };
}

function validarCampos(d: Dados, exigirTudo: boolean) {
  if (d.nome.length < 2) throw new Erro(400, "Informe seu nome");
  if (!d.whatsapp) throw new Erro(400, "Informe um WhatsApp válido com DDD");
  if (exigirTudo) {
    if (d.loja.length < 2) throw new Erro(400, "Informe o nome da loja");
    if (!d.email) throw new Erro(400, "Informe um e-mail válido");
    if (!(cpfValido(d.documento) || cnpjValido(d.documento))) throw new Erro(400, "Informe um CPF ou CNPJ válido");
    if (DESCARTAVEIS.has(d.email.dominio)) throw new Erro(400, "Use um e-mail permanente (e-mails temporários não são aceitos)");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(d.dispositivo)) throw new Erro(400, "Não foi possível identificar o navegador. Atualize a página e tente de novo.");
  }
}

async function testeDisponivel(admin: any, d: Dados, ip: string): Promise<boolean> {
  const conds = [
    `documento.eq.${d.documento}`, `whatsapp.eq.${d.whatsapp}`,
    `email_normalizado.eq."${d.email!.normalizado.replace(/["\\]/g, "")}"`, `dispositivo.eq.${d.dispositivo}`,
  ];
  const { data: usados } = await admin.from("testes_gratis").select("id").or(conds.join(",")).limit(1);
  if (usados?.length) return false;
  if (ip) {
    const desde = new Date(Date.now() - 30 * 864e5).toISOString();
    const { data: porIp } = await admin.from("testes_gratis").select("impressao").eq("ip", ip).gte("created_at", desde);
    if ((porIp?.length ?? 0) >= 2) return false;
    if (d.impressao && porIp?.some((t: any) => t.impressao === d.impressao)) return false;
  }
  return true;
}

async function limitarPorIp(admin: any, ip: string) {
  if (!ip) return;
  const desde = new Date(Date.now() - 3600e3).toISOString();
  const { count } = await admin.from("leads").select("id", { count: "exact", head: true }).eq("ip", ip).gte("created_at", desde);
  if ((count ?? 0) >= 8) throw new Erro(429, "Muitas tentativas. Aguarde alguns minutos ou fale com a gente pelo WhatsApp.");
}

async function registrarLead(admin: any, d: Dados, ip: string, origem: string, empresa_id: string | null = null) {
  // Evita duplicar o mesmo contato no mesmo dia: atualiza em vez de inserir
  const hoje = new Date(Date.now() - 864e5).toISOString();
  const { data: existente } = await admin.from("leads").select("id").eq("whatsapp", d.whatsapp).gte("created_at", hoje).limit(1).maybeSingle();
  const linha = {
    nome: d.nome, loja: d.loja || null, segmento: d.segmento || null, whatsapp: d.whatsapp,
    email: d.emailOriginal || null, documento: d.documento || null, cidade: d.cidade || null,
    interesse: d.interesse || null, mensagem: d.mensagem || null, origem, ip: ip || null,
    ...(empresa_id ? { empresa_id } : {}),
  };
  if (existente) await admin.from("leads").update(linha).eq("id", existente.id);
  else await admin.from("leads").insert(linha);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") throw new Erro(405, "Método não permitido");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const ip = ipDe(req);

    // Armadilha para robôs: campo invisível no formulário
    if (body.site) return json({ ok: true, disponivel: true });

    if (body.acao === "contato") {
      const d = ler(body);
      validarCampos(d, false);
      await limitarPorIp(admin, ip);
      await registrarLead(admin, d, ip, "site");
      return json({ ok: true });
    }

    if (body.acao === "verificar") {
      const d = ler(body);
      validarCampos(d, true);
      await limitarPorIp(admin, ip);
      const ok = await testeDisponivel(admin, d, ip);
      await registrarLead(admin, d, ip, ok ? "teste" : "teste_bloqueado");
      return json({ ok: true, disponivel: ok, mensagem: ok ? null : RECUSA });
    }

    if (body.acao === "iniciar") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: u } = await admin.auth.getUser(token);
      const user = u?.user;
      if (!user) throw new Erro(401, "Entre na sua conta para iniciar o teste");
      if (!user.email_confirmed_at) throw new Erro(403, "Confirme seu e-mail antes de iniciar o teste");

      const { data: perfil } = await admin.from("perfis").select("empresa_id").eq("id", user.id).maybeSingle();
      if (perfil) return json({ ok: true, empresa_id: perfil.empresa_id });

      const d = ler({ ...user.user_metadata, ...body, email: user.email });
      validarCampos(d, true);

      if (!(await testeDisponivel(admin, d, ip))) {
        await registrarLead(admin, d, ip, "teste_bloqueado");
        throw new Erro(409, RECUSA);
      }

      // Reserva o teste (os índices únicos são a última barreira contra cadastros simultâneos)
      const { data: reserva, error: eRes } = await admin.from("testes_gratis").insert({
        documento: d.documento, whatsapp: d.whatsapp, email_normalizado: d.email!.normalizado,
        dispositivo: d.dispositivo, impressao: d.impressao || null, ip: ip || null, user_id: user.id,
      }).select("id").single();
      if (eRes) {
        await registrarLead(admin, d, ip, "teste_bloqueado");
        throw new Erro(409, RECUSA);
      }

      const { data: empresa_id, error } = await admin.rpc("criar_empresa_teste", {
        p_user: user.id, p_razao_social: d.loja, p_nome_fantasia: d.loja, p_documento: d.documento,
        p_segmento: d.segmento || "padaria", p_nome_usuario: d.nome, p_whatsapp: d.whatsapp,
      });
      if (error) {
        await admin.from("testes_gratis").delete().eq("id", reserva.id);
        throw new Erro(500, "Não foi possível criar a loja de teste. Tente novamente.");
      }
      await admin.from("testes_gratis").update({ empresa_id }).eq("id", reserva.id);
      await registrarLead(admin, d, ip, "teste", empresa_id);
      return json({ ok: true, empresa_id });
    }

    throw new Erro(400, "Ação inválida");
  } catch (e) {
    const status = e instanceof Erro ? e.status : 500;
    if (!(e instanceof Erro)) console.error(e);
    return json({ error: e instanceof Erro ? e.message : "Erro inesperado" }, status);
  }
});
