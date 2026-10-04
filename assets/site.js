// Site de vendas: preços, simulador, captação de contatos e início do teste grátis.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { MARCA, PRECOS, SUPABASE_URL, SUPABASE_ANON_KEY, linkWhatsApp } from "./config.js";
import { obterDispositivo, obterImpressao } from "./dispositivo.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const brl = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: n % 1 || n < 10 ? 2 : 0 });
const brl2 = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: "pdv-auth", persistSession: true } });

// ---------- Marca, preços e WhatsApp ----------
$$("[data-marca]").forEach((e) => (e.textContent = MARCA));
$$("[data-preco]").forEach((e) => {
  const v = PRECOS[e.dataset.preco];
  const txt = e.hasAttribute("data-sem-rs") ? v.toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : brl2(v);
  e.textContent = (e.hasAttribute("data-mais") ? "+ " : "") + txt + (e.dataset.sufixo || "");
});
const zap = linkWhatsApp(`Olá! Vi o site do ${MARCA} e quero saber mais.`);
if (zap) { const z = $("#zap-flutua"); z.href = zap; z.hidden = false; }

// ---------- Simulador ----------
const sim = $("#sim");
let caixas = 1;
function calcular() {
  const equip = sim.equip.value;
  const nota = sim.nota.checked, gaveta = sim.gaveta.checked, manut = sim.manut.checked;
  const itens = []; const obs = []; let total = 0; let entrada = 0; let promo = null;
  const combo = equip.startsWith("combo");
  $("#linha-caixas").hidden = equip === "tenho";
  $("#linha-nota").hidden = combo;
  $("#linha-gaveta").hidden = !combo && equip !== "compra";
  $("#linha-manut").hidden = equip !== "compra";

  if (combo) {
    itens.push([`Combo Completo, 1º caixa${equip === "combo_note" ? " (notebook)" : ""}`, PRECOS.combo]);
    if (caixas > 1) itens.push([`${caixas - 1} ${caixas > 2 ? "caixas adicionais" : "caixa adicional"}`, (caixas - 1) * PRECOS.caixaExtra]);
    if (equip === "combo_note") itens.push([`Notebook no lugar do desktop × ${caixas}`, caixas * PRECOS.notebook]);
    if (gaveta) itens.push([`Gaveta de dinheiro × ${caixas}`, caixas * PRECOS.gaveta]);
    total = itens.reduce((a, [, v]) => a + v, 0);
    promo = total - PRECOS.combo + PRECOS.comboPromo;
    obs.push("Entrada R$ 0,00. Instalação, treinamento, nota fiscal e manutenção inclusos.");
    obs.push(`Contratando durante o teste: ${brl2(promo)} nos 3 primeiros meses.`);
    obs.push("Fidelidade de 24 meses.");
  } else if (equip === "compra") {
    itens.push([nota ? "Sistema + Nota fiscal" : "Sistema", nota ? PRECOS.sistemaNota : PRECOS.sistema]);
    if (manut) itens.push([`Manutenção dos equipamentos × ${caixas}`, caixas * PRECOS.manutencaoAvulsa]);
    total = itens.reduce((a, [, v]) => a + v, 0);
    entrada = caixas * PRECOS.kitCompra + (gaveta ? caixas * PRECOS.gavetaCompra : 0);
    obs.push(`Equipamentos: ${brl2(entrada)} (${caixas} kit${caixas > 1 ? "s" : ""}${gaveta ? " com gaveta" : ""}), em até 10 vezes. Instalação inclusa.`);
    obs.push("Sem fidelidade no sistema.");
  } else {
    itens.push([nota ? "Sistema + Nota fiscal" : "Sistema", nota ? PRECOS.sistemaNota : PRECOS.sistema]);
    total = itens[0][1];
    obs.push("Caixas e usuários ilimitados. Configuração remota inclusa.");
    obs.push("Sem fidelidade.");
  }
  $("#sim-itens").innerHTML = itens.map(([n, v]) => `<div class="rk-linha"><span>${esc(n)}</span><b>${brl2(v)}</b></div>`).join("");
  $("#sim-total").textContent = brl2(total);
  $("#sim-obs").innerHTML = obs.map((o) => `<span>${esc(o)}</span>`).join("");
  return { equip, caixas, nota: combo || nota, gaveta, total, entrada, promo };
}
sim.addEventListener("change", calcular);
$$(".contador button").forEach((b) => (b.onclick = () => { caixas = Math.min(10, Math.max(1, caixas + Number(b.dataset.d))); $("#caixas").textContent = caixas; calcular(); }));
calcular();
$("#sim-quero").onclick = () => {
  const r = calcular();
  const nomes = { combo: "Combo desktop", combo_note: "Combo notebook", compra: "Compra do kit", tenho: "Só sistema" };
  abrirContato(`${nomes[r.equip]} · ${r.equip === "tenho" ? "" : r.caixas + " caixa(s) · "}${r.nota ? "com nota" : "sem nota"}${r.gaveta ? " · gaveta" : ""} · ${brl2(r.total)}/mês`);
};

