// Pedido por voz: o garçom fala, o sistema monta o pedido, o garçom confere e envia.
// Fluxo: Ouvir → Entender (IA no servidor quando configurada; senão, no próprio aparelho) → Conferir → Enviar.
// Nada vai para a cozinha sem o garçom ver o resumo. Itens com dúvida ficam travados até ele escolher.
// Usado pelo app do garçom (botão flutuante e detalhe da mesa) e pela tela Mesas do sistema.
import { fn, rpc } from "./api.js";
import { estado } from "./estado.js";
import { html, render, dinheiro, qtd as fmtQtd, lerNumero, toast, erro, modal, ocupado, numero } from "./ui.js";
import { icone } from "./icons.js";
import { catalogo } from "./seletor.js";
import { interpretar, prepararCatalogo, chaveAprendizado, semAcento } from "./voz-interpretar.js";

const Reconhecedor = window.SpeechRecognition || window.webkitSpeechRecognition;
export const vozDisponivel = () => !!Reconhecedor;
const ehAndroid = /android/i.test(navigator.userAgent);
const FRACIONADOS = ["KG", "G", "L", "ML", "M"];
const r3 = (n) => Math.round(n * 1000) / 1000;

// IA no servidor: null = ainda não sei, false = não configurada/publicada nesta sessão
let iaAtiva = null;
let catPreparado = null, catPreparadoDe = null;

// ---------- Aprendizado: o que o garçom corrigiu vale para as próximas falas neste aparelho ----------
const chaveLS = () => `voz-aprendido-${estado.empresa?.id || ""}`;
function lerAprendido() { try { return JSON.parse(localStorage.getItem(chaveLS()) || "{}") || {}; } catch { return {}; } }
function aprender(trecho, produtoId) {
  const k = chaveAprendizado(trecho || "");
  if (!k || k.length < 2) return;
  try {
    const a = lerAprendido();
    delete a[k]; a[k] = produtoId;                 // mais recente por último
    const ks = Object.keys(a);
    for (const x of ks.slice(0, Math.max(0, ks.length - 300))) delete a[x];
    localStorage.setItem(chaveLS(), JSON.stringify(a));
  } catch { /* sem armazenamento: só não aprende */ }
}

const comTempo = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("tempo")), ms))]);

/**
 * Abre o pedido por voz.
 * @param {{mesa?:object, pessoas?:number, mesas:()=>object[], onMudou?:()=>void}} op
 *   mesa: linha de mesas_painel() quando o garçom já está numa mesa (senão ele diz a mesa na fala).
 * @returns {Promise<{mesa:object, venda_id:string}|null>} a mesa que recebeu o pedido, ou null se cancelou
 */
