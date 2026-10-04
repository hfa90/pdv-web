// Estado da sessão e regras de acesso por nível (espelham as regras do banco).
import { sb, q } from "./api.js";

export const estado = {
  usuario: null,   // auth.users
  perfil: null,    // public.perfis
  empresa: null,   // public.empresas
  fiscal: null,    // public.config_fiscal
  caixa: null,     // sessão de caixa aberta do operador
  conta: null,     // situação comercial: teste, ativo, bloqueio
  adminPlataforma: false, // fornecedor do sistema
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
  mesas:         { titulo: "Mesas",         icone: "mesa",       papeis: TODOS, modulo: "garcom" },
  delivery:      { titulo: "Delivery",      icone: "moto",       papeis: ["admin", "gerente", "caixa"], modulo: "delivery" },
  caixa:         { titulo: "Caixa",         icone: "caixa",      papeis: ["admin", "gerente", "caixa"] },
  vendas:        { titulo: "Vendas",        icone: "vendas",     papeis: ["admin", "gerente", "caixa"] },
  produtos:      { titulo: "Produtos",      icone: "produtos",   papeis: ["admin", "gerente"] },
  estoque:       { titulo: "Estoque",       icone: "estoque",    papeis: ["admin", "gerente"] },
  clientes:      { titulo: "Clientes",      icone: "clientes",   papeis: TODOS },
  relatorios:    { titulo: "Relatórios",    icone: "relatorios", papeis: ["admin", "gerente"] },
  usuarios:      { titulo: "Usuários",      icone: "usuarios",   papeis: ["admin", "gerente"] },
  configuracoes: { titulo: "Configurações", icone: "config",     papeis: ["admin", "gerente", "caixa"] },
  plataforma:    { titulo: "Plataforma",    icone: "plataforma", papeis: [], soFornecedor: true },
};

export const papel = () => estado.perfil?.papel;
const moduloLiberado = (m) => !m || (m === "garcom" ? !!estado.conta?.garcom : !!(estado.conta?.delivery_contratado && estado.conta?.delivery_ativo));
export const pode = (rota) => {
  const r = ROTAS[rota];
  if (!r) return false;
  if (r.soFornecedor) return estado.adminPlataforma;
  return r.papeis.includes(papel()) && moduloLiberado(r.modulo);
};
export const eh = (...papeis) => papeis.includes(papel());
export const rotaInicial = () => (eh("admin", "gerente") ? "painel" : "pdv");

export async function carregarContexto() {
  const { data: { user } } = await sb.auth.getUser();
  estado.usuario = user;
  if (!user) return false;
  estado.adminPlataforma = !!(await sb.rpc("sou_admin_plataforma")).data;
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
  await Promise.all([atualizarCaixa(), atualizarConta()]);
  return true;
}

export async function atualizarCaixa() {
  if (!estado.perfil) return null;
  estado.caixa = await q(sb.from("caixa_sessoes").select("*")
    .eq("operador_id", estado.perfil.id).eq("status", "aberto").maybeSingle());
  return estado.caixa;
}

export async function atualizarConta() {
  estado.conta = (await sb.rpc("situacao_conta")).data || null;
  return estado.conta;
}

/** Dias que faltam no teste (arredondado para cima). */
export function diasDeTeste() {
  const fim = estado.conta?.teste_expira_em;
  if (!fim) return null;
  return Math.max(0, Math.ceil((new Date(fim) - Date.now()) / 864e5));
}

export function limparEstado() {
  Object.keys(estado).forEach((k) => (estado[k] = null));
  estado.adminPlataforma = false;
}
