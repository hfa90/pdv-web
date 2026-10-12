// Pedido por voz do app do garçom: transforma o que o garçom falou em itens do cardápio da loja.
//
// Entrada (POST, usuário logado):
//   { texto: string, alternativas?: string[], aprendido?: { [frase]: produto_id }, mesa_atual?: number }
// Saída:
//   { configurado: false }  → sem chave de IA no servidor: o app usa a interpretação local do aparelho
//   { configurado: true, origem: "ia", mesa, pessoas, itens: [...], nao_entendidos: [...] }
//
// O catálogo vem do banco (só produtos ativos da loja do usuário) e cada produto devolvido é conferido
// aqui: a IA não consegue inventar produto nem preço. Nada é gravado: o app mostra o resumo, o garçom
// confere e só então o pedido é lançado pelas funções de sempre (adicionar_itens).
//
// Segredos da função (Supabase › Edge Functions › Secrets):
//   ANTHROPIC_API_KEY = chave da API da Anthropic (https://console.anthropic.com)
//   VOZ_MODELO        = opcional; padrão "claude-haiku-5-5" (rápido e barato). Para mais precisão: "claude-sonnet-5-5".
import { autenticar, cors, HttpError, json } from "../_shared/auth.ts";

const MODELO = Deno.env.get("VOZ_MODELO") || "claude-haiku-5-5";
const LIMITE_PRODUTOS = 3000;

const FERRAMENTA = {
  name: "registrar_pedido",
  description: "Registra o pedido entendido, item por item, usando só códigos do cardápio.",
  input_schema: {
    type: "object",
    properties: {
      mesa: { type: ["integer", "null"], description: "Número da mesa dito pelo garçom, ou null." },
      pessoas: { type: ["integer", "null"], description: "Quantidade de pessoas dita (\"4 pessoas\"), ou null." },
      itens: {
        type: "array",
        items: {
          type: "object",
          properties: {
            produto: { type: "string", description: "Código do cardápio, ex.: P12" },
            quantidade: { type: "number", description: "Na unidade do produto (KG: 300 gramas = 0.3)." },
            observacao: { type: ["string", "null"], description: "Só o pedido especial para a cozinha (\"sem cebola\", \"bem passado\"). null se não houver." },
            certeza: { type: "string", enum: ["alta", "media", "baixa"] },
            motivo: { type: ["string", "null"], enum: ["parecidos", "peso", "incerto", null] },
            trecho: { type: "string", description: "As palavras exatas do garçom que geraram este item." },
            alternativas: { type: "array", items: { type: "string" }, description: "Outros códigos plausíveis quando há dúvida (até 4)." },
          },
          required: ["produto", "quantidade", "observacao", "certeza", "motivo", "trecho", "alternativas"],
        },
      },
      nao_entendidos: { type: "array", items: { type: "string" }, description: "Trechos que pedem algo que não existe no cardápio ou que não deu para entender." },
    },
    required: ["mesa", "pessoas", "itens", "nao_entendidos"],
  },
};

const REGRAS = `Você interpreta pedidos falados por garçons de restaurante no Brasil. O texto vem do reconhecimento de voz do celular e pode ter erros de transcrição (palavras trocadas por outras de som parecido, números por extenso, falta de pontuação).

Regras, em ordem de importância:
1. NUNCA chute. Um item errado na cozinha é pior que uma pergunta. Se mais de um produto do cardápio serve para o que foi dito (ex.: "coca" e existem Coca Lata, Coca 600ml e Coca 2L), use certeza "media", motivo "parecidos" e liste os outros em alternativas, com o mais provável em "produto".
2. Use SOMENTE códigos que existem no cardápio. Se o garçom pediu algo que não existe, coloque o trecho em nao_entendidos. Não troque por um produto "parecido" de outro tipo.
3. Certeza "alta" só quando o que foi dito identifica um único produto sem dúvida razoável. Variações não ditas valem o produto base ("coca lata" = Coca Lata, não Coca Zero Lata).
4. Quantidade: "duas cocas" = 2; sem número = 1. Produtos vendidos por KG/G/L/ML: converta para a unidade do produto ("300 gramas" de produto KG = 0.3). Se o peso/volume não foi dito para um produto por peso, use quantidade 1, certeza "media" e motivo "peso".
5. Observação é só instrução para a cozinha/bar sobre AQUELE item ("sem cebola", "bem passado", "sem gelo", "com limão"). "Duas cocas, uma sem gelo" = 1 coca + 1 coca com observação "sem gelo". Observação não pode conter outro produto do cardápio que o garçom pediu separado.
6. "mesa 12", "mesa doze" → mesa = 12 (não é item). "quatro pessoas" → pessoas = 4. Palavras como "me vê", "por favor", "anota aí" não são itens.
7. Em "trecho" copie as palavras do garçom que geraram o item, para ele conferir.
8. Escreva a observação em português correto, curta, com acentos.`;