export async function pedidoPorVoz(op) {
  const { produtos } = await catalogo();
  if (!produtos.length) { toast("Nenhum produto cadastrado", "erro"); return null; }
  if (catPreparadoDe !== produtos) { catPreparado = prepararCatalogo(produtos); catPreparadoDe = produtos; }
  const porId = new Map(produtos.map((p) => [p.id, p]));
  const mesaFixa = op.mesa || null;

  // Estado da tela
  let etapa = "ouvir";
  let fala = "", provisorio = "", alternativasFala = [];
  let rec = null, ouvindo = false, pararPedido = false, segurando = false, apertouEm = 0;
  let mesa = mesaFixa, pessoas = op.pessoas || null, escolherMesa = false;
  let itens = [];        // { uid, produto, quantidade, observacao, trecho, certeza, motivo, alternativas, confirmado, obs_de, obs_texto, escolhido }
  let naoEntendidos = []; // { uid, texto }
  let origem = "", aviso = "";
  let uid = 0;
  let falaAnterior = "";  // em "Falar mais", o resumo já montado continua

  return modal({
    titulo: "Pedido por voz", largo: true, fixo: true,
    corpo: html`<div class="voz" id="voz"></div>`,
    onPronto: (d, fechar) => {
      d.classList.add("modal-voz");
      const alvo = d.querySelector("#voz");
      const pararTudo = () => { pararPedido = true; try { rec?.abort(); } catch { /* ignora */ } ouvindo = false; window.speechSynthesis?.cancel(); };
      d.addEventListener("close", pararTudo);
      d.addEventListener("cancel", (e) => { if (itens.length && etapa === "resumo") e.preventDefault(); });

      // ======================== 1. OUVIR ========================
      const telaOuvir = () => {
        etapa = "ouvir";
        const alvoMesa = mesa ? mesa.nome : null;
        render(alvo, html`
          <div class="voz-alvo">${alvoMesa ? html`${icone("mesa", 'width="18" height="18"')} <strong>${alvoMesa}</strong>` : html`Diga a <strong>mesa</strong> e o pedido`}</div>
          <button type="button" class="voz-mic ${ouvindo ? "on" : ""}" id="voz-mic" aria-label="${ouvindo ? "Parar de ouvir" : "Falar"}" ${Reconhecedor ? "" : "disabled"}>
            ${icone("microfone", 'width="54" height="54"')}<span class="voz-onda"></span></button>
          <div class="voz-estado" id="voz-estado">${Reconhecedor ? (ouvindo ? "Ouvindo… fale o pedido" : "Toque para falar · ou segure enquanto fala") : "Este navegador não reconhece voz"}</div>
          <label class="field voz-texto-campo"><span>${Reconhecedor ? "O que entendi (pode corrigir)" : "Dite pelo microfone do teclado ou digite"}</span>
            <textarea class="input voz-texto" id="voz-texto" rows="3" placeholder="Ex.: Mesa 12, duas coca lata, um x-tudo sem cebola e uma porção de fritas">${fala}</textarea></label>
          <p class="hint voz-dica">Fale natural: quantidade, produto e o jeito (“sem cebola”, “bem passado”). ${mesaFixa ? "" : "Comece pela mesa."}</p>
          <div class="voz-rodape">
            <button type="button" class="btn lg" data-a="cancelar">${falaAnterior ? "Voltar ao resumo" : "Cancelar"}</button>
            <button type="button" class="btn primary lg" data-a="entender" ${fala.trim() ? "" : "disabled"}>Entender pedido</button>
          </div>`);
        ligarOuvir();
      };

      const mostrarFala = () => {
        const ta = alvo.querySelector("#voz-texto");
        if (!ta) return;
        ta.value = (fala + (provisorio ? (fala ? " " : "") + provisorio : "")).trim();
        ta.scrollTop = ta.scrollHeight;
        const b = alvo.querySelector('[data-a="entender"]');
        if (b) b.disabled = !ta.value.trim();
      };
      const mostrarEstado = (txt) => {
        const e = alvo.querySelector("#voz-estado"); if (e) e.textContent = txt;
        const m = alvo.querySelector("#voz-mic");
        if (m) { m.classList.toggle("on", ouvindo); m.setAttribute("aria-label", ouvindo ? "Parar de ouvir" : "Falar"); }
      };

      const comecar = () => {
        if (!Reconhecedor || ouvindo) return;
        pararPedido = false;
        rec = new Reconhecedor();
        rec.lang = "pt-BR";
        rec.interimResults = true;
        rec.maxAlternatives = 3;
        rec.continuous = !ehAndroid; // no Android o modo contínuo repete frases; reinicia sozinho no fim
        let altsSessao = [];
        rec.onresult = (ev) => {
          let parcial = "";
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i];
            if (r.isFinal) {
              const t = r[0].transcript.trim();
              fala = (fala + " " + t).trim();
              altsSessao.push([...r].slice(1).map((a) => a.transcript.trim()));
            } else parcial += r[0].transcript;
          }
          provisorio = parcial.trim();
          mostrarFala();
        };
        rec.onerror = (ev) => {
          if (ev.error === "no-speech" || ev.error === "aborted") return;
          pararPedido = true;
          const msg = ev.error === "not-allowed" || ev.error === "service-not-allowed"
            ? "Sem permissão para o microfone. Libere o microfone para este site nas configurações do navegador."
            : ev.error === "network" ? "O reconhecimento de voz precisa de internet. Digite o pedido ou use o microfone do teclado."
            : ev.error === "audio-capture" ? "Microfone não encontrado ou em uso por outro app." : "Não consegui ouvir: " + ev.error;
          toast(msg, "erro");
        };
        rec.onend = () => {
          // Guarda as transcrições alternativas desta parte (ajudam a IA com palavras mal reconhecidas)
          if (altsSessao.length) {
            for (let k = 0; k < 2; k++) {
              const alt = altsSessao.map((a) => a[k] || "").filter(Boolean).join(" ");
              if (alt) alternativasFala[k] = ((alternativasFala[k] || "") + " " + alt).trim();
            }
            altsSessao = [];
          }
          if (provisorio) { fala = (fala + " " + provisorio).trim(); provisorio = ""; mostrarFala(); }
          if (!pararPedido && etapa === "ouvir") { try { rec.start(); return; } catch { /* cai para parado */ } }
          ouvindo = false; mostrarEstado(fala ? "Pronto. Toque para falar mais ou em Entender pedido" : "Toque para falar · ou segure enquanto fala");
        };
        try { rec.start(); ouvindo = true; navigator.vibrate?.(25); mostrarEstado("Ouvindo… fale o pedido"); }
        catch (e) { ouvindo = false; erro(e); }
      };
      const parar = () => { pararPedido = true; try { rec?.stop(); } catch { /* ignora */ } };

      const ligarOuvir = () => {
        const mic = alvo.querySelector("#voz-mic");
        const ta = alvo.querySelector("#voz-texto");
        ta.oninput = () => { fala = ta.value; provisorio = ""; alvo.querySelector('[data-a="entender"]').disabled = !fala.trim(); };
        ta.onfocus = () => { if (ouvindo) parar(); };
        if (mic) {
          // Toque = liga/desliga. Segurar = fala enquanto segura e entende ao soltar (tipo rádio).
          mic.onpointerdown = (e) => { e.preventDefault(); apertouEm = Date.now(); segurando = !ouvindo; if (!ouvindo) comecar(); else parar(); };
          mic.onpointerup = () => {
            if (segurando && Date.now() - apertouEm > 600) { parar(); setTimeout(() => { if (fala.trim()) concluirFala(); }, 450); }
            segurando = false;
          };
          mic.onpointerleave = mic.onpointercancel = () => { if (segurando && Date.now() - apertouEm > 600) parar(); segurando = false; };
          mic.oncontextmenu = (e) => e.preventDefault();
        }
        if (!Reconhecedor) setTimeout(() => ta.focus(), 50);
      };

      // ======================== 2. ENTENDER ========================
      const entender = async () => {
        if (ouvindo) parar();
        const texto = (alvo.querySelector("#voz-texto")?.value ?? fala).trim();
        if (!texto) return;
        fala = texto;
        etapa = "entendendo";
        render(alvo, html`<div class="voz-entendendo"><div class="spinner" aria-hidden="true"></div><p><strong>Entendendo o pedido…</strong></p><p class="muted small">“${texto}”</p></div>`);
        const aprendido = lerAprendido();
        const local = interpretar(texto, { produtos, catalogoPreparado: catPreparado, mesas: op.mesas?.() || [], aprendido });
        let r = null;
        origem = "local"; aviso = "";
        if (iaAtiva !== false && navigator.onLine) {
          try {
            const x = await comTempo(fn("pedido-voz", { texto, alternativas: alternativasFala.filter(Boolean), aprendido, mesa_atual: mesaFixa?.numero || null }), 12000);
            if (x?.configurado === false) iaAtiva = false;
            else if (x?.itens) { r = cruzar(x, local); origem = "ia"; iaAtiva = true; }
          } catch (e) {
            if (/não está publicada|not found|404|Failed to send/i.test(e.message || "")) iaAtiva = false; // função não publicada: segue só no aparelho
            else aviso = "A IA não respondeu agora; o pedido foi entendido pelo próprio aparelho. Confira com atenção.";
          }
        }
        if (!r) r = local;
        aplicarResultado(r);
        telaResumo();
      };

      /** Segunda opinião: se a IA tem certeza mas o aparelho entendeu outro produto no mesmo trecho, vira dúvida. */
      const cruzar = (ia, local) => {
        const norm = (s) => semAcento(s).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
        for (const it of ia.itens) {
          if (it.certeza !== "alta") continue;
          const l = local.itens.find((x) => norm(x.trecho) && norm(x.trecho) === norm(it.trecho));
          if (l && l.certeza === "alta" && l.produto_id !== it.produto_id) {
            it.certeza = "media"; it.motivo = "parecidos";
            it.alternativas = [...new Set([it.produto_id, l.produto_id, ...(it.alternativas || [])])];
          }
        }
        if (ia.mesa == null && local.mesa != null) ia.mesa = local.mesa;
        if (ia.pessoas == null && local.pessoas != null) ia.pessoas = local.pessoas;
        return ia;
      };

      const aplicarResultado = (r) => {
        const novos = [];
        for (const i of r.itens) {
          const p = porId.get(i.produto_id);
          if (!p) { naoEntendidos.push({ uid: ++uid, texto: i.trecho || "?" }); continue; }
          novos.push({
            uid: ++uid, produto: p, quantidade: r3(Number(i.quantidade) || 1), observacao: i.observacao || "", trecho: i.trecho || "",
            certeza: i.certeza, motivo: i.motivo, confirmado: i.certeza === "alta",
            alternativas: (i.alternativas || []).map((id) => porId.get(id)).filter(Boolean),
            obs_de: i.motivo === "talvez_obs" ? i.obs_de : null, obs_texto: i.obs_texto || "",
          });
        }
        // obs_de aponta para a posição dentro desta fala: converte para o uid
        for (const n of novos) if (n.obs_de != null) n.obs_de = novos[n.obs_de]?.uid ?? null;
        itens.push(...novos);
        naoEntendidos.push(...(r.nao_entendidos || []).filter(Boolean).map((t) => ({ uid: ++uid, texto: t })));
        if (!mesaFixa && r.mesa != null) {
          const achou = (op.mesas?.() || []).filter((m) => Number(m.numero) === Number(r.mesa));
          if (achou.length === 1) mesa = achou[0];
          else { escolherMesa = true; if (!achou.length) aviso = [aviso, `Não achei a mesa ${r.mesa}. Escolha a mesa abaixo.`].filter(Boolean).join(" "); }
        }
        if (r.pessoas) pessoas = r.pessoas;
        if (!mesa) escolherMesa = true;
      };

      // ======================== 3. CONFERIR ========================
      const pendentes = () => itens.filter((i) => !i.confirmado).length + naoEntendidos.length;
      const total = () => itens.reduce((a, i) => a + i.quantidade * Number(i.produto.preco_venda), 0);
      const nomeMesa = (m) => (m ? m.nome : "");

      const telaResumo = () => {
        etapa = "resumo";
        const pend = pendentes();
        const lista = op.mesas?.() || [];
        const livre = mesa && !mesa.venda_id && !mesa.comanda;
        if (livre && !pessoas) pessoas = Math.min(2, mesa.lugares || 2);
        const podeEnviar = mesa && itens.length && !pend;
        render(alvo, html`
          ${aviso ? html`<div class="voz-aviso">${icone("alerta", 'width="18" height="18"')}<span>${aviso}</span></div>` : ""}
          <div class="voz-fala"><span class="muted small">Você disse</span><p>“${fala}”</p></div>

          <section class="voz-mesa ${mesa ? "" : "falta"}">
            ${mesa && !escolherMesa ? html`
              <div class="voz-mesa-linha">${icone("mesa", 'width="22" height="22"')}<strong>${nomeMesa(mesa)}</strong>
                <span class="sit sit-${mesa.venda_id ? (mesa.conta_pedida ? "conta" : "ocupada") : "livre"}">${mesa.venda_id ? (mesa.conta_pedida ? "Conta pedida" : "Ocupada") : "Livre"}</span>
                <span class="grow"></span>${mesaFixa ? "" : html`<button type="button" class="btn sm" data-a="trocar-mesa">Trocar</button>`}</div>
              ${livre ? html`<div class="voz-pessoas"><span>Mesa livre: será aberta com</span>
                <div class="qtd"><button type="button" data-a="p-menos" aria-label="Menos pessoas">−</button><span>${pessoas}</span><button type="button" data-a="p-mais" aria-label="Mais pessoas">+</button></div><span>${pessoas === 1 ? "pessoa" : "pessoas"}</span></div>` : ""}
              ${mesa.conta_pedida ? html`<p class="small txt-perigo" style="margin:.3rem 0 0">Esta mesa já pediu a conta. Enviar o pedido cancela o pedido de conta.</p>` : ""}`
            : html`<div class="voz-tit">${icone("mesa", 'width="20" height="20"')} <strong>Para qual mesa?</strong></div>
              <div class="voz-mesas">${lista.map((m) => html`<button type="button" class="mesa-mini sit-${m.venda_id ? "ocupada" : "livre"} ${mesa?.id === m.id ? "ativo" : ""}" data-mesa="${m.id}"><strong>${m.nome.replace(/^Mesa\s+/i, "")}</strong><span class="small">${m.venda_id ? dinheiro(m.total) : "livre"}</span></button>`)}</div>`}
          </section>

          <section class="voz-itens">
            ${itens.length ? itens.map(cartaoItem) : html`<p class="muted" style="text-align:center">Nenhum item entendido ainda.</p>`}
            ${naoEntendidos.map((n) => html`<div class="voz-item nao">
              <div class="voz-item-topo">${icone("alerta", 'width="18" height="18"')}<span class="grow"><strong>Não entendi:</strong> “${n.texto}”</span></div>
              <div class="voz-escolha"><button type="button" class="btn sm primary" data-buscar-nao="${n.uid}">${icone("busca", 'width="15" height="15"')} Escolher produto</button>
                <button type="button" class="btn sm" data-ignorar="${n.uid}">Ignorar</button></div></div>`)}
          </section>

          <div class="voz-mais">
            <button type="button" class="btn" data-a="falar-mais">${icone("microfone", 'width="18" height="18"')} Falar mais</button>
            <button type="button" class="btn" data-a="add">${icone("mais", 'width="18" height="18"')} Produto</button>
            ${"speechSynthesis" in window && itens.length ? html`<button type="button" class="btn ghost" data-a="ler" aria-label="Ouvir o resumo">${icone("som", 'width="18" height="18"')} Ouvir</button>` : ""}
          </div>
          <p class="hint voz-origem">${origem === "ia" ? "Entendido com IA e conferido pelo aparelho." : "Entendido pelo próprio aparelho."} Correções que você fizer ficam aprendidas neste aparelho.</p>

          <div class="voz-rodape">
            <button type="button" class="btn lg" data-a="cancelar">Cancelar</button>
            <button type="button" class="btn primary lg ${podeEnviar ? "ok" : ""}" data-a="enviar" ${podeEnviar ? "" : "disabled"}>
              ${!mesa ? "Escolha a mesa" : !itens.length ? "Sem itens" : pend ? `Confira ${pend} ${pend === 1 ? "item" : "itens"} acima` : html`${icone("check", 'width="20" height="20"')} Confirmar e enviar · ${dinheiro(total())}`}</button>
          </div>`);
        if (pend) alvo.querySelector(".voz-item.duvida, .voz-item.nao")?.scrollIntoView({ block: "nearest" });
      };

      const cartaoItem = (i) => {
        const p = i.produto, frac = FRACIONADOS.includes(p.unidade);
        const duvida = !i.confirmado;
        const alvoObs = i.obs_de != null ? itens.find((x) => x.uid === i.obs_de) : null;
        return html`<div class="voz-item ${duvida ? "duvida" : ""}" data-item="${i.uid}">
          <div class="voz-item-topo">
            <div class="qtd voz-qtd"><button type="button" data-menos="${i.uid}" aria-label="Diminuir">−</button><span>${fmtQtd(i.quantidade, p.unidade)}${frac ? html`<small> ${p.unidade.toLowerCase()}</small>` : ""}</span><button type="button" data-mais="${i.uid}" aria-label="Aumentar">+</button></div>
            <div class="grow voz-nome"><strong>${p.nome}</strong>
              ${i.observacao ? html`<div class="obs">${i.observacao}</div>` : ""}
              ${i.trecho ? html`<div class="muted small">ouvi: “${i.trecho}”</div>` : ""}</div>
            <div class="voz-preco">${dinheiro(i.quantidade * Number(p.preco_venda))}</div>
          </div>
          ${duvida ? html`<div class="voz-pergunta">${
            i.motivo === "talvez_obs" && alvoObs ? html`<span>“${i.obs_texto || i.trecho}” é…</span>
              <div class="voz-escolha"><button type="button" class="btn sm primary" data-ok="${i.uid}">Item novo: ${p.nome}</button>
                <button type="button" class="btn sm" data-virar-obs="${i.uid}">Observação de ${alvoObs.produto.nome}</button></div>`
            : i.motivo === "peso" ? html`<span>Quanto? (em ${p.unidade.toLowerCase()})</span>
              <form class="voz-escolha" data-peso="${i.uid}"><input class="input voz-peso" name="q" inputmode="decimal" value="${numero(i.quantidade, i.quantidade % 1 ? 3 : 0)}" aria-label="Quantidade em ${p.unidade}">
                <button class="btn sm primary">Confirmar</button></form>`
            : i.alternativas.length > 1 ? html`<span>Qual destes?</span>
              <div class="voz-escolha voz-alts">${i.alternativas.map((a) => html`<button type="button" class="btn sm ${a.id === p.id && i.escolhido ? "primary" : ""}" data-alt="${i.uid}:${a.id}">${a.nome} <small>${dinheiro(a.preco_venda)}</small></button>`)}
                <button type="button" class="btn sm ghost" data-trocar="${i.uid}">${icone("busca", 'width="15" height="15"')} Outro</button></div>`
            : html`<span>É este mesmo?</span>
              <div class="voz-escolha"><button type="button" class="btn sm primary" data-ok="${i.uid}">${icone("check", 'width="15" height="15"')} Sim</button>
                <button type="button" class="btn sm" data-trocar="${i.uid}">${icone("busca", 'width="15" height="15"')} Trocar</button></div>`
          }</div>` : ""}
          <div class="voz-item-acoes">
            <button type="button" class="link-btn" data-obs="${i.uid}">${i.observacao ? "Editar observação" : "+ Observação"}</button>
            ${!duvida ? html`<button type="button" class="link-btn" data-trocar="${i.uid}">Trocar produto</button>` : ""}
            <span class="grow"></span>
            <button type="button" class="btn sm ghost icon-btn" data-tirar="${i.uid}" aria-label="Tirar ${p.nome}">${icone("lixo", 'width="16" height="16"')}</button>
          </div>
        </div>`;
      };

      // ======================== Busca de produto ========================
      const buscarProduto = (titulo, inicial = "") => modal({
        titulo, largo: true,
        corpo: html`<div class="stack"><input class="input lg" id="vb-busca" type="search" placeholder="Nome ou código do produto" value="${inicial}" autocomplete="off" autofocus enterkeyhint="search">
          <div class="voz-busca" id="vb-lista"></div></div>`,
        onPronto: (d2, fechar2) => {
          const inp = d2.querySelector("#vb-busca");
          const desenhar = () => {
            const t = semAcento(inp.value.trim());
            let lista;
            if (!t) lista = produtos.filter((p) => p.favorito).slice(0, 40);
            else {
              const ws = t.split(/\s+/);
              lista = produtos.filter((p) => { const n = semAcento(p.nome); return ws.every((w) => n.includes(w)) || semAcento(p.codigo) === t; });
              if (!lista.length) { // nada literal: usa a busca aproximada (erros de digitação ou de voz)
                const r = interpretar(t, { produtos, catalogoPreparado: catPreparado });
                const ids = r.itens.flatMap((i) => i.alternativas);
                lista = [...new Set(ids)].map((id) => porId.get(id)).filter(Boolean);
              }
            }
            render(d2.querySelector("#vb-lista"), lista.length ? html`${lista.slice(0, 60).map((p) => html`<button type="button" class="voz-busca-item" data-p="${p.id}"><span class="grow">${p.nome}</span><span class="muted">${dinheiro(p.preco_venda)}</span></button>`)}`
              : html`<p class="muted" style="text-align:center">Nada encontrado.</p>`);
            d2.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => fechar2(porId.get(b.dataset.p))));
          };
          inp.oninput = desenhar; desenhar();
        },
      });

      const lerResumo = () => {
        const s = window.speechSynthesis; if (!s) return;
        s.cancel();
        const partes = [mesa ? nomeMesa(mesa) : "Mesa não escolhida",
          ...itens.map((i) => `${fmtQtd(i.quantidade, i.produto.unidade).replace(".", ",")} ${i.produto.nome}${i.observacao ? ", " + i.observacao : ""}`)];
        const u = new SpeechSynthesisUtterance(partes.join(". ") + ".");
        u.lang = "pt-BR"; u.rate = 1.05;
        s.speak(u);
      };

      // ======================== 4. ENVIAR ========================
      const enviar = async (botao) => {
        if (!mesa || !itens.length || pendentes()) return;
        const linhas = itens.map((i) => ({ produto_id: i.produto.id, quantidade: i.quantidade, observacao: i.observacao?.trim().slice(0, 140) || null }));
        let vendaId = mesa.venda_id;
        try {
          await ocupado(botao, async () => {
            if (!vendaId) {
              vendaId = await rpc("abrir_mesa", { p_mesa: mesa.id, p_pessoas: pessoas || null });
              mesa = { ...mesa, venda_id: vendaId, aberta_em: new Date().toISOString(), pessoas, total: 0, itens: 0 };
            }
            const r = await rpc("adicionar_itens", { p_venda: vendaId, p_itens: linhas });
            const n = `${r.itens_adicionados} ${r.itens_adicionados === 1 ? "item" : "itens"}`;
            toast(r.cozinha === "aguardando" ? `${n} · aguardando aprovação do caixa para ir à cozinha`
              : r.cozinha === "novo" ? `${n} enviado(s) para a cozinha · ${mesa.nome}` : `${n} lançado(s) · ${mesa.nome}`, "ok");
          });
          for (const i of itens) if (i.escolhido && i.trecho) aprender(i.trecho, i.produto.id);
          navigator.vibrate?.([20, 40, 20]);
          op.onMudou?.();
          fechar({ mesa, venda_id: vendaId });
        } catch (e) {
          erro(e);
          // Sem internet: guarda para reenviar depois (mesmo mecanismo do lançamento manual)
          if (vendaId && !navigator.onLine) {
            try { localStorage.setItem("pdv-pedido-pendente", JSON.stringify({ venda: vendaId, mesa: mesa.nome, itens: linhas, em: Date.now() })); toast("Pedido guardado: será enviado quando a internet voltar", "ok"); fechar({ mesa, venda_id: vendaId }); } catch { /* sem armazenamento */ }
          }
          op.onMudou?.();
        }
      };

      /** Fim da fala (botão Entender ou soltar o microfone). Em "Falar mais", soma ao resumo que já existe. */
      const concluirFala = async () => {
        if (!falaAnterior) return entender();
        const nova = (alvo.querySelector("#voz-texto")?.value || fala).trim();
        if (!nova) return;
        const ant = falaAnterior; falaAnterior = "";
        fala = nova;
        await entender();
        fala = `${ant} … ${nova}`;
        telaResumo();
      };

      // ======================== Eventos ========================
      const achar = (u) => itens.find((i) => i.uid === Number(u));
      alvo.addEventListener("submit", (e) => {
        const f = e.target.closest("[data-peso]"); if (!f) return;
        e.preventDefault();
        const i = achar(f.dataset.peso), q = lerNumero(f.q.value);
        if (!(q > 0)) return toast("Quantidade inválida", "erro");
        i.quantidade = r3(q); i.confirmado = true; telaResumo();
      });
      alvo.addEventListener("click", async (e) => {
        const b = e.target.closest("button"); if (!b || b.disabled) return;
        const ds = b.dataset;
        try {
          if (ds.a === "cancelar") {
            if (etapa === "ouvir" && falaAnterior) { parar(); fala = falaAnterior; falaAnterior = ""; return telaResumo(); }
            return fechar(null);
          }
          if (ds.a === "entender") return concluirFala();
          if (ds.a === "falar-mais") { falaAnterior = fala; fala = ""; provisorio = ""; alternativasFala = []; telaOuvir(); if (Reconhecedor) comecar(); return; }
          if (ds.a === "trocar-mesa") { escolherMesa = true; return telaResumo(); }
          if (ds.mesa) { mesa = (op.mesas?.() || []).find((m) => m.id === ds.mesa); escolherMesa = false; aviso = ""; return telaResumo(); }
          if (ds.a === "p-menos" || ds.a === "p-mais") { pessoas = Math.max(1, Math.min(50, (pessoas || 1) + (ds.a === "p-mais" ? 1 : -1))); return telaResumo(); }
          if (ds.a === "ler") return lerResumo();
          if (ds.a === "enviar") return enviar(b);
          if (ds.a === "add") {
            const p = await buscarProduto("Adicionar produto");
            if (p) { itens.push({ uid: ++uid, produto: p, quantidade: 1, observacao: "", trecho: "", certeza: "alta", confirmado: !FRACIONADOS.includes(p.unidade), motivo: FRACIONADOS.includes(p.unidade) ? "peso" : null, alternativas: [p] }); }
            return telaResumo();
          }
          if (ds.mais || ds.menos) {
            const i = achar(ds.mais || ds.menos), frac = FRACIONADOS.includes(i.produto.unidade), passo = frac ? 0.1 : 1;
            if (ds.menos && i.quantidade - passo <= 0) itens = itens.filter((x) => x !== i);
            else i.quantidade = r3(i.quantidade + (ds.mais ? passo : -passo));
            return telaResumo();
          }
          if (ds.tirar) { itens = itens.filter((x) => x.uid !== Number(ds.tirar)); itens.forEach((x) => { if (x.obs_de === Number(ds.tirar)) { x.obs_de = null; x.motivo = "incerto"; } }); return telaResumo(); }
          if (ds.ok) { const i = achar(ds.ok); i.confirmado = true; i.escolhido = i.motivo !== "talvez_obs"; return telaResumo(); }
          if (ds.alt) {
            const [u, pid] = ds.alt.split(":"); const i = achar(u);
            // A mesma palavra com a mesma dúvida ("duas cocas, uma sem gelo") recebe a mesma escolha
            const iguais = itens.filter((x) => x === i || (!x.confirmado && x.motivo === "parecidos" && x.trecho && x.trecho === i.trecho));
            for (const x of iguais) {
              x.produto = porId.get(pid); x.escolhido = true;
              if (FRACIONADOS.includes(x.produto.unidade)) { x.motivo = "peso"; x.confirmado = false; } else { x.motivo = null; x.confirmado = true; }
            }
            return telaResumo();
          }
          if (ds.virarObs) {
            const i = achar(ds.virarObs), dono = achar(i.obs_de);
            if (dono) dono.observacao = [dono.observacao, i.obs_texto || i.trecho].filter(Boolean).join(", ");
            itens = itens.filter((x) => x !== i);
            return telaResumo();
          }
          if (ds.trocar) {
            const i = achar(ds.trocar);
            const p = await buscarProduto(`Trocar “${i.trecho || i.produto.nome}”`, "");
            if (p) {
              i.produto = p; i.escolhido = true; i.alternativas = [p];
              if (FRACIONADOS.includes(p.unidade)) { i.motivo = "peso"; i.confirmado = false; } else { i.confirmado = true; i.motivo = null; }
            }
            return telaResumo();
          }
          if (ds.buscarNao) {
            const n = naoEntendidos.find((x) => x.uid === Number(ds.buscarNao));
            const p = await buscarProduto(`“${n.texto}”`, "");
            if (p) {
              const frac = FRACIONADOS.includes(p.unidade);
              itens.push({ uid: ++uid, produto: p, quantidade: 1, observacao: "", trecho: n.texto, certeza: "alta", confirmado: !frac, motivo: frac ? "peso" : null, alternativas: [p], escolhido: true });
              naoEntendidos = naoEntendidos.filter((x) => x !== n);
            }
            return telaResumo();
          }
          if (ds.ignorar) { naoEntendidos = naoEntendidos.filter((x) => x.uid !== Number(ds.ignorar)); return telaResumo(); }
          if (ds.obs) {
            const i = achar(ds.obs);
            const v = await modal({
              titulo: i.produto.nome,
              corpo: html`<form class="stack" id="f-obs"><label class="field"><span>Observação para a cozinha</span>
                <input class="input lg" name="v" value="${i.observacao}" maxlength="140" autofocus autocomplete="off"></label>
                <div class="chips">${["sem cebola", "sem gelo", "bem passado", "ao ponto", "mal passado", "sem sal", "com limão", "separado"].map((s) => html`<button type="button" class="chip" data-s="${s}">${s}</button>`)}</div></form>`,
              rodape: html`<button class="btn" data-fechar>Voltar</button><button class="btn primary" form="f-obs">Salvar</button>`,
              onPronto: (d3, f3) => {
                const inp = d3.querySelector("input");
                d3.querySelectorAll("[data-s]").forEach((c) => (c.onclick = () => { inp.value = [inp.value.trim(), c.dataset.s].filter(Boolean).join(", "); inp.focus(); }));
                d3.querySelector("form").onsubmit = (ev) => { ev.preventDefault(); f3(inp.value.trim()); };
              },
            });
            if (v != null) i.observacao = v.slice(0, 140);
            return telaResumo();
          }
        } catch (err) { erro(err); }
      });

      telaOuvir();
      if (Reconhecedor) comecar(); // já abre ouvindo: um toque no botão e o garçom fala
    },
  });
}
