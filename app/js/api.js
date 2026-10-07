// Camada de acesso a dados. Todas as páginas falam com o Supabase por aqui.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// ---------- Aparelho vinculado ----------
// Toda chamada ao banco leva o código do aparelho e a chave que o servidor deu a ele
// (ver app/js/dispositivos.js e supabase/migrations/018_dispositivos.sql). Sem isso o
// servidor recusa vendas e movimentos de caixa de quem tem o acesso vinculado.
// Só vai para /rest/v1 (as Edge Functions não aceitam cabeçalhos extras).
const lerLS = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lerCookie = (k) => document.cookie.split("; ").find((c) => c.startsWith(k + "="))?.split("=")[1] || null;
function uidDaSessao() {
  try { const s = JSON.parse(lerLS("pdv-auth") || "null"); return s?.user?.id || s?.currentSession?.user?.id || null; } catch { return null; }
}
export function chaveDoAparelho(uid = uidDaSessao()) {
  if (!uid) return null;
  return lerLS("lis-disp-tk-" + uid) || lerCookie("lis-disp-tk-" + uid.slice(0, 8));
}
function fetchComAparelho(url, opcoes = {}) {
  if (String(url).includes("/rest/v1/")) {
    const ap = lerLS("lis-dispositivo") || lerCookie("lis-dispositivo");
    const tk = chaveDoAparelho();
    if (ap) {
      const h = new Headers(opcoes.headers || {});
      h.set("x-lis-aparelho", ap);
      if (tk) h.set("x-lis-token", tk);
      opcoes = { ...opcoes, headers: h };
    }
  }
  return fetch(url, opcoes);
}

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "pdv-auth" },
  global: { fetch: fetchComAparelho },
});

/** Converte erros técnicos em mensagens que o operador entende. */
export function mensagemErro(err) {
  if (!err) return "Erro desconhecido";
  const m = err.message || String(err);
  if (/Invalid login credentials/i.test(m)) return "E-mail ou senha incorretos";
  if (/Email not confirmed/i.test(m)) return "Confirme seu e-mail antes de entrar";
  if (/User already registered/i.test(m)) return "Este e-mail já está cadastrado";
  if (/Password should be at least/i.test(m)) return "A senha deve ter ao menos 8 caracteres";
  if (/duplicate key.*barras/i.test(m)) return "Já existe um produto com este código de barras";
  if (/duplicate key.*codigo/i.test(m)) return "Já existe um produto com este código";
  if (/duplicate key.*categorias/i.test(m)) return "Já existe uma categoria com este nome";
  if (/row-level security|permission denied/i.test(m)) return "Você não tem permissão para esta ação";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Sem conexão com o servidor. Verifique a internet.";
  if (/violates foreign key/i.test(m)) return "Este registro está em uso e não pode ser excluído";
  return m;
}

/** Nome legível do que foi pedido ao banco (ex.: "rpc/registrar_venda", "produtos"). */
function alvoDe(builder) {
  try { const u = new URL(builder?.url); return { alvo: u.pathname.replace(/^\/rest\/v1\//, ""), metodo: builder.method, params: builder.body }; }
  catch { return {}; }
}

/**
 * Cria o erro amigável e registra no diagnóstico com os detalhes técnicos
 * (código do Postgres, tabela/função, tempo). O operador vê a mensagem simples;
 * o suporte vê tudo em Diagnóstico.
 */
function erroDoBanco(error, info = {}, ms = 0) {
  const e = new Error(mensagemErro(error));
  e.tecnico = {
    mensagem_original: error?.message, codigo: error?.code || undefined, detalhes: error?.details || undefined, dica: error?.hint || undefined,
    alvo: info.alvo, metodo: info.metodo, ms: Math.round(ms) || undefined,
    params: info.params && typeof info.params === "object" ? Object.keys(info.params) : undefined,
  };
  const regra = error?.code === "P0001" || /^(22|23)/.test(error?.code || "");
  // Sem internet o PDV continua vendendo (modo offline): registra, mas sem alarme vermelho
  const rede = /Failed to fetch|NetworkError|Load failed|tempo esgotado|Sem conexão/i.test(`${error?.message} ${e.message}`);
  const ev = window.lisDiag?.registrar({ tipo: regra || rede ? "aviso" : "erro", gravidade: rede ? "media" : undefined, origem: "banco", mensagem: e.message, tecnico: { ...e.tecnico, stack: new Error().stack } });
  if (ev) e.diagId = ev.id;
  return e;
}

/** Executa uma query e lança erro amigável. */
export async function q(promise) {
  const t0 = performance.now();
  const { data, error } = await promise;
  if (error) throw erroDoBanco(error, alvoDe(promise), performance.now() - t0);
  return data;
}

/** Chama uma função RPC do banco. */
export function rpc(nome, params = {}) {
  return q(sb.rpc(nome, params));
}

/** Busca todas as linhas (paginando de 1000 em 1000 — limite do PostgREST). */
export async function todos(montarQuery, lote = 1000) {
  const saida = [];
  for (let de = 0; ; de += lote) {
    const parte = await q(montarQuery().range(de, de + lote - 1));
    saida.push(...parte);
    if (parte.length < lote) break;
  }
  return saida;
}

/** Chama uma Edge Function. */
export async function fn(nome, body) {
  const t0 = performance.now();
  const { data, error } = await sb.functions.invoke(nome, { body });
  if (error || data?.error) {
    let msg = error?.message || data.error;
    const status = error?.context?.status;
    try { const ctx = await error?.context?.json?.(); if (ctx?.error || ctx?.message) msg = ctx.error || ctx.message; } catch { /* ignora */ }
    const e = new Error(mensagemErro({ message: msg }));
    e.tecnico = { funcao_edge: nome, acao: body?.acao, status, mensagem_original: error?.message, tipo: error?.name, ms: Math.round(performance.now() - t0) };
    const ev = window.lisDiag?.registrar({ tipo: status && status < 500 && status !== 404 ? "aviso" : "erro", origem: "funcao", mensagem: e.message, tecnico: e.tecnico });
    if (ev) e.diagId = ev.id;
    throw e;
  }
  return data;
}