// deno-lint-ignore no-explicit-any
type Dados = Record<string, any>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { admin, perfil } = await autenticar(req);
    if (perfil.papel === "cozinha") throw new HttpError(403, "Sem permissão");
    const corpo = await req.json().catch(() => ({}));
    const texto = String(corpo.texto ?? "").trim().slice(0, 1200);
    if (corpo.acao === "status") return json({ configurado: !!Deno.env.get("ANTHROPIC_API_KEY"), modelo: MODELO });
    const chave = Deno.env.get("ANTHROPIC_API_KEY");
    if (!chave) return json({ configurado: false });
    if (!texto) throw new HttpError(400, "Fale o pedido");
    const alternativasFala = (Array.isArray(corpo.alternativas) ? corpo.alternativas : []).map((s: unknown) => String(s).slice(0, 600)).filter((s: string) => s && s !== texto).slice(0, 3);

    const [{ data: produtos, error: e1 }, { data: categorias }] = await Promise.all([
      admin.from("produtos").select("id,nome,unidade,categoria_id,favorito").eq("empresa_id", perfil.empresa_id).eq("ativo", true).order("nome").limit(LIMITE_PRODUTOS),
      admin.from("categorias").select("id,nome").eq("empresa_id", perfil.empresa_id),
    ]);
    if (e1) throw e1;
    if (!produtos?.length) throw new HttpError(400, "Nenhum produto cadastrado");
    const nomeCat = new Map((categorias || []).map((c: Dados) => [c.id, c.nome]));
    const codigo = new Map<string, Dados>();
    const linhas = (produtos as Dados[]).map((p, i) => {
      const k = "P" + (i + 1);
      codigo.set(k, p);
      return `${k} | ${p.nome} | ${p.unidade} | ${nomeCat.get(p.categoria_id) || "Sem categoria"}${p.favorito ? " | mais pedido" : ""}`;
    });
    const idParaCodigo = new Map([...codigo].map(([k, p]) => [p.id, k]));

    // O que este aparelho já aprendeu com as correções do garçom ("coca" quer dizer Coca Lata)
    const dicas = Object.entries((corpo.aprendido && typeof corpo.aprendido === "object") ? corpo.aprendido : {})
      .slice(0, 80).map(([frase, id]) => idParaCodigo.has(String(id)) ? `"${String(frase).slice(0, 40)}" → ${idParaCodigo.get(String(id))}` : null).filter(Boolean);

    const usuario = [
      `Fala do garçom: "${texto}"`,
      alternativasFala.length ? `Outras transcrições possíveis da mesma fala (use para resolver palavras mal reconhecidas): ${alternativasFala.map((a: string) => `"${a}"`).join("; ")}` : "",
      corpo.mesa_atual ? `O garçom está com a mesa ${Number(corpo.mesa_atual)} aberta na tela.` : "",
      dicas.length ? `Nesta loja, o garçom já confirmou que:\n${dicas.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 2000,
        temperature: 0,
        system: [
          { type: "text", text: REGRAS },
          // O cardápio muda pouco: fica em cache na Anthropic (mais rápido e mais barato nas próximas falas)
          { type: "text", text: `Cardápio (código | nome | unidade | categoria):\n${linhas.join("\n")}`, cache_control: { type: "ephemeral" } },
        ],
        tools: [FERRAMENTA],
        tool_choice: { type: "tool", name: "registrar_pedido" },
        messages: [{ role: "user", content: usuario }],
      }),
    }).finally(() => clearTimeout(timer));
    if (!resp.ok) {
      const det = await resp.text().catch(() => "");
      console.error("anthropic", resp.status, det.slice(0, 500));
      throw new HttpError(502, resp.status === 401 ? "Chave da IA inválida (ANTHROPIC_API_KEY)" : "A IA não respondeu agora");
    }
    const r = await resp.json();
    const uso = r.content?.find((c: Dados) => c.type === "tool_use")?.input as Dados | undefined;
    if (!uso) throw new HttpError(502, "A IA não devolveu o pedido");

    // Confere tudo: só produtos reais da loja, quantidades válidas
    const nao: string[] = (uso.nao_entendidos || []).map((s: unknown) => String(s).slice(0, 120)).filter(Boolean);
    const itens = [];
    for (const it of (uso.itens || []) as Dados[]) {
      const p = codigo.get(String(it.produto));
      const q = Number(it.quantidade);
      if (!p || !(q > 0) || q > 999) { nao.push(String(it.trecho || it.produto || "").slice(0, 120)); continue; }
      const alts = [p.id, ...((it.alternativas || []) as string[]).map((c) => codigo.get(String(c))?.id).filter(Boolean)];
      let certeza = ["alta", "media", "baixa"].includes(it.certeza) ? it.certeza : "media";
      let motivo = ["parecidos", "peso", "incerto"].includes(it.motivo) ? it.motivo : null;
      if (certeza === "alta" && new Set(alts).size > 1) { certeza = "media"; motivo = motivo || "parecidos"; }
      if (certeza !== "alta" && !motivo) motivo = "incerto";
      itens.push({
        produto_id: p.id,
        quantidade: Math.round(q * 1000) / 1000,
        observacao: it.observacao ? String(it.observacao).trim().slice(0, 140) || null : null,
        certeza, motivo,
        trecho: String(it.trecho || "").slice(0, 120),
        alternativas: [...new Set(alts)].slice(0, 5),
      });
    }
    const mesa = Number.isInteger(uso.mesa) ? uso.mesa : null;
    const pessoas = Number.isInteger(uso.pessoas) && uso.pessoas > 0 && uso.pessoas <= 50 ? uso.pessoas : null;
    return json({ configurado: true, origem: "ia", modelo: MODELO, mesa, pessoas, itens, nao_entendidos: nao });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof DOMException && e.name === "AbortError") return json({ error: "A IA demorou para responder" }, 504);
    console.error(e);
    return json({ error: (e as Error).message || "Erro ao interpretar o pedido" }, 500);
  }
});