// ---------- Chamada às funções do servidor ----------
async function chamar(corpo, token) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/teste`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}` },
    body: JSON.stringify(corpo),
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(dados.error || "Não foi possível enviar agora. Tente novamente.");
  return dados;
}
const lerForm = (f) => Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, String(v).trim()]));
const digitos = (s) => String(s || "").replace(/\D/g, "");
function docValido(c) {
  c = digitos(c);
  if (c.length === 11) {
    if (/^(\d)\1+$/.test(c)) return false;
    for (let t = 9; t < 11; t++) { let s = 0; for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i); if (((s * 10) % 11) % 10 !== Number(c[t])) return false; }
    return true;
  }
  if (c.length === 14) {
    if (/^(\d)\1+$/.test(c)) return false;
    const calc = (n) => { const p = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]; const r = p.reduce((a, w, i) => a + Number(c[i]) * w, 0) % 11; return r < 2 ? 0 : 11 - r; };
    return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
  }
  return false;
}
const mensagem = (alvo, texto, tipo = "") => { alvo.innerHTML = texto ? `<div class="alerta ${tipo}">${texto}</div>` : ""; };

// Máscaras simples
function mascararTelefone(i) { i.addEventListener("input", () => { const d = digitos(i.value).slice(0, 11); i.value = d.length > 10 ? d.replace(/(\d{2})(\d{5})(\d{0,4})/, "($1) $2-$3") : d.replace(/(\d{2})(\d{0,4})(\d{0,4})/, (m, a, b, c) => `(${a}) ${b}${c ? "-" + c : ""}`).replace(/\D+$/, ""); }); }
function mascararDoc(i) { i.addEventListener("input", () => { const d = digitos(i.value).slice(0, 14); i.value = d.length <= 11 ? d.replace(/(\d{3})(\d{3})?(\d{3})?(\d{0,2})?/, (m, a, b, c, e) => [a, b, c].filter(Boolean).join(".") + (e ? "-" + e : "")) : d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, "$1.$2.$3/$4-$5"); }); }
$$('input[name="whatsapp"]').forEach(mascararTelefone);
$$('input[name="documento"]').forEach(mascararDoc);

