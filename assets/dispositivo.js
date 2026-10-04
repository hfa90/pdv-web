// Identificação do aparelho para o antifraude do teste grátis.
// - dispositivo: código aleatório guardado no navegador (localStorage + cookie, um restaura o outro)
// - impressao: resumo (hash) de características do navegador e da tela
// Nada disso identifica a pessoa; serve só para impedir testes repetidos no mesmo aparelho.

const CHAVE = "lis-dispositivo";

function lerCookie(nome) {
  return document.cookie.split("; ").find((c) => c.startsWith(nome + "="))?.split("=")[1] || null;
}

export function obterDispositivo() {
  let id = null;
  try { id = localStorage.getItem(CHAVE); } catch { /* armazenamento bloqueado */ }
  if (!id) id = lerCookie(CHAVE);
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    const b = new Uint8Array(18);
    crypto.getRandomValues(b);
    id = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  try { localStorage.setItem(CHAVE, id); } catch { /* ignora */ }
  document.cookie = `${CHAVE}=${id}; max-age=${400 * 86400}; path=/; samesite=lax; secure`;
  return id;
}

async function sha256(texto) {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
    return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 40);
  }
  // Sem HTTPS não há crypto.subtle: usa um hash simples (FNV-1a em 4 sementes)
  return [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((h) => {
    for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, "0");
  }).join("");
}

export async function obterImpressao() {
  const partes = [
    navigator.userAgent, navigator.language, (navigator.languages || []).join(","), navigator.platform,
    screen.width + "x" + screen.height + "x" + screen.colorDepth, window.devicePixelRatio,
    Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency, navigator.deviceMemory,
  ];
  try {
    const c = document.createElement("canvas"); c.width = 220; c.height = 40;
    const x = c.getContext("2d");
    x.textBaseline = "top"; x.font = "16px Arial"; x.fillStyle = "#136F63"; x.fillRect(0, 0, 220, 40);
    x.fillStyle = "#F2B33D"; x.fillText("Pão de queijo 0,75 ✓", 4, 10);
    partes.push(c.toDataURL());
  } catch { /* sem canvas */ }
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) partes.push(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch { /* sem webgl */ }
  return sha256(partes.join("|"));
}
