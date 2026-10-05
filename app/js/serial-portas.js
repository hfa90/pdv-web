// Várias portas seriais no mesmo computador (impressora e balança):
// cada uma guarda a identificação da porta que foi pareada para não pegar a do outro aparelho.
const ler = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const grava = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };

export const CHAVE_IMPRESSORA = "pdv-porta-impressora";
export const CHAVE_BALANCA = "pdv-porta-balanca";

function infoPorta(porta, indice) {
  const i = porta.getInfo?.() || {};
  return { v: i.usbVendorId ?? null, p: i.usbProductId ?? null, i: indice };
}
const igual = (a, b) => !!a && !!b && (a.v != null || b.v != null ? a.v === b.v && a.p === b.p : a.i === b.i);

/** Guarda qual porta foi escolhida para este aparelho. */
export async function lembrarPorta(chave, porta) {
  const portas = await navigator.serial.getPorts();
  grava(chave, infoPorta(porta, portas.indexOf(porta)));
}

/** Acha a porta deste aparelho entre as já autorizadas, sem pegar a do outro. */
export async function acharPorta(chave, chaveOutro) {
  const portas = await navigator.serial.getPorts();
  const minha = ler(chave), outra = ler(chaveOutro);
  const comInfo = portas.map((p, i) => [p, infoPorta(p, i)]);
  const achada = minha && comInfo.find(([, inf]) => igual(inf, minha));
  if (achada) return achada[0];
  const livre = comInfo.find(([, inf]) => !igual(inf, outra));
  return livre ? livre[0] : null;
}
