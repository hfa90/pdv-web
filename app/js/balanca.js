// Balança de checkout ligada ao computador (porta serial COM, USB-serial ou Bluetooth SPP).
// Usa a Web Serial API (Chrome/Edge). Protocolos mais comuns no Brasil:
//  - Toledo (Prix 3 Fit, Prix 4 Uno, 9094/9098 – protocolo P03): envia ENQ (0x05), responde STX + peso + ETX
//  - Filizola (CS15, BP15, Platina – protocolo ENQ): igual ao Toledo na prática
//  - Urano (POP-S, US 15/2): envia ENQ, responde texto com o peso em kg
//  - Elgin (DP/SA): ENQ ou contínuo
//  - Contínuo: a balança manda o peso o tempo todo, sem pedir
// Peso "IIIII" = instável, "SSSSS" = sobrecarga, "NNNNN" = negativo (padrão Toledo/Filizola).
import { lembrarPorta, acharPorta, CHAVE_IMPRESSORA, CHAVE_BALANCA } from "./serial-portas.js";

const CHAVE = "pdv-balanca";
export const PROTOCOLOS = {
  toledo:   { nome: "Toledo (Prix 3 Fit, Prix 4, 9094)", enq: true,  baud: 9600, paridade: "none" },
  filizola: { nome: "Filizola (CS, BP, Platina)",        enq: true,  baud: 9600, paridade: "none" },
  urano:    { nome: "Urano (POP-S, US)",                 enq: true,  baud: 9600, paridade: "none" },
  elgin:    { nome: "Elgin (DP, SA)",                    enq: true,  baud: 9600, paridade: "none" },
  continuo: { nome: "Outra marca (envio contínuo)",      enq: false, baud: 9600, paridade: "none" },
  simulador:{ nome: "Simulador (testar sem balança)",    enq: false, baud: 9600, paridade: "none" },
};

const PADRAO = { ativa: false, protocolo: "toledo", baudRate: 9600, paridade: "none", dataBits: 8, stopBits: 1,
  autoConfirmar: true, etiquetaTipo: "preco", etiquetaDigitos: 5 };

export function configBalanca() {
  try { return { ...PADRAO, ...JSON.parse(localStorage.getItem(CHAVE) || "{}") }; } catch { return { ...PADRAO }; }
}
export function salvarConfigBalanca(c) {
  try { localStorage.setItem(CHAVE, JSON.stringify({ ...configBalanca(), ...c })); } catch { /* sem armazenamento */ }
  fechar().catch(() => {});
  window.dispatchEvent(new Event("pdv-balanca"));
}

export const suportaBalanca = () => "serial" in navigator;
export const balancaAtiva = () => configBalanca().ativa;

let porta = null, leitor = null, buffer = "", ultimo = null, lendoLoop = false, ouvintes = new Set();
let simPeso = 0;

export const estadoBalanca = () => ({ conectada: !!porta || configBalanca().protocolo === "simulador", ultimo });
export function aoMudar(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); }
const avisar = () => ouvintes.forEach((f) => { try { f(estadoBalanca()); } catch { /* ignora */ } });

/** Interpreta a resposta da balança e devolve { peso (kg), estavel, erro }. */
export function interpretar(texto) {
  const t = String(texto).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (!t) return null;
  if (/I{3,}/.test(t)) return { peso: null, estavel: false, erro: "Peso instável" };
  if (/S{3,}/.test(t)) return { peso: null, estavel: false, erro: "Sobrecarga" };
  if (/N{3,}/.test(t)) return { peso: null, estavel: false, erro: "Peso negativo" };
  const instavel = /\b(US|M|MOT|INST)\b/i.test(t) && !/\bST\b/i.test(t);
  const m = t.match(/-?\d+(?:[.,]\d+)?/g);
  if (!m) return null;
  let bruto = m[m.length - 1];
  let peso;
  if (/[.,]/.test(bruto)) {
    peso = Number(bruto.replace(",", "."));
    if (/\bg\b/i.test(t) && !/kg/i.test(t)) peso /= 1000;
  } else {
    // Toledo/Filizola: 5 ou 6 dígitos com 3 casas decimais implícitas (01250 = 1,250 kg)
    peso = Number(bruto) / 1000;
  }
  if (!Number.isFinite(peso)) return null;
  return { peso: Math.round(peso * 1000) / 1000, estavel: !instavel, erro: peso < 0 ? "Peso negativo" : null };
}

