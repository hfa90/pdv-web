// Backup da loja: agenda automática (ou só manual), cópias guardadas,
// baixar/exportar, importar e restaurar. Quem vê cada botão vem do banco
// (backup_painel → permissoes), que é quem realmente decide.
import { rpc } from "../api.js";
import { estado } from "../estado.js";
import { html, render, $, $$, dataHora, toast, erro, confirmar, ocupado, carregando, numero, modal } from "../ui.js";
import { icone } from "../icons.js";
import {
  badgeTipo, tamanho, descreverAgenda, baixarJson, nomeArquivo, escolherArquivoJson, lojasDoArquivo,
  restaurarBackup, avisarRestauracao, formAgenda, ligarAgenda,
} from "../backup-util.js";

export default async function paginaBackup(el) {
  render(el, html`<div class="page" style="max-width:1100px">
    <div class="page-head"><div><h1>Backup</h1><p>Cópias de segurança de todos os dados da loja: produtos, vendas, caixa, clientes, estoque, financeiro e configurações.</p></div></div>
    <div id="painel-backup"></div></div>`);
  await montarPainelBackup($("#painel-backup", el), null, { aoRestaurarPropria: () => setTimeout(() => location.reload(), 1200) });
}

/**
 * Painel de backup de uma loja. empresaId = null → a loja de quem está logado.
 * O superusuário usa o mesmo painel (na Plataforma) passando o id da loja.
 */
