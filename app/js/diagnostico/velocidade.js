// =====================================================================
// Teste de velocidade da internet
// ---------------------------------------------------------------------
// Mede a internet da loja contra um servidor neutro (Cloudflare) e, em
// seguida, o servidor do próprio sistema (Supabase). Comparando os dois dá
// para dizer com segurança se a lentidão é da INTERNET ou do SISTEMA.
//   ping / variação (jitter) / perda → download → upload → servidor do sistema
// Se o Cloudflare estiver bloqueado na rede, o download usa um arquivo do
// próprio site (o manual em PDF) e o upload fica "não medido".
// =====================================================================
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

const CF = "https://speed.cloudflare.com";
const CHAVE_HIST = "lis-diag-velocidade";
const ARQ_RESERVA = new URL("../../../assets/Manual-PDV.pdf", import.meta.url).href;

/** O que o sistema precisa para funcionar bem (por caixa). */
export const REQUISITOS = { download: 2, upload: 1, ping: 200, jitter: 50, perda: 5 };

const agora = () => performance.now();
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const mediana = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function comTempo(p, ms, ctl) {
  let t;
  try { return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => { ctl?.abort(); rej(new Error("tempo esgotado")); }, ms); })]); }
  finally { clearTimeout(t); }
}

/** n pedidos pequenos: latência (mediana), variação e perda. */
async function medirPing(url, n, opcoes = {}, aoMedir) {
  const tempos = []; let falhas = 0;
  for (let i = 0; i < n; i++) {
    const ctl = new AbortController(); const t0 = agora();
    try {
      const r = await comTempo(fetch(url + (url.includes("?") ? "&" : "?") + "r=" + Math.random(), { cache: "no-store", signal: ctl.signal, ...opcoes }), 4000, ctl);
      await r.arrayBuffer();
      tempos.push(agora() - t0);
      aoMedir?.(agora() - t0);
    } catch { falhas++; }
    await espera(60);
  }
  if (!tempos.length) return { ok: false, perda: 100 };
  // A primeira conexão inclui DNS/TLS: descartada se houver amostras suficientes
  const amostra = tempos.length > 3 ? tempos.slice(1) : tempos;
  const jitter = amostra.length > 1 ? amostra.slice(1).reduce((s, x, i) => s + Math.abs(x - amostra[i]), 0) / (amostra.length - 1) : 0;
  return { ok: true, ping: Math.round(mediana(amostra)), jitter: Math.round(jitter), perda: Math.round((falhas / n) * 100), min: Math.round(Math.min(...amostra)) };
}

/** Baixa por até `duracao` ms, lendo aos pedaços para mostrar a velocidade ao vivo. */
async function medirDownload(urls, duracao, aoProgresso) {
  const ctl = new AbortController();
  const t0 = agora(); let bytes = 0; let ultimo = t0; let amostras = [];
  const fim = setTimeout(() => ctl.abort(), duracao);
  try {
    for (const url of urls) {
      if (agora() - t0 > duracao) break;
      const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const leitor = r.body.getReader();
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        bytes += value.length;
        const t = agora();
        if (t - ultimo > 150) {
          const mbps = (bytes * 8) / ((t - t0) / 1000) / 1e6;
          amostras.push(mbps); ultimo = t; aoProgresso?.(mbps, (t - t0) / duracao);
        }
      }
    }
  } catch (e) { if (e.name !== "AbortError" && !bytes) throw e; }
  finally { clearTimeout(fim); }
  const seg = (agora() - t0) / 1000;
  if (bytes < 50000) throw new Error("download muito pequeno para medir");
  return { mbps: (bytes * 8) / seg / 1e6, bytes, segundos: seg };
}

/** Envia pedaços crescentes até `duracao` ms. */
async function medirUpload(duracao, aoProgresso) {
  const t0 = agora(); let bytes = 0;
  const tamanhos = [100e3, 250e3, 500e3, 1e6, 2e6, 4e6, 8e6, 8e6, 8e6];
  for (const tam of tamanhos) {
    if (agora() - t0 > duracao) break;
    const corpo = new Uint8Array(tam);
    const ctl = new AbortController();
    await comTempo(fetch(CF + "/__up", { method: "POST", body: corpo, signal: ctl.signal }).then((r) => r.text()), Math.max(2000, duracao - (agora() - t0) + 3000), ctl);
    bytes += tam;
    const t = agora();
    aoProgresso?.((bytes * 8) / ((t - t0) / 1000) / 1e6, (t - t0) / duracao);
  }
  return { mbps: (bytes * 8) / ((agora() - t0) / 1000) / 1e6, bytes };
}

