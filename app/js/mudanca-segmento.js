// Mudança de setor da loja (migração 023).
// O superusuário pede (Plataforma › Lojas › Gerenciar); aqui o cliente é avisado
// do que será apagado e SÓ consegue confirmar depois de baixar o backup completo
// (um único arquivo .json com todos os dados da loja).
import { rpc } from "./api.js";
import { estado } from "./estado.js";
import { html, render, toast, erro, modal, dataHora } from "./ui.js";
import { icone } from "./icons.js";
import { baixarJson, nomeArquivo, tamanho } from "./backup-util.js";

const CHAVE = "lis-setor-depois-";

/** Ao entrar: se houver pedido pendente, mostra o aviso. */
export async function verificarMudancaSegmento({ forcar = false } = {}) {
  let m;
  try { m = await rpc("segmento_pendente"); } catch { return; }   // banco sem a 023: ignora
  if (!m) return;
  try { if (!forcar && sessionStorage.getItem(CHAVE + m.id)) return; } catch { /* sem armazenamento */ }
  if (!m.pode_confirmar) {
    return modal({
      titulo: "Mudança de setor da loja",
      corpo: html`<div class="stack"><p>O suporte vai mudar esta loja de <strong>${m.de_nome}</strong> para <strong>${m.para_nome}</strong>.</p>
        <p class="small">Isso só acontece quando o <strong>administrador da loja</strong> entrar no sistema, baixar o backup e confirmar.
        Até lá, tudo continua funcionando normalmente.</p></div>`,
      rodape: html`<button class="btn primary" data-fechar>Entendi</button>`,
      onPronto: () => { try { sessionStorage.setItem(CHAVE + m.id, "1"); } catch { /* ok */ } },
    });
  }
  return avisoAdmin(m);
}

function avisoAdmin(m) {
  const loja = estado.empresa?.nome_fantasia || estado.empresa?.razao_social || "loja";
  let baixou = !!m.baixado_em && (Date.now() - new Date(m.baixado_em)) < 23 * 3600e3;
  return modal({
    titulo: `Mudança de setor: ${m.de_nome} → ${m.para_nome}`, largo: true, fixo: true,
    corpo: html`<div class="stack-lg">
      <div class="alerta"><strong>Atenção: dados da loja serão apagados.</strong> O suporte pediu para mudar <strong>${loja}</strong> de
        <strong>${m.de_nome}</strong> para <strong>${m.para_nome}</strong>. Os produtos passam a ser os de exemplo de ${m.para_nome.toLowerCase()}${m.para === "restaurante" ? " e as mesas e o app do garçom ficam liberados" : ""}.</div>
      ${m.mensagem ? html`<div class="alerta info"><strong>Mensagem do suporte:</strong> ${m.mensagem}</div>` : ""}
      <div class="two-col">
        <div><h3 style="margin-bottom:.4rem;color:var(--danger)">Será apagado</h3><ul class="lista-setor">${m.apaga.map((x) => html`<li>${x}</li>`)}</ul></div>
        <div><h3 style="margin-bottom:.4rem">Continua como está</h3><ul class="lista-setor">${m.mantem.map((x) => html`<li>${x}</li>`)}</ul></div>
      </div>
      <div class="passo-setor ${baixou ? "feito" : ""}" id="passo1">
        <div><strong>1. Baixe o backup completo (obrigatório)</strong>
          <p class="small muted">Um único arquivo com <strong>tudo</strong> o que está no sistema: produtos, clientes, vendas, caixa, estoque,
            financeiro, usuários e configurações. Guarde em local seguro (pendrive, e-mail, nuvem). Ele pode ser importado de volta em Backup.</p>
          <p class="small" id="info-baixado">${baixou ? html`${icone("check", 'width="14" height="14"')} Backup baixado em ${dataHora(m.baixado_em)}.` : ""}</p></div>
        <button class="btn ${baixou ? "" : "primary"}" id="baixar-tudo">${icone("baixar", 'width="18" height="18"')} ${baixou ? "Baixar de novo" : "Baixar backup completo"}</button>
      </div>
      <div class="passo-setor" id="passo2" ${baixou ? "" : 'aria-disabled="true"'}>
        <div><strong>2. Confirme a mudança</strong>
          <p class="small muted">O sistema ainda guarda uma cópia no servidor antes de apagar. Digite <strong>APAGAR</strong> para confirmar.</p>
          <input class="input" id="conf-apagar" autocomplete="off" placeholder="APAGAR" ${baixou ? "" : "disabled"} style="max-width:220px"></div>
        <button class="btn danger" id="confirmar-setor" ${baixou ? "" : "disabled"}>Apagar e mudar para ${m.para_nome}</button>
      </div>
    </div>`,
    rodape: html`<button class="btn" id="setor-depois">Decidir depois</button>`,
    onPronto: (d, fechar) => {
      d.querySelector(".modal-head [data-fechar]")?.setAttribute("hidden", "");
      d.addEventListener("cancel", (e) => e.preventDefault());
      const liberar = () => {
        baixou = true;
        d.querySelector("#passo1").classList.add("feito");
        d.querySelector("#passo2").removeAttribute("aria-disabled");
        d.querySelector("#conf-apagar").disabled = false;
        d.querySelector("#confirmar-setor").disabled = false;
        d.querySelector("#conf-apagar").focus();
      };
      d.querySelector("#setor-depois").onclick = () => { try { sessionStorage.setItem(CHAVE + m.id, "1"); } catch { /* ok */ } fechar(); };
      d.querySelector("#baixar-tudo").onclick = async (ev) => {
        const b = ev.currentTarget; b.disabled = true;
        try {
          const dados = await rpc("backup_exportar", { p_empresa: null });
          baixarJson(dados, nomeArquivo(`${dados.loja}-antes-de-mudar-setor`));
          const r = await rpc("segmento_registrar_download", { p_id: m.id });
          render(d.querySelector("#info-baixado"), html`${icone("check", 'width="14" height="14"')} Backup baixado em ${dataHora(r.baixado_em)} (${tamanho(JSON.stringify(dados).length)}). Confira se o arquivo está na pasta Downloads.`);
          b.textContent = "Baixar de novo"; b.className = "btn";
          liberar();
        } catch (e) { erro(e); }
        finally { b.disabled = false; }
      };
      d.querySelector("#confirmar-setor").onclick = async (ev) => {
        if (!baixou) return toast("Baixe o backup completo primeiro", "erro");
        if (d.querySelector("#conf-apagar").value.trim().toUpperCase() !== "APAGAR") return toast("Digite APAGAR para confirmar", "erro");
        const b = ev.currentTarget; b.disabled = true; b.textContent = "Mudando…";
        try {
          const r = await rpc("segmento_confirmar", { p_id: m.id, p_confirmacao: "APAGAR" });
          fechar();
          toast(`Loja mudada para ${m.para_nome}: ${r.produtos_exemplo} produtos de exemplo criados. Recarregando…`, "ok");
          setTimeout(() => location.reload(), 1800);
        } catch (e) { erro(e); b.disabled = false; b.textContent = `Apagar e mudar para ${m.para_nome}`; }
      };
    },
  });
}
