// Interpretação de pedidos falados em português, direto no aparelho (sem internet e sem custo).
// Entrada: o texto reconhecido + o catálogo + as mesas. Saída: mesa, pessoas e itens com
// quantidade, observação e grau de certeza. A regra de ouro: nunca chutar em silêncio.
// Quando há dúvida (dois produtos parecidos, peso não dito, palavra desconhecida) o item volta
// marcado para o garçom escolher no resumo, antes de qualquer coisa ir para a cozinha.

export const semAcento = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const NUMEROS = {
  um: 1, uma: 1, hum: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
  dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezasseis: 16,
  dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60,
  setenta: 70, oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300,
  trezentas: 300, quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500, seiscentos: 600,
  setecentos: 700, oitocentos: 800, novecentos: 900, mil: 1000,
};
const UNIDADES = {
  l: "l", lt: "l", litro: "l", litros: "l", ml: "ml", mililitro: "ml", mililitros: "ml",
  kg: "kg", quilo: "kg", quilos: "kg", kilo: "kg", kilos: "kg", quilograma: "kg", quilogramas: "kg",
  g: "g", gr: "g", grama: "g", gramas: "g",
};
const FRACIONADOS = ["KG", "G", "L", "ML", "M"];
// Frases que o garçom fala mas não são pedido
const ENCHIMENTO = [
  "por favor", "por gentileza", "me ve", "me da", "me traz", "me traga", "traz", "traga", "manda", "mande", "anota ai", "anota",
  "eu quero", "a gente quer", "vou querer", "vamos querer", "quero", "queria", "vai ser", "pode ser", "pode mandar", "pra mim",
  "pra gente", "tambem", "entao", "beleza", "so isso", "e so", "isso ai", "pedido", "ok", "ai", "ne",
];
// Palavras que não ajudam a achar o produto
const VAZIAS = new Set(["de", "da", "do", "das", "dos", "d", "a", "o", "as", "os", "com", "e", "no", "na", "nos", "nas", "em", "pra", "para", "pro", "um", "uma", "uns", "umas", "the"]);
// Palavras que costumam abrir uma observação para a cozinha
const OBS = new Set(["sem", "com", "bem", "mal", "ao", "no", "pouco", "pouca", "muito", "muita", "mais", "menos", "extra", "separado", "separada",
  "gelado", "gelada", "trincando", "natural", "quente", "morno", "morna", "viagem", "levar", "embalar", "tirar", "trocar", "caprichado", "caprichada",
  "capricha", "zero", "light", "duplo", "dupla", "acompanha", "acompanhando", "metade", "molho", "ponto"]);
const SEPARADORES = new Set([",", "e", ";", "."]);
const ehObs = (t) => OBS.has(t) || OBS.has(t.replace(/s$/, ""));
// Palavras que só distinguem uma variação ("Coca" x "Coca Zero"): se o garçom não falou, é o produto base
const MODIFICADORES = new Set(["zero", "diet", "light", "sem", "meia", "meio", "mini", "grande", "pequeno", "pequena", "media", "medio",
  "duplo", "dupla", "triplo", "especial", "kids", "infantil", "integral", "fit", "extra", "gelado", "gelada"].map((w) => fon(w)));
const ehTamanho = (k) => /^\d/.test(k) || ["l", "ml", "kg", "g"].includes(k);

/** Separa o texto em palavras, guardando a forma original (para a observação) e a normalizada (para comparar). */
export function palavras(texto) {
  let s = String(texto ?? "")
    .replace(/(\d),(\d)/g, "$1.$2")                  // 1,5 -> 1.5
    .replace(/(\d)[x×]\s+(?=\D)/gi, "$1 ")         // "2x coca" -> "2 coca" (mas "2 x tudo" fica)
    .replace(/(\d)([a-zà-ú])/gi, "$1 $2").replace(/([a-zà-ú])(\d)/gi, "$1 $2")
    .replace(/[-_/+]/g, " ")
    .replace(/([,;.!?])(?!\d)/g, " $1 ");
  const brutas = s.split(/\s+/).filter(Boolean);
  const out = [];
  for (const o of brutas) {
    let t = semAcento(o).replace(/[^a-z0-9.,;]/g, "");
    if (!t) continue;
    if (t === "!" || t === "?") continue;
    if (t === "xis" || t === "xiz" || t === "chis") t = "x";
    if (UNIDADES[t]) t = UNIDADES[t];
    out.push({ o: o.replace(/[!?]/g, ""), t });
  }
  // Tira frases de enchimento ("me vê", "por favor"...)
  const limpas = [];
  for (let i = 0; i < out.length; i++) {
    let pulou = 0;
    for (const f of ENCHIMENTO) {
      const fs = f.split(" ");
      if (fs.every((w, k) => out[i + k]?.t === w)) { pulou = fs.length; break; }
    }
    if (pulou) { i += pulou - 1; continue; }
    limpas.push(out[i]);
  }
  return juntarNumeros(limpas);
}