/** Pede ao navegador para escolher a porta da balança (precisa de clique do usuário). */
export async function parearBalanca() {
  if (!suportaBalanca()) throw new Error("Use o Google Chrome ou o Microsoft Edge no computador para ligar a balança.");
  await fechar();
  const p = await navigator.serial.requestPort();
  await lembrarPorta(CHAVE_BALANCA, p);
  porta = p;
  await abrir();
  return "Balança pareada";
}

async function abrir() {
  const c = configBalanca();
  if (c.protocolo === "simulador") return;
  if (!porta) porta = await acharPorta(CHAVE_BALANCA, CHAVE_IMPRESSORA);
  if (!porta) throw new Error("Balança não pareada. Vá em Configurações › Balança e clique em Parear.");
  if (!porta.readable) {
    await porta.open({ baudRate: Number(c.baudRate) || 9600, dataBits: Number(c.dataBits) || 8,
      stopBits: Number(c.stopBits) || 1, parity: c.paridade || "none", flowControl: "none" });
  }
  if (!lendoLoop) lerSempre();
  avisar();
}

async function lerSempre() {
  lendoLoop = true;
  const dec = new TextDecoder("latin1");
  try {
    while (porta?.readable) {
      leitor = porta.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await leitor.read();
          if (done) break;
          buffer += dec.decode(value);
          // Separa os quadros: STX...ETX, quebra de linha ou CR
          const partes = buffer.split(/[\x03\r\n]/);
          buffer = partes.pop().slice(-64);
          for (const q of partes) {
            const r = interpretar(q);
            if (r) { ultimo = { ...r, em: Date.now() }; avisar(); }
          }
        }
      } finally { try { leitor.releaseLock(); } catch { /* ignora */ } leitor = null; }
    }
  } catch (e) { /* porta desconectada */
    window.lisDiag?.registrar({ tipo: "erro", origem: "balanca", mensagem: "Balança desconectou", tecnico: window.lisDiag.deErro(e).tecnico });
  }
  lendoLoop = false;
  avisar();
}

async function pedirPeso() {
  const c = configBalanca();
  if (!PROTOCOLOS[c.protocolo]?.enq || !porta?.writable) return;
  const w = porta.writable.getWriter();
  try { await w.write(new Uint8Array([0x05])); } finally { w.releaseLock(); }
}

/** Lê o peso atual. Retorna { peso, estavel, erro }. */
export async function lerPeso({ timeout = 1200 } = {}) {
  const c = configBalanca();
  if (c.protocolo === "simulador") {
    // Simulador: oscila um pouco e estabiliza (para treinar o caixa sem balança)
    if (!simPeso) simPeso = Math.round((0.15 + Math.random() * 1.6) * 1000) / 1000;
    ultimo = { peso: simPeso, estavel: true, erro: null, em: Date.now() };
    avisar();
    return ultimo;
  }
  await abrir();
  const antes = ultimo?.em || 0;
  await pedirPeso();
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    if (ultimo && ultimo.em > antes) return ultimo;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (ultimo && Date.now() - ultimo.em < 1500) return ultimo;
  const e = new Error("A balança não respondeu. Confira o cabo, a velocidade (baud) e o protocolo.");
  const ev = window.lisDiag?.registrar({ tipo: "erro", origem: "balanca", mensagem: e.message, tecnico: { protocolo: c.protocolo, baud: c.baudRate, paridade: c.paridade, porta_aberta: !!porta?.readable, ultima_leitura_ms: ultimo ? Date.now() - ultimo.em : null } });
  if (ev) e.diagId = ev.id;
  throw e;
}

/** Novo produto na balança: o simulador sorteia outro peso. */
export function novoItemSimulador() { simPeso = 0; }

export async function fechar() {
  try { await leitor?.cancel(); } catch { /* ignora */ }
  try { await porta?.close(); } catch { /* ignora */ }
  porta = null; leitor = null; buffer = ""; ultimo = null;
  avisar();
}

/** Lê etiqueta de balança (EAN-13 começando com 2): 2 CCCCC VVVVV D. */
export function lerEtiquetaBalanca(codigo) {
  if (!/^2\d{12}$/.test(codigo)) return null;
  const c = configBalanca();
  const dig = Number(c.etiquetaDigitos) === 4 ? 4 : 5;
  const prod = codigo.slice(1, 1 + dig).replace(/^0+/, "");
  const valor = Number(codigo.slice(1 + dig, 12));
  return c.etiquetaTipo === "peso"
    ? { codigo: prod, peso: valor / 1000 }
    : { codigo: prod, preco: valor / 100 };
}
