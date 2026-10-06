// Fechar a conta pelo app do garçom: PIX (QR com o valor) e cartão na maquininha (sem TEF).
// Os pagamentos ficam guardados no aparelho até a conta fechar (se a internet ou a bateria cair,
// nada se perde) e, ao fechar, entram no caixa principal pelo servidor (garcom_fechar_conta).
import { sb, q, rpc, fn } from "./api.js";
import { estado } from "./estado.js";
import { html, render, dinheiro, lerNumero, toast, erro, modal, confirmar, ocupado, somenteDigitos, docValido, raw, rotuloMesa } from "./ui.js";
import { icone } from "./icons.js";
import { payloadPix, qrSvg, qrPronto, txidVenda } from "../../assets/pix.js";
import { rotuloServico, rotuloCouvert } from "./restaurante.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const NOMES = { pix: "PIX", debito: "Débito", credito: "Crédito" };
const CHAVE = (id) => "pdv-fechamento-" + id;
const CAMPOS = "id,numero,status,canal,identificador,subtotal,desconto,acrescimo,taxa_servico,couvert,servico_pct,couvert_unit,pessoas,total,alterado_em,cpf_cnpj_consumidor";

function lerLocal(id) { try { return JSON.parse(localStorage.getItem(CHAVE(id)) || "null"); } catch { return null; } }
function salvarLocal(id, s) { try { localStorage.setItem(CHAVE(id), JSON.stringify(s)); } catch { /* sem armazenamento */ } }
function apagarLocal(id) { try { localStorage.removeItem(CHAVE(id)); } catch { /* ignora */ } }
const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

/**
 * Abre a cobrança da mesa. Resolve true se a conta foi fechada.
 * @param {string} vendaId
 * @param {string} nome  nome da mesa/comanda
 */
