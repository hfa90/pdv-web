// "Meu turno" do garçom: o que ele recebeu no app (PIX, débito, crédito com NSU),
// a comissão das mesas que atendeu (inclusive a taxa de serviço) e a conferência com a
// maquininha/app do banco, registrada como fechamento do dia.
import { rpc } from "./api.js";
import { estado } from "./estado.js";
import { html, render, $, $$, dinheiro, numero, hora, lerNumero, toast, erro, carregando, ocupado, rotuloMesa, pedirTexto } from "./ui.js";
import { icone } from "./icons.js";
import { hojeISO, somarDias, dataBR } from "./gestao-ui.js";

const FORMAS = [["pix", "PIX", "pix"], ["debito", "Débito", "cartao"], ["credito", "Crédito", "cartao"]];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const chaveConf = (dia) => `garcom-conferidos-${estado.perfil?.id}-${dia}`;
const lerConf = (dia) => { try { return new Set(JSON.parse(localStorage.getItem(chaveConf(dia)) || "[]")); } catch { return new Set(); } };
const salvarConf = (dia, s) => { try { localStorage.setItem(chaveConf(dia), JSON.stringify([...s])); } catch { /* ignora */ } };

/**
 * @param {HTMLElement} alvo
 * @param {{perfil?: string|null, somenteLeitura?: boolean}} op  perfil = outro garçom (gerente/caixa)
 */
