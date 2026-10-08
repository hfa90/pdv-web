// Entrar, criar conta, recuperar senha e cadastro inicial da empresa.
import { sb, fn, mensagemErro } from "../api.js";
import { estado } from "../estado.js";
import { MARCA, linkWhatsApp } from "../config.js";
import { obterDispositivo, obterImpressao } from "../../../assets/dispositivo.js";

const estado_usuario = () => estado.usuario;
import { html, render, $, lerForm, toast, ocupado, docValido, somenteDigitos } from "../ui.js";

function moldura(conteudo) {
  return html`
  <div class="auth">
    <section class="auth-arte">
      <div class="brand" style="padding:0"><div class="brand-mark" style="background:#fff;color:var(--primary)">${MARCA.slice(0, 1)}</div>
        <div class="brand-name">${MARCA}</div></div>
      <div>
        <h2>Venda no balcão, na mesa e no caixa.</h2>
        <p>Para padarias, mercadinhos, lanchonetes, cafés e restaurantes. Cupom na impressora térmica e nota fiscal em poucos toques.</p>
      </div>
      <div class="auth-recibo" aria-hidden="true">
        <div class="l"><span>2 Pão francês</span><span>1,50</span></div>
        <div class="l"><span>1 Café com leite</span><span>6,00</span></div>
        <div class="l"><span>0,250 kg Queijo</span><span>11,48</span></div>
        <div class="l t"><span>Total</span><span>R$ 18,98</span></div>
      </div>
    </section>
    <section class="auth-form"><div class="auth-box">${conteudo}</div></section>
  </div>`;
}

export function telaLogin(app, aoEntrar, modo = "entrar") {
  const telas = {
    entrar: html`
      <div><h1>Entrar</h1><p class="muted">Use o e-mail e a senha cadastrados.</p></div>
      <form class="stack" id="f">
        <label class="field"><span>E-mail</span><input class="input lg" name="email" type="email" autocomplete="username" required autofocus></label>
        <label class="field"><span>Senha</span><input class="input lg" name="senha" type="password" autocomplete="current-password" required></label>
        <div id="msg"></div>
        <button class="btn primary lg block">Entrar</button>
      </form>
      <div class="row" style="justify-content:space-between">
        <button class="link-btn" data-modo="recuperar">Esqueci a senha</button>
        <button class="link-btn" data-modo="criar">Criar conta da loja</button>
      </div>
      <button class="link-btn" id="pedir-ajuda" style="align-self:center">Não consegue entrar? Pedir ajuda ao suporte</button>`,
    criar: html`
      <div><h1>Criar conta</h1><p class="muted">Quem cria a conta vira o administrador da loja.</p></div>
      <form class="stack" id="f">
        <label class="field"><span>Seu nome</span><input class="input" name="nome" required autofocus></label>
        <label class="field"><span>E-mail</span><input class="input" name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Senha</span><input class="input" name="senha" type="password" minlength="8" autocomplete="new-password" required>
          <span class="hint">Mínimo de 8 caracteres.</span></label>
        <div id="msg"></div>
        <button class="btn primary lg block">Criar conta</button>
      </form>
      <button class="link-btn" data-modo="entrar">Já tenho conta</button>`,
    recuperar: html`
      <div><h1>Recuperar senha</h1><p class="muted">Enviaremos um link para criar uma nova senha.</p></div>
      <form class="stack" id="f">
        <label class="field"><span>E-mail</span><input class="input lg" name="email" type="email" required autofocus></label>
        <div id="msg"></div>
        <button class="btn primary lg block">Enviar link</button>
      </form>
      <button class="link-btn" data-modo="entrar">Voltar para entrar</button>`,
  };
  render(app, moldura(telas[modo]));
  app.querySelectorAll("[data-modo]").forEach((b) => (b.onclick = () => telaLogin(app, aoEntrar, b.dataset.modo)));
  app.querySelector("#pedir-ajuda")?.addEventListener("click", () => import("../suporte.js").then((m) => m.pedirAjuda({ app: "pdv" })).catch(() => {}));
  const msg = (t, tipo = "") => render($("#msg"), t ? html`<div class="alerta ${tipo}">${t}</div>` : "");

  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const d = lerForm(e.target);
    const botao = e.target.querySelector("button");
    msg("");
    await ocupado(botao, async () => {
      try {
        if (modo === "entrar") {
          const { error } = await sb.auth.signInWithPassword({ email: d.email, password: d.senha });
          if (error) throw error;
          aoEntrar();
        } else if (modo === "criar") {
          if (d.senha.length < 8) throw new Error("A senha deve ter ao menos 8 caracteres");
          const { data, error } = await sb.auth.signUp({
            email: d.email, password: d.senha,
            options: { data: { nome: d.nome }, emailRedirectTo: location.origin + location.pathname },
          });
          if (error) throw error;
          sessionStorage.setItem("pdv-nome", d.nome);
          if (data.session) aoEntrar();
          else msg("Conta criada. Abra o link que enviamos para seu e-mail e depois entre aqui.", "info");
        } else {
          const { error } = await sb.auth.resetPasswordForEmail(d.email, { redirectTo: location.origin + location.pathname });
          if (error) throw error;
          msg("Se o e-mail estiver cadastrado, você receberá o link em instantes.", "info");
        }
      } catch (err) { msg(mensagemErro(err)); }
    });
  };
}