/**
 * Roda o teste completo. aoProgresso({ fase, valor, fracao, parcial }) atualiza a tela.
 * Devolve { em, internet:{ping,jitter,perda,download,upload,fonte}, servidor:{ping,jitter,perda}, veredito }
 */
export async function testarVelocidade(aoProgresso = () => {}) {
  const res = { em: Date.now(), internet: {}, servidor: {}, avisos: [] };
  const passo = (fase, valor, fracao = 0) => aoProgresso({ fase, valor, fracao, parcial: res });

  if (!navigator.onLine) { res.veredito = veredito(res); return res; }

  // 1. Latência da internet (servidor neutro)
  passo("ping", null);
  const pingCF = await medirPing(CF + "/__down?bytes=0", 10, {}, (ms) => passo("ping", ms));
  res.internet.cloudflare = pingCF.ok;
  Object.assign(res.internet, pingCF.ok ? { ping: pingCF.ping, jitter: pingCF.jitter, perda: pingCF.perda } : {});

  // 2. Download
  passo("download", 0);
  try {
    if (!pingCF.ok) throw new Error("Cloudflare indisponível");
    const d = await medirDownload([1e6, 10e6, 25e6, 25e6, 25e6].map((b) => `${CF}/__down?bytes=${b}&r=${Math.random()}`), 8000, (mbps, f) => passo("download", mbps, f));
    Object.assign(res.internet, { download: round(d.mbps), fonte: "Cloudflare" });
  } catch {
    try {
      const d = await medirDownload([ARQ_RESERVA + "?r=" + Math.random()], 8000, (mbps, f) => passo("download", mbps, f));
      Object.assign(res.internet, { download: round(d.mbps), fonte: "site do sistema" });
      res.avisos.push("O servidor de teste (Cloudflare) não respondeu nesta rede; o download foi medido com um arquivo do próprio site e o upload não foi medido.");
    } catch (e) { res.avisos.push("Não foi possível medir o download: " + e.message); }
  }

  // 3. Upload
  if (pingCF.ok) {
    passo("upload", 0);
    try { const u = await medirUpload(7000, (mbps, f) => passo("upload", mbps, f)); res.internet.upload = round(u.mbps); }
    catch (e) { res.avisos.push("Não foi possível medir o upload: " + e.message); }
  }

  // 4. Servidor do sistema (Supabase): mesmo tipo de pedido pequeno
  passo("servidor", null);
  const pingSB = await medirPing(`${SUPABASE_URL}/auth/v1/health`, 8, { headers: { apikey: SUPABASE_ANON_KEY } }, (ms) => passo("servidor", ms));
  Object.assign(res.servidor, pingSB.ok ? { ping: pingSB.ping, jitter: pingSB.jitter, perda: pingSB.perda } : { ok: false, perda: 100 });
  if (!pingCF.ok && pingSB.ok) {
    // Sem servidor neutro: usa o próprio servidor como referência de latência
    Object.assign(res.internet, { ping: res.internet.ping ?? pingSB.ping, jitter: res.internet.jitter ?? pingSB.jitter, perda: res.internet.perda ?? pingSB.perda });
  }

  res.veredito = veredito(res);
  passo("fim", null, 1);
  salvarHistorico(res);
  window.lisDiag?.registrar({ tipo: "info", origem: "rede", mensagem: `Teste de velocidade: ${res.internet.download ?? "?"} Mbps ↓ · ${res.internet.upload ?? "?"} Mbps ↑ · ping ${res.internet.ping ?? "?"} ms · servidor ${res.servidor.ping ?? "?"} ms — ${res.veredito.titulo}`,
    tecnico: { internet: res.internet, servidor: res.servidor, veredito: res.veredito.codigo } });
  return res;
}

const round = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