// ---------- Teste grátis ----------
const fTeste = $("#form-teste");
fTeste.addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = lerForm(fTeste);
  const msg = $("#msg-teste");
  if (d.nome.length < 2 || d.loja.length < 2) return mensagem(msg, "Preencha seu nome e o nome da loja.");
  if (digitos(d.whatsapp).length < 10) return mensagem(msg, "Informe o WhatsApp com DDD.");
  if (!docValido(d.documento)) return mensagem(msg, "CPF ou CNPJ inválido. Confira os números.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return mensagem(msg, "Informe um e-mail válido.");
  if ((d.senha || "").length < 8) return mensagem(msg, "A senha precisa ter pelo menos 8 caracteres.");
  if (!fTeste.aceite.checked) return mensagem(msg, "Marque a autorização de contato para continuar.");
  mensagem(msg, "");
  const botao = fTeste.querySelector("button[type=submit]");
  botao.disabled = true; const rotulo = botao.textContent; botao.textContent = "Criando…";
  try {
    const dispositivo = obterDispositivo();
    const impressao = await obterImpressao();
    const base = { nome: d.nome, loja: d.loja, segmento: d.segmento, whatsapp: digitos(d.whatsapp), documento: digitos(d.documento), email: d.email, dispositivo, impressao, site: d.site };
    const v = await chamar({ acao: "verificar", interesse: "Teste grátis", ...base });
    if (!v.disponivel) {
      const z = linkWhatsApp(`Olá! Sou ${d.nome}, da ${d.loja}. Quero falar sobre o teste do ${MARCA}.`);
      mensagem(msg, `${esc(v.mensagem)}${z ? `<br><a class="botao primario" href="${z}" target="_blank" rel="noopener">Falar no WhatsApp</a>` : "<br>Nossa equipe vai entrar em contato pelo WhatsApp informado."}`, "aviso");
      return;
    }
    const appUrl = new URL("app/", location.href).href;
    const { data, error } = await sb.auth.signUp({
      email: d.email, password: d.senha,
      options: { emailRedirectTo: appUrl, data: { nome: d.nome, loja: d.loja, segmento: d.segmento, whatsapp: base.whatsapp, documento: base.documento, dispositivo } },
    });
    if (error) {
      if (/already|registered/i.test(error.message)) return mensagem(msg, `Este e-mail já tem cadastro. <a href="app/">Entre no sistema</a> ou use outro e-mail.`);
      if (/rate limit|too many/i.test(error.message)) return mensagem(msg, "Muitos cadastros agora. Tente em alguns minutos.");
      throw error;
    }
    // Se o e-mail já estiver confirmado (confirmação desligada no servidor), cria a loja na hora
    if (data.session) {
      await chamar({ acao: "iniciar", ...base }, data.session.access_token);
      location.href = appUrl + "#/painel";
      return;
    }
    fTeste.hidden = true;
    $("#email-ok").textContent = d.email;
    $("#teste-ok").hidden = false;
    $("#teste-ok").scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (err) {
    mensagem(msg, esc(err.message || "Não foi possível criar o teste agora."));
  } finally {
    botao.disabled = false; botao.textContent = rotulo;
  }
});

// ---------- Fale conosco ----------
const dlg = $("#dlg-contato"), fContato = $("#form-contato");
function abrirContato(interesse) {
  fContato.hidden = false;
  fContato.interesse.value = interesse || "Falar com consultor";
  mensagem($("#msg-contato"), "");
  dlg.showModal();
  fContato.nome.focus();
}
$$("[data-contato]").forEach((b) => (b.onclick = () => abrirContato(b.dataset.contato)));
$$("[data-fechar]", dlg).forEach((b) => (b.onclick = () => dlg.close()));
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
fContato.addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = lerForm(fContato);
  const msg = $("#msg-contato");
  if (d.nome.length < 2) return mensagem(msg, "Informe seu nome.");
  if (digitos(d.whatsapp).length < 10) return mensagem(msg, "Informe o WhatsApp com DDD.");
  const botao = fContato.querySelector("button[type=submit]");
  botao.disabled = true;
  try {
    await chamar({ acao: "contato", ...d, whatsapp: digitos(d.whatsapp) });
    mensagem(msg, "Recebemos seu contato. Vamos chamar você no WhatsApp em breve.", "aviso");
    fContato.reset();
    setTimeout(() => dlg.close(), 2600);
  } catch (err) { mensagem(msg, esc(err.message)); }
  finally { botao.disabled = false; }
});