export async function fecharConta(vendaId, nome) {
  const [st, inicial] = await Promise.all([rpc("caixa_principal_status"), q(sb.from("vendas").select(CAMPOS).eq("id", vendaId).single())]);
  if (!st.habilitado && estado.perfil?.papel === "atendente") { toast("O fechamento pelo app está desligado. Leve a conta ao caixa.", "erro"); return false; }
  if (!st.aberto) { toast("Nenhum caixa aberto. Peça para abrirem o caixa principal antes de fechar a conta.", "erro"); return false; }
  if (inicial.status !== "aberta") { toast("Esta conta já foi fechada", "erro"); return false; }
  await qrPronto().catch(() => {});

  let v = inicial;
  const salvo = lerLocal(vendaId);
  const s = salvo || { id_local: novoId(), pagamentos: [], cpf: v.cpf_cnpj_consumidor || "" };
  let forma = "pix", valorDigitado = null, aviso = salvo?.pagamentos?.length ? "Pagamentos já recebidos nesta conta foram recuperados deste aparelho." : "";
  let cobranca = null, timerPix = null, concluida = null;
  const e = estado.empresa;
  const temChave = !!e.pix_chave;
  const fiscalAtivo = !!estado.fiscal?.habilitado;

  const pago = () => r2(s.pagamentos.reduce((a, p) => a + p.valor, 0));
  const falta = () => Math.max(0, r2(Number(v.total) - pago()));
  const guardar = () => salvarLocal(vendaId, { ...s, total: v.total });

  return modal({
    titulo: `Fechar conta · ${rotuloMesa(nome)}`, fixo: true, largo: true,
    corpo: html`<div id="fc" class="fc"></div>`,
    onPronto: (d, fechar) => {
      const box = d.querySelector("#fc");
      const pararPix = () => { clearTimeout(timerPix); timerPix = null; cobranca = null; };
      d.addEventListener("close", () => {
        pararPix();
        if (!concluida && s.pagamentos.length) toast("Pagamentos guardados neste aparelho. Abra “Fechar conta” de novo para concluir.", "");
      });

      function adicionar(p) {
        s.pagamentos.push({ forma: p.forma, valor: r2(p.valor), nsu: p.nsu || null, em: new Date().toISOString() });
        valorDigitado = null; aviso = ""; guardar(); pararPix(); desenhar();
        navigator.vibrate?.(40);
        toast(`${NOMES[p.forma]} de ${dinheiro(p.valor)} registrado`, "ok");
      }

      async function recarregar(msg) {
        v = await q(sb.from("vendas").select(CAMPOS).eq("id", vendaId).single());
        aviso = msg || ""; desenhar();
      }

      function desenhar() {
        if (concluida) return desenharFim();
        const f = falta();
        const valor = Math.min(f, valorDigitado ?? f);
        const pessoas = Math.max(1, Number(v.pessoas) || 1);
        render(box, html`
          ${aviso ? html`<div class="alerta warn">${aviso}</div>` : ""}
          <div class="fc-topo">
            <div class="fc-linhas">
              <div class="linha-valor"><span>Consumo</span><span>${dinheiro(v.subtotal)}</span></div>
              ${Number(v.desconto) ? html`<div class="linha-valor"><span>Desconto</span><span>−${dinheiro(v.desconto)}</span></div>` : ""}
              ${Number(v.servico_pct) ? html`<div class="linha-valor"><span>${rotuloServico(v.servico_pct)} ${s.pagamentos.length ? "" : html`<button class="link-btn" data-a="tirar-taxa">cliente não quer</button>`}</span><span>${dinheiro(v.taxa_servico)}</span></div>` : ""}
              ${Number(v.couvert) ? html`<div class="linha-valor"><span>${rotuloCouvert(v.couvert_unit, v.pessoas)}</span><span>${dinheiro(v.couvert)}</span></div>` : ""}
              <div class="md-total"><span>Total</span><strong>${dinheiro(v.total)}</strong></div>
              ${pessoas > 1 ? html`<div class="muted small r">${dinheiro(Number(v.total) / pessoas)} por pessoa (${pessoas})</div>` : ""}
            </div>
            <div class="fc-saldo ${f ? "" : "ok"}"><span>${f ? "Falta receber" : "Tudo recebido"}</span><strong>${dinheiro(f)}</strong>
              ${pago() ? html`<small>Recebido ${dinheiro(pago())}</small>` : ""}</div>
          </div>

          ${s.pagamentos.length ? html`<div class="fc-pags">${s.pagamentos.map((p, i) => html`<div class="fc-pag">
              ${icone(p.forma === "pix" ? "pix" : "cartao", 'width="18" height="18"')}<span class="grow"><strong>${NOMES[p.forma]}</strong>${p.nsu ? html` <span class="muted small">· ${p.forma === "pix" ? "cobrança" : "NSU"} ${p.nsu}</span>` : ""}</span>
              <strong>${dinheiro(p.valor)}</strong><button class="btn sm ghost icon-btn" data-tirar="${i}" aria-label="Remover pagamento">${icone("lixo", 'width="16" height="16"')}</button></div>`)}</div>` : ""}

          ${f > 0 ? html`
            <div class="seg fc-formas" role="group" aria-label="Forma de pagamento">${Object.entries(NOMES).map(([k, n]) => html`<button type="button" data-forma="${k}" class="${forma === k ? "ativo" : ""}">${icone(k === "pix" ? "pix" : "cartao", 'width="18" height="18"')} ${n}</button>`)}</div>
            <div class="fc-valor">
              <label class="field grow"><span>Valor desta cobrança</span><input class="input lg" id="fc-v" inputmode="decimal" value="${String(valor.toFixed(2)).replace(".", ",")}"></label>
              <div class="fc-div"><span class="small muted">Dividir o que falta</span><div class="row wrap" style="gap:.3rem">
                <button type="button" class="btn sm" data-div="1">Tudo</button>${[2, 3, 4].concat(pessoas > 4 ? [pessoas] : []).map((n) => html`<button type="button" class="btn sm" data-div="${n}">÷ ${n}</button>`)}</div></div>
            </div>
            <div id="fc-area" class="pix-area"></div>
            <p class="hint">Dinheiro? Leve a conta ao caixa. Os pagamentos entram no caixa de ${st.operador}.</p>`
          : html`
            ${fiscalAtivo ? html`<label class="field"><span>CPF/CNPJ na nota (opcional)</span><input class="input lg" id="fc-cpf" inputmode="numeric" value="${s.cpf || ""}"></label>` : ""}
            <button class="btn primary lg block" data-a="concluir">${icone("check", 'width="20" height="20"')} Fechar conta e liberar ${v.canal === "mesa" ? "a mesa" : "a comanda"}</button>`}`);

        box.querySelectorAll("[data-forma]").forEach((b) => (b.onclick = () => { forma = b.dataset.forma; pararPix(); desenhar(); }));
        box.querySelectorAll("[data-div]").forEach((b) => (b.onclick = () => { const n = Number(b.dataset.div); valorDigitado = n > 1 ? r2(Math.ceil((falta() / n) * 100) / 100) : null; pararPix(); desenhar(); }));
        const inp = box.querySelector("#fc-v");
        if (inp) inp.onchange = () => { const n = lerNumero(inp.value); valorDigitado = n > 0 ? Math.min(r2(n), falta()) : null; pararPix(); desenhar(); };
        box.querySelectorAll("[data-tirar]").forEach((b) => (b.onclick = async () => {
          const p = s.pagamentos[Number(b.dataset.tirar)];
          if (!(await confirmar(`Remover ${NOMES[p.forma]} de ${dinheiro(p.valor)}? Só remova se o pagamento não foi concluído (estorne na maquininha se preciso).`, { ok: "Remover", perigo: true }))) return;
          s.pagamentos.splice(Number(b.dataset.tirar), 1); guardar(); desenhar();
        }));
        box.querySelector('[data-a="tirar-taxa"]')?.addEventListener("click", async () => {
          if (!(await confirmar("Tirar a taxa de serviço desta conta? (A taxa é opcional para o cliente.)", { ok: "Tirar taxa" }))) return;
          try { await rpc("definir_taxas_mesa", { p_venda: v.id, p_servico: false, p_couvert: null, p_pessoas: null }); await recarregar(); toast("Taxa de serviço retirada", "ok"); }
          catch (err) { erro(err); }
        });
        box.querySelector('[data-a="concluir"]')?.addEventListener("click", (ev) => concluir(ev.currentTarget));
        if (f > 0) desenharArea(valor);
      }

      function desenharArea(valor) {
        const area = box.querySelector("#fc-area");
        if (forma !== "pix") {
          render(area, html`<div class="fc-cartao">${icone("cartao", 'width="34" height="34"')}
            <div class="stack grow" style="gap:.5rem">
              <div>Passe <strong class="pix-valor">${dinheiro(valor)}</strong> na maquininha no <strong>${NOMES[forma].toLowerCase()}</strong>.</div>
              <label class="field"><span>NSU / código de autorização (opcional, ajuda na conferência)</span><input class="input" id="fc-nsu" maxlength="40" inputmode="numeric"></label>
              <button class="btn primary lg" data-a="cartao-ok">${icone("check", 'width="18" height="18"')} Aprovado na maquininha · ${dinheiro(valor)}</button>
            </div></div>`);
          area.querySelector('[data-a="cartao-ok"]').onclick = () => adicionar({ forma, valor, nsu: area.querySelector("#fc-nsu").value.trim() });
          return;
        }
        if (st.pix_automatico) return pixAutomatico(area, valor);
        if (!temChave) {
          render(area, html`<div class="alerta info">A loja ainda não cadastrou a chave PIX (Configurações › PIX). Se o cliente já fez o PIX para a loja, confirme abaixo.</div>
            <button class="btn" data-a="pix-ok" style="margin-top:.6rem">PIX recebido · ${dinheiro(valor)}</button>`);
          area.querySelector('[data-a="pix-ok"]').onclick = () => adicionar({ forma: "pix", valor });
          return;
        }
        const codigo = payloadPix({ tipo: e.pix_tipo, chave: e.pix_chave, nome: e.pix_nome || e.nome_fantasia || e.razao_social, cidade: e.pix_cidade || e.municipio, valor, txid: txidVenda("MESA", v.numero) });
        mostrarQr(area, codigo, valor, false);
      }

      function mostrarQr(area, codigo, valor, auto) {
        render(area, html`<div class="row wrap pix-linha">
          <div class="qr-box">${raw(qrSvg(codigo, 220))}</div>
          <div class="stack grow" style="gap:.5rem;min-width:200px">
            <div><div class="muted small">PIX para ${e.pix_nome || e.nome_fantasia || "a loja"}</div><div class="pix-valor">${dinheiro(valor)}</div></div>
            <div class="pix-status ${auto ? "auto" : ""}">${auto ? html`<span class="pulso"></span> Aguardando pagamento · confirma sozinho` : "Mostre o QR ao cliente e confira o PIX no app do banco dele."}</div>
            <button type="button" class="btn sm" data-a="copiar">Copiar código</button>
            <button type="button" class="btn ${auto ? "" : "primary lg"}" data-a="pix-ok">${auto ? "Confirmar manualmente" : "PIX recebido"} · ${dinheiro(valor)}</button>
          </div></div>`);
        area.querySelector('[data-a="copiar"]').onclick = () => navigator.clipboard?.writeText(codigo).then(() => toast("Código PIX copiado", "ok"), () => toast("Não foi possível copiar", "erro"));
        area.querySelector('[data-a="pix-ok"]').onclick = async () => {
          if (auto && !(await confirmar("Confirmar sem a confirmação automática? Só faça isso se viu o comprovante do PIX.", { ok: "Confirmar" }))) return;
          adicionar({ forma: "pix", valor, nsu: cobranca?.id || null });
        };
      }

      async function pixAutomatico(area, valor) {
        if (cobranca?.valor === valor && cobranca.qr) return mostrarQr(area, cobranca.qr, valor, true);
        pararPix();
        render(area, html`<div class="pix-carregando"><span class="spinner"></span> Gerando cobrança PIX de ${dinheiro(valor)}…</div>`);
        try {
          const c = await fn("pagamentos", { acao: "pix_criar", valor, descricao: `${rotuloMesa(nome)} · ${e.nome_fantasia || ""}`.trim() });
          if (!d.open || forma !== "pix") return;
          cobranca = { id: c.id, valor, qr: c.qr_code };
          mostrarQr(area, c.qr_code, valor, true);
          const verificar = async () => {
            if (!cobranca || cobranca.id !== c.id || !d.open) return;
            try {
              const r = await fn("pagamentos", { acao: "pix_status", payment_id: c.id });
              if (r.status === "approved") { bipeOk(); adicionar({ forma: "pix", valor, nsu: String(c.id) }); return; }
              if (["rejected", "cancelled", "expired"].includes(r.status)) { pararPix(); desenhar(); return; }
            } catch { /* tenta de novo */ }
            timerPix = setTimeout(verificar, 3000);
          };
          timerPix = setTimeout(verificar, 3000);
        } catch (err) {
          render(area, html`<div class="alerta warn">Não foi possível gerar a cobrança automática (${err.message}).${temChave ? " Usando a chave PIX da loja." : ""}</div><div id="fc-alt" style="margin-top:.6rem"></div>`);
          cobranca = { id: null, valor };
          if (temChave) mostrarQr(area.querySelector("#fc-alt"), payloadPix({ tipo: e.pix_tipo, chave: e.pix_chave, nome: e.pix_nome || e.nome_fantasia || e.razao_social, cidade: e.pix_cidade || e.municipio, valor, txid: txidVenda("MESA", v.numero) }), valor, false);
        }
      }
      const bipeOk = () => import("./avisos.js").then((m) => m.bipe(1)).catch(() => {});

      async function concluir(botao) {
        const cpf = somenteDigitos(box.querySelector("#fc-cpf")?.value || "");
        if (cpf && !docValido(cpf)) return toast("CPF/CNPJ inválido", "erro");
        s.cpf = cpf; guardar();
        try {
          const r = await ocupado(botao, () => rpc("garcom_fechar_conta", { p_venda: v.id, p: {
            alterado_em: v.alterado_em, id_local: s.id_local, cpf_cnpj: cpf || null,
            pagamentos: s.pagamentos.map((p) => ({ forma: p.forma, valor: p.valor, nsu: p.nsu })) } }));
          apagarLocal(vendaId);
          concluida = { ...r, doc: null };
          navigator.vibrate?.([30, 60, 30]);
          desenharFim();
          if (fiscalAtivo && (estado.fiscal.emitir_automatico || cpf)) {
            try { concluida.doc = await fn("fiscal", { acao: "emitir", venda_id: r.id, modelo: "65" }); }
            catch (err) { concluida.erroNota = err.message; }
            desenharFim();
          }
        } catch (err) {
          if (/mudou/.test(err.message)) return recarregar(err.message + (pago() > Number(v.total) ? " Os pagamentos passaram do novo total: remova ou ajuste." : ""));
          if (/somam/.test(err.message)) return recarregar(err.message);
          erro(err);
        }
      }

      function desenharFim() {
        const c = concluida;
        const doc = c.doc;
        render(box, html`<div class="fc-fim">
          <div class="fc-ok">${icone("check", 'width="40" height="40"')}</div>
          <h2>Conta fechada</h2>
          <p><strong>${dinheiro(c.total)}</strong> recebidos${c.caixa ? html` · entrou no caixa de <strong>${c.caixa}</strong>` : ""}${c.ja_registrada ? " (já estava registrada)" : ""}.</p>
          ${doc?.status === "autorizado" && doc.qrcode_url ? html`<div class="stack" style="justify-items:center;gap:.4rem"><div class="qr-box sm">${raw(qrSvg(doc.qrcode_url, 160))}</div>
            <span class="small muted">NFC-e nº ${doc.numero || "—"} autorizada · o cliente pode ler o QR</span></div>` : ""}
          ${doc && doc.status !== "autorizado" ? html`<p class="small muted">NFC-e: ${doc.status}${doc.mensagem ? ` · ${doc.mensagem}` : ""}. O caixa acompanha em Vendas.</p>` : ""}
          ${c.erroNota ? html`<div class="alerta warn">A conta foi fechada, mas a NFC-e não saiu: ${c.erroNota}. O caixa pode emitir em Vendas.</div>` : ""}
          <button class="btn primary lg block" data-fechar-fim>Concluir</button></div>`);
        box.querySelector("[data-fechar-fim]").onclick = () => fechar(true);
      }

      desenhar();
    },
  }).then((r) => !!r || !!concluida);
}
