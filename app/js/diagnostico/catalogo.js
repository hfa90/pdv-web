// =====================================================================
// Catálogo de problemas conhecidos do Lis PDV
// ---------------------------------------------------------------------
// Cada entrada ensina, em linguagem simples:
//   explicacao → o que aconteceu (com uma comparação do dia a dia quando ajuda)
//   impacto    → o que para de funcionar
//   causas     → por que costuma acontecer (da mais comum para a menos comum)
//   operador   → o que o caixa/garçom pode fazer sozinho, agora
//   tecnico    → o passo a passo para quem dá suporte
//   acoes      → botões que resolvem sozinhos (implementados em painel.js)
//   sql / onde → comando pronto e arquivos do projeto para olhar
// A primeira entrada cujo `testa` der verdadeiro é a escolhida.
// Para ensinar um problema novo ao sistema: copie uma entrada parecida e ajuste.
// =====================================================================
import { migracaoDe, EDGE } from "./mapa-banco.js";

export const AREAS = {
  internet:    { nome: "Internet",              cor: "#2563EB" },
  servidor:    { nome: "Servidor (Supabase)",   cor: "#7C3AED" },
  login:       { nome: "Login e sessão",        cor: "#0891B2" },
  permissao:   { nome: "Permissões",            cor: "#9333EA" },
  banco:       { nome: "Banco de dados",        cor: "#B42318" },
  regra:       { nome: "Regras do sistema",     cor: "#8A5300" },
  dados:       { nome: "Dados digitados",       cor: "#A16207" },
  fiscal:      { nome: "Nota fiscal",           cor: "#0F766E" },
  pagamento:   { nome: "PIX e pagamentos",      cor: "#15803D" },
  impressora:  { nome: "Impressora",            cor: "#C2410C" },
  balanca:     { nome: "Balança",               cor: "#B45309" },
  offline:     { nome: "Vendas sem internet",   cor: "#DC2626" },
  aparelho:    { nome: "Aparelho e navegador",  cor: "#475569" },
  atualizacao: { nome: "Arquivos e atualização", cor: "#4F46E5" },
  codigo:      { nome: "Erro no código",        cor: "#BE123C" },
};

export const GRAVIDADES = {
  critica: { nome: "Crítico", desc: "Para de vender ou pode perder dados", peso: 4 },
  alta:    { nome: "Alto",    desc: "Uma parte importante parou",           peso: 3 },
  media:   { nome: "Médio",   desc: "Uma ação falhou, o resto funciona",    peso: 2 },
  baixa:   { nome: "Baixo",   desc: "Aviso ou regra do sistema",            peso: 1 },
  info:    { nome: "Info",    desc: "Só para contexto",                     peso: 0 },
};

// ---------- Extração de pistas da mensagem ----------
function texto(ev) {
  const t = ev.tecnico || {};
  return [ev.mensagem, t.mensagem_original, t.codigo, t.detalhes, t.dica, t.tipo, t.status ? "HTTP " + t.status : "", t.alvo]
    .filter(Boolean).join(" | ");
}

