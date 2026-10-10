// =====================================================================
// Busca da Central de Ajuda — SEM IA.
// ---------------------------------------------------------------------
// Funciona como um "Google" pequeno, todo dentro do navegador:
//   1. normaliza o texto (minúsculas, sem acento, sem pontuação);
//   2. joga fora palavras vazias ("como", "eu", "o", "pra"...);
//   3. troca o jeito leigo de falar pelos sinônimos (SINONIMOS);
//   4. aceita erro de digitação (distância de edição) e começo de palavra;
//   5. dá nota por onde a palavra apareceu (título vale mais que o texto);
//   6. mostra só o que o nível da pessoa pode usar.
// Mensagens de erro coladas ou lidas de um print também passam pelo
// catálogo do Diagnóstico (diagnosticar), que reconhece o problema.
// =====================================================================
import { ARTIGOS, GLOSSARIO, SINONIMOS, CATEGORIAS } from "./artigos.js";
import { PROBLEMAS, diagnosticar } from "../diagnostico/catalogo.js";

const PARADAS = new Set(("a o e as os um uma uns umas de do da dos das no na nos nas em por para pra pro pras pros com sem que se " +
  "eu tu ele ela nos voces voce vc vcs meu minha meus minhas seu sua seus suas isso isto esse essa este esta aquele aquela ai la " +
  "como onde quando qual quais quem porque pq por que oque sobre ao aos ate mas ou ja tem ter tenho ta to estou esta estao foi " +
  "fazer faco faz consigo consegue conseguir posso pode podemos preciso precisa quero queria gostaria saber sei me te lhe mim " +
  "favor ola oi bom dia tarde noite obrigado obrigada ajuda ajudar help sistema programa sistemas tela tem algum alguma la aqui " +
  "entao tipo assim muito mais menos bem so tambem tb nao")
  .split(" "));
// "nao" sai das buscas (quase toda dúvida tem "não"), mas o texto continua com ele para a frase exata

export const normalizar = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/ç/g, "c").replace(/[^a-z0-9]+/g, " ").trim();

/** Raiz simples do português: tira plural e algumas terminações (imprimindo → imprim). */
export function raiz(p) {
  if (p.length <= 3 || /^\d+$/.test(p)) return p;
  return p.replace(/(amento|imento|acoes|icoes|mente|ando|endo|indo|ados|idas|idos|adas|ador|cao|coes|oes|aes|ais|eis|ar|er|ir|ou|ei|ado|ido|ada|ida|es|s)$/, "")
    .replace(/(.{3,})[aeo]$/, "$1");
}

const palavras = (s) => normalizar(s).split(" ").filter((p) => p.length > 1 || /\d/.test(p));
const chaves = (s) => palavras(s).filter((p) => !PARADAS.has(p));

// Mapa palavra → grupo de sinônimos (pela raiz)
const GRUPO = new Map();
SINONIMOS.forEach((g, i) => g.forEach((w) => palavras(w).forEach((p) => { const r = raiz(p); if (!GRUPO.has(r)) GRUPO.set(r, new Set()); GRUPO.get(r).add(i); })));
const RAIZES_GRUPO = SINONIMOS.map((g) => [...new Set(g.flatMap((w) => palavras(w).map(raiz)))]);

/** Distância de edição (Damerau simples), parando cedo quando passa do limite. */
function distancia(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let ant2 = null, ant = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i]; let menor = i;
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + custo);
      if (ant2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, ant2[j - 2] + 1);
      cur[j] = v; if (v < menor) menor = v;
    }
    if (menor > max) return max + 1;
    ant2 = ant; ant = cur;
  }
  return ant[n];
}
const tolerancia = (p) => (p.length >= 8 ? 2 : p.length >= 5 ? 1 : 0);

// ---------------------------------------------------------------------
// Índice: artigos + glossário + problemas do diagnóstico
// ---------------------------------------------------------------------
const PESOS = { titulo: 6, termos: 4, resumo: 2.2, corpo: 1 };
const textoDe = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : typeof v === "string" ? v : "");