export function telaOnboarding(app, aoConcluir) {
  const meta = estado_usuario()?.user_metadata || {};
  render(app, moldura(html`
    <div><h1>Ative seu teste grátis</h1><p class="muted">7 dias para usar o sistema completo na sua loja. Já deixamos produtos de exemplo para você começar a vender no primeiro minuto.</p></div>
    <form class="stack" id="f">
      <label class="field"><span>Seu nome</span><input class="input" name="nome" value="${meta.nome || sessionStorage.getItem("pdv-nome") || ""}" required autofocus></label>
      <label class="field"><span>Nome da loja</span><input class="input" name="loja" value="${meta.loja || ""}" required></label>
      <label class="field"><span>Tipo de negócio</span>
        <select class="input" name="segmento">
          ${[["padaria","Padaria"],["mercadinho","Mercadinho"],["supermercado","Supermercado"],["lanchonete","Lanchonete"],["cafe","Café da manhã / cafeteria"],["restaurante","Restaurante (com mesas e app do garçom)"]]
            .map(([v, n]) => html`<option value="${v}" ${meta.segmento === v ? "selected" : ""}>${n}</option>`)}
        </select></label>
      <div class="grid-2">
        <label class="field"><span>WhatsApp</span><input class="input" name="whatsapp" value="${meta.whatsapp || ""}" inputmode="tel" placeholder="(92) 99999-0000" required></label>
        <label class="field"><span>CPF ou CNPJ</span><input class="input" name="documento" value="${meta.documento || ""}" inputmode="numeric" required></label>
      </div>
      <p class="hint">O teste é de um por negócio. Esses dados não são compartilhados.</p>
      <div id="msg"></div>
      <button class="btn primary lg block">Começar meu teste de 7 dias</button>
    </form>
    <button class="link-btn" id="sair">Sair</button>`));
  $("#sair").onclick = async () => { await sb.auth.signOut(); aoConcluir(); };
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const d = lerForm(e.target);
    const msg = (t, extra = "") => render($("#msg"), html`<div class="alerta">${t}${extra}</div>`);
    if (!docValido(d.documento)) return msg("CPF ou CNPJ inválido");
    if (somenteDigitos(d.whatsapp).length < 10) return msg("Informe o WhatsApp com DDD");
    await ocupado(e.target.querySelector("button"), async () => {
      try {
        await fn("teste", { acao: "iniciar", ...d, documento: somenteDigitos(d.documento),
          dispositivo: obterDispositivo(), impressao: await obterImpressao() });
        sessionStorage.removeItem("pdv-nome");
        toast("Loja de teste criada. Boas vendas!", "ok");
        location.hash = "#/painel";
        aoConcluir();
      } catch (err) {
        const zap = linkWhatsApp(`Olá! Quero conhecer os planos do ${MARCA}. Minha loja: ${d.loja}.`);
        render($("#msg"), html`<div class="alerta warn">${err.message}
          ${zap ? html`<div style="margin-top:.5rem"><a class="btn sm" href="${zap}" target="_blank" rel="noopener">Falar no WhatsApp</a></div>` : ""}
          <div style="margin-top:.5rem"><a href="../#planos">Ver planos e preços</a></div></div>`);
      }
    });
  };
}

export function telaNovaSenha(app, aoConcluir) {
  render(app, moldura(html`
    <div><h1>Nova senha</h1><p class="muted">Escolha uma senha com ao menos 8 caracteres.</p></div>
    <form class="stack" id="f">
      <label class="field"><span>Nova senha</span><input class="input lg" name="senha" type="password" minlength="8" autocomplete="new-password" required autofocus></label>
      <div id="msg"></div>
      <button class="btn primary lg block">Salvar senha</button>
    </form>`));
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const { senha } = lerForm(e.target);
    await ocupado(e.target.querySelector("button"), async () => {
      const { error } = await sb.auth.updateUser({ password: senha });
      if (error) return render($("#msg"), html`<div class="alerta">${mensagemErro(error)}</div>`);
      toast("Senha alterada", "ok");
      aoConcluir();
    });
  };
}
