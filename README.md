# Lis PDV — Ponto de venda web

Sistema de frente de caixa para padarias, mercadinhos, supermercados, lanchonetes, cafés e restaurantes.
Frontend em HTML, CSS e JavaScript puro (sem etapa de build) e backend 100% Supabase (Postgres + Auth + Edge Functions).

## O que tem

- **PDV** rápido para teclado, leitor de código de barras e tela touch: favoritos, categorias, busca, `3*789…` para multiplicar, etiquetas de balança (EAN-13 iniciado em 2), produtos por peso, observações por item, desconto/acréscimo/taxa de serviço, vários pagamentos com troco.
- **Pedidos e comandas** (mesa, comanda, senha) que podem ser lançados por atendentes e fechados no caixa.
- **Caixa**: abertura com fundo de troco, sangria, suprimento, resumo parcial e fechamento com conferência (esperado × contado).
- **Produtos e categorias**, importação por CSV, margem, dados fiscais (NCM, CEST, CFOP, CSOSN, origem).
- **Estoque** com baixa automática nas vendas, entradas, saídas, contagem de inventário e histórico.
- **Clientes** com preenchimento de endereço pelo CEP (para NF-e).
- **Relatórios**: faturamento, ticket médio, lucro estimado, por dia/hora, por forma de pagamento, por operador, mais vendidos, exportação CSV.
- **Impressão térmica**: pelo navegador (qualquer impressora) ou direto em ESC/POS via WebUSB / Web Serial (Bluetooth), 58 ou 80 mm, QR Code, corte de papel e abertura de gaveta.
- **Nota fiscal**: NFC-e (cupom fiscal eletrônico, modelo 65) e NF-e (modelo 55) via provedor Focus NFe, com DANFE NFC-e impresso na térmica, consulta e cancelamento.
- **Níveis de acesso**: Administrador, Gerente, Caixa e Atendente.
- **Registro de atividades** (auditoria) de cancelamentos, alterações de preço, caixa, usuários e notas.
- **PIX com QR Code no caixa**: a chave da loja fica em Configurações › PIX e o PDV gera o código "copia e cola" (BR Code com CRC16) com o valor exato. Opcional: token do Mercado Pago para cobrança com confirmação automática.
- **Mesas (restaurantes)**: mapa interativo do salão (arrastar para montar, áreas, formatos), situação ao vivo (livre, ocupada, conta pedida), lançar itens, transferir/juntar, conta por pessoa e envio para o caixa.
- **App do garçom** (`garcom/`): PWA instalável no celular ou tablet, mesmo login e mesmas regras do banco, funciona com internet instável e reenvia pedidos pendentes.
- **Cozinha**: um computador pode imprimir sozinho os itens lançados pelos garçons e os pedidos do delivery.
- **Delivery e cardápio digital** (`cardapio/?loja=endereco`): cardápio com fotos, sacola, entrega ou retirada, CEP automático, PIX, e acompanhamento do pedido em tempo real (recebido, em preparo, saiu, entregue). A loja gerencia em um quadro por etapa com aviso sonoro.

- **Balança integrada** (Configurações › Balança): Toledo, Filizola, Urano, Elgin ou envio contínuo pela porta serial/USB (Web Serial, Chrome/Edge). Produtos por KG abrem o visor de pesagem no PDV e entram sozinhos quando o peso estabiliza. Também lê etiquetas de balança com preço ou peso (EAN-13 iniciado em 2, código de 4 ou 5 dígitos). Modo simulador para treinar sem balança.
- **Códigos e etiquetas**: gerador interativo de EAN-13, EAN-8, Code 128, ITF-14 e QR Code (texto/link, PIX da loja, WhatsApp, Wi-Fi, cardápio), com pré-visualização ao vivo, cor e estilo do QR, código interno válido, gravação no cadastro do produto, impressão em etiqueta térmica ou folha A4 (Pimaco 6180), fila de impressão e download PNG/SVG.
- **Minha assinatura** (administrador/gerente): plano, próximo pagamento, faturas com link de pagamento, pendências da loja, uso do mês e pedidos de pacotes adicionais.
- **Menu lateral recolhível** (só ícones, abre ao passar o mouse; botão para fixar aberto) e **tema escuro** (sistema e site; segue o tema do aparelho até a pessoa escolher).

## Segurança

- Multiempresa com isolamento por **Row Level Security** em todas as tabelas.
- O navegador **não grava** vendas, caixa ou estoque diretamente: tudo passa por funções do banco (`registrar_venda`, `cancelar_venda`, `abrir_caixa`…) que validam o nível de acesso.
- **Preços vêm sempre do cadastro**, nunca do navegador. O limite de desconto de caixas/atendentes é aplicado no servidor.
- O estoque só muda por movimentação registrada (privilégio de coluna).
- Itens retirados de comandas ficam registrados (antifraude), e cancelamentos exigem motivo e nível de gerente.
- Tokens do provedor fiscal ficam numa tabela sem acesso pela API; só a Edge Function lê.
- Criação de usuários e troca de senha acontecem numa Edge Function com service role, nunca no navegador.
- Todo texto exibido passa por escape automático (`html\`\``) contra XSS; Content-Security-Policy restritiva.

## Endereços

- **Site de vendas:** `index.html` na raiz (planos, simulador, teste grátis, captação de contatos)
- **Sistema:** `app/` (o PDV em si)
- **App do garçom:** `garcom/` (PWA; liberado para lojas do segmento restaurante ou com o módulo ativado no painel Plataforma)
- **Cardápio digital:** `cardapio/?loja=<endereço da loja>` (público; módulo delivery)

## Teste grátis e antifraude

