// Estado da sessão e regras de acesso por nível (espelham as regras do banco).
import { sb, q } from "./api.js";
import { salvarContextoLocal, lerContextoLocal, usuarioDaSessaoLocal, ehErroDeRede, marcarRede, comTempo } from "./contingencia.js";

export const estado = {
  usuario: null,   // auth.users
  perfil: null,    // public.perfis
  empresa: null,   // public.empresas
  fiscal: null,    // public.config_fiscal
  caixa: null,     // sessão de caixa aberta do operador
  conta: null,     // situação comercial: teste, ativo, bloqueio
  adminPlataforma: false, // fornecedor do sistema
  offline: false,  // abriu sem internet usando a cópia local do contexto
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
  fiado:         { titulo: "Fiado",         icone: "caderno",    papeis: ["admin", "gerente", "caixa"] },
  produtos:      { titulo: "Produtos",      icone: "produtos",   papeis: ["admin", "gerente"] },
  promocoes:     { titulo: "Promoções",     icone: "etiqueta",   papeis: ["admin", "gerente"] },
  compras:       { titulo: "Compras",       icone: "caminhao",   papeis: ["admin", "gerente"] },
  estoque:       { titulo: "Estoque",       icone: "estoque",    papeis: ["admin", "gerente"] },
  validade:      { titulo: "Validade e perdas", icone: "ampulheta", papeis: ["admin", "gerente", "caixa"] },
  etiquetas:     { titulo: "Códigos e etiquetas", icone: "barras", papeis: ["admin", "gerente"] },
  clientes:      { titulo: "Clientes",      icone: "clientes",   papeis: TODOS },
  financeiro:    { titulo: "Financeiro",    icone: "carteira",   papeis: ["admin", "gerente"] },
  alertas:       { titulo: "Alertas",       icone: "escudo",     papeis: ["admin", "gerente"] },
  relatorios:    { titulo: "Relatórios",    icone: "relatorios", papeis: ["admin", "gerente"] },
  usuarios:      { titulo: "Usuários",      icone: "usuarios",   papeis: ["admin", "gerente"] },
  conta:         { titulo: "Minha assinatura", icone: "assinatura", papeis: ["admin", "gerente"] },
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
  try {
    const ok = await carregarContextoOnline();
    estado.offline = false;
    if (estado.perfil) salvarContextoLocal();
    return ok;
  } catch (e) {
    if (!ehErroDeRede(e)) throw e;
    // Sem internet: abre com a última cópia do contexto deste aparelho
    const uid = usuarioDaSessaoLocal();
    const c = uid && lerContextoLocal(uid);
    if (!c) throw new Error("Sem internet. O primeiro acesso neste aparelho precisa de conexão; depois o caixa funciona mesmo offline.");
    estado.usuario = c.usuario; estado.perfil = c.perfil; estado.empresa = c.empresa; estado.fiscal = c.fiscal;
    estado.caixa = c.caixa; estado.conta = c.conta; estado.adminPlataforma = !!c.adminPlataforma;
    estado.offline = true;
    marcarRede(false);
    return true;
  }
}

async function carregarContextoOnline() {
  const { data: { user }, error } = await comTempo(sb.auth.getUser(), 10000);
  if (error && ehErroDeRede(error)) throw error;
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

/** Sessão de caixa aberta. Sem internet, mantém a última conhecida. */
export async function atualizarCaixa() {
  if (!estado.perfil) return null;
  try {
    estado.caixa = await q(comTempo(sb.from("caixa_sessoes").select("*")
      .eq("operador_id", estado.perfil.id).eq("status", "aberto").maybeSingle(), 10000));
    salvarContextoLocal();
  } catch (e) {
    if (!ehErroDeRede(e)) throw e;
    marcarRede(false);
  }
  return estado.caixa;
}

export async function atualizarConta() {
  try {
    const { data, error } = await comTempo(sb.rpc("situacao_conta"), 10000);
    if (error && ehErroDeRede(error)) return estado.conta;
    estado.conta = data || null;
    salvarContextoLocal();
  } catch { /* sem rede: mantém a situação conhecida */ }
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
  estado.offline = false;
}