const valorNum = (t) => (/^\d+(\.\d+)?$/.test(t) ? Number(t) : NUMEROS[t]);

/** "vinte e um" -> 21; "trezentos e cinquenta" -> 350; "um e meio" -> 1.5; "meio quilo" -> 0.5 kg. */
function juntarNumeros(ps) {
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if ((p.t === "meio" || p.t === "meia") && ["kg", "l", "g", "ml"].includes(ps[i + 1]?.t)) { out.push({ ...p, n: 0.5 }); continue; }
    let n = valorNum(p.t);
    if (n == null) { out.push(p); continue; }
    let o = p.o, j = i;
    while (ps[j + 1]?.t === "e" && ps[j + 2]) {
      const prox = valorNum(ps[j + 2].t);
      const extenso = NUMEROS[ps[j + 2].t] != null && NUMEROS[ps[j].t] != null;
      if (prox != null && extenso && ((n >= 20 && n < 100 && prox < 10) || (n >= 100 && prox < 100) || (n >= 1000 && prox < 1000))) {
        n += prox; o += " e " + ps[j + 2].o; j += 2; continue;
      }
      if ((ps[j + 2].t === "meio" || ps[j + 2].t === "meia") && n < 20) { n += 0.5; o += " e meio"; j += 2; continue; }
      break;
    }
    // "1 quilo e meio"
    if (["kg", "l"].includes(ps[j + 1]?.t) && ps[j + 2]?.t === "e" && ["meio", "meia"].includes(ps[j + 3]?.t)) {
      out.push({ o, t: String(n + 0.5), n: n + 0.5 }, ps[j + 1]); i = j + 3; continue;
    }
    out.push({ o, t: String(n), n });
    i = j;
  }
  return out;
}

// ---------- Comparação aproximada (erros do reconhecimento de voz) ----------
/** Chave fonética simples do português: "coca"≈"koka", "chopp"≈"xop", "hamburguer"≈"amburger". */
export function fon(w) {
  if (/^\d/.test(w)) return w;
  let s = w
    .replace(/ph/g, "f").replace(/ch|sh/g, "x").replace(/lh/g, "li").replace(/nh/g, "ni")
    .replace(/sc(?=[ei])/g, "s").replace(/qu(?=[ei])/g, "k").replace(/qu/g, "ku").replace(/gu(?=[ei])/g, "g")
    .replace(/c(?=[ei])/g, "s").replace(/c/g, "k").replace(/z$/g, "s").replace(/w/g, "v").replace(/y/g, "i")
    .replace(/h/g, "").replace(/(.)\1+/g, "$1");
  if (s.length > 3) s = s.replace(/(oe|ae)s$/, "ao").replace(/([rsz])es$/, "$1").replace(/s$/, "");
  return s;
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let ant = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    ant = cur;
  }
  return ant[n];
}

function parecido(a, b) {
  if (a === b) return 1;
  const na = /^\d/.test(a), nb = /^\d/.test(b);
  if (na || nb) return na && nb && Number(a) === Number(b) ? 1 : 0;
  if (a.length >= 3 && b.startsWith(a)) return 0.88;      // "refri" ~ "refrigerante"
  if (b.length >= 4 && a.startsWith(b)) return 0.85;
  const r = 1 - lev(a, b) / Math.max(a.length, b.length);
  return r >= 0.67 ? r : 0;
}

const chaves = (ws) => ws.filter((w) => !VAZIAS.has(w)).map(fon);

/** Prepara o catálogo uma vez (chaves fonéticas de cada produto). */
export function prepararCatalogo(produtos) {
  return produtos.map((p) => {
    const ws = palavras(p.nome).map((x) => x.t).filter((t) => !SEPARADORES.has(t));
    return { p, k: chaves(ws), nome: ws.join(" "), codigo: semAcento(p.codigo || "") };
  });
}

