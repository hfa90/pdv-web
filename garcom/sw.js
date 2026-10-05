// Service worker do app do garçom: abre rápido e funciona com internet instável.
// Arquivos do app: rede primeiro (pega atualizações) e cópia local se cair a conexão.
// Dados (Supabase) nunca são guardados aqui: sempre vêm do servidor.
const VERSAO = "garcom-v2";
const ESSENCIAIS = [
  "./", "./index.html", "./app.js", "./garcom.css", "./manifest.webmanifest",
  "./icones/icone-192.png", "./icones/icone-512.png",
  "../app/css/app.css", "../app/js/api.js", "../app/js/config.js", "../app/js/estado.js", "../app/js/ui.js",
  "../app/js/icons.js", "../app/js/seletor.js", "../app/js/mesa-detalhe.js", "../app/js/links.js", "../assets/config.js",
  "../app/js/contingencia.js", "../assets/dispositivo.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ESSENCIAIS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return; // dados sempre ao vivo
  const mesmo = url.origin === self.location.origin;
  const cdn = url.hostname === "cdn.jsdelivr.net" || url.hostname.endsWith("gstatic.com") || url.hostname === "fonts.googleapis.com";
  if (!mesmo && !cdn) return;

  if (cdn) {
    // Bibliotecas versionadas: cache primeiro
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((resp) => {
      if (resp.ok || resp.type === "opaque") { const copia = resp.clone(); caches.open(VERSAO).then((c) => c.put(req, copia)); }
      return resp;
    })));
    return;
  }
  e.respondWith(fetch(req).then((resp) => {
    if (resp.ok) { const copia = resp.clone(); caches.open(VERSAO).then((c) => c.put(req, copia)); }
    return resp;
  }).catch(() => caches.match(req).then((r) => r || (req.mode === "navigate" ? caches.match("./index.html") : Response.error()))));
});