export function pistas(ev) {
  const t = ev.tecnico || {};
  const s = texto(ev);
  const funcao = s.match(/function (?:public\.)?([a-z0-9_]+)/i)?.[1] || String(t.alvo || "").match(/rpc\/([a-z0-9_]+)/i)?.[1] || null;
  const tabela = s.match(/relation "(?:public\.)?([a-z0-9_]+)"/i)?.[1] || s.match(/'([a-z0-9_]+)' in the schema cache/i)?.[1]
    || (!/rpc\//.test(t.alvo || "") ? String(t.alvo || "").match(/rest\/v1\/([a-z0-9_]+)/i)?.[1] : null) || null;
  const coluna = s.match(/column "?([a-z0-9_.]+)"? (?:of relation|does not exist)/i)?.[1] || s.match(/Could not find the '([a-z0-9_]+)' column/i)?.[1] || null;
  const migracao = migracaoDe(funcao) || migracaoDe(tabela);
  return { funcao, tabela, coluna, migracao, status: t.status, edge: t.funcao_edge, local: t.local };
}

const tem = (re) => (ev) => re.test(texto(ev));
const codigo = (...cs) => (ev) => cs.includes(String(ev.tecnico?.codigo || ""));
const origem = (...os) => (ev) => os.includes(ev.origem);
const e = (...fs) => (ev) => fs.every((f) => f(ev));
const ou = (...fs) => (ev) => fs.some((f) => f(ev));
const nao = (f) => (ev) => !f(ev);

const SQL_RECARREGAR = `-- Faz a API do Supabase enxergar funções/colunas recém-criadas
notify pgrst, 'reload schema';`;

// =====================================================================
export const PROBLEMAS = [
  // ------------------------------------------------------------ INÍCIO
  {
    id: "inicio-nao-carregou", area: "atualizacao", gravidade: "critica",
    titulo: "O sistema não conseguiu abrir",
    testa: e(origem("inicio"), tem(/não iniciou/)),
    explicacao: "Ao abrir, o navegador precisa baixar os arquivos do sistema e as bibliotecas (como a do Supabase). Algum deles não chegou, então a tela ficou girando. É como um carro que não pega porque faltou uma peça.",
    impacto: "Ninguém consegue usar este aparelho até resolver.",
    causas: ["Internet fora do ar ou muito instável justo na hora de abrir.",
      "Antivírus, firewall ou o provedor bloqueando cdn.jsdelivr.net ou cdnjs.cloudflare.com.",
      "Atualização publicada pela metade (algum arquivo faltando no servidor).",
      "Cópia antiga do sistema presa no navegador (cache)."],
    operador: ["Veja se a internet funciona abrindo outro site.", "Clique em “Limpar cache e recarregar”.", "Se não abrir, tente em outro navegador (Chrome ou Edge) e chame o suporte."],
    tecnico: ["Veja em “Detalhes técnicos” a lista recursos_com_falha: ela diz QUAL arquivo não carregou.",
      "Se for cdn.jsdelivr.net/cdnjs: teste abrir a URL direto no navegador do cliente. Se não abrir, é bloqueio de rede/antivírus/DNS (troque o DNS para 1.1.1.1 ou 8.8.8.8 ou libere o domínio).",
      "Se for um arquivo do próprio sistema (app/js/...): confira se ele foi publicado e se o caminho/maiúsculas estão iguais (servidor Linux diferencia).",
      "Abra o DevTools (F12) › Console e Network com “Disable cache” marcado e recarregue."],
    acoes: ["limpar-cache", "testar"], onde: ["app/index.html", "app/sw.js", "app/js/main.js"],
  },
  {
    id: "inicio-travado", area: "servidor", gravidade: "alta",
    titulo: "Abriu, mas travou carregando os dados",
    testa: e(origem("inicio"), tem(/travou/)),
    explicacao: "Os arquivos chegaram, mas o sistema ficou esperando a resposta do servidor (login, dados da loja) e ela não veio. É como ligar para um número que só chama e ninguém atende.",
    impacto: "A tela fica girando; vendas não começam.",
    causas: ["Internet conectada ao Wi-Fi mas sem saída para a internet.", "Servidor do Supabase lento, fora do ar ou projeto pausado.", "Relógio do aparelho muito errado (o login é recusado)."],
    operador: ["Clique em “Testar tudo agora” e veja o que fica vermelho.", "Recarregue a página.", "Se tiver vendas offline pendentes, NÃO limpe os dados do navegador."],
    tecnico: ["Rode as checagens: Internet, Servidor, Sessão e Relógio dizem onde parou.", "Veja status.supabase.com e o painel do projeto (se está pausado ou no limite do plano).", "Confira a data/hora do Windows (Configurações › Hora e idioma › Sincronizar agora)."],
    acoes: ["testar", "recarregar"], onde: ["app/js/estado.js (carregarContexto)"],
  },

  // ------------------------------------------------------------ INTERNET
  {
    id: "rede-sem-internet", area: "internet", gravidade: "alta",
    titulo: "Sem conexão com a internet",
    testa: e(nao(origem("impressora", "balanca", "recurso")), nao(tem(/dynamically imported|module script|transfer error|Edge Function/i)),
      ou(e(origem("rede"), tem(/sem internet|caiu|offline/i)),
        tem(/Failed to fetch|NetworkError|Load failed|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|AuthRetryableFetchError|Sem conex[aã]o com o servidor|Sem internet/i))),
    explicacao: "O aparelho tentou falar com o servidor e a mensagem não chegou lá. O sistema foi feito para continuar vendendo assim: as vendas ficam guardadas neste aparelho e são enviadas sozinhas quando a internet volta.",
    impacto: "Vender continua funcionando. Abrir/fechar caixa, NFC-e, PIX automático e telas de gestão precisam de internet.",
    causas: ["Wi-Fi/cabo desconectado ou roteador travado.", "Wi-Fi conectado, mas a internet do provedor caiu.", "Plano de dados do celular acabou (app do garçom).", "DNS ou firewall bloqueando *.supabase.co."],
    operador: ["Continue vendendo normalmente: as vendas não se perdem.", "Desligue e ligue o roteador (espere 1 minuto).", "NÃO limpe os dados do navegador nem troque de usuário enquanto houver vendas aguardando envio."],
    tecnico: ["Confirme se é só neste aparelho (outros aparelhos/celular na mesma rede funcionam?).", "No navegador, abra https://status.supabase.com e o endereço do projeto.", "Se só o Supabase não abre: DNS (troque para 1.1.1.1/8.8.8.8) ou bloqueio de firewall/antivírus para *.supabase.co.", "A fila de vendas fica em localStorage (chave lis-fila-vendas-<empresa>) — não apague."],
    acoes: ["testar", "abrir-fila"], onde: ["app/js/contingencia.js"],
  },
  {
    id: "rede-lenta", area: "internet", gravidade: "media",
    titulo: "Internet lenta: o servidor demorou demais",
    testa: tem(/tempo esgotado|timed? ?out|ETIMEDOUT|aborted due to timeout/i),
    explicacao: "O pedido saiu, mas a resposta demorou mais que o limite (8 a 20 segundos). Para o caixa não ficar travado, o sistema desiste e trata como “sem internet”.",
    impacto: "Ações demoram ou falham; vendas continuam pelo modo offline.",
    causas: ["Internet sobrecarregada (alguém baixando/vendo vídeo na mesma rede).", "Sinal de Wi-Fi fraco no ponto do caixa.", "Servidor do Supabase lento naquele momento."],
    operador: ["Tente de novo em alguns segundos.", "Se possível, ligue o computador do caixa por cabo."],
    tecnico: ["Veja a latência na checagem “Internet”: acima de 1.500 ms já atrapalha.", "Separe a rede do caixa da rede de clientes ou limite banda de convidados no roteador.", "Se for o servidor, veja Supabase › Reports (CPU/conexões) e consultas lentas."],
    acoes: ["testar"], onde: ["app/js/contingencia.js (comTempo)"],
  },

  // ------------------------------------------------------------ SERVIDOR
  {
    id: "servidor-pausado", area: "servidor", gravidade: "critica",
    titulo: "Projeto do Supabase pausado ou bloqueado",
    testa: tem(/project (is )?paused|paused project|HTTP 540|exceeded.*quota|over.*usage limit/i),
    explicacao: "O banco de dados está desligado do lado do Supabase. Projetos gratuitos pausam depois de dias sem uso e projetos acima do limite do plano podem ser bloqueados.",
    impacto: "Nenhum aparelho de nenhuma loja consegue falar com o servidor.",
    causas: ["Plano gratuito pausado por inatividade.", "Limite de uso/plano estourado ou fatura em aberto no Supabase."],
    operador: ["Continue vendendo offline e chame o suporte imediatamente."],
    tecnico: ["Entre em supabase.com/dashboard › projeto › clique em “Restore/Resume”.", "Confira Billing/Usage do projeto.", "Depois de voltar, as filas offline dos aparelhos são enviadas sozinhas."],
    acoes: ["testar"],
  },
  {
    id: "servidor-fora", area: "servidor", gravidade: "alta",
    titulo: "Servidor indisponível no momento",
    testa: tem(/HTTP 50[0-4]|HTTP 52\d|Bad Gateway|Service Unavailable|Gateway Time-?out|upstream|connection refused|too many connections|code 53300|remaining connection slots/i),
    explicacao: "A internet do aparelho está ok, mas o servidor respondeu “agora não consigo”. Costuma ser passageiro.",
    impacto: "Ações online falham por alguns minutos; vendas seguem offline.",
    causas: ["Instabilidade ou manutenção no Supabase.", "Banco sobrecarregado (muitas conexões ou consulta pesada)."],
    operador: ["Aguarde 1–2 minutos e tente de novo; continue vendendo."],
    tecnico: ["Veja status.supabase.com.", "No painel: Reports › Database (CPU, conexões) e Logs › API/Postgres no horário do erro.", "Se for “too many connections”, procure loops de chamadas ou canais Realtime duplicados."],
    acoes: ["testar"],
  },
  {
    id: "banco-consulta-lenta", area: "servidor", gravidade: "media",
    titulo: "Consulta pesada demais foi cancelada",
    testa: ou(codigo("57014"), tem(/statement timeout|canceling statement/i)),
    explicacao: "O banco começou a calcular, mas a conta demorou mais que o limite e foi interrompida para não travar os outros.",
    impacto: "Aquela tela/relatório não carrega; o resto funciona.",
    causas: ["Período muito grande em relatório.", "Falta de índice para aquela consulta.", "Muitos dados acumulados (anos de vendas)."],
    operador: ["Escolha um período menor e tente de novo."],
    tecnico: ["Veja em Detalhes técnicos o alvo (tabela/função).", "No SQL Editor rode EXPLAIN ANALYZE da consulta e crie o índice que falta (ver 004_indices.sql).", "Supabase › Advisors › Performance mostra índices sugeridos."],
    acoes: [], onde: ["supabase/migrations/004_indices.sql"],
  },

  // ------------------------------------------------------------ LOGIN
  {
    id: "login-relogio", area: "login", gravidade: "alta",
    titulo: "Relógio do aparelho errado",
    testa: tem(/issued in the future|clock skew|relógio|\biat\b|\bnbf\b|token is not valid yet/i),
    explicacao: "O login usa um “crachá digital” com data e hora de validade. Se o relógio do aparelho está muito adiantado ou atrasado, o crachá parece vencido (ou do futuro) e o servidor recusa.",
    impacto: "O login cai ou nada carrega, mesmo com internet.",
    causas: ["Bateria da placa-mãe fraca (o relógio volta para outra data quando desliga).", "Sincronização automática de hora desligada.", "Fuso horário errado."],
    operador: ["Confira a data e a hora no canto da tela do computador."],
    tecnico: ["Windows: Configurações › Hora e idioma › ativar “Definir hora automaticamente” › “Sincronizar agora”.", "Se a hora volta errada após desligar, troque a bateria CR2032 da placa-mãe.", "A checagem “Relógio do aparelho” mostra a diferença em segundos para o servidor."],
    acoes: ["testar", "renovar-sessao"],
  },
  {
    id: "login-sessao-expirada", area: "login", gravidade: "media",
    titulo: "Sessão expirada",
    testa: ou(codigo("PGRST301", "PGRST302", "401"), tem(/JWT expired|invalid JWT|Invalid Refresh Token|Refresh Token Not Found|refresh_token_not_found|session_not_found|Auth session missing|Não autenticado|HTTP 401/i)),
    explicacao: "O sistema guarda o login por um tempo e o renova sozinho. A renovação falhou (aparelho ficou muito tempo sem internet, alguém saiu em outra aba, ou a senha foi trocada).",
    impacto: "As ações online são recusadas até entrar de novo.",
    causas: ["Muito tempo offline: o login venceu.", "Senha trocada ou usuário desativado pelo gerente.", "Relógio do aparelho errado.", "Saiu do sistema em outra aba do mesmo navegador."],
    operador: ["Clique em “Renovar sessão”.", "Se não resolver e não houver vendas pendentes, saia e entre de novo."],
    tecnico: ["Se repetir em vários aparelhos, confira Authentication › Settings (JWT expiry) e se o usuário está ativo em perfis.", "Confira o relógio (checagem “Relógio do aparelho”).", "Vendas offline continuam guardadas mesmo saindo; são enviadas quando o mesmo operador entrar."],
    acoes: ["renovar-sessao", "testar"], onde: ["app/js/api.js", "app/js/estado.js"],
  },
  {
    id: "login-credenciais", area: "login", gravidade: "baixa",
    titulo: "E-mail/matrícula ou senha incorretos",
    testa: tem(/Invalid login credentials|E-mail ou senha incorretos|Senha atual incorreta|senha (incorreta|inválida)/i),
    explicacao: "O servidor não reconheceu a combinação de login e senha. Nada de errado com o sistema.",
    impacto: "Só aquela pessoa não entra.",
    causas: ["Senha digitada errada (Caps Lock, teclado numérico desligado).", "E-mail com erro de digitação.", "Senha trocada recentemente."],
    operador: ["Confira Caps Lock e digite devagar.", "Peça ao gerente para redefinir a senha em Usuários."],
    tecnico: ["Em Usuários o gerente pode trocar a senha (Edge Function usuarios).", "Garçom: 5 erros bloqueiam por 15 min — o gerente libera em Usuários."],
    acoes: [],
  },
  {
    id: "login-bloqueado", area: "login", gravidade: "baixa",
    titulo: "Acesso bloqueado ou desativado",
    testa: tem(/acesso foi desativado|bloquead[oa].*(tentativa|minutos)|muitas tentativas|Email not confirmed|Confirme seu e-mail|ainda não foi criado|sem login configurado/i),
    explicacao: "O login existe, mas está impedido de entrar agora: desativado pelo gerente, bloqueado por muitas tentativas erradas ou com e-mail ainda não confirmado.",
    impacto: "Só aquela pessoa não entra.",
    causas: ["Usuário desativado em Usuários.", "5 senhas erradas seguidas (garçom: bloqueio de 15 min).", "E-mail de confirmação não foi clicado."],
    operador: ["Peça ao gerente para conferir o usuário em Usuários."],
    tecnico: ["Usuários › editar › ativar / liberar bloqueio.", "E-mail não confirmado: reenviar pelo Supabase › Authentication › Users, ou confirmar manualmente."],
    acoes: [],
  },

  // ------------------------------------------------------------ PERMISSÕES
  {
    id: "permissao-negada", area: "permissao", gravidade: "baixa",
    titulo: "Sem permissão para esta ação",
    testa: ou(codigo("42501"), tem(/row-level security|permission denied|Sem permiss[aã]o|Acesso negado|Acesso restrito|Você não tem permissão|Operação não permitida|HTTP 403/i)),
    explicacao: "O banco confere o nível de acesso de quem pediu (Caixa, Gerente, Admin…). Esta pessoa não tem o nível exigido para essa ação. É a segurança funcionando, não um defeito.",
    impacto: "Só esta ação é recusada.",
    causas: ["Ação reservada a gerente/administrador.", "Usuário com nível errado no cadastro.", "Módulo não contratado/ativado para a loja.",
      "Se acontecer com o administrador: política RLS ou GRANT faltando no banco (migração incompleta)."],
    operador: ["Peça a um gerente para fazer a ação ou liberar."],
    tecnico: ["Veja em Detalhes técnicos o alvo (tabela/função) e o nível do usuário (contexto.papel).",
      "Se o nível deveria poder: confira a policy da tabela e o GRANT EXECUTE da função na migração correspondente.",
      "Teste no SQL Editor: select private.papel(), private.empresa_id(); logado como o usuário (ou via set request.jwt.claims)."],
    acoes: [], onde: ["app/js/estado.js (ROTAS)", "supabase/migrations/003_endurecer_permissoes.sql"],
  },

  // ------------------------------------------------------------ BANCO (estrutura)
  {
    id: "banco-funcao-faltando", area: "banco", gravidade: "alta",
    titulo: "Função do banco não encontrada",
    testa: ou(codigo("PGRST202", "42883"), tem(/Could not find the function|function .* does not exist/i)),
    explicacao: (ev, p) => `O sistema pediu ao banco para executar “${p.funcao || "uma função"}”, mas ela não existe lá (ou existe com outros parâmetros). Isso acontece quando o código foi atualizado e o banco não: falta rodar ${p.migracao ? "a migração " + p.migracao : "uma migração"} no Supabase.`,
    impacto: "Tudo que depende dessa função falha em TODAS as lojas até rodar a migração.",
    causas: (ev, p) => [p.migracao ? `A migração ${p.migracao} não foi executada no SQL Editor.` : "Uma migração nova não foi executada.",
      "A migração foi executada, mas a API ainda não “enxergou” (cache de esquema).", "O código chama a função com nomes de parâmetros diferentes da versão do banco."],
    operador: ["Não há o que fazer neste aparelho: chame o suporte."],
    tecnico: (ev, p) => [p.migracao ? `Abra supabase/migrations/${p.migracao}, copie tudo e rode no Supabase › SQL Editor.` : "Descubra qual migração cria a função (busque o nome em supabase/migrations).",
      "Depois rode o comando abaixo para recarregar o cache da API.",
      "Se já existia: compare os nomes dos parâmetros do rpc() no JS com a definição SQL (Detalhes técnicos › dica mostra a assinatura que a API procurou).",
      "Use a checagem “Banco atualizado” para ver todas as migrações que faltam."],
    sql: SQL_RECARREGAR, acoes: ["testar", "copiar-sql"], onde: ["supabase/migrations/", "app/js/diagnostico/mapa-banco.js"],
  },
  {
    id: "banco-tabela-coluna-faltando", area: "banco", gravidade: "alta",
    titulo: "Tabela ou coluna não existe no banco",
    testa: ou(codigo("42P01", "42703", "PGRST204", "PGRST200"), tem(/relation .* does not exist|column .* does not exist|Could not find the .* column|in the schema cache|Could not find a relationship/i)),
    explicacao: (ev, p) => `O sistema procurou ${p.coluna ? `a coluna “${p.coluna}”` : p.tabela ? `a tabela “${p.tabela}”` : "uma tabela/coluna"} no banco e não achou. O código está mais novo que o banco${p.migracao ? `: falta rodar ${p.migracao}` : ""}.`,
    impacto: "As telas que usam esses dados falham.",
    causas: ["Migração nova não executada.", "Cache de esquema da API desatualizado.", "Nome digitado diferente no código (erro de programação)."],
    operador: ["Chame o suporte."],
    tecnico: (ev, p) => [p.migracao ? `Rode supabase/migrations/${p.migracao} no SQL Editor.` : "Busque o nome da coluna/tabela em supabase/migrations para achar a migração.", "Rode o comando abaixo para recarregar o cache.", "Se a coluna não existe em nenhuma migração, é erro no código: veja o alvo e o arquivo em Detalhes técnicos."],
    sql: SQL_RECARREGAR, acoes: ["testar", "copiar-sql"],
  },
  {
    id: "banco-registro-esperado", area: "codigo", gravidade: "media",
    titulo: "Esperava 1 registro e veio nenhum (ou vários)",
    testa: ou(codigo("PGRST116"), tem(/JSON object requested, multiple \(or no\) rows returned|Cannot coerce the result to a single JSON object/i)),
    explicacao: "O código pediu “me dê exatamente um registro” (.single()), mas o banco encontrou zero ou mais de um. Normalmente é um cadastro faltando (ex.: loja sem configuração) ou o usuário sem acesso àquele registro.",
    impacto: "A tela que fez o pedido não carrega.",
    causas: ["Registro ainda não criado (ex.: empresa sem config_fiscal).", "RLS escondendo o registro deste usuário.", "Dados duplicados que deveriam ser únicos."],
    operador: ["Chame o suporte e diga em qual tela estava."],
    tecnico: ["Veja o alvo em Detalhes técnicos: é a tabela consultada.", "Se zero linhas for normal, troque .single() por .maybeSingle() no código.", "Se duplicado, crie índice único e limpe as duplicatas."],
    acoes: [],
  },

  // ------------------------------------------------------------ REGRAS DO SISTEMA (P0001 etc.)
  {
    id: "regra-caixa-fechado", area: "regra", gravidade: "baixa",
    titulo: "Caixa fechado",
    testa: tem(/Abra o caixa|Nenhum caixa aberto|caixa principal/i),
    explicacao: "Para registrar dinheiro entrando, precisa haver um caixa aberto (com fundo de troco). É uma regra para o fechamento bater no fim do dia.",
    impacto: "Não finaliza venda/recebimento até abrir o caixa.",
    causas: ["O caixa não foi aberto hoje.", "O caixa foi fechado em outro aparelho.", "App do garçom: o caixa principal da loja não está aberto."],
    operador: ["Vá em Caixa › Abrir caixa e informe o fundo de troco.", "Garçom: peça para abrirem o caixa principal."],
    tecnico: ["O caixa principal do app do garçom é definido em Configurações › Restaurante."],
    acoes: ["ir-caixa"],
  },
  {
    id: "regra-conta-bloqueada", area: "regra", gravidade: "alta",
    titulo: "Vendas bloqueadas pela assinatura",
    testa: tem(/período de teste terminou|Limite de 200 vendas|Conta suspensa|vendas (estão )?pausadas|teste (grátis )?encerrado/i),
    explicacao: "A loja está em teste encerrado, atingiu o limite do teste ou está suspensa. O banco bloqueia novas vendas (os dados continuam guardados).",
    impacto: "Não registra vendas novas.",
    causas: ["Teste de 7 dias acabou ou passou de 200 vendas.", "Loja suspensa por pagamento em aberto."],
    operador: ["Fale com o responsável da loja (Minha assinatura)."],
    tecnico: ["No painel Plataforma › Lojas: ativar plano, estender teste ou reativar.", "Confira private.conta_liberada(<empresa>) no SQL Editor."],
    acoes: [],
  },
  {
    id: "regra-desconto", area: "regra", gravidade: "baixa",
    titulo: "Desconto acima do permitido",
    testa: tem(/Desconto acima do limite|Desconto maior que o total|Desconto inválido/i),
    explicacao: "Cada nível de acesso tem um limite de desconto, conferido no servidor (não dá para burlar pela tela).",
    impacto: "Só esta venda precisa de ajuste.",
    causas: ["Desconto maior que o limite do caixa/atendente.", "Desconto maior que o valor da venda."],
    operador: ["Peça a um gerente para dar o desconto ou diminua o valor."],
    tecnico: ["O limite fica no cadastro do usuário/empresa e é aplicado em registrar_venda."],
    acoes: [],
  },
  {
    id: "regra-conflito-aparelhos", area: "regra", gravidade: "baixa",
    titulo: "Outro aparelho mexeu no mesmo pedido",
    testa: tem(/recebeu itens novos em outro aparelho|mesa já foi fechada|venda já está|já cancelada|já foi encerrado|já respondido/i),
    explicacao: "Duas pessoas mexeram no mesmo pedido/mesa quase ao mesmo tempo. O servidor recusou para não cobrar errado.",
    impacto: "Só este pedido precisa ser reaberto.",
    causas: ["Garçom lançou item enquanto o caixa recebia.", "Mesa fechada em outro aparelho."],
    operador: ["Feche e abra o pedido de novo para ver a versão atual, confira e tente outra vez."],
    tecnico: ["Comportamento esperado (proteção). Se acontecer sempre, veja se o Realtime está conectado (checagem “Tempo real”)."],
    acoes: [],
  },
  {
    id: "regra-negocio", area: "regra", gravidade: "baixa",
    titulo: "O sistema recusou por uma regra",
    testa: ou(codigo("P0001"), tem(/^(Informe|Adicione|Escolha|Quantidade|Produto (inativo|não encontrado|indisponível)|Pagamento insuficiente|Troco só|Limite de|Valor (inválido|maior)|Forma de pagamento|Para vender no fiado|Atendentes podem|Só (o|a) )/i)),
    explicacao: (ev) => `O servidor conferiu a operação e recusou com o motivo: “${ev.mensagem}”. Não é defeito: é uma regra do sistema avisando que falta algo ou que algo não está certo.`,
    impacto: "Só esta ação, até corrigir o que a mensagem pede.",
    causas: ["Falta preencher algo ou um valor está fora do permitido.", "Produto inativo/sem cadastro.", "Ação reservada a outro nível de acesso."],
    operador: ["Leia a mensagem: ela diz o que corrigir.", "Se não entender, chame o gerente."],
    tecnico: ["A mensagem vem de um RAISE EXCEPTION em supabase/migrations — busque o texto para ver a regra exata."],
    acoes: [],
  },

  // ------------------------------------------------------------ DADOS
  {
    id: "dados-duplicado", area: "dados", gravidade: "baixa",
    titulo: "Já existe um cadastro igual",
    testa: ou(codigo("23505"), tem(/duplicate key|já existe|já está cadastrado|User already registered/i)),
    explicacao: "Alguns campos não podem se repetir (código de barras, código do produto, nome de categoria, e-mail). Já existe outro registro com esse mesmo valor.",
    impacto: "Só este cadastro não é salvo.",
    causas: ["Produto cadastrado duas vezes.", "Código de barras reaproveitado."],
    operador: ["Busque o cadastro existente e edite-o em vez de criar outro."],
    tecnico: ["Detalhes técnicos › detalhes mostra a chave repetida: Key (campo)=(valor)."],
    acoes: [],
  },
  {
    id: "dados-em-uso", area: "dados", gravidade: "baixa",
    titulo: "Registro em uso, não pode excluir",
    testa: ou(codigo("23503"), tem(/violates foreign key|está em uso/i)),
    explicacao: "Esse registro é usado por outros (ex.: produto que já tem vendas). Excluir quebraria o histórico.",
    impacto: "Só a exclusão é recusada.",
    causas: ["Produto/cliente/categoria com histórico."],
    operador: ["Em vez de excluir, marque como inativo."],
    tecnico: ["Detalhes técnicos mostra qual tabela referencia o registro."],
    acoes: [],
  },
  {
    id: "dados-invalidos", area: "dados", gravidade: "baixa",
    titulo: "Valor digitado em formato inválido",
    testa: ou(codigo("22P02", "23514", "23502", "22003", "22007", "22008"), tem(/invalid input syntax|violates check constraint|violates not-null|out of range|numeric field overflow|invalid input value for enum/i)),
    explicacao: "Algum campo chegou ao banco num formato que ele não aceita (texto onde era número, valor negativo, campo obrigatório vazio, número grande demais).",
    impacto: "Só este salvamento.",
    causas: ["Digitação com vírgula/ponto trocados.", "Campo obrigatório em branco.", "Importação de CSV com coluna errada."],
    operador: ["Confira os campos do formulário e tente de novo."],
    tecnico: ["Detalhes técnicos › detalhes/mensagem original mostram o campo e o valor.", "Se o formulário deveria validar antes, ajuste a validação no JS da tela."],
    acoes: [],
  },

  // ------------------------------------------------------------ VENDAS OFFLINE
  {
    id: "offline-venda-recusada", area: "offline", gravidade: "critica",
    titulo: "Venda feita sem internet foi recusada pelo servidor",
    testa: ou(origem("fila"), tem(/Preços mudaram muito desde a venda sem internet|Venda offline recusada/i)),
    explicacao: "Uma venda feita offline foi enviada quando a internet voltou, mas o servidor recusou (ex.: o preço mudou muito, produto desativado, caixa fechado). Ela continua guardada NESTE aparelho esperando conferência — ainda não entrou no caixa nem no estoque.",
    impacto: "O caixa não fecha e o relatório fica sem essa venda até alguém resolver.",
    causas: ["Preço do produto alterado enquanto estava offline.", "Produto desativado/excluído.", "Caixa do operador fechado em outro aparelho.", "Loja bloqueada pela assinatura."],
    operador: ["Não limpe o navegador. Clique em “Ver vendas pendentes” e mostre ao gerente."],
    tecnico: ["Veja o motivo de cada venda na fila (Vendas feitas sem internet).", "Corrija a causa (reabra caixa, reative produto) e clique em “Enviar agora”.", "Só use “Descartar” se a venda já foi lançada manualmente — descartar apaga a venda do aparelho."],
    acoes: ["abrir-fila"], onde: ["app/js/contingencia.js (sincronizarFila)"],
  },
  {
    id: "armazenamento-cheio", area: "aparelho", gravidade: "critica",
    titulo: "Memória do navegador cheia",
    testa: ou(origem("armazenamento"), tem(/QuotaExceeded|quota.*exceeded|exceeded the quota|armazenamento (cheio|indisponível)/i)),
    explicacao: "O navegador reserva um espaço pequeno (cerca de 5 MB) para o sistema guardar catálogo, venda em andamento e vendas offline. Esse espaço encheu.",
    impacto: "Risco de não conseguir guardar vendas feitas sem internet.",
    causas: ["Catálogo muito grande (milhares de produtos com fotos/descrições).", "Muitas vendas offline acumuladas.", "Navegador em modo anônimo (espaço ainda menor)."],
    operador: ["Não use janela anônima.", "Clique em “Liberar espaço” (não apaga vendas pendentes)."],
    tecnico: ["A checagem “Armazenamento” mostra quanto cada parte ocupa.", "“Liberar espaço” remove catálogos de outras lojas e o histórico antigo do diagnóstico; nunca a fila de vendas.", "Se for o catálogo, considere migrar o cache de produtos para IndexedDB."],
    acoes: ["liberar-espaco", "testar"], onde: ["app/js/contingencia.js (salvarCatalogo)"],
  },

  // ------------------------------------------------------------ FISCAL
  {
    id: "fiscal-config", area: "fiscal", gravidade: "media",
    titulo: "Nota fiscal não configurada",
    testa: tem(/Emissão fiscal desativada|Token do provedor|Cadastre o CNPJ|NF-e exige cliente/i),
    explicacao: "Para emitir nota o sistema precisa dos dados da empresa e do token do provedor (Focus NFe). Algum deles está faltando.",
    impacto: "Vendas funcionam; só a nota não sai.",
    causas: ["Emissão não ativada em Configurações › Nota fiscal.", "Token de homologação/produção não colado.", "CNPJ da empresa não cadastrado.", "NF-e sem cliente com CPF/CNPJ e endereço."],
    operador: ["Avise o gerente: a venda ficou registrada, a nota pode ser emitida depois em Vendas."],
    tecnico: ["Configurações › Nota fiscal: ative, cole os tokens (homologação e produção) e teste.", "Os tokens ficam em fiscal_credenciais (só a Edge Function lê)."],
    acoes: ["ir-config"], onde: ["supabase/functions/fiscal/index.ts"],
  },
  {
    id: "fiscal-rejeicao", area: "fiscal", gravidade: "media",
    titulo: "A SEFAZ rejeitou a nota",
    testa: tem(/Rejei[cç][aã]o|rejeitad|SEFAZ|CSC|certificado|NCM|CFOP|CSOSN|denegad/i),
    explicacao: "A nota chegou na Secretaria da Fazenda e foi recusada por algum dado fiscal. A mensagem da SEFAZ diz o motivo (geralmente com um código, ex.: “Rejeição 778: NCM inexistente”).",
    impacto: "Aquela nota não foi autorizada; a venda está registrada.",
    causas: ["NCM/CFOP/CSOSN do produto errado.", "Certificado A1 vencido no provedor.", "CSC da NFC-e errado.", "Dados do cliente incompletos (NF-e)."],
    operador: ["Avise o gerente com o número da venda."],
    tecnico: ["Pesquise o código da rejeição + “NFC-e” para o significado exato.", "Corrija o produto (NCM/CFOP/CSOSN) com o contador e reemita em Vendas.", "Certificado/CSC: painel do Focus NFe."],
    acoes: [], onde: ["supabase/functions/fiscal/index.ts"],
  },

  // ------------------------------------------------------------ PAGAMENTOS
  {
    id: "pagamento-mercadopago", area: "pagamento", gravidade: "media",
    titulo: "Falha ao falar com o Mercado Pago",
    testa: tem(/Mercado Pago|Cobrança automática não configurada|invalid.*access.?token|unauthorized.*payment|pix_criar|pix_status/i),
    explicacao: "O PIX com confirmação automática depende do Mercado Pago. Ele recusou ou não respondeu.",
    impacto: "O PIX automático falha; o PIX estático (QR com a chave da loja) continua funcionando.",
    causas: ["Token do Mercado Pago inválido, vencido ou de teste.", "Conta do Mercado Pago com restrição.", "Instabilidade no Mercado Pago."],
    operador: ["Use o PIX com a chave da loja e confira o recebimento no app do banco."],
    tecnico: ["Configurações › PIX: gere um novo Access Token de produção no Mercado Pago e salve.", "Logs da Edge Function pagamentos no Supabase mostram a resposta completa."],
    acoes: ["ir-config"], onde: ["supabase/functions/pagamentos/index.ts"],
  },

  // ------------------------------------------------------------ EDGE FUNCTIONS
  {
    id: "edge-nao-publicada", area: "servidor", gravidade: "alta",
    titulo: "Função do servidor não publicada",
    testa: ou(e(origem("funcao"), tem(/HTTP 404|not found|NOT_FOUND/i)), tem(/Requested function was not found/i)),
    explicacao: (ev, p) => `A Edge Function “${p.edge || "?"}”${EDGE[p.edge] ? ` (usada para ${EDGE[p.edge]})` : ""} não está publicada no Supabase.`,
    impacto: (ev, p) => `Para de funcionar: ${EDGE[p.edge] || "a ação que usa essa função"}.`,
    causas: ["A função nunca foi publicada neste projeto.", "Foi publicada com outro nome."],
    operador: ["Chame o suporte."],
    tecnico: (ev, p) => [`No terminal da pasta do projeto: supabase functions deploy ${p.edge || "<nome>"}${p.edge === "garcom-login" ? " --no-verify-jwt" : ""}`, "Confira em Supabase › Edge Functions se ela aparece na lista.", "Confira os Secrets que ela usa (ex.: RESEND_API_KEY para o resumo diário)."],
    acoes: ["testar"],
  },
  {
    id: "edge-falhou", area: "servidor", gravidade: "media",
    titulo: "Função do servidor respondeu com erro",
    testa: ou(origem("funcao"), tem(/non-2xx status code|FunctionsHttpError|FunctionsRelayError|FunctionsFetchError|Failed to send a request to the Edge Function/i)),
    explicacao: (ev, p) => `A Edge Function “${p.edge || "?"}” foi chamada mas não terminou bem${p.status ? ` (código ${p.status})` : ""}. A mensagem mostrada é a que ela devolveu.`,
    impacto: (ev, p) => `Falha em: ${EDGE[p.edge] || "a ação que chamou a função"}.`,
    causas: ["Secret (chave/token) faltando ou errado na função.", "Erro dentro da função (veja os logs).", "Sem internet no momento da chamada."],
    operador: ["Tente de novo em instantes. Se repetir, chame o suporte."],
    tecnico: (ev, p) => [`Supabase › Edge Functions › ${p.edge || "<função>"} › Logs no horário do erro.`, "Status 401/403: sessão/permissão. 400: dado ou configuração faltando (a mensagem diz qual). 500: exceção no código da função.", `Código: supabase/functions/${p.edge || "<função>"}/index.ts`],
    acoes: ["testar"],
  },

  // ------------------------------------------------------------ IMPRESSORA
  {
    id: "impressora-windows-driver", area: "impressora", gravidade: "alta",
    titulo: "O Windows não libera a impressora USB para o navegador",
    testa: e(ou(origem("impressora"), tem(/claim|transferOut|usb/i)), tem(/Unable to claim interface|Access denied|SecurityError|claimInterface|Failed to (open|claim)|is not allowed to access/i)),
    explicacao: "No modo “USB direto”, o navegador conversa sozinho com a impressora. Mas no Windows o driver do fabricante já está “segurando” a impressora, e o navegador não consegue usá-la ao mesmo tempo. É como duas pessoas tentando dirigir o mesmo carro.",
    impacto: "Cupom não imprime e gaveta não abre por USB direto.",
    causas: ["Driver da impressora (Elgin, Epson, Bematech…) instalado no Windows.", "Outro programa (outro PDV, utilitário do fabricante) usando a impressora.", "Outra aba do sistema aberta e já conectada à impressora."],
    operador: ["Feche outras abas do sistema e tente de novo.", "Enquanto isso, use Configurações › Impressora › “Pelo navegador”."],
    tecnico: ["Opção simples: modo “Pelo navegador” com a térmica como impressora padrão e atalho do Chrome com --kiosk-printing (imprime sem janela).",
      "Opção USB direto: com o Zadig (zadig.akeo.ie) troque o driver da impressora para WinUSB. Atenção: depois disso ela só imprime pelo navegador.",
      "Opção serial: instale o driver de porta COM virtual do fabricante e use o modo “porta serial”."],
    acoes: ["ir-config"], onde: ["app/js/impressao/escpos.js"],
  },
  {
    id: "impressora-desconectada", area: "impressora", gravidade: "alta",
    titulo: "Impressora não responde",
    testa: e(ou(origem("impressora"), tem(/impressora|transfer|serial|usb/i)), tem(/transfer error|device (was )?disconnected|device unavailable|NetworkError: A transfer|The device was disconnected|no longer available|Failed to execute 'write'|BreakError|BufferOverrunError|port is closed/i)),
    explicacao: "O sistema mandou o cupom, mas a impressora não recebeu. Ela foi desligada, desconectada ou ficou sem resposta.",
    impacto: "Cupom não imprime e a gaveta não abre.",
    causas: ["Impressora desligada, sem papel ou com tampa aberta.", "Cabo USB solto ou porta USB com mau contato.", "Bluetooth desconectou.", "Computador entrou em economia de energia e desligou a porta USB."],
    operador: ["Confira se a impressora está ligada, com papel e tampa fechada.", "Tire e ponha o cabo USB.", "Clique em “Testar impressão” em Configurações › Impressora."],
    tecnico: ["Desative “Suspensão seletiva de USB” nas opções de energia do Windows.", "Se trocar de porta USB, pareie de novo em Configurações › Impressora.", "Bluetooth: confirme o pareamento no Windows e a porta COM correta."],
    acoes: ["ir-config"], onde: ["app/js/impressao/escpos.js"],
  },
  {
    id: "impressora-porta-ocupada", area: "impressora", gravidade: "media",
    titulo: "Porta serial ocupada",
    testa: tem(/Failed to open serial port|port is already open|already open|InvalidStateError.*port/i),
    explicacao: "A porta COM só pode ser usada por um programa por vez. Outro programa (ou outra aba) já está com ela aberta.",
    impacto: "Impressora ou balança serial não funciona neste momento.",
    causas: ["Outra aba do sistema aberta.", "Programa da balança/impressora do fabricante aberto.", "Impressora e balança configuradas na MESMA porta."],
    operador: ["Feche outras abas e janelas do sistema e tente de novo."],
    tecnico: ["Gerenciador de Dispositivos › Portas (COM e LPT): confirme qual COM é a impressora e qual é a balança.", "Pareie de novo cada uma na sua tela (Impressora e Balança) — o sistema lembra qual é qual."],
    acoes: ["ir-config"], onde: ["app/js/serial-portas.js"],
  },
  {
    id: "impressora-nao-pareada", area: "impressora", gravidade: "media",
    titulo: "Nenhuma impressora pareada neste aparelho",
    testa: tem(/Nenhuma impressora (USB|serial) pareada|Modo de impressão inválido|não expõe uma saída compatível/i),
    explicacao: "O modo de impressão escolhido precisa que a impressora seja autorizada (pareada) neste navegador, uma única vez. Isso ainda não foi feito aqui — ou a impressora conectada não é uma térmica compatível.",
    impacto: "Cupom não imprime.",
    causas: ["Primeira vez neste computador/navegador.", "Dados do navegador foram limpos.", "Impressora trocada."],
    operador: ["Vá em Configurações › Impressora e clique em “Parear impressora”."],
    tecnico: ["Pareamento é por navegador e por perfil do Chrome.", "“Não expõe uma saída compatível”: a impressora não é ESC/POS por USB (use modo navegador)."],
    acoes: ["ir-config"],
  },

  // ------------------------------------------------------------ BALANÇA
  {
    id: "balanca-sem-resposta", area: "balanca", gravidade: "media",
    titulo: "A balança não respondeu",
    testa: tem(/balança não respondeu|Balança não pareada|Balança desconectou/i),
    explicacao: "O sistema pediu o peso e a balança não mandou resposta a tempo. Normalmente é cabo, porta ou configuração de comunicação diferente da balança.",
    impacto: "Produtos por peso precisam ser digitados à mão.",
    causas: ["Cabo serial/USB solto.", "Velocidade (baud) ou protocolo diferente do configurado na balança.", "Porta COM trocada (ligou em outra USB).", "Balança desligada ou em modo que não envia peso."],
    operador: ["Confira cabo e se a balança está ligada.", "Digite o peso manualmente enquanto isso."],
    tecnico: ["Configurações › Balança: confira protocolo (Toledo/Filizola/Urano/Elgin) e baud (geralmente 9600, 8N1).", "No menu da balança, confira o protocolo de comunicação (ex.: Toledo P03).", "Use o modo Simulador para isolar: se o simulador funciona, o problema é cabo/porta/configuração."],
    acoes: ["ir-config"], onde: ["app/js/balanca.js"],
  },
  {
    id: "balanca-leitura", area: "balanca", gravidade: "baixa",
    titulo: "Peso instável, negativo ou sobrecarga",
    testa: tem(/Peso instável|Sobrecarga|Peso negativo/i),
    explicacao: "A balança está avisando que não consegue dar um peso confiável agora.",
    impacto: "Espera o peso estabilizar.",
    causas: ["Produto ainda balançando.", "Balança sem tara (prato vazio mostrando negativo).", "Peso acima da capacidade."],
    operador: ["Espere parar, tare a balança com o prato vazio ou divida o produto."],
    tecnico: ["Comportamento normal da balança."],
    acoes: [],
  },

  // ------------------------------------------------------------ APARELHO E NAVEGADOR
  {
    id: "navegador-sem-suporte", area: "aparelho", gravidade: "media",
    titulo: "Este navegador não tem o recurso necessário",
    testa: tem(/Use o Google Chrome|navigator\.(usb|serial)|is not supported|not supported in this browser|Cannot read properties of undefined \(reading '(requestPort|requestDevice|getPorts|getDevices)'\)/i),
    explicacao: "Impressão direta e balança usam recursos (WebUSB e Web Serial) que só existem no Google Chrome e no Microsoft Edge de computador.",
    impacto: "Impressão direta e balança não funcionam neste navegador.",
    causas: ["Firefox, Safari ou navegador de celular.", "Página aberta sem HTTPS (fora do localhost)."],
    operador: ["Use o Google Chrome ou o Microsoft Edge no computador do caixa."],
    tecnico: ["WebUSB/Web Serial exigem contexto seguro (HTTPS ou localhost).", "No celular use impressão “Pelo navegador”."],
    acoes: [],
  },
  {
    id: "navegador-permissao", area: "aparelho", gravidade: "baixa",
    titulo: "O navegador bloqueou uma permissão",
    testa: tem(/NotAllowedError|play\(\) failed|didn't interact|permission (denied|dismissed)|Wake ?Lock|Notification/i),
    explicacao: "Por segurança, o navegador só libera som, notificações, área de transferência e “tela sempre acesa” depois de a pessoa clicar na página ou autorizar.",
    impacto: "Aviso sonoro/notificação/tela acesa podem não funcionar até um clique.",
    causas: ["Página aberta sem nenhum clique ainda (ex.: TV da cozinha).", "Notificações bloqueadas no cadeado da barra de endereço."],
    operador: ["Clique uma vez em qualquer lugar da tela.", "Libere notificações no cadeado ao lado do endereço."],
    tecnico: ["Para telas sem toque (cozinha/TV), Chrome: chrome://settings/content/sound e notificações › permitir para o domínio."],
    acoes: [],
  },
  {
    id: "seguranca-csp", area: "aparelho", gravidade: "media",
    titulo: "Endereço bloqueado pela segurança da página",
    testa: origem("seguranca"),
    explicacao: (ev) => `A página só pode falar com endereços de uma lista de confiança (Content-Security-Policy). Ela tentou acessar ${ev.tecnico?.bloqueado || "um endereço"} que não está na lista.`,
    impacto: "O recurso que usa esse endereço não funciona.",
    causas: ["Integração nova cujo domínio não foi adicionado à CSP.", "Extensão do navegador injetando conteúdo (nesse caso pode ignorar)."],
    operador: ["Chame o suporte."],
    tecnico: (ev) => [`Se o endereço é legítimo, acrescente-o na diretiva ${ev.tecnico?.diretiva || "connect-src/script-src"} da meta Content-Security-Policy em app/index.html (e garcom/index.html).`, "Se for chrome-extension:// ou algo desconhecido, é extensão do navegador: teste em janela sem extensões."],
    acoes: [], onde: ["app/index.html (Content-Security-Policy)"],
  },
  {
    id: "tempo-real", area: "internet", gravidade: "media",
    titulo: "Atualização em tempo real desconectada",
    testa: tem(/CHANNEL_ERROR|TIMED_OUT|realtime|WebSocket/i),
    explicacao: "Mesas, cozinha, delivery e avisos se atualizam sozinhos por uma conexão contínua (Realtime). Ela caiu.",
    impacto: "Telas não atualizam sozinhas (é preciso recarregar); pedidos novos podem não tocar som.",
    causas: ["Internet instável.", "Firewall/proxy bloqueando WebSocket (wss://).", "Muitas abas abertas do sistema."],
    operador: ["Recarregue a página (F5)."],
    tecnico: ["Libere wss://*.supabase.co no firewall/proxy.", "Supabase › Realtime: confira limites de conexões do plano."],
    acoes: ["recarregar"],
  },

  // ------------------------------------------------------------ ARQUIVOS / ATUALIZAÇÃO
  {
    id: "atualizacao-modulo", area: "atualizacao", gravidade: "alta",
    titulo: "Parte do sistema não carregou (atualização incompleta)",
    testa: tem(/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Expected a JavaScript module script|MIME type|Unexpected token '<'/i),
    explicacao: "Cada tela é baixada quando é aberta. O navegador tentou baixar o arquivo desta tela e não conseguiu — geralmente porque o sistema foi atualizado e o navegador ainda tem uma cópia velha misturada com a nova, ou a internet falhou nessa hora.",
    impacto: "Aquela tela não abre.",
    causas: ["Atualização publicada enquanto o sistema estava aberto.", "Cache do navegador/service worker com versão antiga.", "Arquivo não enviado na publicação (ou caminho com maiúscula diferente).", "Internet caiu na hora de abrir a tela."],
    operador: ["Clique em “Limpar cache e recarregar” (as vendas pendentes NÃO são apagadas)."],
    tecnico: ["Confira se o arquivo do alvo existe no servidor publicado (abra a URL).", "“MIME type text/html”: o servidor devolveu a página 404/index no lugar do .js — caminho errado.", "Ao publicar mudanças, aumente VERSAO em app/sw.js (e garcom/sw.js) para forçar a troca do cache."],
    acoes: ["limpar-cache"], onde: ["app/sw.js", "app/js/main.js (PAGINAS)"],
  },
  {
    id: "atualizacao-cdn", area: "atualizacao", gravidade: "alta",
    titulo: "Biblioteca externa não carregou",
    testa: ou(e(origem("recurso"), tem(/jsdelivr|cdnjs|googleapis|gstatic/i)), tem(/qrcode is not defined|JsBarcode is not defined|createClient/i)),
    explicacao: "O sistema usa algumas bibliotecas prontas baixadas de servidores públicos (QR Code, código de barras, Supabase). Uma delas não chegou.",
    impacto: "QR Code do PIX, códigos de barras ou o próprio sistema podem não funcionar.",
    causas: ["Antivírus/firewall/filtro de conteúdo bloqueando cdn.jsdelivr.net ou cdnjs.cloudflare.com.", "DNS do provedor com problema.", "Primeira abertura sem internet (sem cópia local ainda)."],
    operador: ["Recarregue a página com internet funcionando."],
    tecnico: ["Abra a URL da biblioteca (Detalhes técnicos) no navegador do cliente.", "Libere os domínios no antivírus/firewall ou troque o DNS (1.1.1.1 / 8.8.8.8).", "Depois de carregar uma vez, o service worker guarda a cópia para uso offline."],
    acoes: ["recarregar", "testar"], onde: ["app/index.html", "app/sw.js (CDN)"],
  },
  {
    id: "atualizacao-arquivo", area: "atualizacao", gravidade: "alta",
    titulo: "Arquivo do sistema não carregou",
    testa: origem("recurso"),
    explicacao: (ev) => `O navegador tentou baixar ${ev.tecnico?.alvo || "um arquivo"} e não conseguiu.`,
    impacto: "A parte do sistema que depende desse arquivo não funciona.",
    causas: ["Arquivo não publicado ou com nome diferente.", "Internet caiu durante o carregamento.", "Cache antigo."],
    operador: ["Clique em “Limpar cache e recarregar”."],
    tecnico: ["Abra a URL do arquivo diretamente.", "Confira a publicação (GitHub Pages/Netlify/Vercel) e maiúsculas/minúsculas do caminho."],
    acoes: ["limpar-cache"],
  },
  {
    id: "cep-falhou", area: "internet", gravidade: "baixa",
    titulo: "Busca de CEP não respondeu",
    testa: tem(/viacep|CEP (não encontrado|inválido)/i),
    explicacao: "O endereço é preenchido por um serviço público de CEP (ViaCEP). Ele não respondeu ou o CEP não existe.",
    impacto: "Só o preenchimento automático; dá para digitar o endereço.",
    causas: ["CEP digitado errado.", "Serviço ViaCEP fora do ar."],
    operador: ["Confira o CEP ou preencha o endereço manualmente."],
    tecnico: ["Teste https://viacep.com.br/ws/<cep>/json/ no navegador."],
    acoes: [],
  },

  // ------------------------------------------------------------ ERRO NO CÓDIGO
  {
    id: "codigo-bug", area: "codigo", gravidade: "alta",
    titulo: "Erro de programação",
    testa: ou(origem("js"), tem(/TypeError|ReferenceError|SyntaxError|RangeError|is not a function|is not defined|Cannot read propert|Cannot set propert|undefined is not|null is not|Maximum call stack/i)),
    explicacao: (ev, p) => `Uma parte do código tentou usar algo que não existia naquele momento (por exemplo, ler um dado que ainda não tinha chegado). Não é culpa de quem estava usando: é um defeito no código${p.local ? ` em ${p.local.arquivo}, linha ${p.local.linha}` : ""}.`,
    impacto: "A ação ou tela onde aconteceu para; o resto do sistema normalmente continua.",
    causas: ["Dado vazio/nulo que o código não esperava (ex.: produto sem categoria, loja sem configuração).", "Tela usada numa ordem que o código não previu (veja a trilha).", "Arquivos de versões diferentes misturados no cache."],
    operador: ["Recarregue a página e tente de novo.", "Se repetir, chame o suporte: o erro já ficou registrado com o passo a passo."],
    tecnico: (ev, p) => [p.local ? `Abra ${p.local.arquivo} na linha ${p.local.linha} (trecho mostrado abaixo).` : "Veja a pilha (stack) em Detalhes técnicos para achar arquivo e linha.",
      "Leia a trilha: os últimos cliques/telas mostram como reproduzir.", "Reproduza com o DevTools (F12) aberto em Sources, com breakpoint na linha.", "Se for “Cannot read properties of null/undefined (reading 'x')”: proteja com ?. ou verifique o dado antes.", "Se só acontece em um aparelho, limpe o cache (pode ser versão misturada)."],
    acoes: ["recarregar", "limpar-cache"],
  },
];

const DESCONHECIDO = {
  id: "desconhecido", area: "codigo", gravidade: "media",
  titulo: "Problema ainda não catalogado",
  explicacao: (ev) => `Aconteceu algo que o diagnóstico ainda não conhece: “${ev.mensagem}”. Os detalhes técnicos e a trilha abaixo mostram o contexto.`,
  impacto: "Desconhecido.",
  causas: ["Veja a mensagem original e o alvo em Detalhes técnicos."],
  operador: ["Tente de novo. Se repetir, gere o relatório e envie ao suporte."],
  tecnico: ["Leia a mensagem original e a trilha.", "Depois de entender, ensine o diagnóstico: acrescente uma entrada em app/js/diagnostico/catalogo.js (PROBLEMAS)."],
  acoes: ["testar"],
};

const resolver = (v, ev, p) => (typeof v === "function" ? v(ev, p) : v);

/** Recebe um evento e devolve o problema do catálogo, já com os textos preenchidos. */
export function diagnosticar(ev) {
  if (!ev) return { ...DESCONHECIDO };
  if (ev.tipo === "info" && !ev.problema) return { id: "info", area: "aparelho", gravidade: "info", titulo: ev.mensagem, explicacao: "Registro informativo.", causas: [], operador: [], tecnico: [], acoes: [] };
  const p = pistas(ev);
  // Venda offline presa vale mais que o motivo dela: sempre aparece como crítico
  const base = (ev.origem === "fila" && PROBLEMAS.find((x) => x.id === "offline-venda-recusada"))
    || PROBLEMAS.find((x) => { try { return x.testa(ev); } catch { return false; } }) || DESCONHECIDO;
  // Mensagens de regra mostradas na tela (aviso) nunca são "críticas"
  let gravidade = ev.gravidade || base.gravidade;
  if (ev.tipo === "aviso" && base.area === "codigo" && ev.origem === "console") gravidade = "media";
  return {
    id: base.id, area: base.area, gravidade, titulo: base.titulo,
    explicacao: resolver(base.explicacao, ev, p),
    impacto: resolver(base.impacto, ev, p),
    causas: resolver(base.causas, ev, p) || [],
    operador: resolver(base.operador, ev, p) || [],
    tecnico: resolver(base.tecnico, ev, p) || [],
    acoes: base.acoes || [], sql: base.sql || null, onde: base.onde || [], pistas: p,
  };
}