/** Quanto as palavras faladas combinam com um produto (0 a 1). */
function pontuar(fal, prod) {
  if (!fal.length || !prod.k.length) return { s: 0, cobre: 0 };
  let soma = 0, cobre = 0;
  for (const f of fal) { const m = Math.max(...prod.k.map((k) => parecido(f, k))); soma += m; if (m >= 0.85) cobre++; }
  const rec = soma / fal.length;
  let prec = 0;
  for (const k of prod.k) prec += Math.max(...fal.map((f) => parecido(f, k)));
  prec /= prod.k.length;
  const sobra = prod.k.filter((k) => !ehTamanho(k) && Math.max(...fal.map((f) => parecido(f, k))) < 0.85);
  const nk = prod.k.filter((k) => !ehTamanho(k)).length;
  return { s: 0.68 * rec + 0.32 * prec + (prod.p.favorito ? 0.004 : 0), rec, cobre: cobre / fal.length, sobra, nk };
}

function melhores(ws, cat, aprendido) {
  const fal = chaves(ws.map((w) => w.t));
  if (!fal.length) return [];
  const frase = fal.join(" ");
  const ap = aprendido?.[frase];
  if (ap) { const x = cat.find((c) => c.p.id === ap); if (x) return [{ c: x, s: 1, rec: 1, aprendido: true }]; }
  if (fal.length === 1 && /^\d+$/.test(fal[0])) {
    const x = cat.find((c) => c.codigo && c.codigo === fal[0]);
    if (x) return [{ c: x, s: 0.97, rec: 1 }];
  }
  return cat.map((c) => ({ c, ...pontuar(fal, c) })).filter((r) => r.s > 0.25).sort((a, b) => b.s - a.s).slice(0, 6);
}

// ---------- Segmentação do pedido ----------
function segmentar(ps) {
  const segs = [];
  let cur = null;
  const novo = (q = null, un = null, sep = false) => { cur = { q, un, ws: [], sep }; segs.push(cur); };
  novo();
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], prox = ps[i + 1];
    if (SEPARADORES.has(p.t)) {
      // "e" dentro de observação ("sem cebola e sem tomate") é tratado depois, na junção
      if (cur.ws.length || cur.q != null) novo(null, null, true);
      continue;
    }
    if (p.t === "mais" || p.t === "outro" || p.t === "outra") {
      if (prox?.n != null || p.t !== "mais") { if (cur.ws.length) novo(null, null, true); if (p.t !== "mais") cur.q = cur.q ?? 1; continue; }
    }
    if (p.n != null) {
      const un = prox && ["kg", "g", "l", "ml"].includes(prox.t) ? prox.t : null;
      if (un) {
        if (!cur.ws.length && (cur.un == null)) { cur.qUn = p.n; cur.un = un; cur.qAntes = cur.q; i++; if (ps[i + 1]?.t === "de") i++; continue; }
        cur.ws.push(p, prox); i++; continue;     // "coca 2 litros" faz parte do nome
      }
      if (!cur.ws.length && cur.q == null && p.n <= 99) { cur.q = p.n; continue; }
      if (cur.ws.length && p.n <= 50 && Number.isInteger(p.n)) { novo(p.n); continue; }
      cur.ws.push(p); continue;                   // "skol 600", código do produto
    }
    cur.ws.push(p);
  }
  return segs.filter((s) => s.ws.length || s.q != null || s.un);
}

/** Dentro do trecho, separa o nome do produto da observação ("x tudo | sem cebola"). */
function produtoEObs(seg, cat, aprendido) {
  const ws = seg.ws;
  const cortes = [ws.length];
  for (let i = 1; i < ws.length; i++) if (ehObs(ws[i].t)) cortes.push(i);
  let melhor = null;
  for (const c of cortes) {
    const r = melhores(ws.slice(0, c), cat, aprendido);
    const s = r[0]?.s ?? 0;
    if (!melhor || s > melhor.s + 0.02 || (Math.abs(s - melhor.s) <= 0.02 && c > melhor.c)) melhor = { c, s, r };
  }
  return { ...melhor, nome: ws.slice(0, melhor.c), obs: ws.slice(melhor.c) };
}

const texto = (ws) => ws.map((w) => w.o).join(" ").replace(/\s+([,.;])/g, "$1").trim();
const arred = (n) => Math.round(n * 1000) / 1000;

function converter(q, un, unidadeProduto) {
  const u = unidadeProduto;
  if (un === "g" && u === "KG") return q / 1000;
  if (un === "kg" && u === "G") return q * 1000;
  if (un === "ml" && u === "L") return q / 1000;
  if (un === "l" && u === "ML") return q * 1000;
  return q;
}

