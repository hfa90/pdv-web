// Promoções programadas: leve X pague Y, preço por dia/horário, atacado e combos.
// O desconto é aplicado sozinho no PDV e confirmado pelo servidor (mesma regra dos dois lados).
import { sb, q, todos } from "../api.js";
import { estado } from "../estado.js";
import { html, render, $, $$, dinheiro, numero, lerNumero, toast, erro, modal, confirmar } from "../ui.js";
import { icone } from "../icons.js";
import { promocaoAtiva, NOMES_TIPO } from "../promocoes-calc.js";
import { dataBR } from "../gestao-ui.js";

const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export default async function promocoes(el, params = []) {
  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Promoções</h1><p>Programe uma vez e o caixa aplica sozinho, no dia e horário certos. Promoções não se somam: vale a que dá mais desconto em cada item.</p></div>
      <button class="btn primary" id="nova">${icone("mais", 'width="18" height="18"')} Nova promoção</button></div>
    <div class="panel" id="l"></div></div>`);
  const [produtos, categorias] = await Promise.all([
    todos(() => sb.from("produtos").select("id,nome,codigo,codigo_barras,preco_venda,unidade,categoria_id").eq("ativo", true).order("nome")),
    q(sb.from("categorias").select("id,nome").eq("ativo", true).order("nome")),
  ]);
  const prodPorId = new Map(produtos.map((p) => [p.id, p]));
  const rotulo = (p) => `${p.nome} · ${dinheiro(p.preco_venda)}${p.codigo_barras ? " · " + p.codigo_barras : ""}`;
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const mapaRotulo = new Map(produtos.map((p) => [norm(rotulo(p)), p]));
  const porRotulo = { get: (t) => mapaRotulo.get(norm(t)), has: (t) => mapaRotulo.has(norm(t)) };
  let lista = [];

  $("#nova", el).onclick = () => editar(null);
  async function carregar() {
    lista = await q(sb.from("promocoes").select("*").order("ativo", { ascending: false }).order("created_at", { ascending: false }));
    const descr = (p) => {
      const alvo = p.tipo === "combo" ? (p.combo || []).map((c) => `${c.qtd}× ${prodPorId.get(c.produto_id)?.nome || "?"}`).join(" + ")
        : [...(p.produtos || []).map((id) => prodPorId.get(id)?.nome || "?"), p.categoria_id ? `categoria ${categorias.find((c) => c.id === p.categoria_id)?.nome || ""}` : ""].filter(Boolean).join(", ");
      const regra = p.tipo === "leve_pague" ? `Leve ${p.leve}, pague ${p.pague}` : p.tipo === "combo" ? `por ${dinheiro(p.preco)}`
        : `${p.tipo === "atacado" ? `a partir de ${numero(p.qtd_minima, p.qtd_minima % 1 ? 3 : 0)} un.: ` : ""}${p.preco != null ? `sai a ${dinheiro(p.preco)}` : `${numero(p.percentual, p.percentual % 1 ? 1 : 0)}% off`}`;
      const quando = [p.dias_semana?.length ? p.dias_semana.map((d) => DIAS[d]).join(", ") : "", p.hora_inicio && p.hora_fim ? `${p.hora_inicio.slice(0, 5)}–${p.hora_fim.slice(0, 5)}` : "",
        p.data_inicio || p.data_fim ? `${p.data_inicio ? dataBR(p.data_inicio) : "…"} a ${p.data_fim ? dataBR(p.data_fim) : "…"}` : ""].filter(Boolean).join(" · ") || "sempre";
      return { alvo, regra, quando };
    };
    render($("#l", el), lista.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Promoção</th><th>Regra</th><th>Quando</th><th>Situação</th><th></th></tr></thead>
      <tbody>${lista.map((p) => { const d = descr(p); const agora = promocaoAtiva(p, new Date(), estado.empresa.fuso); return html`<tr>
        <td><strong>${p.nome}</strong><div class="small muted">${NOMES_TIPO[p.tipo]} · ${d.alvo}</div></td><td>${d.regra}</td><td class="small">${d.quando}</td>
        <td>${!p.ativo ? html`<span class="badge">desligada</span>` : agora ? html`<span class="badge ok">valendo agora</span>` : html`<span class="badge warn">fora do horário</span>`}</td>
        <td class="r"><div class="row" style="gap:.3rem;justify-content:flex-end"><button class="btn sm ghost" data-on="${p.id}">${p.ativo ? "Desligar" : "Ligar"}</button><button class="btn sm" data-ed="${p.id}">Editar</button></div></td></tr>`; })}</tbody></table></div>`
      : html`<div class="empty">${icone("estrela", 'width="40" height="40"')}<p>Nenhuma promoção ainda.</p><p class="small">Ideias: "Leve 3 pague 2" em refrigerante, pão com 30% off depois das 19h, preço de atacado a partir de 6 unidades, combo café + pão de queijo.</p></div>`);
    $$("[data-ed]", el).forEach((b) => (b.onclick = () => editar(lista.find((p) => p.id === b.dataset.ed))));
    $$("[data-on]", el).forEach((b) => (b.onclick = async () => {
      const p = lista.find((x) => x.id === b.dataset.on);
      try { await q(sb.from("promocoes").update({ ativo: !p.ativo }).eq("id", p.id)); carregar(); } catch (e) { erro(e); }
    }));
  }

  async function editar(p, produtoInicial = null) {
    const st = p ? { ...p, produtos: [...(p.produtos || [])], combo: (p.combo || []).map((c) => ({ ...c })), dias_semana: [...(p.dias_semana || [])] }
      : { nome: "", tipo: "leve_pague", ativo: true, produtos: produtoInicial ? [produtoInicial] : [], categoria_id: null, leve: 3, pague: 2, preco: null, percentual: null, qtd_minima: 6,
        combo: [], dias_semana: [], hora_inicio: null, hora_fim: null, data_inicio: null, data_fim: null };
    const r = await modal({
      titulo: p?.id ? "Editar promoção" : "Nova promoção", largo: true,
      corpo: html`<datalist id="dl-promo">${produtos.map((x) => html`<option value="${rotulo(x)}"></option>`)}</datalist><form id="fpr" class="stack-lg"></form>`,
      rodape: html`${p?.id ? html`<button class="btn danger" id="exc">Excluir</button>` : ""}<span class="grow"></span><button class="btn" data-fechar>Voltar</button><button class="btn primary" form="fpr">Salvar</button>`,
      onPronto: (d, fechar) => {
        const f = d.querySelector("#fpr");
        const desenhar = () => {
          const ex = exemplo(st);
          render(f, html`
            <div class="grid-2"><label class="field"><span>Nome (aparece no cupom)</span><input class="input" name="nome" value="${st.nome}" placeholder="Ex.: Leve 3 pague 2 Coca 2L" required></label>
              <label class="field"><span>Tipo</span><select class="input" name="tipo">${Object.entries(NOMES_TIPO).map(([k, n]) => html`<option value="${k}" ${k === st.tipo ? "selected" : ""}>${n}</option>`)}</select></label></div>
            ${st.tipo === "combo" ? html`<div class="stack"><strong>Itens do combo</strong>
                ${st.combo.map((c, i) => html`<div class="row"><input class="input" style="width:80px" data-cq="${i}" value="${c.qtd}" inputmode="numeric"><span class="grow">× ${prodPorId.get(c.produto_id)?.nome || "?"} (${dinheiro(prodPorId.get(c.produto_id)?.preco_venda)})</span><button type="button" class="btn sm ghost" data-crem="${i}">Tirar</button></div>`)}
                <div class="row"><input class="input grow" list="dl-promo" data-cadd placeholder="Adicionar produto ao combo"></div>
                <label class="field" style="max-width:240px"><span>Preço do combo (R$)</span><input class="input" name="preco" inputmode="decimal" value="${st.preco ?? ""}"></label></div>`
            : html`<div class="stack"><strong>Vale para</strong>
                <div class="chips">${st.produtos.map((id) => html`<span class="chip ativo">${prodPorId.get(id)?.nome || "?"} <button type="button" class="link-x" data-prem="${id}" aria-label="Tirar">✕</button></span>`)}</div>
                <input class="input" list="dl-promo" data-padd placeholder="Adicionar produto">
                <label class="field" style="max-width:320px"><span>…ou uma categoria inteira</span><select class="input" name="categoria_id"><option value="">—</option>${categorias.map((c) => html`<option value="${c.id}" ${c.id === st.categoria_id ? "selected" : ""}>${c.nome}</option>`)}</select></label></div>
              ${st.tipo === "leve_pague" ? html`<div class="grid-3"><label class="field"><span>Leve</span><input class="input" name="leve" inputmode="numeric" value="${st.leve ?? 3}"></label>
                  <label class="field"><span>Pague</span><input class="input" name="pague" inputmode="numeric" value="${st.pague ?? 2}"></label></div>`
                : html`<div class="grid-3">${st.tipo === "atacado" ? html`<label class="field"><span>A partir de (quantidade)</span><input class="input" name="qtd_minima" inputmode="decimal" value="${st.qtd_minima ?? ""}"></label>` : ""}
                  <label class="field"><span>Novo preço unitário (R$)</span><input class="input" name="preco" inputmode="decimal" value="${st.preco ?? ""}" placeholder="ou use %"></label>
                  <label class="field"><span>Desconto (%)</span><input class="input" name="percentual" inputmode="decimal" value="${st.percentual ?? ""}"></label></div>`}`}
            <div class="stack"><strong>Quando vale</strong>
              <div class="chips">${DIAS.map((n, i) => html`<label class="chip ${st.dias_semana.includes(i) ? "ativo" : ""}"><input type="checkbox" hidden data-dia="${i}" ${st.dias_semana.includes(i) ? "checked" : ""}>${n}</label>`)}</div>
              <div class="grid-3"><label class="field"><span>Das</span><input class="input" type="time" name="hora_inicio" value="${st.hora_inicio?.slice(0, 5) || ""}"></label>
                <label class="field"><span>Até</span><input class="input" type="time" name="hora_fim" value="${st.hora_fim?.slice(0, 5) || ""}"></label><span></span>
                <label class="field"><span>De (data)</span><input class="input" type="date" name="data_inicio" value="${st.data_inicio || ""}"></label>
                <label class="field"><span>Até (data)</span><input class="input" type="date" name="data_fim" value="${st.data_fim || ""}"></label></div>
              <p class="small muted">Sem dias marcados = todos os dias. Sem horário = o dia inteiro. "Das 22h até 2h" atravessa a meia-noite.</p></div>
            <label class="check"><input type="checkbox" name="ativo" ${st.ativo ? "checked" : ""}> Promoção ligada</label>
            <div id="ex">${ex ? html`<div class="alerta info">${ex}</div>` : ""}</div>`);
        };
        const atualizarExemplo = () => { const ex = exemplo(st); render(f.querySelector("#ex"), ex ? html`<div class="alerta info">${ex}</div>` : ""); };
        const ler = () => {
          const v = (n) => f.querySelector(`[name=${n}]`)?.value;
          st.nome = v("nome") ?? st.nome; st.tipo = v("tipo") ?? st.tipo;
          if (f.querySelector("[name=categoria_id]")) st.categoria_id = v("categoria_id") || null;
          for (const k of ["leve", "pague"]) if (f.querySelector(`[name=${k}]`)) st[k] = Number(v(k)) || null;
          for (const k of ["preco", "percentual", "qtd_minima"]) if (f.querySelector(`[name=${k}]`)) st[k] = v(k)?.trim() ? lerNumero(v(k)) : null;
          for (const k of ["hora_inicio", "hora_fim", "data_inicio", "data_fim"]) st[k] = v(k) || null;
          st.ativo = f.querySelector("[name=ativo]")?.checked ?? st.ativo;
          st.dias_semana = [...f.querySelectorAll("[data-dia]")].filter((x) => x.checked).map((x) => Number(x.dataset.dia));
          f.querySelectorAll("[data-cq]").forEach((x) => (st.combo[Number(x.dataset.cq)].qtd = Math.max(1, Number(x.value) || 1)));
        };
        // Escolher na lista (datalist) já adiciona, sem precisar sair do campo
        f.addEventListener("input", (e) => {
          const t = e.target;
          if ((t.matches("[data-padd]") || t.matches("[data-cadd]")) && porRotulo.has(t.value)) t.dispatchEvent(new Event("change", { bubbles: true }));
        });
        f.addEventListener("change", (e) => {
          ler();
          const t = e.target;
          if (t.matches("[data-padd]") || t.matches("[data-cadd]")) {
            if (!t.value.trim()) return;
            const pr = porRotulo.get(t.value);
            if (!pr) return toast("Escolha um produto da lista", "erro");
            if (t.matches("[data-padd]")) { if (!st.produtos.includes(pr.id)) st.produtos.push(pr.id); }
            else if (!st.combo.some((c) => c.produto_id === pr.id)) st.combo.push({ produto_id: pr.id, qtd: 1 });
            return desenhar();
          }
          // Só redesenha quando muda a estrutura; nos demais campos mantém o foco de quem está digitando
          if (t.matches("[name=tipo], [data-dia], [data-cq]")) return desenhar();
          atualizarExemplo();
        });
        f.addEventListener("click", (e) => {
          const pr = e.target.closest("[data-prem]"), cr = e.target.closest("[data-crem]");
          if (pr) { ler(); st.produtos = st.produtos.filter((x) => x !== pr.dataset.prem); desenhar(); }
          if (cr) { ler(); st.combo.splice(Number(cr.dataset.crem), 1); desenhar(); }
        });
        f.onsubmit = (e) => { e.preventDefault(); ler(); fechar({ salvar: true }); };
        d.querySelector("#exc")?.addEventListener("click", () => fechar({ excluir: true }));
        desenhar();
      },
    });
    if (!r) return;
    try {
      if (r.excluir) { if (!(await confirmar(`Excluir "${p.nome}"?`, { perigo: true, ok: "Excluir" }))) return; await q(sb.from("promocoes").delete().eq("id", p.id)); toast("Promoção excluída", "ok"); return carregar(); }
      const erroValid = validar(st);
      if (erroValid) { toast(erroValid, "erro"); return editar({ ...st, id: p?.id }); }
      const dados = {
        nome: st.nome.trim(), tipo: st.tipo, ativo: st.ativo,
        produtos: st.tipo === "combo" ? [] : st.produtos, categoria_id: st.tipo === "combo" ? null : st.categoria_id,
        leve: st.tipo === "leve_pague" ? st.leve : null, pague: st.tipo === "leve_pague" ? st.pague : null,
        preco: ["preco_horario", "atacado", "combo"].includes(st.tipo) ? st.preco : null,
        percentual: ["preco_horario", "atacado"].includes(st.tipo) && st.preco == null ? st.percentual : null,
        qtd_minima: st.tipo === "atacado" ? st.qtd_minima : null, combo: st.tipo === "combo" ? st.combo : null,
        dias_semana: st.dias_semana.length ? st.dias_semana : null,
        hora_inicio: st.hora_inicio && st.hora_fim ? st.hora_inicio : null, hora_fim: st.hora_inicio && st.hora_fim ? st.hora_fim : null,
        data_inicio: st.data_inicio, data_fim: st.data_fim,
      };
      if (p?.id) await q(sb.from("promocoes").update(dados).eq("id", p.id));
      else await q(sb.from("promocoes").insert({ ...dados, empresa_id: estado.empresa.id }));
      toast("Promoção salva. O caixa já aplica.", "ok"); carregar();
    } catch (e) { erro(e); }
  }

  function validar(s) {
    if (!s.nome?.trim()) return "Dê um nome para a promoção";
    if (s.tipo === "combo") {
      if (s.combo.length < 2 && !(s.combo.length === 1 && s.combo[0].qtd > 1)) return "O combo precisa de pelo menos 2 itens";
      if (!(s.preco > 0)) return "Informe o preço do combo";
      const normal = s.combo.reduce((a, c) => a + c.qtd * Number(prodPorId.get(c.produto_id)?.preco_venda || 0), 0);
      if (s.preco >= normal) return `O preço do combo deve ser menor que ${dinheiro(normal)} (soma dos itens)`;
      return null;
    }
    if (!s.produtos.length && !s.categoria_id) return "Escolha os produtos ou a categoria";
    if (s.tipo === "leve_pague" && !(s.leve >= 2 && s.pague >= 1 && s.pague < s.leve)) return "Em “leve X pague Y”, Y precisa ser menor que X";
    if (["preco_horario", "atacado"].includes(s.tipo) && !(s.preco >= 0 && s.preco != null) && !(s.percentual > 0 && s.percentual < 100)) return "Informe o novo preço ou o desconto em %";
    if (s.tipo === "atacado" && !(s.qtd_minima > 0)) return "Informe a quantidade mínima do atacado";
    if ((s.hora_inicio && !s.hora_fim) || (!s.hora_inicio && s.hora_fim)) return "Informe o horário de início e de fim";
    if (s.data_inicio && s.data_fim && s.data_fim < s.data_inicio) return "A data final é antes da inicial";
    return null;
  }

  function exemplo(s) {
    const p = s.tipo === "combo" ? null : prodPorId.get(s.produtos[0]);
    if (s.tipo === "leve_pague" && p && s.leve > s.pague) return `Ex.: ${s.leve} × ${p.nome} = ${dinheiro(s.leve * p.preco_venda)} → paga ${dinheiro(s.pague * p.preco_venda)}`;
    if (["preco_horario", "atacado"].includes(s.tipo) && p) {
      const novo = s.preco != null ? s.preco : s.percentual ? Math.round(p.preco_venda * (1 - s.percentual / 100) * 100) / 100 : null;
      if (novo != null) return `Ex.: ${p.nome} de ${dinheiro(p.preco_venda)} por ${dinheiro(novo)}${s.tipo === "atacado" && s.qtd_minima ? ` levando ${numero(s.qtd_minima)} ou mais` : ""}`;
    }
    if (s.tipo === "combo" && s.combo.length && s.preco > 0) {
      const normal = s.combo.reduce((a, c) => a + c.qtd * Number(prodPorId.get(c.produto_id)?.preco_venda || 0), 0);
      return `Separados: ${dinheiro(normal)} · no combo: ${dinheiro(s.preco)} (economia de ${dinheiro(normal - s.preco)})`;
    }
    return "";
  }

  await carregar();
  if (params[0] === "nova") { history.replaceState(null, "", "#/promocoes"); editar(null, prodPorId.has(params[1]) ? params[1] : null); }
}