export async function montarPainelBackup(alvo, empresaId = null, { aoRestaurarPropria, aoMudar } = {}) {
  render(alvo, carregando());
  let p;
  try { p = await rpc("backup_painel", { p_empresa: empresaId }); }
  catch (e) { render(alvo, html`<div class="alerta">${e.message}</div>`); return; }
  const perm = p.permissoes, c = p.config || {};
  const propria = !empresaId || empresaId === estado.perfil?.empresa_id;
  // Apagar tudo (030): administrador da própria loja ou superusuário
  const podeApagar = perm.super || (propria && estado.perfil?.papel === "admin");
  const recarregar = () => { aoMudar?.(); return montarPainelBackup(alvo, empresaId, { aoRestaurarPropria, aoMudar }); };

  const agendaTxt = c.modo === "manual" && !p.plataforma.obrigatorio ? "Só manual (o automático está desligado)" : descreverAgenda({ ...c, modo: "automatico" });
  render(alvo, html`
    <div class="kpis">
      <div class="panel kpi"><div class="k-ic">${icone("calendario")}</div><div class="k-label">Backup automático</div>
        <div class="k-valor" style="font-size:1.1rem">${agendaTxt}</div>
        <div class="k-sub">${p.plataforma.pausado ? "pausado pela plataforma" : c.proximo_backup_em && !(c.modo === "manual" && !p.plataforma.obrigatorio) ? `próximo: ${dataHora(c.proximo_backup_em)}` : "—"}</div></div>
      <div class="panel kpi"><div class="k-ic">${icone("relogio")}</div><div class="k-label">Último backup</div>
        <div class="k-valor" style="font-size:1.1rem">${p.backups[0] ? dataHora(p.backups[0].created_at) : "Nenhum ainda"}</div>
        <div class="k-sub">${c.ultimo_erro ? html`<span style="color:var(--danger)">falhou: ${c.ultimo_erro}</span>` : p.backups[0] ? `${numero(p.backups[0].registros)} registros` : "faça o primeiro agora"}</div></div>
      <div class="panel kpi"><div class="k-ic">${icone("pacote")}</div><div class="k-label">Cópias guardadas</div>
        <div class="k-valor">${p.backups.length}</div><div class="k-sub">${tamanho(p.espaco_bytes)} no total</div></div>
    </div>

    <div class="toolbar">
      ${perm.manual ? html`<button class="btn primary" id="bk-agora">${icone("check", 'width="18" height="18"')} Fazer backup agora</button>` : ""}
      ${perm.baixar ? html`<button class="btn" id="bk-exportar">${icone("baixar", 'width="18" height="18"')} Exportar arquivo</button>` : ""}
      ${perm.restaurar ? html`<button class="btn" id="bk-importar">${icone("transferir", 'width="18" height="18"')} Importar arquivo</button>` : ""}
    </div>

    ${perm.configurar ? html`<div class="panel" style="margin-bottom:1rem"><div class="panel-head"><h2>Agenda do backup</h2></div>
      <form class="panel-pad stack" id="bk-cfg">
        ${formAgenda(c, { obrigatorio: p.plataforma.obrigatorio, manterMax: p.plataforma.manter_max, podePapeisBaixar: estado.perfil?.papel === "admin" || perm.super, ehSuper: perm.super })}
        <div><button class="btn primary">Salvar agenda</button>
          ${c.atualizado_por ? html`<span class="small muted" style="margin-left:.5rem">alterado por ${c.atualizado_por} em ${dataHora(c.updated_at)}</span>` : ""}</div>
      </form></div>` : ""}

    <div class="panel"><div class="panel-head"><h2>Cópias guardadas</h2></div>
      ${p.backups.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Quando</th><th>Tipo</th><th>Feito por</th><th class="r">Registros</th><th class="r">Tamanho</th><th></th></tr></thead>
        <tbody>${p.backups.map((b) => html`<tr>
          <td>${dataHora(b.created_at)}${b.restaurado_em ? html`<div class="small muted">restaurado em ${dataHora(b.restaurado_em)}</div>` : ""}</td>
          <td>${badgeTipo(b.tipo)}${b.observacao ? html`<div class="small muted">${b.observacao}</div>` : ""}</td>
          <td class="small">${b.criado_por || "—"}</td>
          <td class="r">${numero(b.registros)}</td><td class="r">${tamanho(b.tamanho_bytes)}</td>
          <td class="r" style="white-space:nowrap">
            ${perm.baixar ? html`<button class="btn sm" data-bk="baixar" data-id="${b.id}" title="Baixar arquivo">${icone("baixar", 'width="15" height="15"')}</button>` : ""}
            ${perm.restaurar ? html`<button class="btn sm" data-bk="restaurar" data-id="${b.id}">Restaurar</button>` : ""}
            ${perm.restaurar && (perm.super || !["antes_exclusao", "antes_restauracao"].includes(b.tipo)) ? html`<button class="btn sm ghost" data-bk="apagar" data-id="${b.id}" title="Apagar cópia">${icone("lixo", 'width="15" height="15"')}</button>` : ""}
          </td></tr>`)}</tbody></table></div>`
        : html`<div class="empty"><p>Nenhuma cópia ainda. ${perm.manual ? "Use “Fazer backup agora” ou aguarde o automático." : "O backup automático cria a primeira no próximo horário."}</p></div>`}
    </div>

    ${podeApagar ? html`<div class="panel zona-perigo">
      <div class="panel-pad row wrap" style="gap:1rem;align-items:center">
        <div class="grow"><h2 style="margin:0 0 .25rem">Apagar dados financeiros</h2>
          <p class="small muted" style="margin:0">Vendas, caixa, sangrias, suprimentos, conferências, contas a pagar, fiado e fechamentos dos garçons. Produtos, estoque e clientes continuam. Antes, o sistema obriga a baixar o backup completo.</p></div>
        <button class="btn danger" id="bk-apagar-financeiro">${icone("lixo", 'width="18" height="18"')} Apagar dados financeiros</button>
      </div>
      <div class="panel-pad row wrap" style="gap:1rem;align-items:center;border-top:1px solid var(--line)">
        <div class="grow"><h2 style="margin:0 0 .25rem">Apagar todos os dados da loja</h2>
          <p class="small muted" style="margin:0">Produtos, estoque, vendas, caixa, clientes, fiado, financeiro, compras e fornecedores. Para recomeçar do zero. Antes, o sistema obriga a baixar o backup completo.</p></div>
        <button class="btn danger" id="bk-apagar-tudo">${icone("lixo", 'width="18" height="18"')} Apagar todos os dados</button>
      </div></div>` : ""}`);
  const ctxApagar = { propria, aoRestaurarPropria, recarregar };
  $("#bk-apagar-tudo", alvo)?.addEventListener("click", () => apagarDados("tudo", p, empresaId, ctxApagar));
  $("#bk-apagar-financeiro", alvo)?.addEventListener("click", () => apagarDados("financeiro", p, empresaId, ctxApagar));

  $("#bk-agora", alvo)?.addEventListener("click", (e) => ocupado(e.currentTarget, async () => {
    try { const b = await rpc("backup_criar", { p_empresa: empresaId, p_obs: null }); toast(`Backup feito: ${numero(b.registros)} registros (${tamanho(b.tamanho_bytes)})`, "ok"); recarregar(); }
    catch (er) { erro(er); }
  }));

  $("#bk-exportar", alvo)?.addEventListener("click", (e) => ocupado(e.currentTarget, async () => {
    try { const d = await rpc("backup_exportar", { p_empresa: empresaId }); baixarJson(d, nomeArquivo(d.loja)); toast("Arquivo exportado. Guarde em local seguro: ele contém dados sensíveis da loja.", "ok"); }
    catch (er) { erro(er); }
  }));

  $("#bk-importar", alvo)?.addEventListener("click", async () => {
    try {
      const dados = await escolherArquivoJson();
      if (!dados) return;
      const lojas = lojasDoArquivo(dados);
      const minha = lojas.find((l) => l.empresa_id === p.empresa_id) || (perm.super ? lojas[0] : null);
      if (!minha) throw new Error("Este arquivo não tem os dados desta loja");
      const meta = await rpc("backup_importar", { p_dados: minha });
      toast("Arquivo importado como cópia. Agora é só restaurar, se quiser.", "ok");
      if (await confirmar(`Arquivo de ${minha.loja} (${dataHora(minha.gerado_em)}) importado. Restaurar agora? Os dados atuais serão trocados pelos do arquivo.`, { titulo: "Restaurar o arquivo importado?", ok: "Continuar" })) {
        const r = await restaurarBackup(meta, { lojaExiste: meta.loja_existe });
        avisarRestauracao(r);
        if (r && propria) return aoRestaurarPropria?.();
      }
      recarregar();
    } catch (er) { erro(er); }
  });

  const form = $("#bk-cfg", alvo);
  if (form) {
    const ler = ligarAgenda(form);
    form.onsubmit = (e) => {
      e.preventDefault();
      ocupado(form.querySelector("button.primary"), async () => {
        try { await rpc("backup_config_salvar", { p: ler(), p_empresa: empresaId }); toast("Agenda do backup salva", "ok"); recarregar(); }
        catch (er) { erro(er); }
      });
    };
  }

  $$("[data-bk]", alvo).forEach((b) => (b.onclick = () => ocupado(b, async () => {
    const meta = p.backups.find((x) => x.id === b.dataset.id);
    try {
      if (b.dataset.bk === "baixar") {
        const d = await rpc("backup_baixar", { p_id: meta.id });
        baixarJson(d, nomeArquivo(meta.loja, meta.created_at));
      } else if (b.dataset.bk === "apagar") {
        if (!(await confirmar(`Apagar a cópia de ${dataHora(meta.created_at)}? Não dá para desfazer.`, { perigo: true, ok: "Apagar" }))) return;
        await rpc("backup_excluir", { p_id: meta.id }); toast("Cópia apagada", "ok"); recarregar();
      } else if (b.dataset.bk === "restaurar") {
        const r = await restaurarBackup(meta, { lojaExiste: true });
        if (!r) return;
        avisarRestauracao(r);
        if (propria) return aoRestaurarPropria?.();
        recarregar();
      }
    } catch (er) { erro(er); }
  })));
}

// ---------------------------------------------------------------------
// Apagar todos os dados da loja (migração 030). Obrigatório baixar o backup completo antes.
// ---------------------------------------------------------------------
const APAGA = ["Produtos e categorias", "Estoque, lotes, validade e perdas", "Promoções", "Vendas, cupons e pagamentos",
  "Caixas, sangrias e conferências", "Clientes e fiado", "Financeiro (contas a pagar)", "Compras, notas de entrada e fornecedores",
  "Comandas, pedidos da cozinha e chamados das mesas", "Registro das notas fiscais emitidas"];
const MANTEM = ["Usuários e senhas", "Dados da empresa (nome, CNPJ, endereço)", "Configurações fiscais, PIX e operadoras de pagamento",
  "Aparelhos autorizados", "Mesas (os QR Codes impressos continuam valendo)", "Assinatura, faturas e licenças", "Registro de atividades"];

const APAGA_FIN = ["Vendas, com itens, pagamentos, comandas e notas fiscais dessas vendas", "Pagamentos feitos pela mesa (QR Code)",
  "Caixas, sangrias, suprimentos e conferências", "Contas a pagar", "Fiado (o saldo dos clientes volta a zero)", "Fechamentos dos garçons"];
const MANTEM_FIN = ["Produtos e estoque atual", "Histórico de entradas e ajustes de estoque", "Clientes e fornecedores", "Compras e notas de entrada",
  "Mesas, usuários e configurações", "Assinatura, faturas e registro de atividades"];

function apagarDados(escopo, painel, empresaId, { propria, aoRestaurarPropria, recarregar }) {
  const loja = painel.loja || estado.empresa?.nome_fantasia || estado.empresa?.razao_social || "loja";
  let codigo = null;
  const fin = escopo === "financeiro";
  const PALAVRA = fin ? "APAGAR FINANCEIRO" : "APAGAR TUDO";
  const nome = fin ? "Apagar dados financeiros" : "Apagar todos os dados";
  const apaga = fin ? APAGA_FIN : APAGA, mantem = fin ? MANTEM_FIN : MANTEM;
  return modal({
    titulo: fin ? "Apagar dados financeiros da loja" : "Apagar todos os dados da loja", largo: true, fixo: true,
    corpo: html`<div class="stack-lg">
      <div class="alerta"><strong>Isto não pode ser desfeito pelo sistema.</strong> ${fin ? "Todo o histórico financeiro" : "Todos os dados de operação"} de <strong>${loja}</strong> ${fin ? "será apagado" : "serão apagados"}.
        Só será possível recuperar importando o backup que você vai baixar agora.</div>
      <div class="two-col">
        <div><h3 style="margin-bottom:.4rem;color:var(--danger)">Será apagado</h3><ul class="lista-setor">${apaga.map((x) => html`<li>${x}</li>`)}</ul></div>
        <div><h3 style="margin-bottom:.4rem">Continua como está</h3><ul class="lista-setor">${mantem.map((x) => html`<li>${x}</li>`)}</ul></div>
      </div>
      <p class="small muted" style="margin:0">Notas fiscais: a lei manda a loja guardar os arquivos (XML) por 5 anos. Eles vão no backup e continuam com o provedor fiscal.</p>
      <div class="passo-setor" id="ap-passo1">
        <div><strong>1. Baixe o backup completo (obrigatório)</strong>
          <p class="small muted">Um único arquivo com <strong>tudo</strong>: produtos, clientes, vendas, caixa, estoque, financeiro, usuários e configurações.
            Guarde em local seguro (pendrive, e-mail, nuvem). Ele pode ser importado de volta nesta tela.</p>
          <p class="small" id="ap-info"></p></div>
        <button class="btn primary" id="ap-baixar">${icone("baixar", 'width="18" height="18"')} Baixar backup completo</button>
      </div>
      <div class="passo-setor" id="ap-passo2" aria-disabled="true">
        <div><strong>2. Confirme</strong>
          <p class="small muted">O servidor ainda guarda uma cópia antes de apagar. Digite <strong>${PALAVRA}</strong> para confirmar. Vale por 30 minutos depois do download.</p>
          <input class="input" id="ap-conf" autocomplete="off" placeholder="${PALAVRA}" disabled style="max-width:260px"></div>
        <button class="btn danger" id="ap-confirmar" disabled>${nome}</button>
      </div>
    </div>`,
    rodape: html`<button class="btn" data-fechar>Cancelar</button>`,
    onPronto: (d, fechar) => {
      const conf = d.querySelector("#ap-conf"), btConf = d.querySelector("#ap-confirmar");
      d.querySelector("#ap-baixar").onclick = async (ev) => {
        const b = ev.currentTarget; b.disabled = true; b.textContent = "Gerando o backup…";
        try {
          const r = await rpc("apagar_dados_iniciar", { p_empresa: empresaId, p_escopo: escopo });
          baixarJson(r.dados, nomeArquivo(`${r.dados.loja || loja}-antes-de-apagar-${fin ? "financeiro" : "tudo"}`));
          codigo = r.codigo;
          render(d.querySelector("#ap-info"), html`${icone("check", 'width="14" height="14"')} Backup baixado agora: ${numero(r.registros)} registros (${tamanho(JSON.stringify(r.dados).length)}). Confira se o arquivo está na pasta Downloads.`);
          d.querySelector("#ap-passo1").classList.add("feito");
          d.querySelector("#ap-passo2").removeAttribute("aria-disabled");
          conf.disabled = false; conf.focus();
          b.className = "btn"; b.textContent = "Baixar de novo";
        } catch (e) {
          erro(/apagar_dados_iniciar|function|does not exist/i.test(e.message) ? new Error("Falta aplicar a migração 030_apagar_dados_loja.sql no banco.") : e);
          b.textContent = "Baixar backup completo";
        } finally { b.disabled = false; }
      };
      conf.oninput = () => { btConf.disabled = !codigo || conf.value.trim().toUpperCase() !== PALAVRA; };
      btConf.onclick = async () => {
        if (!codigo) return toast("Baixe o backup completo primeiro", "erro");
        if (!(await confirmar(`Última confirmação: ${fin ? "apagar os dados financeiros" : "apagar todos os dados"} de ${loja}?`, { titulo: nome, ok: "Apagar", perigo: true }))) return;
        btConf.disabled = true; btConf.textContent = "Apagando…";
        try {
          const r = await rpc("apagar_dados_confirmar", { p_codigo: codigo, p_confirmacao: PALAVRA });
          fechar(true);
          toast(`Pronto: ${numero(r.apagados)} registros apagados. O backup ficou no seu computador e uma cópia no servidor.`, "ok");
          if (propria) setTimeout(() => (aoRestaurarPropria ? aoRestaurarPropria() : location.reload()), 1500);
          else recarregar();
        } catch (e) { erro(e); btConf.disabled = false; btConf.textContent = nome; }
      };
    },
  });
}