/**
 * Interpreta o texto falado.
 * @param {string} fala texto reconhecido
 * @param {{produtos:object[], catalogoPreparado?:object[], mesas?:object[], aprendido?:Record<string,string>}} ctx
 * @returns {{mesa:number|null, pessoas:number|null, itens:object[], nao_entendidos:string[]}}
 */
export function interpretar(fala, { produtos, catalogoPreparado, mesas = [], aprendido = {} }) {
  const cat = catalogoPreparado || prepararCatalogo(produtos);
  let ps = palavras(fala);
  let mesa = null, pessoas = null;

  // "mesa 12", "mesa doze"
  for (let i = 0; i < ps.length - 1; i++) {
    if (/^mesas?$/.test(ps[i].t) && ps[i + 1].n != null && Number.isInteger(ps[i + 1].n)) {
      mesa = ps[i + 1].n;
      const ini = ["na", "pra", "para", "da", "a"].includes(ps[i - 1]?.t) ? i - 1 : i;
      ps = [...ps.slice(0, ini), { o: ",", t: "," }, ...ps.slice(i + 2)];
      break;
    }
  }
  // "4 pessoas", "somos 3"
  for (let i = 0; i < ps.length - 1; i++) {
    if (ps[i].n != null && /^(pessoas?|lugares)$/.test(ps[i + 1].t)) {
      pessoas = ps[i].n;
      const ini = ["com", "pra", "para", "sao", "somos"].includes(ps[i - 1]?.t) ? i - 1 : i;
      ps = [...ps.slice(0, ini), { o: ",", t: "," }, ...ps.slice(i + 2)];
      break;
    }
  }
  if (mesa != null && !mesas.some((m) => Number(m.numero) === mesa)) {
    // número dito não é mesa cadastrada: devolve como está, a tela pede para escolher
  }

  const segs = segmentar(ps);
  const itens = [], nao = [];
  let ultimo = null;
  for (const seg of segs) {
    if (!seg.ws.length) { if (seg.q != null || seg.un) nao.push(seg.un ? `${seg.qUn} ${seg.un}` : String(seg.q)); continue; }
    let r = produtoEObs(seg, cat, aprendido);
    let q = seg.q ?? 1, un = null;

    if (seg.un) {
      const top = r.r[0]?.c.p;
      if (top && FRACIONADOS.includes(top.unidade)) { q = converter(seg.qUn, seg.un, top.unidade); un = seg.un; if (seg.qAntes != null) q *= seg.qAntes; }
      else {
        // "2 litros de coca": o volume faz parte do nome do produto
        const comVolume = { ...seg, ws: [{ o: String(seg.qUn), t: String(seg.qUn), n: seg.qUn }, { o: seg.un, t: seg.un }, ...seg.ws] };
        const r2 = produtoEObs(comVolume, cat, aprendido);
        if ((r2.r[0]?.s ?? 0) >= (r.r[0]?.s ?? 0)) r = r2;
        q = seg.qAntes ?? 1;
      }
    }

    const top = r.r[0];
    const ehObsSolta = !seg.q && !seg.un && ehObs(seg.ws[0].t) && (!top || top.s < 0.78);
    // "duas cocas, uma sem gelo": separa parte do item anterior com a observação
    if (ultimo && seg.q != null && !seg.un && ehObs(seg.ws[0].t) && (!top || top.s < 0.78) && seg.q < ultimo.quantidade) {
      ultimo.quantidade = arred(ultimo.quantidade - seg.q);
      const parte = { ...ultimo, quantidade: seg.q, observacao: [ultimo.observacao, texto(seg.ws)].filter(Boolean).join(", ") };
      itens.push(parte); ultimo = parte; continue;
    }
    // "guaraná com gelo e limão" x "x tudo sem cebola e coca lata": sem quantidade, logo depois
    // de uma observação, e o nome só bate em parte -> pode ser produto novo OU resto da observação.
    // Não dá para saber com certeza: vai como item marcado e o garçom decide com um toque.
    const talvezObs = ultimo?.observacao && seg.sep && seg.q == null && !seg.un && top && !ehObsSolta && !top.aprendido
      && top.sobra?.length >= top.nk - top.sobra?.length;
    if (ehObsSolta && ultimo) { ultimo.observacao = [ultimo.observacao, texto(seg.ws)].filter(Boolean).join(", "); continue; }
    if (!top || top.s < 0.5) {
      // "arroz e feijão": talvez o "e" fazia parte do nome. Tenta juntar com o anterior.
      if (ultimo && seg.sep && seg.q == null) {
        const junto = produtoEObs({ ws: [...ultimo._ws, { o: "e", t: "e" }, ...seg.ws] }, cat, aprendido);
        if ((junto.r[0]?.s ?? 0) >= 0.8 && (junto.r[0].s > (ultimo._s ?? 0))) { aplicar(ultimo, junto); continue; }
      }
      nao.push(texto(seg.ws));
      continue;
    }
    // Junção "arroz e feijão" quando os dois pedaços sozinhos acham coisas piores
    if (ultimo && seg.sep && seg.q == null && !seg.un) {
      const junto = produtoEObs({ ws: [...ultimo._ws, { o: "e", t: "e" }, ...seg.ws] }, cat, aprendido);
      if ((junto.r[0]?.s ?? 0) >= 0.9 && junto.r[0].s > top.s + 0.05 && junto.r[0].s > (ultimo._s ?? 0) + 0.05) { aplicar(ultimo, junto); continue; }
    }
    const it = { quantidade: arred(q), _un: un };
    aplicar(it, r);
    if (talvezObs) Object.assign(it, { certeza: "media", motivo: "talvez_obs", obs_de: itens.indexOf(ultimo), obs_texto: texto(seg.ws) });
    itens.push(it);
    ultimo = it;
  }
  return { mesa, pessoas, itens: itens.map(({ _ws, _s, _un, ...i }) => i), nao_entendidos: nao };

  function aplicar(it, r) {
    r = { ...r, r: baseAntesDasVariacoes(r.r) };
    const top = r.r[0], seg2 = r.r.find((x) => x.c.p.id !== top.c.p.id && !x.variacao);
    const folga = seg2 ? top.s - seg2.s : 1;
    let certeza = top.aprendido || (top.s >= 0.72 && top.rec >= 0.9 && folga >= 0.1) ? "alta" : top.s >= 0.55 ? "media" : "baixa";
    let motivo = certeza === "alta" ? null : folga < 0.1 ? "parecidos" : "incerto";
    const p = top.c.p;
    if (FRACIONADOS.includes(p.unidade) && !it._un) { certeza = certeza === "alta" ? "media" : certeza; motivo = "peso"; }
    Object.assign(it, {
      produto_id: p.id,
      observacao: texto(r.obs).replace(/^(com|e)\s+(?=sem\b)/i, "") || null,
      certeza, motivo,
      trecho: texto(r.nome),
      alternativas: r.r.filter((x) => x.s >= top.s - 0.25).slice(0, 5).map((x) => x.c.p.id),
      _ws: r.nome, _s: top.s,
    });
  }
}

