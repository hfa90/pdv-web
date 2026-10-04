// Estado da sessão e regras de acesso por nível (espelham as regras do banco).
import { sb, q } from "./api.js";

export const estado = {
  usuario: null,   // auth.users
  perfil: null,    // public.perfis
  empresa: null,   // public.empresas
  fiscal: null,    // public.config_fiscal
  caixa: null,     // sessão de caixa aberta do operador
};

export const PAPEIS = {
  admin: { nome: "Administrador", desc: "Acesso total, incluindo usuários e configurações fiscais." },
  gerente: { nome: "Gerente", desc: "Produtos, estoque, relatórios, cancelamentos e equipe de caixa." },
  caixa: { nome: "Caixa", desc: "Vende, recebe pagamentos, abre e fecha o próprio caixa." },
  atendente: { nome: "Atendente", desc: "Lança pedidos e comandas. Não recebe pagamentos." },
};

const TODOS = ["admin", "gerente", "caixa", "atendente"];
// Quais telas cada nível enxerga. A segurança real está no banco (RLS + funções);
// isto só evita mostrar o que a pessoa não pode usar.
export const ROTAS = {
  painel:        { titulo: "Painel",        icone: "painel",     papeis: ["admin", "gerente"] },
  pdv:           { titulo: "Vender",        icone: "pdv",        papeis: TODOS },
  caixa:         { titulo: "Caixa",         icone: "caixa",      papeis: ["admin", "gerente", "caixa"] },
  vendas:        { titulo: "Vendas",        icone: "vendas",     papeis: ["admin", "gerente", "caixa"] },
  produtos:      { titulo: "Produtos",      icone: "produtos",   papeis: ["admin", "gerente"] },
  estoque:       { titulo: "Estoque",       icone: "estoque",    papeis: ["admin", "gerente"] },
  clientes:      { titulo: "Clientes",      icone: "clientes",   papeis: TODOS },
  relatorios:    { titulo: "Relatórios",    icone: "relatorios", papeis: ["admin", "gerente"] },
  usuarios:      { titulo: "Usuários",      icone: "usuarios",   papeis: ["admin", "gerente"] },
  configuracoes: { titulo: "Configurações", icone: "config",     papeis: ["admin", "gerente", "caixa"] },
};

export const papel = () => estado.perfil?.papel;
export const pode = (rota) => !!ROTAS[rota]?.papeis.includes(papel());
export const eh = (...papeis) => papeis.includes(papel());
export const rotaInicial = () => (eh("admin", "gerente") ? "painel" : "pdv");

export async function carregarContexto() {
  const { data: { user } } = await sb.auth.getUser();
  estado.usuario = user;
  if (!user) return false;
  const perfil = await q(sb.from("perfis").select("*").eq("id", user.id).maybeSingle());
  estado.perfil = perfil;
  if (!perfil) return true; // logado, mas ainda sem empresa (onboarding)
  if (!perfil.ativo) throw new Error("Seu acesso foi desativado. Fale com o administrador.");
  const [empresa, fiscal] = await Promise.all([
    q(sb.from("empresas").select("*").eq("id", perfil.empresa_id).single()),
    q(sb.from("config_fiscal").select("*").eq("empresa_id", perfil.empresa_id).maybeSingle()),
  ]);
  estado.empresa = empresa;
  estado.fiscal = fiscal;
  await atualizarCaixa();
  return true;
}

export async function atualizarCaixa() {
  if (!estado.perfil) return null;
  estado.caixa = await q(sb.from("caixa_sessoes").select("*")
    .eq("operador_id", estado.perfil.id).eq("status", "aberto").maybeSingle());
  return estado.caixa;
}

export function limparEstado() {
  Object.keys(estado).forEach((k) => (estado[k] = null));
}
