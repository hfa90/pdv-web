// Envia os erros deste aparelho ao servidor (tabela diagnostico_eventos), para o
// suporte ver de longe, no painel Diagnóstico › Lojas, o que está acontecendo
// em cada loja — antes mesmo de o cliente ligar.
// Silencioso: sem internet, sem login ou sem a migração 017, só tenta depois.
import { sb } from "../api.js";
import { estado } from "../estado.js";
import { aparelhoId, aparelhoNome } from "../contingencia.js";

let timer = null, enviando = false, semMigracao = false;

async function enviar() {
  const D = window.lisDiag;
  if (enviando || semMigracao || !D || !navigator.onLine || !estado.perfil) return;
  // Só o que importa para o suporte: erros e avisos que não são regras do dia a dia
  const pend = D.pendentesEnvio().filter((e) => e.tipo === "erro" || ["critica", "alta", "media"].includes(e.gravidade)).slice(-30);
  if (!pend.length) return;
  enviando = true;
  try {
    const p = pend.map((e) => ({
      ocorrido_em: new Date(e.ultimo_em || e.em).toISOString(), problema: e.problema || null, gravidade: e.gravidade || null,
      origem: e.origem, mensagem: e.mensagem, vezes: e.vezes || 1, rota: e.contexto?.rota || null, versao_app: e.versao,
      navegador: (navigator.userAgent.match(/(Edg|OPR|Chrome|Firefox|Safari)\/\d+/) || [""])[0],
      tecnico: e.tecnico || {}, trilha: (e.trilha || []).slice(-10),
    }));
    const { error } = await sb.rpc("diagnostico_registrar", { p_eventos: p, p_aparelho: aparelhoId(), p_aparelho_nome: aparelhoNome() });
    if (error) {
      if (/diagnostico_registrar|PGRST202|schema cache/.test(error.message || "")) semMigracao = true; // migração 017 ainda não aplicada
      return;
    }
    D.marcarEnviados(pend.map((e) => e.id));
    // O que não importa para o suporte também sai da lista de pendentes
    D.marcarEnviados(D.pendentesEnvio().filter((e) => !pend.includes(e)).filter((e) => e.tipo !== "erro" && !["critica", "alta", "media"].includes(e.gravidade)).map((e) => e.id));
  } catch { /* tenta depois */ } finally { enviando = false; }
}

export function iniciarEnvio() {
  if (timer) return;
  window.lisDiag?.definirContexto(() => ({
    loja: estado.empresa?.nome_fantasia || estado.empresa?.razao_social || null,
    usuario: estado.perfil?.nome || null, papel: estado.perfil?.papel || null,
    caixa_aberto: !!estado.caixa, offline: !!estado.offline, aparelho: aparelhoNome(),
  }));
  // Erro grave: envia logo; o resto vai de minuto em minuto
  window.lisDiag?.ouvir((ev) => { if (ev && ["critica", "alta"].includes(ev.gravidade)) setTimeout(enviar, 3000); });
  window.addEventListener("online", () => setTimeout(enviar, 5000));
  timer = setInterval(enviar, 60000);
  setTimeout(enviar, 8000);
}