/**
 * Se o melhor candidato e os que empatam com ele diferem só por modificadores que o garçom NÃO falou
 * ("coca lata" -> Coca Lata, e não Coca Zero Lata), o produto base vence com certeza.
 */
function baseAntesDasVariacoes(lista) {
  if (lista.length < 2 || lista[0].aprendido) return lista;
  const cheios = lista.filter((x) => x.rec >= 0.9 && x.s >= lista[0].s - 0.12);
  if (cheios.length < 2) return lista;
  for (const base of [...cheios].sort((a, b) => a.sobra.length - b.sobra.length)) {
    const ok = cheios.every((x) => x === base || (base.sobra.every((k) => x.sobra.includes(k)) && x.sobra.length > base.sobra.length
      && x.sobra.filter((k) => !base.sobra.includes(k)).every((k) => MODIFICADORES.has(k))));
    if (ok) return [{ ...base, s: Math.max(base.s, lista[0].s), rec: 1 }, ...lista.filter((x) => x !== base).map((x) => (cheios.includes(x) ? { ...x, variacao: true } : x))];
  }
  // Empate de verdade: o favorito ("mais pedidos") aparece primeiro nas opções
  return [...lista].sort((a, b) => (Math.abs(a.s - b.s) <= 0.05 ? (b.c.p.favorito ? 1 : 0) - (a.c.p.favorito ? 1 : 0) : 0) || b.s - a.s);
}

/** Chave para guardar o que o garçom corrigiu ("coca" -> Coca-Cola Lata) e acertar da próxima vez. */
export const chaveAprendizado = (trecho) => chaves(palavras(trecho).map((w) => w.t).filter((t) => !SEPARADORES.has(t))).join(" ");
