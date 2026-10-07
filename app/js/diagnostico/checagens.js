// =====================================================================
// Checagens de saúde: um "check-up" completo do aparelho e do servidor.
// Cada checagem é independente (se uma travar, as outras rodam) e devolve:
//   { id, grupo, titulo, status: ok|aviso|erro|info|pulado, valor, detalhe, problema? }
// `problema` aponta para o catálogo (catalogo.js) com a explicação e a solução.
// Lê o que pode direto do navegador (localStorage, caches) para funcionar
// mesmo quando o resto do sistema não carregou.
// =====================================================================
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";
import { FUNCOES, TABELAS, ARQUIVOS, EDGE } from "./mapa-banco.js";

const lerLS = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const comTempo = (p, ms, msg = "tempo esgotado") => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
};
const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(".", ",") + " s" : Math.round(n) + " ms");

async function modApi() { return import("../api.js"); }
async function modEstado() { try { return await import("../estado.js"); } catch { return null; } }

// Compartilhado entre checagens de uma mesma rodada
let r = {};

// ---------- As checagens, na ordem em que aparecem ----------
const CHECAGENS = [
  {
    id: "navegador", grupo: "Aparelho", titulo: "Navegador",
    async rodar() {
      const ua = navigator.userAgent;
      const nav = /Edg\/(\d+)/.test(ua) ? "Edge " + RegExp.$1 : /OPR\/(\d+)/.test(ua) ? "Opera " + RegExp.$1 : /Chrome\/(\d+)/.test(ua) ? "Chrome " + RegExp.$1
        : /Firefox\/(\d+)/.test(ua) ? "Firefox " + RegExp.$1 : /Version\/(\d+).*Safari/.test(ua) ? "Safari " + RegExp.$1 : "Desconhecido";
      const so = /Windows NT 10/.test(ua) ? "Windows 10/11" : /Windows/.test(ua) ? "Windows" : /Android (\d+)/.test(ua) ? "Android " + RegExp.$1
        : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
      const usb = "usb" in navigator, serial = "serial" in navigator;
      const seguro = window.isSecureContext;
      const versao = Number((nav.match(/\d+/) || [0])[0]);
      const chromium = /Chrome|Edge|Opera/.test(nav);
      const extras = [`WebUSB ${usb ? "✓" : "✗"}`, `Web Serial ${serial ? "✓" : "✗"}`, `HTTPS ${seguro ? "✓" : "✗"}`].join(" · ");
      if (!seguro) return { status: "erro", valor: `${nav} · ${so}`, detalhe: "Página aberta sem HTTPS: impressão direta, balança e modo offline não funcionam. " + extras, problema: "navegador-sem-suporte" };
      if (chromium && versao && versao < 100) return { status: "aviso", valor: `${nav} · ${so}`, detalhe: "Navegador muito antigo. Atualize o Chrome/Edge. " + extras };
      if (!chromium) return { status: "aviso", valor: `${nav} · ${so}`, detalhe: "Funciona para vender, mas impressão direta (USB/serial) e balança só existem no Chrome/Edge de computador. " + extras, problema: "navegador-sem-suporte" };
      return { status: "ok", valor: `${nav} · ${so}`, detalhe: extras };
    },
  },
  {
    id: "internet", grupo: "Conexão", titulo: "Internet até o servidor",
    async rodar() {
      if (!navigator.onLine) { r.online = false; return { status: "erro", valor: "Desconectado", detalhe: "O aparelho diz que não há rede (Wi-Fi/cabo).", problema: "rede-sem-internet" }; }
      const tempos = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        try {
          const resp = await comTempo(fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_ANON_KEY }, cache: "no-store" }), 8000);
          tempos.push(performance.now() - t0);
          r.healthStatus = resp.status;
        } catch (e) {
          r.online = false;
          return { status: "erro", valor: "Sem resposta", detalhe: `O Wi-Fi/cabo está conectado, mas o servidor não respondeu (${e.message}). Internet do provedor fora, DNS ou bloqueio de firewall.`, problema: /tempo/.test(e.message) ? "rede-lenta" : "rede-sem-internet" };
        }
      }
      r.online = true;
      const med = tempos.sort((a, b) => a - b)[1];
      r.latencia = med;
      if (med > 2000) return { status: "erro", valor: ms(med), detalhe: "Muito lenta: o caixa vai travar e cair para o modo offline com frequência.", problema: "rede-lenta" };
      if (med > 800) return { status: "aviso", valor: ms(med), detalhe: "Lenta. Normal é abaixo de 300 ms.", problema: "rede-lenta" };
      return { status: "ok", valor: ms(med), detalhe: `Tempo de resposta (mediana de 3 tentativas). ${med < 300 ? "Ótimo." : "Aceitável."}` };
    },
  },
  {
    id: "servidor", grupo: "Conexão", titulo: "Servidor (Supabase)",
    async rodar() {
      if (r.online === false) return { status: "pulado", valor: "—", detalhe: "Sem internet para testar." };
      try {
        const resp = await comTempo(fetch(`${SUPABASE_URL}/rest/v1/`, { headers: { apikey: SUPABASE_ANON_KEY }, cache: "no-store" }), 8000);
        if (resp.status === 540 || resp.status === 402) return { status: "erro", valor: `Pausado (${resp.status})`, detalhe: "O projeto está pausado/bloqueado no Supabase.", problema: "servidor-pausado" };
        if (resp.status >= 500) return { status: "erro", valor: `Erro ${resp.status}`, detalhe: "O servidor está com problema agora.", problema: "servidor-fora" };
        return { status: "ok", valor: "Respondendo", detalhe: `API de dados ok (HTTP ${resp.status}). Projeto: ${new URL(SUPABASE_URL).hostname.split(".")[0]}` };
      } catch (e) {
        return { status: "erro", valor: "Sem resposta", detalhe: e.message, problema: "servidor-fora" };
      }
    },
  },
  {
    id: "sessao", grupo: "Login", titulo: "Sessão (login)",
    async rodar() {
      const { sb } = await modApi();
      const { data } = await comTempo(sb.auth.getSession(), 8000);
      const s = data?.session;
      if (!s) return { status: "info", valor: "Ninguém conectado", detalhe: "Tela de login. As checagens de loja e banco precisam de alguém conectado." };
      r.logado = true;
      const resta = s.expires_at * 1000 - Date.now();
      if (resta <= 0) {
        if (r.online === false) return { status: "aviso", valor: "Vencida (offline)", detalhe: "Sem internet o login não renova; renova sozinho quando a conexão voltar.", problema: "login-sessao-expirada" };
        const { error } = await comTempo(sb.auth.refreshSession(), 8000);
        if (error) return { status: "erro", valor: "Vencida", detalhe: `Não conseguiu renovar: ${error.message}`, problema: "login-sessao-expirada" };
        return { status: "ok", valor: "Renovada agora", detalhe: s.user?.email || "" };
      }
      return { status: "ok", valor: `Válida por ${Math.round(resta / 60000)} min`, detalhe: `${s.user?.email || ""} · renova sozinha antes de vencer` };
    },
  },
  {
    id: "relogio", grupo: "Login", titulo: "Relógio do aparelho",
    async rodar() {
      if (r.online === false) return { status: "pulado", valor: "—", detalhe: "Sem internet para comparar." };
      if (!r.logado) return { status: "pulado", valor: "—", detalhe: "Precisa de alguém conectado." };
      const { sb } = await modApi();
      const t0 = Date.now();
      const { data, error } = await comTempo(sb.rpc("diagnostico_servidor"), 10000);
      const t1 = Date.now();
      if (error) { r.semDiag = true; return { status: "pulado", valor: "—", detalhe: "Precisa da migração 017_diagnostico.sql no Supabase." }; }
      r.servidor = data;
      const servidor = new Date(data.agora).getTime() + (t1 - t0) / 2;
      const dif = Math.round((t1 - servidor) / 1000);
      const txt = `${dif > 0 ? "adiantado" : "atrasado"} ${Math.abs(dif)} s · aparelho ${new Date(t1).toLocaleTimeString("pt-BR")}`;
      if (Math.abs(dif) > 120) return { status: "erro", valor: `${Math.abs(dif) >= 3600 ? Math.round(Math.abs(dif) / 3600) + " h" : Math.round(Math.abs(dif) / 60) + " min"} de diferença`, detalhe: txt, problema: "login-relogio" };
      if (Math.abs(dif) > 30) return { status: "aviso", valor: `${Math.abs(dif)} s de diferença`, detalhe: txt, problema: "login-relogio" };
      return { status: "ok", valor: "Certo", detalhe: txt };
    },
  },
  {
    id: "banco", grupo: "Banco", titulo: "Banco atualizado (migrações)",
    async rodar() {
      if (r.online === false || !r.logado) return { status: "pulado", valor: "—", detalhe: "Precisa de internet e de alguém conectado." };
      if (r.semDiag || !r.servidor) return { status: "aviso", valor: "017 não aplicada", detalhe: "Rode supabase/migrations/017_diagnostico.sql para esta checagem (e para ver os erros das lojas de longe).", problema: "banco-funcao-faltando" };
      const fs = new Set(r.servidor.funcoes || []), ts = new Set(r.servidor.tabelas || []);
      const faltam = {};
      for (const [n, m] of Object.entries(FUNCOES)) if (!fs.has(n)) (faltam[m] ||= []).push(n + "()");
      for (const [n, m] of Object.entries(TABELAS)) if (!ts.has(n)) (faltam[m] ||= []).push(n);
      const ms_ = Object.keys(faltam).sort();
      if (!ms_.length) return { status: "ok", valor: `Todas as ${Object.keys(ARQUIVOS).length} migrações`, detalhe: `${fs.size} funções e ${ts.size} tabelas conferidas.` };
      return { status: "erro", valor: `Falta${ms_.length > 1 ? "m" : ""} ${ms_.join(", ")}`,
        detalhe: ms_.map((m) => `${ARQUIVOS[m]}: ${faltam[m].slice(0, 4).join(", ")}${faltam[m].length > 4 ? "…" : ""}`).join("\n"),
        problema: "banco-funcao-faltando", extra: { faltam: ms_.map((m) => ARQUIVOS[m]), alvo: "rpc/" + (faltam[ms_[0]].find((x) => x.endsWith("()")) || "").replace("()", "") } };
    },
  },
  {
    id: "loja", grupo: "Loja", titulo: "Usuário e loja",
    async rodar() {
      const m = await modEstado();
      const e = m?.estado;
      if (!e?.perfil) return { status: r.logado ? "aviso" : "pulado", valor: r.logado ? "Sem loja" : "—", detalhe: r.logado ? "Logado mas sem perfil/loja (cadastro inicial não concluído)." : "Ninguém conectado." };
      const papel = m.PAPEIS?.[e.perfil.papel]?.nome || e.perfil.papel;
      return { status: e.offline ? "aviso" : "ok", valor: `${e.perfil.nome} · ${papel}`,
        detalhe: `${e.empresa?.nome_fantasia || e.empresa?.razao_social || "Loja"}${e.offline ? " · aberto com a cópia local (sem internet)" : ""}` };
    },
  },
  {
    id: "aparelho", grupo: "Loja", titulo: "Aparelho vinculado",
    async rodar() {
      const e = (await modEstado())?.estado;
      const d = e?.dispositivo;
      if (!e?.perfil || !d) return { status: "pulado", valor: "—", detalhe: "Precisa de alguém conectado (com internet)." };
      if (d.sem_migracao) return { status: "aviso", valor: "018 não aplicada", detalhe: "Rode supabase/migrations/018_dispositivos.sql para exigir aparelho vinculado." };
      if (d.status === "livre") return { status: "info", valor: "Livre", detalhe: "Este nível de acesso pode usar qualquer aparelho." };
      if (["liberado", "vinculado"].includes(d.status)) return { status: "ok", valor: d.nome || "Liberado", detalhe: `Código ${d.aparelho || "?"} · ${d.usados ?? "?"} de ${d.limite ?? "?"} aparelho(s) do usuário` };
      if (d.status === "erro") return { status: "aviso", valor: "Não verificado", detalhe: d.mensagem || "" };
      return { status: "erro", valor: d.status === "conflito" ? "Chave não confere" : "Sem vaga", detalhe: `Código ${d.aparelho || "?"} · limite ${d.limite ?? "?"}`, problema: "aparelho-nao-autorizado" };
    },
  },
  {
    id: "assinatura", grupo: "Loja", titulo: "Assinatura",
    async rodar() {
      const c = (await modEstado())?.estado?.conta;
      if (!c) return { status: "pulado", valor: "—", detalhe: "Situação da conta não carregada." };
      if (c.bloqueio) return { status: "erro", valor: "Vendas bloqueadas", detalhe: c.bloqueio, problema: "regra-conta-bloqueada" };
      if (c.status !== "ativo") return { status: "aviso", valor: "Teste grátis", detalhe: `${c.vendas_teste ?? "?"} de 200 vendas · expira ${c.teste_expira_em ? new Date(c.teste_expira_em).toLocaleDateString("pt-BR") : "?"}` };
      return { status: "ok", valor: "Ativa", detalhe: `Plano ${c.plano || ""}`.trim() };
    },
  },
  {
    id: "caixa", grupo: "Loja", titulo: "Caixa deste usuário",
    async rodar() {
      const e = (await modEstado())?.estado;
      if (!e?.perfil) return { status: "pulado", valor: "—", detalhe: "Ninguém conectado." };
      if (!["admin", "gerente", "caixa"].includes(e.perfil.papel)) return { status: "info", valor: "Não se aplica", detalhe: "Este nível não abre caixa." };
      if (!e.caixa) return { status: "info", valor: "Fechado", detalhe: "Para vender é preciso abrir o caixa (Caixa › Abrir).", problema: "regra-caixa-fechado" };
      return { status: "ok", valor: "Aberto", detalhe: `Desde ${new Date(e.caixa.aberto_em || e.caixa.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` };
    },
  },
  {
    id: "fila", grupo: "Vendas offline", titulo: "Vendas feitas sem internet",
    async rodar() {
      const itens = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith("lis-fila-vendas-")) itens.push(...(lerLS(k) || [])); }
      if (!itens.length) return { status: "ok", valor: "Nenhuma pendente", detalhe: "Todas as vendas chegaram ao servidor." };
      const comErro = itens.filter((x) => x.erro);
      const total = itens.reduce((s, x) => s + (Number(x.total) || 0), 0);
      const velha = Math.min(...itens.map((x) => new Date(x.criado_em).getTime()));
      const idade = Math.round((Date.now() - velha) / 60000);
      const det = `${itens.length} venda(s) · R$ ${total.toFixed(2).replace(".", ",")} · mais antiga há ${idade >= 120 ? Math.round(idade / 60) + " h" : idade + " min"}`;
      if (comErro.length) return { status: "erro", valor: `${comErro.length} recusada(s)`, detalhe: det + "\nMotivos: " + [...new Set(comErro.map((x) => x.erro))].join("; "), problema: "offline-venda-recusada" };
      return { status: r.online === false ? "aviso" : idade > 30 ? "erro" : "aviso", valor: `${itens.length} aguardando`, detalhe: det + (r.online === false ? " · serão enviadas quando a internet voltar" : idade > 30 ? " · com internet e ainda não foram: confira" : ""), problema: r.online === false ? "rede-sem-internet" : "offline-venda-recusada" };
    },
  },
  {
    id: "armazenamento", grupo: "Aparelho", titulo: "Armazenamento do navegador",
    async rodar() {
      const partes = { "Vendas offline": 0, "Catálogo": 0, "Venda em andamento": 0, "Diagnóstico": 0, "Login": 0, "Outros": 0 };
      let total = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i), n = (k.length + (localStorage.getItem(k) || "").length) * 2;
        total += n;
        const g = k.startsWith("lis-fila") ? "Vendas offline" : k.startsWith("lis-catalogo") ? "Catálogo" : /rascunho|venda-atual|cupom/.test(k) ? "Venda em andamento"
          : k.startsWith("lis-diag") ? "Diagnóstico" : /auth/.test(k) ? "Login" : "Outros";
        partes[g] += n;
      }
      const LIMITE = 5 * 1024 * 1024;
      const pct = Math.round((total / LIMITE) * 100);
      const det = Object.entries(partes).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g}: ${kb(n)}`).join(" · ");
      let anonimo = "";
      try { const est = await navigator.storage?.estimate?.(); if (est?.quota && est.quota < 200 * 1024 * 1024) anonimo = " · cota pequena (janela anônima?)"; } catch { /* ignora */ }
      r.armazenamento = { total, partes };
      if (pct > 85) return { status: "erro", valor: `${pct}% usado`, detalhe: det + anonimo, problema: "armazenamento-cheio", barra: pct };
      if (pct > 60 || anonimo) return { status: "aviso", valor: `${pct}% usado`, detalhe: det + anonimo, problema: "armazenamento-cheio", barra: pct };
      return { status: "ok", valor: `${pct}% usado`, detalhe: det, barra: pct };
    },
  },
  {
    id: "atualizacao", grupo: "Aparelho", titulo: "Versão e cópia offline (service worker)",
    async rodar() {
      if (!("serviceWorker" in navigator)) return { status: "aviso", valor: "Sem suporte", detalhe: "Este navegador não guarda cópia offline do sistema." };
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg?.active) return { status: "aviso", valor: "Não instalado", detalhe: "Sem cópia offline: se a internet cair ao abrir, o sistema não abre. Abra uma vez com internet (precisa de HTTPS).", problema: "atualizacao-arquivo" };
      const chaves = await caches.keys();
      let publicada = null;
      try { const txt = await comTempo(fetch(reg.active.scriptURL, { cache: "no-store" }).then((x) => x.text()), 6000); publicada = txt.match(/VERSAO\s*=\s*"([^"]+)"/)?.[1] || null; } catch { /* offline */ }
      const prefixo = (publicada || chaves[0] || "").split("-")[0];
      const emUso = chaves.filter((k) => k.startsWith(prefixo + "-")).sort().pop() || chaves[0] || "?";
      const versao = `Sistema ${window.lisDiag?.versao || "?"}`;
      if (!navigator.serviceWorker.controller) return { status: "aviso", valor: "Atualizando", detalhe: `${versao} · recarregue a página para usar a cópia offline.`, problema: "atualizacao-modulo" };
      if (publicada && emUso !== publicada) return { status: "aviso", valor: "Atualização pendente", detalhe: `${versao} · em uso: ${emUso} · publicada: ${publicada}. Feche e abra o sistema (ou limpe o cache).`, problema: "atualizacao-modulo" };
      let n = 0; try { n = (await (await caches.open(emUso)).keys()).length; } catch { /* ignora */ }
      return { status: "ok", valor: emUso, detalhe: `${versao} · ${n} arquivos guardados para abrir sem internet` };
    },
  },
  {
    id: "bibliotecas", grupo: "Aparelho", titulo: "Bibliotecas externas",
    async rodar() {
      const libs = [["QR Code (PIX)", typeof window.qrcode === "function"]];
      if (document.querySelector('script[src*="JsBarcode"]')) libs.push(["Código de barras", typeof window.JsBarcode === "function"]);
      let supa = false; try { await comTempo(modApi(), 6000); supa = true; } catch { /* falhou */ }
      libs.unshift(["Supabase", supa]);
      const falta = libs.filter(([, ok]) => !ok).map(([n]) => n);
      const det = libs.map(([n, ok]) => `${n} ${ok ? "✓" : "✗"}`).join(" · ");
      if (falta.length) return { status: "erro", valor: `Falta: ${falta.join(", ")}`, detalhe: det, problema: "atualizacao-cdn" };
      return { status: "ok", valor: "Carregadas", detalhe: det };
    },
  },
  {
    id: "impressora", grupo: "Periféricos", titulo: "Impressora",
    async rodar() {
      const c = { modo: "navegador", largura: 80, ...(lerLS("pdv-impressora") || {}) };
      if (c.modo === "navegador") return { status: "ok", valor: `Pelo navegador · ${c.largura} mm`, detalhe: "Usa a impressora instalada no Windows (janela de impressão ou --kiosk-printing)." };
      if (c.modo === "usb") {
        if (!("usb" in navigator)) return { status: "erro", valor: "USB direto sem suporte", detalhe: "Este navegador não tem WebUSB.", problema: "navegador-sem-suporte" };
        const ds = await navigator.usb.getDevices();
        if (!ds.length) return { status: "erro", valor: "Não pareada", detalhe: "Modo USB direto, mas nenhuma impressora autorizada neste navegador.", problema: "impressora-nao-pareada" };
        return { status: "ok", valor: `USB · ${ds[0].productName || "impressora"}`, detalhe: ds.map((d) => `${d.manufacturerName || ""} ${d.productName || ""} (${d.vendorId.toString(16)}:${d.productId.toString(16)})`.trim()).join(" · ") + ` · ${c.largura} mm` };
      }
      if (c.modo === "serial") {
        if (!("serial" in navigator)) return { status: "erro", valor: "Serial sem suporte", detalhe: "Este navegador não tem Web Serial.", problema: "navegador-sem-suporte" };
        const ps = await navigator.serial.getPorts();
        if (!ps.length) return { status: "erro", valor: "Não pareada", detalhe: "Modo serial, mas nenhuma porta autorizada.", problema: "impressora-nao-pareada" };
        return { status: "ok", valor: `Serial · ${c.baudRate || 9600} baud`, detalhe: `${ps.length} porta(s) autorizada(s)` };
      }
      return { status: "aviso", valor: c.modo, detalhe: "Modo desconhecido." };
    },
  },
  {
    id: "balanca", grupo: "Periféricos", titulo: "Balança",
    async rodar() {
      const c = lerLS("pdv-balanca") || {};
      if (!c.ativa) return { status: "info", valor: "Desligada", detalhe: "Não usa balança integrada (etiquetas de balança funcionam igual)." };
      if (c.protocolo === "simulador") return { status: "aviso", valor: "Simulador", detalhe: "Modo de treino: o peso é sorteado, não é a balança real." };
      if (!("serial" in navigator)) return { status: "erro", valor: "Sem suporte", detalhe: "Balança precisa de Chrome/Edge no computador.", problema: "navegador-sem-suporte" };
      const ps = await navigator.serial.getPorts();
      if (!ps.length) return { status: "erro", valor: "Não pareada", detalhe: `Protocolo ${c.protocolo || "toledo"}, mas nenhuma porta autorizada.`, problema: "balanca-sem-resposta" };
      return { status: "ok", valor: `${c.protocolo || "toledo"} · ${c.baudRate || 9600} baud`, detalhe: `${ps.length} porta(s) serial autorizada(s). Teste pesando um produto no PDV.` };
    },
  },
  {
    id: "edge", grupo: "Servidor", titulo: "Funções do servidor (Edge Functions)",
    async rodar() {
      if (r.online === false) return { status: "pulado", valor: "—", detalhe: "Sem internet para testar." };
      const res = await Promise.all(Object.keys(EDGE).map(async (n) => {
        try { const x = await comTempo(fetch(`${SUPABASE_URL}/functions/v1/${n}`, { method: "OPTIONS", cache: "no-store" }), 8000); return [n, x.status < 400 ? "ok" : x.status === 404 ? "falta" : "erro" + x.status]; }
        catch { return [n, "sem resposta"]; }
      }));
      const ruins = res.filter(([, s]) => s !== "ok");
      const det = res.map(([n, s]) => `${n} ${s === "ok" ? "✓" : "✗ " + s}`).join(" · ");
      if (!ruins.length) return { status: "ok", valor: `${res.length} publicadas`, detalhe: det };
      return { status: "aviso", valor: `${ruins.length} com problema`, detalhe: det + "\n“sem resposta” quase sempre = não publicada: supabase functions deploy <nome>", problema: "edge-nao-publicada", extra: { edge: ruins[0][0] } };
    },
  },
  {
    id: "tempo-real", grupo: "Servidor", titulo: "Tempo real (Realtime)",
    async rodar() {
      const { sb } = await modApi();
      const cs = sb.getChannels?.() || [];
      if (!cs.length) return { status: "info", valor: "Nenhum canal", detalhe: "Esta tela não usa atualização em tempo real." };
      const ruins = cs.filter((c) => ["errored", "closed"].includes(c.state));
      const det = cs.map((c) => `${String(c.topic).replace(/^realtime:/, "").replace(/-[0-9a-f-]{20,}.*/, "")}: ${c.state}`).join(" · ");
      if (ruins.length) return { status: "aviso", valor: `${ruins.length} de ${cs.length} caídos`, detalhe: det, problema: "tempo-real" };
      return { status: "ok", valor: `${cs.length} conectado(s)`, detalhe: det };
    },
  },
  {
    id: "erros", grupo: "Histórico", titulo: "Problemas nas últimas 24 h",
    async rodar() {
      const evs = (window.lisDiag?.eventos() || []).filter((e) => e.tipo !== "info" && Date.now() - e.em < 864e5);
      const graves = evs.filter((e) => ["critica", "alta"].includes(e.gravidade));
      if (!evs.length) return { status: "ok", valor: "Nenhum", detalhe: "Nenhum erro registrado neste aparelho." };
      return { status: graves.length ? "aviso" : "info", valor: `${evs.length} registro(s)`, detalhe: `${graves.length} grave(s). Veja a linha do tempo abaixo.` };
    },
  },
  {
    id: "desempenho", grupo: "Aparelho", titulo: "Desempenho",
    async rodar() {
      const nav = performance.getEntriesByType("navigation")[0];
      const carga = nav ? nav.loadEventEnd || nav.duration : 0;
      const mem = performance.memory ? performance.memory.usedJSHeapSize : 0;
      const abertoHa = Math.round((Date.now() - (window.lisDiag?.marcas().inicio || Date.now())) / 60000);
      const det = `Abriu em ${carga ? ms(carga) : "?"}${mem ? ` · memória ${kb(mem)}` : ""} · aberto há ${abertoHa >= 120 ? Math.round(abertoHa / 60) + " h" : abertoHa + " min"} · ${navigator.hardwareConcurrency || "?"} núcleos`;
      if (mem > 800 * 1024 * 1024) return { status: "aviso", valor: "Memória alta", detalhe: det + " · recarregar a página libera memória" };
      if (carga > 8000) return { status: "aviso", valor: "Abertura lenta", detalhe: det };
      return { status: "ok", valor: carga ? ms(carga) : "ok", detalhe: det };
    },
  },
];

export const LISTA = CHECAGENS.map(({ id, grupo, titulo }) => ({ id, grupo, titulo }));

/** Roda todas as checagens; chama aoProgresso(resultados) a cada uma que termina. */
export async function rodarChecagens(aoProgresso = () => {}) {
  r = {};
  const res = CHECAGENS.map(({ id, grupo, titulo }) => ({ id, grupo, titulo, status: "rodando" }));
  aoProgresso(res);
  for (let i = 0; i < CHECAGENS.length; i++) {
    const t0 = performance.now();
    try {
      Object.assign(res[i], await comTempo(CHECAGENS[i].rodar(), 15000, "a checagem demorou demais"));
    } catch (e) {
      Object.assign(res[i], { status: "erro", valor: "Falhou", detalhe: e?.message || String(e),
        problema: /import|module/i.test(e?.message) ? "atualizacao-cdn" : /tempo|fetch|network/i.test(e?.message) ? "rede-sem-internet" : null });
      if (/dynamically imported|module script/i.test(e?.message)) Object.assign(res[i], { status: "erro", valor: "Não testado", detalhe: "Os arquivos do sistema/Supabase não carregaram, então não deu para testar isto." });
    }
    res[i].ms = Math.round(performance.now() - t0);
    aoProgresso(res);
  }
  return res;
}

/** Nota geral: o pior status encontrado. */
export function resumoGeral(res) {
  const n = (s) => res.filter((x) => x.status === s).length;
  const erro = n("erro"), aviso = n("aviso");
  return { status: erro ? "erro" : aviso ? "aviso" : "ok", erro, aviso, ok: n("ok") };
}
