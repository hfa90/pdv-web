// =====================================================================
// Anexos da Central de Ajuda: ler o texto de um print, foto ou PDF.
// ---------------------------------------------------------------------
// SEM IA: a leitura de imagem usa OCR (Tesseract, reconhecimento de letras,
// o mesmo tipo de tecnologia do scanner). O texto lido só serve para BUSCAR
// nos artigos e reconhecer a mensagem de erro no catálogo do Diagnóstico.
// O arquivo também pode ir junto no pedido de ajuda para o suporte ver.
// Tudo roda no navegador; nada é enviado a terceiros (as bibliotecas vêm
// do jsDelivr e ficam guardadas no aparelho depois da primeira vez).
// =====================================================================

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs";
const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";

export const LIMITE_BYTES = 5 * 1024 * 1024;
export const MAX_ANEXOS = 5;
export const ACEITA = "image/*,application/pdf,.txt,.log,.csv,.json,.doc,.docx";

const ehImagem = (f) => /^image\//.test(f.type);
const ehPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const ehTexto = (f) => /^text\//.test(f.type) || /\.(txt|log|csv|json)$/i.test(f.name);
const ehWord = (f) => /\.(docx?|odt)$/i.test(f.name) || /word/.test(f.type);

export function tipoAmigavel(f) {
  if (ehImagem(f)) return "Imagem";
  if (ehPdf(f)) return "PDF";
  if (ehTexto(f)) return "Texto";
  if (ehWord(f)) return "Documento do Word";
  return "Arquivo";
}

function carregarScript(src) {
  return new Promise((ok, falha) => {
    if (document.querySelector(`script[src="${src}"]`) && window.Tesseract) return ok();
    const s = document.createElement("script");
    s.src = src; s.async = true; s.crossOrigin = "anonymous";
    s.onload = () => ok(); s.onerror = () => falha(new Error("Não deu para baixar o leitor de imagens. Confira a internet."));
    document.head.appendChild(s);
  });
}

let workerOcr = null;
let progressoAtual = null;
async function ocr(imagem, aoProgresso) {
  if (!navigator.onLine && !window.Tesseract) throw new Error("Sem internet: o leitor de imagens precisa ser baixado na primeira vez.");
  await carregarScript(TESSERACT);
  progressoAtual = aoProgresso;
  if (!workerOcr) {
    workerOcr = window.Tesseract.createWorker("por", 1, {
      logger: (m) => {
        if (!progressoAtual) return;
        if (m.status === "recognizing text") progressoAtual(0.25 + m.progress * 0.75, "Lendo o texto…");
        else if (/load|initializ/i.test(m.status)) progressoAtual(Math.min(0.25, (m.progress || 0) * 0.25), "Preparando o leitor (só na primeira vez)…");
      },
    });
  }
  const w = await workerOcr;
  const { data } = await w.recognize(imagem);
  progressoAtual = null;
  return limparTexto(data?.text || "");
}

async function textoDoPdf(arquivo, aoProgresso) {
  const pdfjs = await import(/* @vite-ignore */ PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjs.getDocument({ data: await arquivo.arrayBuffer() }).promise;
  const paginas = Math.min(doc.numPages, 6);
  let texto = "";
  for (let i = 1; i <= paginas; i++) {
    aoProgresso?.(i / (paginas + 1), `Lendo a página ${i} de ${paginas}…`);
    const pg = await doc.getPage(i);
    const c = await pg.getTextContent();
    texto += c.items.map((x) => x.str).join(" ") + "\n";
  }
  texto = limparTexto(texto);
  if (texto.replace(/\s/g, "").length > 20) return texto;
  // PDF escaneado (só imagem): lê a primeira página com o OCR
  const pg = await doc.getPage(1);
  const vp = pg.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = vp.width; canvas.height = vp.height;
  await pg.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  return ocr(canvas, aoProgresso);
}

const limparTexto = (t) => String(t).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);

/**
 * Lê o texto de um arquivo. Devolve { texto, lido: bool, aviso }.
 * aoProgresso(fração 0..1, mensagem)
 */
export async function lerArquivo(arquivo, aoProgresso) {
  if (arquivo.size > LIMITE_BYTES * 4) return { texto: "", lido: false, aviso: "Arquivo grande demais para ler aqui." };
  if (ehTexto(arquivo)) return { texto: limparTexto(await arquivo.text()), lido: true };
  if (ehImagem(arquivo)) return { texto: await ocr(arquivo, aoProgresso), lido: true };
  if (ehPdf(arquivo)) return { texto: await textoDoPdf(arquivo, aoProgresso), lido: true };
  if (ehWord(arquivo)) return { texto: "", lido: false, aviso: "Não consigo ler documentos do Word aqui, mas ele pode ir junto para o suporte. Dica: tire um print da parte com o problema." };
  return { texto: "", lido: false, aviso: "Este tipo de arquivo não é lido aqui, mas pode ir junto para o suporte." };
}

/**
 * Prepara o arquivo para enviar ao suporte: imagens grandes são reduzidas
 * (JPEG até 1600 px) para caber no limite de 5 MB e subir rápido.
 */
export async function prepararEnvio(arquivo) {
  if (!ehImagem(arquivo) || (arquivo.size < 1.5 * 1024 * 1024 && arquivo.type !== "image/bmp")) return arquivo;
  try {
    const bmp = await createImageBitmap(arquivo);
    const escala = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * escala); c.height = Math.round(bmp.height * escala);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    if (!blob) return arquivo;
    return new File([blob], arquivo.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch { return arquivo; }
}

/** Nome seguro para o caminho no armazenamento. */
export const nomeSeguro = (n) => String(n || "arquivo").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "arquivo";

export const tamanhoTxt = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