/** Conclusão em linguagem simples: de quem é o problema? */
export function veredito(r) {
  const i = r.internet || {}, s = r.servidor || {}, R = REQUISITOS;
  if (!navigator.onLine || (!i.download && !s.ping && i.ping == null)) {
    return { codigo: "sem-internet", tipo: "erro", culpa: "internet", titulo: "Sem internet",
      texto: "O aparelho não alcança nenhum servidor na internet. O problema é a conexão da loja (Wi-Fi, cabo, roteador ou provedor), não o sistema. O caixa continua vendendo no modo offline." };
  }
  const internetRuim = [];
  if (i.download != null && i.download < R.download) internetRuim.push(`download de ${i.download} Mbps (mínimo ${R.download})`);
  if (i.upload != null && i.upload < R.upload) internetRuim.push(`upload de ${i.upload} Mbps (mínimo ${R.upload})`);
  if (i.ping != null && i.ping > R.ping * 1.5) internetRuim.push(`resposta de ${i.ping} ms (ideal até ${R.ping})`);
  if (i.jitter != null && i.jitter > R.jitter * 2) internetRuim.push(`variação de ${i.jitter} ms (instável)`);
  if (i.perda != null && i.perda > R.perda) internetRuim.push(`${i.perda}% dos pedidos perdidos`);

  const servidorFora = s.ok === false || s.perda >= 50;
  const servidorLento = s.ping != null && i.ping != null && s.ping > Math.max(500, i.ping * 4);

  if (internetRuim.length && !servidorFora) {
    return { codigo: "internet-ruim", tipo: "erro", culpa: "internet", titulo: "O problema é a internet da loja",
      texto: `A conexão está abaixo do que o sistema precisa: ${internetRuim.join("; ")}. O servidor de teste é neutro (não é o sistema), então a lentidão vem da rede da loja ou do provedor.`,
      dicas: ["Reinicie o roteador e o modem (desligue 30 s).", "Ligue o computador do caixa por cabo em vez de Wi-Fi.", "Veja se alguém está baixando/assistindo vídeos na mesma rede.", "Rode o teste de novo; se continuar, acione o provedor com este resultado."] };
  }
  if (servidorFora) {
    return { codigo: "servidor-fora", tipo: "erro", culpa: "sistema", titulo: "A internet está boa; o servidor do sistema não respondeu",
      texto: `A internet da loja respondeu ${i.download ? `com ${i.download} Mbps` : "normalmente"}, mas o servidor do sistema não. Aqui o problema é do lado do sistema (servidor fora do ar, pausado ou bloqueado nesta rede).`,
      dicas: ["Veja status.supabase.com e o painel do projeto.", "Teste em outra rede (4G do celular): se funcionar lá, a rede da loja bloqueia *.supabase.co.", "Enquanto isso o caixa vende offline."] };
  }
  if (servidorLento) {
    return { codigo: "servidor-lento", tipo: "aviso", culpa: "sistema", titulo: "A internet está boa; o servidor do sistema está lento",
      texto: `A internet responde em ${i.ping} ms, mas o servidor do sistema leva ${s.ping} ms (${Math.round(s.ping / Math.max(1, i.ping))}× mais). A lentidão é do servidor, não da loja.`,
      dicas: ["Veja Supabase › Reports (CPU, conexões) e consultas lentas.", "Confira status.supabase.com.", "Se for só nesta rede, pode ser a rota do provedor até o servidor."] };
  }
  return { codigo: "tudo-ok", tipo: "ok", culpa: "nenhum", titulo: "Internet e servidor estão bons",
    texto: `A internet (${i.download ?? "?"} Mbps ↓${i.upload != null ? ` · ${i.upload} Mbps ↑` : ""} · ${i.ping ?? "?"} ms) e o servidor do sistema (${s.ping ?? "?"} ms) estão dentro do esperado. Se o sistema está lento, a causa provável é o aparelho (muitas abas, pouca memória) ou uma tela específica — veja o check-up e a linha do tempo.`,
    dicas: ["Feche abas e programas que não estão em uso.", "Recarregue a página do sistema.", "Veja no check-up se há algum item vermelho."] };
}

export function historico() { try { return JSON.parse(localStorage.getItem(CHAVE_HIST) || "[]"); } catch { return []; } }
function salvarHistorico(r) {
  try {
    const h = historico();
    h.unshift({ em: r.em, internet: r.internet, servidor: r.servidor, codigo: r.veredito.codigo, titulo: r.veredito.titulo });
    localStorage.setItem(CHAVE_HIST, JSON.stringify(h.slice(0, 15)));
  } catch { /* sem espaço */ }
}