export async function desenharTurno(alvo, op = {}) {
  let dia = hojeISO();
  const proprio = !op.perfil || op.perfil === estado.perfil?.id;

  async function carregar() {
    render(alvo, carregando());
    let t;
    try { t = await rpc("garcom_turno", { p_dia: dia, p_perfil: op.perfil || null }); }
    catch (e) { render(alvo, html`<div class="alerta">${/garcom_turno|function/.test(e.message) ? "Atualização do banco pendente (migração 016)." : e.message}</div>`); return; }
    desenhar(t);
  }

  function desenhar(t) {
    const rec = t.recebido || {}, res = t.resumo || {}, ab = t.abertas || {};
    const conf = lerConf(t.dia);
    const fech = t.fechamento;
    const baseTxt = t.comissao_base === "servico" ? "da taxa de serviço" : "do consumo";
    render(alvo, html`<div class="turno">
      <div class="turno-dias">
        <div class="chips">
          <button class="chip ${dia === hojeISO() ? "ativo" : ""}" data-dia="${hojeISO()}">Hoje</button>
          <button class="chip ${dia === somarDias(hojeISO(), -1) ? "ativo" : ""}" data-dia="${somarDias(hojeISO(), -1)}">Ontem</button>
        </div>
        <input class="input" type="date" id="t-dia" value="${dia}" max="${hojeISO()}" aria-label="Escolher dia">
      </div>
      ${!proprio ? html`<h2 style="margin:0">${t.garcom.nome} · ${dataBR(t.dia)}</h2>` : ""}

      <section class="turno-hero">
        <div class="turno-hero-top"><span>${icone("carteira", 'width="20" height="20"')} Recebido por ${proprio ? "você" : "ele(a)"} no app ${t.hoje ? "hoje" : "em " + dataBR(t.dia)}</span>
          <strong>${dinheiro(rec.total)}</strong><small>${rec.qtd || 0} pagamento(s) em ${t.recebimentos.length} conta(s)</small></div>
        <div class="turno-formas">${FORMAS.map(([k, n, ic]) => html`<div><span>${icone(ic, 'width="16" height="16"')} ${n}</span><strong>${dinheiro(rec[k])}</strong></div>`)}</div>
      </section>

      <section class="panel panel-pad turno-comissao">
        <div class="turno-com-top">
          <div><div class="muted small">Comissão ${t.hoje ? "de hoje" : "do dia"}</div><div class="turno-com-v">${dinheiro(res.comissao)}</div>
            <div class="small muted">${numero(t.comissao_percentual, 1)}% ${baseTxt} · ${res.mesas || 0} mesa(s) fechada(s)</div></div>
          ${t.hoje && Number(ab.mesas) ? html`<div class="turno-prev"><div class="muted small">Mesas abertas agora</div><strong>+${dinheiro(ab.comissao_prevista)}</strong><div class="small muted">${ab.mesas} mesa(s) · ${dinheiro(ab.consumo)}</div></div>` : ""}
        </div>
        <div class="turno-linhas">
          <div class="linha-valor"><span>Consumo das suas mesas</span><span>${dinheiro(res.consumo)}</span></div>
          <div class="linha-valor"><span>Taxa de serviço arrecadada nas suas mesas</span><span>${dinheiro(res.servico)}</span></div>
          ${Number(res.couvert) ? html`<div class="linha-valor"><span>Couvert</span><span>${dinheiro(res.couvert)}</span></div>` : ""}
          <div class="linha-valor"><span>Ticket médio por mesa</span><span>${dinheiro(res.ticket_mesa)}</span></div>
        </div>
        ${t.mesas.length ? html`<details class="turno-det"><summary>Ver mesas e comissão de cada uma</summary>
          <div class="turno-lista">${t.mesas.map((m) => html`<div class="turno-item"><span class="grow"><strong>${rotuloMesa(m.mesa) || "Mesa"}</strong> <span class="muted small">${hora(m.hora)} · ${m.no_app ? "fechada no app" : "fechada no caixa"}</span>
            <span class="small muted block">Consumo ${dinheiro(m.consumo)}${Number(m.servico) ? ` · serviço ${dinheiro(m.servico)}` : ""}</span></span><strong class="txt-ok">+${dinheiro(m.comissao)}</strong></div>`)}</div></details>` : ""}
      </section>

      <section class="panel panel-pad stack">
        <div><h2>Conferir com a maquininha</h2><p class="small muted" style="margin:.2rem 0 0">Digite o total do relatório da maquininha (débito e crédito) e do PIX que você conferiu. A diferença aparece na hora.</p></div>
        ${fech ? html`<div class="alerta ${Number(fech.diferenca) === 0 ? "ok" : "warn"}">Fechamento registrado às ${hora(fech.criado_em)} · ${Number(fech.diferenca) === 0 ? "tudo bateu" : `diferença de ${dinheiro(fech.diferenca)}`}. ${proprio && t.hoje ? "Pode registrar de novo se receber mais contas." : ""}</div>` : ""}
        <div class="turno-conf">${FORMAS.map(([k, n]) => {
          const inf = fech?.informado?.[k];
          return html`<label class="field"><span>${n} <small class="muted">sistema ${dinheiro(rec[k])}</small></span>
            <input class="input lg" data-inf="${k}" inputmode="decimal" placeholder="0,00" value="${inf != null ? String(Number(inf).toFixed(2)).replace(".", ",") : ""}" ${proprio ? "" : "disabled"}>
            <small class="turno-dif" data-dif="${k}"></small></label>`;
        })}</div>
        <div class="turno-total-dif" id="t-dif"></div>
        ${proprio ? html`<button class="btn primary lg" id="t-fechar">${icone("check", 'width="18" height="18"')} Registrar fechamento do turno</button>` : ""}
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Contas que ${proprio ? "você" : "ele(a)"} recebeu</h2><span class="small muted">${proprio ? "marque ao conferir cada comprovante" : ""}</span></div>
        ${t.recebimentos.length ? html`<div class="turno-lista">${t.recebimentos.map((v) => html`<label class="turno-item ${conf.has(v.id) ? "ok" : ""}">
          ${proprio ? html`<input type="checkbox" data-conf="${v.id}" ${conf.has(v.id) ? "checked" : ""}>` : ""}
          <span class="grow"><strong>${rotuloMesa(v.mesa) || "Conta nº " + v.numero}</strong> <span class="muted small">${hora(v.hora)}</span>
            <span class="small block">${(v.pagamentos || []).map((p) => `${p.forma === "pix" ? "PIX" : p.forma === "debito" ? "Débito" : "Crédito"} ${dinheiro(p.valor)}${p.nsu ? ` · ${p.forma === "pix" ? "cobrança" : "NSU"} ${p.nsu}` : ""}`).join("  ·  ")}</span></span>
          <strong>${dinheiro(v.total)}</strong></label>`)}</div>`
        : html`<p class="muted panel-pad" style="margin:0">Nenhuma conta recebida no app neste dia.</p>`}
      </section>

      ${proprio ? html`<div class="row wrap" style="justify-content:center">
        <button class="btn" id="t-compartilhar">${icone("link", 'width="16" height="16"')} Enviar resumo</button>
        <button class="btn ghost" id="t-pin">Trocar minha senha</button></div>` : ""}
    </div>`);

    const calcular = () => {
      let tot = 0, algumaDif = false;
      for (const [k] of FORMAS) {
        const inp = $(`[data-inf="${k}"]`, alvo);
        const vazio = !inp.value.trim();
        const v = vazio ? 0 : lerNumero(inp.value);
        const d = r2(v - Number(rec[k] || 0));
        tot = r2(tot + (vazio ? 0 : d));
        if (!vazio && d !== 0) algumaDif = true;
        const el = $(`[data-dif="${k}"]`, alvo);
        el.className = "turno-dif " + (vazio ? "" : d === 0 ? "ok" : "erro");
        el.textContent = vazio ? "" : d === 0 ? "✓ bateu" : d > 0 ? `sobra ${dinheiro(d)}` : `falta ${dinheiro(-d)}`;
      }
      const algum = $$("[data-inf]", alvo).some((i) => i.value.trim());
      const msg = !algumaDif ? "Tudo certo: o que você conferiu bate com o sistema."
        : tot === 0 ? "O total bate, mas as formas não: confira se algum pagamento foi lançado como débito em vez de crédito (ou PIX)."
        : `Diferença total: ${dinheiro(tot)}. Confira os comprovantes abaixo.`;
      render($("#t-dif", alvo), algum ? html`<span class="${algumaDif ? "txt-perigo" : "txt-ok"}">${msg}</span>` : "");
    };
    $$("[data-inf]", alvo).forEach((i) => (i.oninput = calcular));
    calcular();
    $$("[data-dia]", alvo).forEach((b) => (b.onclick = () => { dia = b.dataset.dia; carregar(); }));
    $("#t-dia", alvo).onchange = (e) => { if (e.target.value) { dia = e.target.value; carregar(); } };
    $$("[data-conf]", alvo).forEach((c) => (c.onchange = () => {
      const s = lerConf(t.dia); c.checked ? s.add(c.dataset.conf) : s.delete(c.dataset.conf); salvarConf(t.dia, s);
      c.closest(".turno-item").classList.toggle("ok", c.checked);
    }));
    $("#t-fechar", alvo)?.addEventListener("click", async (e) => {
      const inf = Object.fromEntries(FORMAS.map(([k]) => [k, lerNumero($(`[data-inf="${k}"]`, alvo).value || "0")]));
      if (Object.values(inf).some((v) => !(v >= 0))) return toast("Confira os valores digitados", "erro");
      let obs = null;
      const dif = r2(inf.pix + inf.debito + inf.credito - Number(rec.total || 0));
      const trocado = FORMAS.some(([k]) => r2(inf[k] - Number(rec[k] || 0)) !== 0);
      if (dif !== 0 || trocado) { obs = await pedirTexto({ titulo: "Houve diferença", rotulo: "O que aconteceu? (o gerente verá)", ok: "Registrar", dica: dif !== 0 ? `Diferença de ${dinheiro(dif)}. Ex.: cliente pagou no caixa, estorno na maquininha.` : "O total bate, mas alguma forma de pagamento não." }); if (obs == null) return; }
      try { await ocupado(e.currentTarget, () => rpc("garcom_fechar_turno", { p_dia: t.dia, p_informado: inf, p_obs: obs })); toast("Fechamento do turno registrado", "ok"); carregar(); }
      catch (err) { erro(err); }
    });
    $("#t-compartilhar", alvo)?.addEventListener("click", () => {
      const txt = [`Turno ${dataBR(t.dia)} · ${t.garcom.nome}`, `Recebido no app: ${dinheiro(rec.total)} (PIX ${dinheiro(rec.pix)}, débito ${dinheiro(rec.debito)}, crédito ${dinheiro(rec.credito)})`,
        `Mesas fechadas: ${res.mesas || 0} · consumo ${dinheiro(res.consumo)} · serviço ${dinheiro(res.servico)}`, `Comissão: ${dinheiro(res.comissao)}`].join("\n");
      if (navigator.share) navigator.share({ text: txt }).catch(() => {});
      else navigator.clipboard?.writeText(txt).then(() => toast("Resumo copiado", "ok"));
    });
    $("#t-pin", alvo)?.addEventListener("click", trocarPin);
  }

  await carregar();
  return { recarregar: carregar };
}

async function trocarPin() {
  const atual = await pedirTexto({ titulo: "Trocar minha senha", rotulo: "Senha atual (números)", tipo: "password", ok: "Continuar" });
  if (!atual) return;
  const nova = await pedirTexto({ titulo: "Nova senha", rotulo: "Nova senha (6 a 12 números)", tipo: "password", ok: "Continuar", dica: "Não use sequências (123456) nem números repetidos (111111)." });
  if (!nova) return;
  const conf = await pedirTexto({ titulo: "Confirme a nova senha", rotulo: "Digite de novo", tipo: "password", ok: "Trocar senha" });
  if (conf == null) return;
  if (nova !== conf) return toast("As senhas não conferem", "erro");
  try { await rpc("alterar_meu_pin", { p_atual: atual, p_novo: nova }); toast("Senha alterada", "ok"); }
  catch (e) { erro(e); }
}