function montarDocs() {
  const docs = ARTIGOS.map((a) => ({ ...a, tipo: "artigo" }));
  for (const [termo, def] of GLOSSARIO) {
    docs.push({ id: "o-que-e-" + normalizar(termo).replace(/ /g, "-"), tipo: "glossario", cat: "glossario", niveis: null,
      titulo: `O que é ${termo}?`, termos: termo + " significa significado o que e quer dizer", resumo: def });
  }
  for (const p of PROBLEMAS) {
    const operador = Array.isArray(p.operador) ? p.operador : [];
    if (!operador.length || typeof p.explicacao !== "string") continue;   // só os que já têm texto pronto
    docs.push({ id: "problema-" + p.id, tipo: "problema", cat: "problemas", niveis: null, area: p.area, gravidade: p.gravidade,
      titulo: p.titulo, termos: `erro problema ${p.area} ${textoDe(p.causas)}`, resumo: p.explicacao,
      impacto: typeof p.impacto === "string" ? p.impacto : "", passos: operador, causas: Array.isArray(p.causas) ? p.causas : [],
      tecnico: Array.isArray(p.tecnico) ? p.tecnico : [] });
  }
  for (const d of docs) {
    const campos = {
      titulo: d.titulo, termos: d.termos, resumo: d.resumo,
      corpo: [textoDe(d.passos), textoDe(d.dicas), textoDe(d.atencao), textoDe(d.impacto), textoDe(d.causas)].join(" "),
    };
    d._idx = {};
    for (const [k, v] of Object.entries(campos)) d._idx[k] = new Set(chaves(v).map(raiz));
    d._frase = normalizar(`${d.titulo} ${d.termos || ""}`);
    d._titulo = normalizar(d.titulo);
  }
  return docs;
}
let DOCS = null;
export const documentos = () => (DOCS ||= montarDocs());
export const porId = (id) => documentos().find((d) => d.id === id) || null;

// Vocabulário (para "Você quis dizer…")
let VOCAB = null;
function vocabulario() {
  if (VOCAB) return VOCAB;
  const mapa = new Map();
  for (const d of documentos()) for (const p of chaves(`${d.titulo} ${d.termos || ""} ${d.resumo || ""}`)) if (p.length >= 4) mapa.set(p, (mapa.get(p) || 0) + 1);
  SINONIMOS.flat().forEach((w) => palavras(w).forEach((p) => p.length >= 4 && mapa.set(p, (mapa.get(p) || 0) + 3)));
  VOCAB = mapa;
  VOCAB.raizes = new Set([...mapa.keys()].map(raiz));
  return VOCAB;
}

// ---------------------------------------------------------------------
// Quem vê o quê
// ---------------------------------------------------------------------
/** perfil: { papel, equipe: bool, super: bool } */
export function podeVer(d, perfil = {}) {
  if (d.soSuper && !perfil.super) return false;
  if (d.soEquipe && !perfil.equipe) return false;
  if (perfil.equipe || perfil.super) return true;
  return !d.niveis || d.niveis.includes(perfil.papel);
}

// ---------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------
/** Uma palavra da pergunta contra um campo do artigo: 1 exato, 0.85 começo, 0.7 erro de digitação. */
function casar(r, conjunto, cacheFuzzy) {
  if (conjunto.has(r)) return 1;
  let melhor = 0;
  const tol = tolerancia(r);
  for (const t of conjunto) {
    if (r.length >= 3 && t.length >= 3 && (t.startsWith(r) || r.startsWith(t)) && Math.min(r.length, t.length) >= 4) { melhor = Math.max(melhor, 0.85); continue; }
    if (tol && melhor < 0.7) {
      const k = r + "|" + t;
      let dist = cacheFuzzy.get(k);
      if (dist === undefined) { dist = distancia(r, t, tol); cacheFuzzy.set(k, dist); }
      if (dist <= tol) melhor = Math.max(melhor, 0.7);
    }
  }
  return melhor;
}

/**
 * Busca. Devolve { resultados: [{doc, nota, motivo}], quisDizer, problema, termos }.
 * opcoes: { perfil, rota (tela atual: dá um empurrãozinho), limite }
 */
