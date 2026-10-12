// IA central do sistema (migração 026): qualquer recurso que use a Anthropic chama chamarIA().
// Ela confere se a loja pode usar (ativa, não bloqueada, recurso ligado, com créditos ou chave própria),
// escolhe a chave e o modelo, chama a API e registra o consumo (tokens e custo).
// As chaves só existem aqui no servidor: o navegador nunca as recebe.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const API = "https://api.anthropic.com/v1";
const VERSAO = "2023-06-01";

/** Motivos pelos quais a IA não está disponível para a loja (o recurso deve seguir sem IA). */
export const MOTIVOS: Record<string, string> = {
  pausada: "A inteligência artificial está pausada nesta loja (Configurações › Inteligência artificial).",
  bloqueada: "A inteligência artificial desta loja foi bloqueada pelo suporte.",
  sem_chave: "Falta cadastrar a chave da Anthropic da loja.",
  indisponivel: "A inteligência artificial do sistema ainda não está disponível.",
  sem_creditos: "Os créditos de inteligência artificial acabaram. Compre mais em Configurações › Inteligência artificial.",
  limite: "A loja chegou ao teto mensal de gasto com inteligência artificial.",
  recurso_desligado: "A inteligência artificial está desligada para este recurso.",
  chave_invalida: "A chave da Anthropic foi recusada. Confira em Configurações › Inteligência artificial.",
  sem_saldo_anthropic: "A conta da Anthropic está sem saldo. Recarregue em console.anthropic.com.",
  falha: "A inteligência artificial não respondeu agora.",
};

export class IaIndisponivel extends Error {
  constructor(public motivo: string) { super(MOTIVOS[motivo] || motivo); }
}

/** Testa uma chave da Anthropic sem gastar (lista os modelos). */
export async function testarChave(chave: string): Promise<{ ok: boolean; erro?: string }> {
  if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(chave.trim())) return { ok: false, erro: "Isso não parece uma chave da Anthropic (começa com sk-ant-)." };
  try {
    const r = await fetch(`${API}/models?limit=1`, { headers: { "x-api-key": chave.trim(), "anthropic-version": VERSAO } });
    if (r.ok) return { ok: true };
    if (r.status === 401) return { ok: false, erro: "Chave recusada pela Anthropic (inválida ou apagada)." };
    if (r.status === 403) return { ok: false, erro: "Esta chave não tem permissão para usar a API." };
    return { ok: false, erro: `A Anthropic respondeu ${r.status}. Tente de novo em instantes.` };
  } catch {
    return { ok: false, erro: "Não foi possível falar com a Anthropic agora." };
  }
}

type Pedido = Record<string, unknown>; // corpo da Messages API, sem "model"

/**
 * Chama o Claude para uma loja.
 * @throws IaIndisponivel quando a loja não pode usar a IA agora (o recurso deve seguir sem IA)
 */
export async function chamarIA(admin: SupabaseClient, op: { empresaId: string; usuarioId?: string; recurso: string; pedido: Pedido; tempoMs?: number }) {
  const { data: aut, error } = await admin.rpc("ia_autorizar", { p_emp: op.empresaId, p_recurso: op.recurso });
  // Função ainda não criada (026 não rodou) conta como "indisponível", para valer a chave antiga abaixo
  if (error && !/ia_autorizar/.test(error.message)) throw new IaIndisponivel("falha");
  let a = (error ? { ok: false, motivo: "indisponivel" } : aut) as Record<string, any>;
  // Compatibilidade: antes da 026 a chave ficava no segredo ANTHROPIC_API_KEY da função
  if (!a?.ok && a?.motivo === "indisponivel" && Deno.env.get("ANTHROPIC_API_KEY")) {
    a = { ok: true, fonte: "sistema", modelo: Deno.env.get("VOZ_MODELO") || "claude-haiku-5-5", chave: Deno.env.get("ANTHROPIC_API_KEY"), preco_entrada: 0, preco_saida: 0, legado: true };
  }
  if (!a?.ok) throw new IaIndisponivel(a?.motivo || "indisponivel");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), op.tempoMs ?? 20000);
  let resp: Response;
  try {
    resp = await fetch(`${API}/messages`, {
      method: "POST", signal: ctl.signal,
      headers: { "x-api-key": a.chave, "anthropic-version": VERSAO, "content-type": "application/json" },
      body: JSON.stringify({ ...op.pedido, model: a.modelo }),
    });
  } catch {
    throw new IaIndisponivel("falha");
  } finally { clearTimeout(timer); }
  if (!resp.ok) {
    const det = await resp.text().catch(() => "");
    console.error("anthropic", resp.status, det.slice(0, 400));
    if (resp.status === 401) throw new IaIndisponivel("chave_invalida");
    if (resp.status === 400 && /credit balance/i.test(det)) throw new IaIndisponivel("sem_saldo_anthropic");
    throw new IaIndisponivel("falha");
  }
  const r = await resp.json();
  const u = r.usage || {};
  const criacao = Number(u.cache_creation_input_tokens || 0), leitura = Number(u.cache_read_input_tokens || 0);
  const entrada = Number(u.input_tokens || 0), saida = Number(u.output_tokens || 0);
  // Preço da plataforma por milhão de tokens (cache: escrita 1,25×, leitura 0,1× do preço de entrada)
  const custo = ((entrada + criacao * 1.25 + leitura * 0.1) * Number(a.preco_entrada || 0) + saida * Number(a.preco_saida || 0)) / 1e6;
  if (!a.legado) {
    await admin.rpc("ia_registrar_uso", {
      p_emp: op.empresaId, p_recurso: op.recurso, p_modelo: a.modelo, p_fonte: a.fonte,
      p_entrada: entrada + criacao, p_saida: saida, p_cache: leitura, p_custo: Math.round(custo * 10000) / 10000, p_usuario: op.usuarioId ?? null,
    }).then(({ error: e }) => { if (e) console.error("ia_registrar_uso", e.message); });
  }
  return { resposta: r, modelo: a.modelo as string, fonte: a.fonte as string };
}
