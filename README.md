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
- **Níveis de acesso**: Administrador, Gerente, Caixa, Atendente (garçom) e Cozinha.
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

## Gestão para o dono

- **Compras › Entrada de nota (XML)**: lê o XML da NF-e do fornecedor, reconhece os produtos (código de barras ou "de-para" do fornecedor, aprendido na primeira nota), converte caixa/fardo em unidades, atualiza custo (com frete, IPI e ST rateados), mostra a nova margem e sugere preço, cria produtos novos, registra lotes com validade e lança as parcelas em contas a pagar. Nunca lança a mesma nota duas vezes.
- **Compras › Sugestão de compra / Curva ABC / Parados**: quanto comprar de cada produto (média de venda × dias de cobertura + mínimo − estoque), agrupado por fornecedor com pedido pronto para WhatsApp; produtos classe A/B/C; dinheiro parado na prateleira.
- **Fiado**: crediário vira dívida do cliente com prazo e limite (o caixa não passa do limite; gerente libera), extrato, recebimento (dinheiro entra no caixa), recibo, cobrança pelo WhatsApp com PIX copia e cola e ajuste de saldo antigo.
- **Financeiro**: lucro real (faturamento − custo dos itens no dia da venda − taxas da maquininha − perdas − despesas), fluxo de caixa dia a dia, contas a pagar (com repetição mensal), conferência de PIX/cartão (digitando os totais ou importando o extrato OFX/CSV, PIX a PIX) e taxas por forma de pagamento.
- **Alertas**: antifraude por operador comparado com a média da loja (cancelamentos, descontos, itens tirados de comanda, gaveta aberta sem venda, faltas de caixa recorrentes, venda em dinheiro cancelada logo depois) e **resumo do dia por e-mail** no horário escolhido.
- **Validade e perdas**: lotes com validade (as vendas consomem primeiro o que vence antes), painel do que está vencendo, baixa como perda e relatório de perdas por motivo e produto.
- **Promoções**: leve X pague Y, preço/percentual por dia e horário, atacado a partir de X unidades e combos. O PDV aplica sozinho (também offline) e o servidor confere com a mesma regra (`app/js/promocoes-calc.js` ↔ `private.calcular_promocoes`).

### Resumo diário por e-mail (configuração única)

