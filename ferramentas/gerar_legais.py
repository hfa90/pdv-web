"""Gera termos.html, privacidade.html e tratamento-de-dados.html na raiz do site.

Edite os textos em ferramentas/legal/*.html (só o conteúdo, sem cabeçalho) e rode:
    python3 ferramentas/gerar_legais.py
Os dados da empresa (razão social, CNPJ, e-mails, foro, versão) ficam em assets/config.js › LEGAL.
Ao mudar o texto de forma relevante, aumente LEGAL.versao: o administrador de cada loja aceita de novo
e a nova versão precisa ser cadastrada no banco (tabela termos_versoes, migração 029).
"""
import pathlib, subprocess

RAIZ = pathlib.Path(__file__).resolve().parent.parent
FONTE = RAIZ / "ferramentas" / "legal"
DOCS = [
    ("termos.html", "Termos de Uso", "Termos de Uso do Lis PDV: planos, pagamento, cancelamento, comodato, responsabilidades e foro."),
    ("privacidade.html", "Política de Privacidade", "Como o Lis PDV trata dados pessoais conforme a LGPD: dados coletados, finalidades, compartilhamento, prazos e direitos."),
    ("tratamento-de-dados.html", "Acordo de Tratamento de Dados", "Acordo de tratamento de dados pessoais entre a loja (controladora) e o Lis PDV (operador), conforme a LGPD."),
]

logo = subprocess.check_output(["node", "-e",
    f"import('{(RAIZ / 'assets' / 'marca.js').as_uri()}').then(m=>process.stdout.write(m.logotipo({{altura:24, classe:'site-logo'}})))"]).decode()

for arq, titulo, desc in DOCS:
    corpo = (FONTE / arq).read_text(encoding="utf-8")
    nav = "".join(f'<a href="{a}"{" aria-current=\"page\"" if a == arq else ""}>{t}</a>' for a, t, _ in DOCS)
    rod = "".join(f'<a href="{a}">{t}</a>' for a, t, _ in DOCS)
    html = f'''<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>{titulo} · Lis PDV</title>
  <meta name="description" content="{desc}">
  <meta name="theme-color" content="#136F63">
  <link rel="icon" type="image/svg+xml" href="assets/marca/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="assets/tema.js"></script>
  <link rel="stylesheet" href="assets/marca.css">
  <link rel="stylesheet" href="assets/site.css">
  <link rel="stylesheet" href="assets/legal.css">
</head>
<body class="legal">
<a class="pular" href="#conteudo">Pular para o conteúdo</a>
<!-- Gerado a partir de ferramentas/legal/ (python3 ferramentas/gerar_legais.py). Dados da empresa: assets/config.js › LEGAL -->
<header class="legal-topo"><div class="legal-topo-in">
  <a class="logo" href="./" aria-label="Lis PDV, início">{logo}</a>
  <nav class="legal-docs" aria-label="Documentos">{nav}</nav>
</div></header>
<div class="legal-corpo">
  <aside class="legal-lado" aria-label="Nesta página">
    <details class="legal-sumario" open><summary>Nesta página</summary>
      <ol id="sumario"></ol></details>
    <button class="botao-imprimir" id="imprimir" type="button">Imprimir ou salvar em PDF</button>
  </aside>
  <main id="conteudo" class="legal-texto">
{corpo}
  </main>
</div>
<footer class="legal-rodape"><div>
  <span>© <span data-legal="razaoSocial"></span></span>
  <a href="./">Site</a><a href="app/">Entrar no sistema</a>{rod}
</div></footer>
<script type="module" src="assets/legal.js"></script>
</body>
</html>
'''
    (RAIZ / arq).write_text(html, encoding="utf-8")
    print("gerado", arq)
