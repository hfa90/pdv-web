// Service worker do sistema (PDV): abre e vende mesmo sem internet.
// - Arquivos do sistema: rede primeiro (pega atualizações); sem rede, usa a cópia local.
// - Bibliotecas de CDN (Supabase, QR Code, fontes): cópia local primeiro, atualiza em segundo plano.
// - Dados do Supabase nunca passam por aqui: vendas offline ficam na fila do próprio PDV
//   (app/js/contingencia.js) e são enviadas quando a conexão volta.
const VERSAO = "pdv-v8";
const ESSENCIAIS = [
  "./", "./index.html", "./css/app.css",
  "./js/main.js", "./js/api.js", "./js/config.js", "./js/estado.js", "./js/ui.js", "./js/icons.js", "./js/links.js",
  "./js/contingencia.js", "./js/balanca.js", "./js/pesagem.js", "./js/serial-portas.js", "./js/seletor.js",
  "./js/mesa-detalhe.js", "./js/cozinha.js", "./js/avisos.js", "./js/pacotes.js",
  "./js/restaurante.js", "./js/aprovacoes.js", "./js/desempenho.js", "./js/paginas/cozinha.js", "./js/paginas/garcons.js", "./js/fechar-conta.js", "./js/recebimentos.js", "./js/turno.js", "./js/painel-garcons.js",
  "./js/impressao/cupom.js", "./js/impressao/escpos.js",
  "./js/paginas/pdv.js", "./js/paginas/caixa.js", "./js/paginas/vendas.js", "./js/paginas/login.js",
  "./js/paginas/clientes.js", "./js/paginas/painel.js", "./js/paginas/mesas.js", "./js/paginas/delivery.js",
  "./js/paginas/produtos.js", "./js/paginas/estoque.js", "./js/paginas/relatorios.js", "./js/paginas/usuarios.js",
  "./js/paginas/etiquetas.js", "./js/paginas/conta.js", "./js/paginas/configuracoes.js",
  "./js/paginas/fiado.js", "./js/paginas/promocoes.js", "./js/paginas/compras.js", "./js/paginas/validade.js",
  "./js/paginas/financeiro.js", "./js/paginas/alertas.js", "./js/promocoes-calc.js", "./js/gestao-ui.js",
  "./js/paginas/diagnostico.js",
  "./js/diagnostico/registro.js", "./js/diagnostico/catalogo.js", "./js/diagnostico/checagens.js", "./js/diagnostico/painel.js",
  "./js/diagnostico/estilo.js", "./js/diagnostico/relatorio.js", "./js/diagnostico/envio.js", "./js/diagnostico/mapa-banco.js",
  "./js/diagnostico/velocidade.js", "./js/dispositivos.js",
  "../assets/config.js", "../assets/pix.js", "../assets/dispositivo.js", "../assets/tema.js",
];
const CDN = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js",
  "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js",
];
const ehCdn = (url) => ["cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSAO).then(async (c) => {
    // Um arquivo que falhe não impede os outros
    await Promise.all([...ESSENCIAIS, ...CDN].map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith("pdv-") && k !== VERSAO).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// A página manda a lista do que já baixou (inclui os módulos internos do Supabase)
self.addEventListener("message", (e) => {
  if (e.data?.tipo !== "guardar" || !Array.isArray(e.data.urls)) return;
  e.waitUntil(caches.open(VERSAO).then((c) => Promise.all(e.data.urls.slice(0, 200).map(async (u) => {
    try { const url = new URL(u); if (!ehCdn(url) || await c.match(u)) return; await c.add(u); } catch { /* ignora */ }
  }))));
});

const comTempo = (p, ms) => new Promise((ok, falha) => { const t = setTimeout(() => falha(new Error("tempo")), ms); p.then((r) => { clearTimeout(t); ok(r); }, (e) => { clearTimeout(t); falha(e); }); });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return; // dados sempre ao vivo
  const mesmo = url.origin === self.location.origin;
  if (!mesmo && !ehCdn(url)) return;

  if (!mesmo) {
    // CDN: cópia local primeiro e atualiza em segundo plano
    e.respondWith(caches.open(VERSAO).then(async (c) => {
      const salvo = await c.match(req);
      const rede = fetch(req).then((r) => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => null);
      if (salvo) { e.waitUntil(rede); return salvo; }
      return (await rede) || Response.error();
    }));
    return;
  }

  // Arquivos do sistema: rede primeiro (até 4 s); se falhar ou demorar, cópia local
  e.respondWith(caches.open(VERSAO).then(async (c) => {
    const rede = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; });
    try { return await comTempo(rede, 4000); }
    catch {
      const salvo = await c.match(req, { ignoreSearch: true }) || (req.mode === "navigate" ? await c.match("./index.html") : null);
      if (salvo) { e.waitUntil(rede.catch(() => {})); return salvo; }
      return rede.catch(() => Response.error());
    }
  }));
});