export function buscar(pergunta, { perfil = {}, rota = null, limite = 12 } = {}) {
  const texto = String(pergunta || "").slice(0, 3000);
  const termos = [...new Set(chaves(texto))].slice(0, 40);
  const saida = { resultados: [], quisDizer: null, problema: null, termos };
  if (!termos.length) return saida;

  // Cada palavra vira: ela mesma (peso 1) + os sinônimos dela (peso 0.75)
  const grupos = termos.map((p) => {
    const r = raiz(p);
    const alternativas = new Map([[r, 1]]);
    for (const gi of GRUPO.get(r) || []) for (const s of RAIZES_GRUPO[gi]) if (!alternativas.has(s)) alternativas.set(s, 0.75);
    return { p, r, alternativas };
  });

  const frase = normalizar(texto);
  const cache = new Map();
  const notas = [], ocultos = [];
  for (const d of documentos()) {
    const visivel = podeVer(d, perfil);
    if (!visivel && (d.soSuper || d.soEquipe)) continue;
    let nota = 0, acertos = 0;
    for (const g of grupos) {
      let melhor = 0;
      for (const [campo, peso] of Object.entries(PESOS)) {
        for (const [alt, pa] of g.alternativas) {
          if (peso * pa <= melhor) continue;
          const m = casar(alt, d._idx[campo], cache);
          if (m) melhor = Math.max(melhor, peso * pa * m);
        }
      }
      if (melhor) { nota += melhor; acertos++; }
    }
    if (!acertos) continue;
    // Cobrir a pergunta inteira vale muito mais do que repetir uma palavra
    const cobertura = acertos / grupos.length;
    nota *= 0.35 + cobertura * cobertura;
    if (frase.length > 6 && d._frase.includes(frase)) nota += 8;          // frase exata
    else if (d._titulo.length > 4 && frase.includes(d._titulo)) nota += 5; // pergunta contém o título
    // Título curto e todo coberto pela pergunta ("Abrir o caixa") ganha de título longo ("Tela Caixa: abrir, sangria…")
    const tit = d._idx.titulo;
    if (tit.size) { let n = 0; for (const t of tit) if (grupos.some((g) => g.alternativas.has(t))) n++; nota += 3 * (n / tit.size); }
    if (rota && d.rota === rota) nota *= 1.15;
    if (d.tipo === "glossario") nota *= termos.length <= 3 ? 1 : 0.6;
    if (d.tipo === "problema") nota *= 0.9;
    (visivel ? notas : ocultos).push({ doc: d, nota, cobertura });
  }
  notas.sort((a, b) => b.nota - a.nota);
  const topo = notas[0]?.nota || 0;
  // corta o que ficou muito abaixo do melhor resultado
  saida.resultados = notas.filter((n) => n.nota >= Math.max(1.2, topo * 0.18)).slice(0, limite);
  // O que a pessoa procura existe, mas é tarefa de outro nível (ex.: caixa perguntando como mudar preço)
  ocultos.sort((a, b) => b.nota - a.nota);
  if (ocultos[0] && ocultos[0].cobertura >= 0.5 && ocultos[0].nota > Math.max(4, topo * 1.1)) saida.outroNivel = ocultos[0].doc;

  // "Você quis dizer": troca as palavras que não existem pela mais parecida do vocabulário
  const vocab = vocabulario();
  let trocou = false;
  const corrigida = termos.map((p) => {
    if (p.length < 4 || vocab.has(p) || vocab.raizes.has(raiz(p)) || /\d/.test(p)) return p;
    let melhor = null, md = 9, mf = 0;
    const tol = tolerancia(p) || 1;
    for (const [v, f] of vocab) {
      if (Math.abs(v.length - p.length) > tol) continue;
      const dist = distancia(p, v, tol);
      if (dist <= tol && (dist < md || (dist === md && f > mf))) { melhor = v; md = dist; mf = f; }
    }
    if (melhor && melhor !== p) { trocou = true; return melhor; }
    return p;
  });
  if (trocou) saida.quisDizer = corrigida.join(" ");

  // Parece mensagem de erro? Pergunta ao catálogo do Diagnóstico
  saida.problema = reconhecerErro(texto);
  return saida;
}

/** Usa o catálogo do Diagnóstico para reconhecer uma mensagem de erro (colada ou lida de um print). */
export function reconhecerErro(texto) {
  const t = String(texto || "").trim();
  if (t.length < 6) return null;
  try {
    const r = diagnosticar({ tipo: "erro", origem: "ajuda", mensagem: t.slice(0, 1500), tecnico: { mensagem_original: t.slice(0, 1500) } });
    if (!r || ["desconhecido", "codigo-bug", "info"].includes(r.id)) return null;
    return r;
  } catch { return null; }
}

/** Sugestões enquanto digita: títulos que começam/contêm o que já foi digitado. */
export function sugerir(parcial, { perfil = {}, limite = 6 } = {}) {
  const n = normalizar(parcial);
  if (n.length < 2) return [];
  const ultimas = n.split(" ");
  const ini = ultimas.slice(0, -1).join(" "), fim = ultimas[ultimas.length - 1];
  const out = [];
  for (const d of documentos()) {
    if (!podeVer(d, perfil) || d.tipo === "problema") continue;
    const t = d._titulo;
    const ok = t.includes(n) || (fim.length >= 2 && (!ini || t.includes(ini)) && t.split(" ").some((w) => w.startsWith(fim)));
    if (ok) out.push(d);
    if (out.length >= limite * 3) break;
  }
  return out.sort((a, b) => (a._titulo.indexOf(n) === -1 ? 99 : a._titulo.indexOf(n)) - (b._titulo.indexOf(n) === -1 ? 99 : b._titulo.indexOf(n))).slice(0, limite);
}

export const nomeCategoria = (k) => CATEGORIAS.find((c) => c[0] === k)?.[1] || "";
export const iconeCategoria = (k) => CATEGORIAS.find((c) => c[0] === k)?.[2] || "caderno";
export { CATEGORIAS };