1. Execute `supabase/migrations/011_gestao.sql` e `012_agendar_resumo.sql` (pg_cron chama a função de hora em hora).
2. Crie uma conta no [Resend](https://resend.com), verifique o domínio do remetente e, em **Supabase › Edge Functions › Secrets**, cadastre `RESEND_API_KEY` e `RESEND_FROM` (ex.: `Lis PDV <resumo@seudominio.com.br>`).
3. A função `resumo-diario` já está publicada. Cada loja liga o envio em **Alertas › Resumo do dia**.

## Restaurante: cozinha, garçons, taxa de serviço e couvert

- **Cozinha com aprovação** (menu **Cozinha**): o garçom lança pelo app → o pedido fica *aguardando aprovação* → quem está no caixa (admin, gerente ou caixa) aprova ou recusa → a tela da cozinha mostra **Na fila → Preparando → Pronto** com tempo de preparo (cores pela meta em minutos), som, tela cheia e tela sempre acesa → o garçom é avisado no celular (som, vibração e notificação) e marca **Servido**. Recusar tira os itens da conta. O que o caixa/gerente lança já vai aprovado. Pagar a conta no caixa aprova o que ainda estava aguardando. Pedidos do delivery aceitos também entram na cozinha (marcar *pronto* na cozinha atualiza o acompanhamento do cliente).
- **Aviso de aprovação em qualquer tela** para quem aprova (contador no menu e botão flutuante). A aprovação pode ser desligada em Configurações › Restaurante.
- **Nível de acesso “Cozinha”**: usuário que só vê a tela da cozinha (para a TV/tablet da cozinha). Categorias que não precisam de preparo (ex.: bebidas em lata) podem ficar fora da cozinha.
- **Transferências**: mesa inteira (muda de lugar ou junta contas) ou **só alguns itens, com quantidade parcial**, para outra mesa, uma comanda aberta ou uma comanda nova. Comandas abertas aparecem na tela Mesas e usam o mesmo painel. Tudo fica no registro de atividades.
- **Tempo de ocupação visual**: barra e cor em cada mesa (verde, amarelo, vermelho pelos limites da loja), “conta pedida há X min”, alerta de mesa **parada sem pedir**, selos de pedido aguardando/preparando/pronto, tempo médio das mesas agora e das fechadas hoje.
- **Garçons** (menu **Garçons**; para o garçom aparece como **Meu desempenho**, também no app): vendido, mesas atendidas, ticket médio por mesa e por pessoa, tempo médio de mesa, mais vendidos, comissão do período, **projeção da comissão do mês no ritmo atual**, meta do mês com quanto falta por dia, ranking e comissão prevista das mesas abertas. O gerente vê a equipe, exporta CSV, define meta e comissão por garçom e troca o garçom responsável por uma mesa.
- **Taxa de serviço e couvert à escolha do dono** (Configurações › Restaurante): serviço *não cobrar / só sugerir na conta / cobrar na conta* com o percentual da loja; couvert por pessoa com nome próprio. O caixa (ou gerente) tira ou põe por mesa. Os valores aparecem separados na conta, no cupom e nos relatórios do garçom. A comissão pode ser sobre o consumo ou sobre a taxa de serviço arrecadada.
- Banco: `013_papel_cozinha.sql` e `014_restaurante.sql` (tabelas `cozinha_pedidos` e `garcom_metas`; colunas `garcom_id`, `servico_pct`, `couvert_unit`, `taxa_servico`, `couvert` em vendas; funções `cozinha_*`, `transferir_pedido`, `definir_taxas_mesa`, `trocar_garcom`, `garcom_desempenho`, `garcons_equipe`, `salvar_meta_garcom`, `salvar_config_restaurante`).

- **Fechar conta pelo app do garçom** (PIX e cartão sem TEF): na mesa, *Fechar conta* mostra consumo, serviço, couvert e total; divide o valor (÷2, ÷3… ou por pessoa) e cobra em partes. PIX mostra o QR com o valor exato (chave da loja ou cobrança automática do Mercado Pago, que confirma sozinha); débito/crédito é passado na maquininha e o garçom confirma "Aprovado", com NSU opcional para conferência. Os pagamentos ficam guardados no celular até a conta fechar e o reenvio nunca cobra duas vezes. Ao fechar, o servidor confere o total, aplica as promoções, baixa o estoque, libera a mesa e lança tudo no **caixa principal** (escolhido em Configurações › Restaurante, ou o caixa aberto há mais tempo). O caixa recebe aviso na hora, pode imprimir o cupom sozinho (Configurações › Impressora) e vê a lista "Fechadas pelos garçons no app" com NSU na tela Caixa; o valor entra no resumo e no fechamento por forma de pagamento. Com NFC-e ativa, o app emite a nota e mostra o QR ao cliente. Dinheiro continua no caixa. O garçom pode tirar a taxa de serviço a pedido do cliente; pôr a taxa ou mexer no couvert, só o caixa/gerente.

- **Login do garçom por matrícula ou CPF + senha numérica** (6 a 12 números, sem sequência ou repetição). O celular é vinculado à loja uma vez pelo QR de Mesas › App do garçom (leva o código da loja); depois o garçom digita só matrícula/CPF e senha. A senha é guardada com bcrypt; 5 erros bloqueiam por 15 minutos (o gerente libera em Usuários). O garçom pode ser criado sem e-mail e troca a própria senha no app. Quem tem e-mail continua podendo entrar por e-mail.
- **Meu turno** (app do garçom e "Meu desempenho" no sistema): quanto recebeu no app no dia por PIX, débito e crédito (com NSU de cada conta), comissão do dia, taxa de serviço arrecadada nas suas mesas, comissão prevista das mesas abertas e **conferência com a maquininha**: ele digita os totais do relatório, vê na hora o que bateu ou a diferença e registra o fechamento do turno (o gerente vê em Garçons › Desempenho individual).
- **Garçons › Ao vivo** (administrador/gerente): um boneco por garçom com anel e % da meta (dia, semana ou mês; sem meta, em relação ao líder), expressão do boneco conforme o desempenho, medalhas do 1º ao 3º, quanto está em mesa agora, hoje, na semana e no mês, mesas abertas, contas pedidas, pedidos prontos, último pedido, e o **mapa do salão com a cor do garçom em cada mesa**. Atualiza em tempo real e tem modo tela cheia.

### Ativar (configuração única)

1. No Supabase › SQL Editor, rode `013_papel_cozinha.sql` **sozinho**, depois `014_restaurante.sql`, `015_garcom_fecha_conta.sql` e `016_garcom_acesso_turno.sql` (o novo nível precisa existir antes).
2. Republique as funções: `supabase functions deploy usuarios` (nível Cozinha e garçom sem e-mail), `fiscal` (NFC-e emitida pelo garçom), `pagamentos` (PIX automático no app do garçom) e a nova `supabase functions deploy garcom-login --no-verify-jwt` (login por matrícula/CPF).
3. Em **Configurações › Restaurante** escolha serviço, couvert, comissão, meta padrão, aprovação da cozinha e tempos.
4. Crie os garçons com o nível **Atendente / garçom** e, se quiser, um usuário **Cozinha** para a tela da cozinha.

## Sem internet, queda de energia e troca de aparelho

- **Queda de energia / bateria**: o cupom em andamento (itens **e pagamentos já recebidos**) é gravado no aparelho a cada toque. Ao religar, a venda volta exatamente como estava. Nada é estornado.
- **Sem internet**: o sistema abre e vende com a cópia local (service worker `app/sw.js`, catálogo e sessão guardados). Vendas concluídas offline entram numa fila e são enviadas sozinhas quando a conexão volta, com a data/hora real. Um aviso na tela mostra "Sem internet · N vendas aguardando envio". PIX estático continua funcionando (o QR é gerado no aparelho; o celular do cliente usa a internet dele). Abrir/fechar caixa e NFC-e precisam de conexão (a NFC-e é emitida no envio).
- **Nunca duplica**: cada venda tem um `id_local`. Reenviar (fila, energia caiu no meio do envio, outro aparelho concluindo a mesma venda) devolve a venda já registrada.
- **Pane no computador do caixa**: com internet, a venda em andamento também fica no servidor. Em outro computador, tablet ou celular, entre com o mesmo usuário e abra **Vender**: aparece "Venda em andamento em outro aparelho" → **Continuar aqui** (também em **Pedidos**). O aparelho antigo, se voltar, é avisado e começa um cupom novo.
- O caixa só fecha depois que as vendas offline daquele operador forem enviadas.
- Banco: `supabase/migrations/010_contingencia.sql` (colunas `id_local`/`offline` em vendas, tabela `vendas_rascunho`, funções `salvar_rascunho`, `assumir_rascunho`, `descartar_rascunho` e `registrar_venda` idempotente).

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
app/js/promocoes-calc.js       regra das promoções (espelho do SQL)
app/js/gestao-ui.js            período, abas, CSV e WhatsApp das telas de gestão
app/js/contingencia.js         modo offline, fila de vendas e venda em andamento entre aparelhos
app/sw.js                      service worker do sistema (abre sem internet)
app/js/impressao/escpos.js     comandos ESC/POS + WebUSB/Serial
app/js/impressao/cupom.js      layout dos cupons (navegador e térmica)
supabase/migrations/*.sql  banco, RLS e regras de negócio
supabase/functions/*       Edge Functions (usuarios, fiscal, teste, pagamentos, resumo-diario)
assets/pix.js              gerador de PIX copia e cola + QR (usado por PDV, garçom e cardápio)
app/js/mesa-detalhe.js     detalhe da mesa (compartilhado entre a tela Mesas e o app do garçom)
app/js/seletor.js          seletor de itens para mesas
app/js/cozinha.js          impressão automática de pedidos do garçom (após aprovação) e do delivery
app/js/restaurante.js      tempo de ocupação, selos da cozinha, taxa de serviço e couvert
app/js/aprovacoes.js       aviso e aprovação dos pedidos do garçom (caixa/gerente)
app/js/desempenho.js       painel de desempenho e comissão do garçom (sistema e app)
app/js/paginas/cozinha.js  tela da cozinha (KDS)
app/js/paginas/garcons.js  equipe, metas e comissões
app/js/fechar-conta.js     cobrança da mesa no app do garçom (PIX e cartão) direto no caixa principal
app/js/recebimentos.js     aviso no caixa principal quando o garçom fecha uma conta
app/js/turno.js            "Meu turno" do garçom: recebimentos, comissão e conferência
app/js/painel-garcons.js   painel ao vivo dos garçons (bonecos, % da meta, mapa do salão)
app/js/dispositivos.js     acesso vinculado ao aparelho: verificação, tela de bloqueio e gestão
app/js/diagnostico/        caixa-preta (registro.js), catálogo de problemas e soluções (catalogo.js),
                           check-up (checagens.js), painel (painel.js), relatório (relatorio.js), envio ao servidor (envio.js)
garcom/                    app do garçom (PWA: manifest, service worker, ícones)
cardapio/                  cardápio digital público e acompanhamento do pedido
```

## Diagnóstico (quando der problema)

Uma "caixa-preta" grava tudo o que dá errado em cada aparelho — com o passo a passo do que a pessoa fez antes — e um painel explica o problema e a solução.

- **Abrir:** `Ctrl+Shift+D` (ou `Ctrl+Alt+D`) em qualquer tela, inclusive no login; menu **Diagnóstico** (admin/gerente); 5 toques rápidos na logo (celular/tablet); ou o botão **Entender** que aparece em todo aviso de erro. Se o sistema não abrir, o painel abre sozinho.
- **Check-up agora:** semáforo geral e testes de internet (latência), servidor, sessão, relógio do aparelho, migrações aplicadas (diz qual `.sql` falta), assinatura, caixa, vendas offline, armazenamento, versão/cache, bibliotecas, impressora, balança, Edge Functions e Realtime.
- **Problemas:** erros agrupados pela causa. Cada um abre um cartão com: o que aconteceu (em linguagem simples), o que para, causas prováveis, passos para o operador, passos para o suporte, comando SQL pronto, botões que resolvem (limpar cache, renovar sessão, liberar espaço, ver vendas pendentes…), trecho do código com a linha do erro e a trilha de cliques.
- **Linha do tempo:** tudo o que aconteceu, com filtros e busca.
- **Lojas (remoto):** com a migração `017_diagnostico.sql`, os erros dos aparelhos chegam ao servidor; o fornecedor vê todas as lojas e o gerente a própria — dá para saber o problema antes de ir ao cliente.
- **Relatório:** "Gerar relatório" cria um `.html` único (abre offline) para o cliente mandar pelo WhatsApp; "Copiar resumo" gera o texto curto.
- **Velocidade da internet:** mede resposta (ping), variação, perda, download e upload contra um servidor neutro (Cloudflare) e depois o servidor do sistema. A conclusão diz se a lentidão é **da internet da loja** ou **do sistema**, com o que fazer. Guarda os últimos testes do aparelho e entra no relatório. Se o Cloudflare estiver bloqueado na rede, o download usa o manual em PDF do próprio site.
- **Guia de problemas:** todos os problemas que o sistema reconhece, para treinar a equipe.
- Nada de senha, token ou cartão é gravado. A fila de vendas offline nunca é apagada pelas ações do painel.
- Ensinar um problema novo: acrescente uma entrada em `app/js/diagnostico/catalogo.js`. Nova migração: acrescente as funções/tabelas em `app/js/diagnostico/mapa-banco.js`. Ao publicar, aumente `VERSAO_APP` em `registro.js` e `VERSAO` em `app/sw.js`/`garcom/sw.js`.
- Banco: rode `supabase/migrations/017_diagnostico.sql` no SQL Editor (tabela `diagnostico_eventos`, funções `diagnostico_registrar`, `diagnostico_recentes`, `diagnostico_servidor`). Sem ela, o painel funciona igual, só não recebe os erros das lojas nem confere relógio/migrações.

## Acesso vinculado ao aparelho (antifraude de licença)

Cada usuário só usa o sistema nos aparelhos liberados para ele. Assim a loja não consegue usar um único acesso de caixa em vários computadores.

- **Limite por nível (padrão):** administrador 2, gerente 2, caixa 1, cozinha 1, atendente/garçom livre (usa vários celulares). Só o fornecedor muda, por loja, em **Plataforma › Lojas › Aparelhos** (também liga/desliga o vínculo e define as trocas por mês).
- **Primeiro acesso vincula sozinho:** ao entrar num aparelho novo, se houver vaga, ele é vinculado e recebe uma chave secreta (o servidor guarda só o hash). Sem vaga, aparece a tela "Este aparelho não está liberado", com o código do aparelho e o que fazer.
- **Conferência no servidor:** toda venda, abertura/fechamento de caixa e movimento de caixa confere o aparelho e a chave (cabeçalhos `x-lis-aparelho`/`x-lis-token`, gatilhos no banco). Não adianta mexer só na tela.
- **Troca de aparelho:** a loja desvincula em **Usuários › Aparelhos** (ou o próprio gerente/administrador na tela de bloqueio), até 3 vezes em 30 dias. Depois disso só o suporte libera. As suas desvinculações não contam.
- **Avisos de uso indevido:** tentativa em aparelho não liberado, código copiado para outro computador, mesma chave usada em dois lugares ao mesmo tempo (IPs diferentes em menos de 2 min) e navegador/tela diferentes do vinculado ficam registrados e aparecem para você e para o gerente.
- **Limite honesto:** o navegador não tem acesso ao número de série do computador. O vínculo usa um código aleatório + chave guardados no navegador + um resumo das características do aparelho. Uma pessoa técnica poderia copiar a chave para outro computador, mas isso aparece como "código copiado" ou "uso simultâneo" nos avisos. Cada navegador conta como um aparelho.
- **Ativar:** publique o site **antes** e só depois rode `supabase/migrations/018_dispositivos.sql` (os aparelhos precisam estar com a versão nova, que manda a chave, senão as vendas são recusadas). Sem a migração, o sistema funciona sem vínculo.

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
