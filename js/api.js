// Camada de acesso a dados. Todas as páginas falam com o Supabase por aqui.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "pdv-auth" },
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

/** Executa uma query e lança erro amigável. */
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(mensagemErro(error));
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
  const { data, error } = await sb.functions.invoke(nome, { body });
  if (error) {
    let msg = error.message;
    try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error; } catch { /* ignora */ }
    throw new Error(mensagemErro({ message: msg }));
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