O teste dura 7 dias (até 200 vendas e 3 usuários, nota fiscal só em homologação). A loja só é criada pela Edge Function `teste`, que confere no servidor:

- CPF/CNPJ válido e nunca usado em outro teste
- WhatsApp e e-mail (normalizado: Gmail sem pontos e sem “+apelido”) nunca usados
- e-mails descartáveis bloqueados
- identificador do aparelho (navegador) nunca usado; no máximo 2 testes por IP em 30 dias
- e-mail confirmado antes de liberar

O registro dos testes (`testes_gratis`) nunca é apagado. Tentativas repetidas viram contatos marcados como “Tentou repetir o teste” no painel **Plataforma**. Ao fim do teste as vendas ficam bloqueadas no banco (gatilhos), não só na tela.

## Painel do fornecedor

O menu **Plataforma** aparece só para os e-mails da tabela `plataforma_admins`. Ali ficam:

- **Faturamento dos clientes**: quanto cada loja faturou hoje, na semana, no mês ou em qualquer período, filtrando por setor; ranking, vendas por dia/hora, por setor e por forma de pagamento, detalhe por loja (mais vendidos) e exportação CSV. Leitura só por funções do banco que conferem `plataforma_admins`.
- **Lojas**: ativar plano, dia de vencimento, módulos, estender teste, suspender e cancelar.
- **Contatos (leads)**, **Cobranças** (gerar mensalidades do mês, fatura avulsa, link/código de pagamento, registrar recebimento) e **Pedidos de pacotes** (aprovar/recusar, somar na mensalidade, liberar módulos).

## Configuração comercial

Marca, WhatsApp de vendas e preços ficam em `assets/config.js` e valem para o site e o sistema.

## Estrutura

```
index.html                 site de vendas
assets/                    estilos, scripts, imagens e configuração do site
assets/config.js           marca, WhatsApp, preços e chave pública do Supabase
app/index.html             o sistema (PDV)
app/css/app.css            estilos do sistema
app/js/config.js           reexporta assets/config.js
app/js/api.js                  cliente Supabase e helpers (rpc, fn, paginação)
app/js/estado.js               sessão e permissões por nível
app/js/ui.js                   html seguro, formatação, modais, toasts
app/js/main.js                 rotas e layout
app/js/paginas/*.js            uma tela por arquivo
app/js/impressao/escpos.js     comandos ESC/POS + WebUSB/Serial
app/js/impressao/cupom.js      layout dos cupons (navegador e térmica)
supabase/migrations/*.sql  banco, RLS e regras de negócio
supabase/functions/*       Edge Functions (usuarios, fiscal, teste, pagamentos)
assets/pix.js              gerador de PIX copia e cola + QR (usado por PDV, garçom e cardápio)
app/js/mesa-detalhe.js     detalhe da mesa (compartilhado entre a tela Mesas e o app do garçom)
app/js/seletor.js          seletor de itens para mesas
app/js/cozinha.js          impressão automática de pedidos do garçom e do delivery
garcom/                    app do garçom (PWA: manifest, service worker, ícones)
cardapio/                  cardápio digital público e acompanhamento do pedido
```

## Rodar localmente

Qualquer servidor estático serve:

```bash
python3 -m http.server 8080
# abra http://localhost:8080
```

WebUSB e Web Serial exigem HTTPS (ou localhost) e Chrome/Edge.

## Publicar

É um site estático: GitHub Pages, Netlify, Vercel ou Cloudflare Pages. Depois de publicar, em
**Supabase > Authentication > URL Configuration** coloque o endereço do site em *Site URL* e em *Redirect URLs*
(necessário para os links de confirmação de e-mail e recuperação de senha).

## Banco de dados

As migrações em `supabase/migrations` já foram aplicadas no projeto. Para recriar em outro projeto,
execute-as na ordem e publique as funções:

```bash
supabase db push
supabase functions deploy usuarios
supabase functions deploy fiscal
```

## Nota fiscal (NFC-e / NF-e)

1. Conta no Focus NFe com a empresa cadastrada (mesmo CNPJ), certificado A1 e CSC da NFC-e.
2. Em **Configurações > Nota fiscal**, ative, cole os tokens e teste em homologação.
3. Revise NCM/CFOP/CSOSN dos produtos com o contador. Padrões: CFOP 5102, CSOSN 102, PIS/COFINS 49.
4. Para trocar de provedor, implemente o mesmo contrato em `supabase/functions/fiscal/index.ts`.

> A informação de tributos aproximados (Lei 12.741/IBPT) ainda não é calculada; alguns estados exigem no DANFE.

## Mesas, garçom e delivery: segurança

- Garçons (nível Atendente) só lançam itens; preços sempre vêm do cadastro (`adicionar_itens`). Tirar item lançado há mais de 5 minutos exige gerente e fica no registro de atividades.
- O cardápio público não lê tabelas: usa só `cardapio_publico`, `criar_pedido_delivery` e `acompanhar_pedido` (código aleatório por pedido), com limite de pedidos por telefone e por loja.
- O acompanhamento ao vivo usa um canal de broadcast por pedido; o caixa e o garçom usam Realtime com RLS.
- Se um garçom lançar itens enquanto o caixa recebe a mesma mesa, o servidor recusa o fechamento e o caixa recarrega o pedido.

## Atalhos do PDV

| Tecla | Ação |
|---|---|
| F2 | Buscar produto |
| F4 | Alterar quantidade do item selecionado |
| F6 | Desconto / acréscimo |
| F8 | Salvar pedido (mesa/comanda) |
| F9 | Receber pagamento |
| ↑ ↓ | Selecionar item |
| Del | Remover item |
| Esc | Limpar cupom |
| Alt+1…6 | Forma de pagamento (na tela de pagamento) |
