// Gerador de comandos ESC/POS (padrão das impressoras térmicas: Epson, Elgin, Bematech, Daruma,
// Tanca, Knup, Jetway e genéricas) e transportes WebUSB / Web Serial.

import { lembrarPorta, acharPorta, CHAVE_IMPRESSORA, CHAVE_BALANCA } from "../serial-portas.js";

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

// Mapeamento para a página de código 860 (Português) — usado quando "remover acentos" está desligado
const CP860 = {
  "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ã": 0x84, "à": 0x85, "Á": 0x86, "ç": 0x87, "ê": 0x88, "Ê": 0x89,
  "è": 0x8a, "Í": 0x8b, "Ô": 0x8c, "ì": 0x8d, "Ã": 0x8e, "Â": 0x8f, "É": 0x90, "À": 0x91, "È": 0x92, "ô": 0x93,
  "õ": 0x94, "ò": 0x95, "Ú": 0x96, "ù": 0x97, "Ì": 0x98, "Õ": 0x99, "Ü": 0x9a, "Ù": 0x9d, "Ó": 0x9f,
  "á": 0xa0, "í": 0xa1, "ó": 0xa2, "ú": 0xa3, "ñ": 0xa4, "Ñ": 0xa5, "ª": 0xa6, "º": 0xa7, "Ò": 0xa9,
};

export const semAcentos = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e\n]/g, "");

export class Escpos {
  constructor({ acentos = false } = {}) {
    this.b = [];
    this.acentos = acentos;
  }
  raw(...bytes) { this.b.push(...bytes); return this; }
  init() { this.raw(ESC, 0x40); if (this.acentos) this.raw(ESC, 0x74, 3); return this; } // ESC t 3 = CP860
  align(a) { return this.raw(ESC, 0x61, { esquerda: 0, centro: 1, direita: 2 }[a] ?? 0); }
  negrito(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  tamanho(larg = 1, alt = 1) { return this.raw(GS, 0x21, ((larg - 1) << 4) | (alt - 1)); }
  texto(s) {
    const str = this.acentos ? String(s ?? "") : semAcentos(s);
    for (const ch of str) {
      const c = ch.charCodeAt(0);
      if (c < 128) this.b.push(c);
      else this.b.push(CP860[ch] ?? 0x3f);
    }
    return this;
  }
  linha(s = "") { return this.texto(s).raw(LF); }
  avancar(n = 3) { return this.raw(ESC, 0x64, n); }
  cortar() { return this.raw(GS, 0x56, 0x42, 0x00); }
  gaveta() { return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa); }
  qrcode(dados, modulo = 5) {
    const d = [...new TextEncoder().encode(dados)];
    const len = d.length + 3;
    this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00);            // modelo 2
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, modulo);                 // tamanho do módulo
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31);                   // correção M
    this.raw(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...d); // armazena
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);                   // imprime
    return this;
  }
  bytes() { return new Uint8Array(this.b); }
}

// ---------- Transportes ----------
let usbDev = null;
let serialPort = null;

export const suportaUSB = () => "usb" in navigator;
export const suportaSerial = () => "serial" in navigator;

async function abrirUSB(dev) {
  if (!dev.opened) await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  for (const intf of dev.configuration.interfaces) {
    for (const alt of intf.alternates) {
      const ep = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      if (ep) {
        if (!intf.claimed) await dev.claimInterface(intf.interfaceNumber);
        return { dev, ep: ep.endpointNumber };
      }
    }
  }
  throw new Error("A impressora USB não expõe uma saída compatível");
}

export async function parearUSB() {
  usbDev = await navigator.usb.requestDevice({ filters: [] });
  await abrirUSB(usbDev);
  return usbDev.productName || "Impressora USB";
}

export async function parearSerial(baudRate = 9600) {
  serialPort = await navigator.serial.requestPort();
  await lembrarPorta(CHAVE_IMPRESSORA, serialPort);
  if (!serialPort.writable) await serialPort.open({ baudRate });
  return "Porta serial/Bluetooth";
}

async function obterUSB() {
  if (!usbDev) usbDev = (await navigator.usb.getDevices())[0] || null;
  if (!usbDev) throw new Error("Nenhuma impressora USB pareada. Vá em Configurações > Impressora.");
  return abrirUSB(usbDev);
}

async function obterSerial(baudRate) {
  if (!serialPort) serialPort = await acharPorta(CHAVE_IMPRESSORA, CHAVE_BALANCA);
  if (!serialPort) throw new Error("Nenhuma impressora serial pareada. Vá em Configurações > Impressora.");
  if (!serialPort.writable) await serialPort.open({ baudRate });
  return serialPort;
}

export async function enviar(modo, bytes, { baudRate = 9600 } = {}) {
  if (modo === "usb") {
    const { dev, ep } = await obterUSB();
    for (let i = 0; i < bytes.length; i += 4096) await dev.transferOut(ep, bytes.slice(i, i + 4096));
  } else if (modo === "serial") {
    const porta = await obterSerial(baudRate);
    const w = porta.writable.getWriter();
    try { await w.write(bytes); } finally { w.releaseLock(); }
  } else {
    throw new Error("Modo de impressão inválido");
  }
}
