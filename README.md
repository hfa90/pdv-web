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

## Teste grátis e antifraude

O teste dura 7 dias (até 200 vendas e 3 usuários, nota fiscal só em homologação). A loja só é criada pela Edge Function `teste`, que confere no servidor:

- CPF/CNPJ válido e nunca usado em outro teste
- WhatsApp e e-mail (normalizado: Gmail sem pontos e sem “+apelido”) nunca usados
- e-mails descartáveis bloqueados
- identificador do aparelho (navegador) nunca usado; no máximo 2 testes por IP em 30 dias
- e-mail confirmado antes de liberar

O registro dos testes (`testes_gratis`) nunca é apagado. Tentativas repetidas viram contatos marcados como “Tentou repetir o teste” no painel **Plataforma**. Ao fim do teste as vendas ficam bloqueadas no banco (gatilhos), não só na tela.

## Painel do fornecedor

O menu **Plataforma** aparece só para os e-mails da tabela `plataforma_admins`. Ali ficam os contatos captados, as lojas em teste e os clientes, com as ações ativar plano, estender teste, suspender e cancelar.

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
supabase/functions/*       Edge Functions (usuarios, fiscal)
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
