// PIX "copia e cola" (BR Code estático, padrão EMV do Banco Central) e QR Code em SVG.
// Usado pelo PDV, pelo app do garçom e pelo cardápio digital.
// O QR usa a biblioteca qrcode-generator (window.qrcode), carregada pela página.

const campo = (id, valor) => {
  const v = String(valor);
  return id + String(v.length).padStart(2, "0") + v;
};

/** CRC16-CCITT (polinômio 0x1021, início 0xFFFF), exigido no campo 63. */
export function crc16(texto) {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(texto)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Remove acentos e caracteres fora do padrão do BR Code. */
const limpar = (s, max) => String(s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^A-Za-z0-9 .,\-/]/g, "").replace(/\s+/g, " ").trim().slice(0, max).trim();

/** Normaliza a chave conforme o tipo (o banco do pagador recusa formatos errados). */
export function normalizarChave(tipo, chave) {
  const c = String(chave || "").trim();
  const dig = c.replace(/\D/g, "");
  switch (tipo) {
    case "cpf": return dig.length === 11 ? dig : null;
    case "cnpj": return dig.length === 14 ? dig : null;
    case "telefone": {
      let d = dig;
      if (d.length === 10 || d.length === 11) d = "55" + d;
      return /^55\d{10,11}$/.test(d) ? "+" + d : null;
    }
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) && c.length <= 77 ? c.toLowerCase() : null;
    case "aleatoria": return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c) ? c.toLowerCase() : null;
    default: return null;
  }
}

/**
 * Monta o código PIX copia e cola.
 * @param {{tipo:string, chave:string, nome:string, cidade:string, valor?:number, txid?:string, mensagem?:string}} p
 */
export function payloadPix({ tipo, chave, nome, cidade, valor, txid, mensagem }) {
  const k = normalizarChave(tipo, chave);
  if (!k) throw new Error("Chave PIX inválida. Confira em Configurações › PIX.");
  const info = mensagem ? limpar(mensagem, Math.max(0, 99 - 22 - k.length - 8)) : "";
  const conta = campo("00", "br.gov.bcb.pix") + campo("01", k) + (info ? campo("02", info) : "");
  const id = (String(txid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 25)) || "***";
  let s = campo("00", "01")
    + campo("26", conta)
    + campo("52", "0000")
    + campo("53", "986")
    + (valor ? campo("54", Number(valor).toFixed(2)) : "")
    + campo("58", "BR")
    + campo("59", limpar(nome, 25) || "RECEBEDOR")
    + campo("60", limpar(cidade, 15) || "BRASIL")
    + campo("62", campo("05", id));
  s += "6304";
  return s + crc16(s);
}

/** SVG do QR Code (string). Requer window.qrcode. */
export function qrSvg(texto, tamanho = 220) {
  if (!window.qrcode) return "";
  const qr = window.qrcode(0, "M");
  qr.addData(texto);
  qr.make();
  const n = qr.getModuleCount();
  const cel = Math.max(2, Math.floor(tamanho / (n + 8)));
  return qr.createSvgTag({ cellSize: cel, margin: cel * 4, scalable: true });
}

/** Espera a biblioteca de QR carregar (o script é "defer"). */
export function qrPronto(tempo = 5000) {
  return new Promise((resolve) => {
    const ini = Date.now();
    (function ver() {
      if (window.qrcode) return resolve(true);
      if (Date.now() - ini > tempo) return resolve(false);
      setTimeout(ver, 60);
    })();
  });
}

/** Identificador curto para conciliar no extrato (aparece como "txid"). */
export const txidVenda = (prefixo, numero) => `${prefixo}${numero || Date.now().toString(36)}`.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 25);

export const TIPOS_CHAVE = [
  ["cpf", "CPF"], ["cnpj", "CNPJ"], ["telefone", "Celular"], ["email", "E-mail"], ["aleatoria", "Chave aleatória"],
];
