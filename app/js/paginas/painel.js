// Painel do dia para administradores e gerentes.
import { sb, q, rpc } from "../api.js";
import { estado } from "../estado.js";
import { html, render, dinheiro, qtd as fmtQtd, hora, rotuloMesa } from "../ui.js";
import { kpis, colunas, barras, preencherHoras } from "./relatorios.js";
import { nomeForma } from "../impressao/cupom.js";
import { icone } from "../icons.js";
import { linkGarcom, linkCardapio } from "../links.js";

export default async function painel(el) {
  const ini = new Date(); ini.setHours(0, 0, 0, 0);
  const fim = new Date(ini); fim.setDate(fim.getDate() + 1);
  const [r, baixo, caixas, pedidos, nProdutos] = await Promise.all([
    rpc("relatorio_vendas", { p_inicio: ini.toISOString(), p_fim: fim.toISOString() }),
    rpc("produtos_estoque_baixo"),
    q(sb.from("caixa_sessoes").select("id,aberto_em,operador:perfis(nome)").eq("status", "aberto")),
    q(sb.from("vendas").select("id,identificador,total,created_at,canal").eq("status", "aberta").order("created_at")),
    sb.from("produtos").select("id", { count: "exact", head: true }).then((x) => x.count || 0),
  ]);
  const saud = new Date().getHours() < 12 ? "Bom dia" : new Date().getHours() < 18 ? "Boa tarde" : "Boa noite";

  render(el, html`<div class="page">
    <div class="page-head"><div><h1>${saud}, ${estado.perfil.nome.split(" ")[0]}</h1>
      <p>${new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}</p></div>
      <a class="btn primary lg" href="#/pdv">Abrir o PDV</a></div>

    ${nProdutos === 0 ? html`<div class="panel panel-pad stack" style="margin-bottom:1.25rem">
      <h2>Primeiros passos</h2>
      <p class="muted">Três coisas para deixar a loja pronta para vender:</p>
      <div class="row wrap"><a class="btn" href="#/configuracoes">1. Dados da loja e impressora</a><a class="btn" href="#/produtos">2. Cadastrar produtos</a><a class="btn" href="#/usuarios">3. Criar usuários de caixa</a></div>
    </div>` : ""}

    ${estado.conta?.garcom || estado.conta?.delivery_contratado ? html`<div class="modulos">
      ${estado.conta?.garcom ? html`<div class="panel panel-pad modulo">
        <div class="modulo-ic">${icone("celular", 'width="26" height="26"')}</div>
        <div class="grow"><h3>App do garçom</h3><p class="small muted">Os garçons lançam pedidos pelo celular ou tablet, direto para a cozinha. Instala como aplicativo.</p>
          <a class="small link-quebra" href="${linkGarcom()}" target="_blank" rel="noopener">${linkGarcom()}</a></div>
        <a class="btn sm" href="#/mesas">Ver mesas</a></div>` : ""}
      ${estado.conta?.delivery_contratado ? html`<div class="panel panel-pad modulo">
        <div class="modulo-ic">${icone("moto", 'width="26" height="26"')}</div>
        <div class="grow"><h3>Cardápio digital e delivery</h3>
          ${estado.empresa.delivery_ativo && estado.empresa.slug ? html`<p class="small muted">Pedidos pelo link, sem comissão. Pagamento por PIX e acompanhamento em tempo real.</p>
            <a class="small link-quebra" href="${linkCardapio(estado.empresa.slug)}" target="_blank" rel="noopener">${linkCardapio(estado.empresa.slug)}</a>`
          : html`<p class="small muted">Monte seu cardápio online e receba pedidos de entrega e retirada sem pagar comissão.</p>`}</div>
        <a class="btn sm ${estado.empresa.delivery_ativo ? "" : "primary"}" href="${estado.empresa.delivery_ativo ? "#/delivery" : "#/configuracoes/delivery"}">${estado.empresa.delivery_ativo ? "Pedidos" : "Ativar"}</a></div>` : ""}
    </div>` : ""}

    ${kpis(r.resumo)}

    <div class="two-col">
      <div class="panel"><div class="panel-head"><h2>Vendas de hoje por hora</h2></div><div class="panel-pad">${colunas(preencherHoras(r.por_hora), (p) => `${p.hora}h`)}</div></div>
      <div class="panel"><div class="panel-head"><h2>Formas de pagamento</h2></div><div class="panel-pad">${barras(r.por_forma, (i) => nomeForma(i.forma), (i) => Number(i.valor))}</div></div>
    </div>

    <div class="two-col" style="margin-top:1rem">
      <div class="panel"><div class="panel-head"><h2>Agora na loja</h2></div><div class="panel-pad stack">
        <div class="linha-valor" style="font-size:1rem"><span>Caixas abertos</span><strong style="color:var(--ink)">${caixas.length}</strong></div>
        ${caixas.map((c) => html`<div class="linha-valor"><span>${c.operador?.nome}</span><span>desde ${hora(c.aberto_em)}</span></div>`)}
        <div class="linha-valor" style="font-size:1rem;margin-top:.5rem"><span>Pedidos e comandas abertos</span><strong style="color:var(--ink)">${pedidos.length} · ${dinheiro(pedidos.reduce((a, p) => a + Number(p.total), 0))}</strong></div>
        ${pedidos.slice(0, 6).map((p) => html`<div class="linha-valor"><span>${rotuloMesa(p.identificador) || "Sem mesa"} · desde ${hora(p.created_at)}</span><span>${dinheiro(p.total)}</span></div>`)}
      </div></div>
      <div class="panel"><div class="panel-head"><h2>Estoque baixo</h2>${baixo.length ? html`<a href="#/estoque" class="small">Ver todos</a>` : ""}</div><div class="panel-pad stack" style="gap:.4rem">
        ${baixo.length ? baixo.slice(0, 8).map((p) => html`<div class="linha-valor" style="font-size:.95rem"><span style="color:var(--ink)">${p.nome}</span>
          <span class="badge ${p.estoque_atual <= 0 ? "danger" : "warn"}">${fmtQtd(p.estoque_atual, p.unidade)} / mín ${fmtQtd(p.estoque_minimo, p.unidade)}</span></div>`)
          : html`<p class="muted">Tudo acima do mínimo.</p>`}
      </div></div>
    </div>
  </div>`);
}
