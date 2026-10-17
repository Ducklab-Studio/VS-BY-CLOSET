# Valle Pass — auditoria de prontidão comercial (17/10/2026)

Auditoria **somente leitura**: código do repositório (`main` em `8f38dab`), consultas `SELECT` em transação `READ ONLY` no Neon,
consultas de leitura à Admin/Storefront API da Shopify, páginas públicas e o checkout aberto no navegador (sem preencher nada,
sem comprar). Nenhuma compra, pedido, preço, produto, estoque, migration ou dado foi alterado. Nenhum dado pessoal foi lido ou
registrado aqui. **Confirmado** = visto no código/dados/páginas; **Hipótese** = precisa de teste.

## 1. Resposta curta

**Parecer: BLOQUEADO para lançamento comercial aberto; PRONTO COM RESSALVAS para uma primeira venda controlada.**
O cliente consegue chegar ao checkout e pagar (R$ 350,00, cartão ou Pix) e a plataforma sabe registrar e identificar a venda — mas
o que o sistema vai *entregar* depois do pagamento (valor do crédito, validade, limite de vendas, código ao cliente) ainda é
configuração de teste e não bate com a oferta divulgada. Os bloqueios P0 são de **configuração e decisão comercial**, não de
código de pagamento, e têm caminho curto (seção 5).

## 2. O que está funcionando (confirmado)

| Item | Evidência |
| --- | --- |
| Produto no ar | Shopify: `Valle Pass`, produto `8723909804132`, variante única `49174518595684`, SKU `01`, `ACTIVE`, **R$ 350,00 BRL**, `requiresShipping = false`, `taxable`, impostos incluídos |
| Publicação | Vitrine headless lista o produto; página `vsbycloset.myshopify.com/products/vs-xxx-001` responde 200 (sem senha); a Admin API não tem o escopo `read_publications`, então a lista de canais não foi lida |
| Compra direta | `/pecas/vs-xxx-001` → botão "Comprar Valle Pass" → `…/cart/49174518595684:1` → checkout Shopify com **1 item, R$ 350,00, sem frete, Cartão de crédito (com parcelas) e Pix**. Aberto também em 375×812: sem rolagem horizontal, formulário legível |
| Separado do aluguel | `lib/cart.ts` recusa Valle Pass em reserva; webhook identifica por produto/variante/campanha (`valePassUnits`); tabela própria `vale_pass_orders`; `catalog-variants` não lista a variante |
| Pipeline pós-pagamento | Registro desde `orders/create`; vale só com `paid`; idempotente (`vouchers_processed_at`, código único, pedido único); fora de ordem, cancelado, reembolsado, excluído e reconciliação a cada 10 min (log do Railway confirma o agendador ativo) |
| Dados sãos | 7 pedidos de teste (#1001–#1007), 1 vale emitido (#1002, depois cancelado); **0 divergências** pedido×vale, 0 códigos duplicados, 0 vale sem pedido; 34 migrations aplicadas |
| Saúde | `/health` 200; API sem `ERROR`/`WARN` no log do deploy atual; CI verde |

Limite do que foi provado: o **único** pagamento de Valle Pass já registrado é o #1002 (14/09, teste). Desde então a loja trocou
de token (Headless) e de meio de pagamento (Mercado Pago/Pix). O caminho "pago → webhook → vale" com a configuração **atual**
nunca foi exercitado por um Valle Pass (o Pix foi validado com uma reserva de aluguel, #1012).

## 3. Problemas

### P0 — impedem vender com segurança

| # | Problema | Evidência | Impacto | Solução | Risco | Teste | Depende de |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0-1 | **Estoque 499 para uma meta de 1.000** (confirmado) | Admin API: `totalInventory = 499`, `tracksInventory`, política `DENY` | Após 499 vendas o botão vira "esgotado"; 501 passes não vendáveis | Ajustar o estoque (ou desligar o controle) no painel da Shopify | Baixo | Conferir quantidade e compra de teste com estoque novo | **Anderson** (quantidade real) |
| P0-2 | **Campanha limitada a 10 vendas e sem como editar** (confirmado) | `vale_pass_campaigns.quantity_limit = 10`; `vale-pass-webhook.service.ts:192-199`: do 11º vale em diante o pedido PAGO **não recebe vale** (só log + evento); a contagem inclui vales cancelados; `ValePassCampaignsController` só tem listar/criar/ativar/desativar, e `shopify_variant_id` é único (recriar dá 409) | O 11º cliente paga R$ 350,00 e fica sem vale; a equipe só vê o pedido sem vale emitido | Endpoint + tela de **edição** da campanha (ADMIN, auditado, sem alterar vales já emitidos); depois ajustar o limite para o real | Baixo (rota de painel, não toca pagamento/webhook) | Unitário + integração; edição não muda vales existentes | **Autorização** + Anderson (limite) |
| P0-3 | **Valor do crédito e validade não aprovados e incoerentes com a oferta** (confirmado + decisão) | Campanha "Teste Valle Pass": `amount_cents = 35000`, `validity_days = 30`. A arte do produto diz "R$ 500 em crédito na Valle Showroom — pague R$ 350 e transforme em benefícios", rótulo "2027"; a descrição na Shopify lista "Valle Compras 500,00 / Valle Showroom 50,00 / 10% de desconto / Valle Experience" | Cada vale nasce com R$ 350 e **expira 30 dias depois da compra** — antes do uso previsto (2027). O cliente paga por uma oferta que o sistema não cumpre | Anderson define crédito, validade (dias ou data fixa) e benefícios; configurar a campanha (depende de P0-2) | Baixo | Vale de teste mostra os valores aprovados | **Anderson** |
| P0-4 | **Sem compra real validada com a configuração atual** (hipótese a testar) | Seção 2 | Pode haver falha só vista com dinheiro real (Pix, webhook, vale, contato) | 1 compra real de R$ 350,00 seguida de reembolso, com checklist (pedido, `paid`, vale, painel, contato) | Baixo | O próprio teste | **Autorização expressa** + titular do pagamento |

### P1 — prejudicam compra, confirmação ou experiência

| # | Problema | Evidência | Impacto | Solução | Risco | Dependência |
| --- | --- | --- | --- | --- | --- | --- |
| P1-1 | **Ninguém entrega o código/comprovante do vale ao cliente** (confirmado) | `src/vale-pass` não envia e-mail/WhatsApp; Railway não tem variáveis de provedor de mensagem; a página prometia "você recebe um código único" (**removido no Draft PR**) | O cliente paga e só recebe o e-mail padrão da Shopify; a equipe precisa avisar manualmente | Decidir: (a) equipe envia pelo painel, (b) e-mail/WhatsApp automáticos (exige provedor e texto aprovado) | Médio (novo envio) | **Anderson** + provedor |
| P1-2 | **Valor pago não é conferido** (confirmado no código; exposição depende de haver desconto) | `handleOrderPaid` emite vale com o valor da campanha, qualquer que seja o total pago; pedido de R$ 0 ou com cupom conta como `paid` | Cupom/desconto automático gera crédito integral | Confirmar que não há cupom/desconto ativo (a Admin API sem `read_discounts`) e, depois, conferir valor pago no webhook | Alto (webhook) — só com plano e autorização | Anderson (cupons) + autorização |
| P1-3 | **A variante do Valle Pass também é uma "peça" ativa do aluguel** (confirmado) | `rental_units` código `01`, nome `VS-XXX-001`, `active` e `reservable_online`, com 12 itens de reservas antigas; `/availability?shopifyVariantId=…49174518595684` responde `bookable: true` | A vitrine esconde, mas uma chamada direta à API poderia reservar/pagar essa "peça" e emitir vale junto; a peça aparece no painel de Peças | Arquivar a peça `01` no ClosetAdmin (histórico preservado) e, depois, recusar essa variante no HOLD | Baixo (arquivar) / Médio (guarda no HOLD) | Equipe (arquivar) + autorização (HOLD) |
| P1-4 | **A home não destaca o Valle Pass** (confirmado) | Hero e menu falam só de aluguel; o Valle Pass é 1 de 4 cartões "Seleção do closet", sem explicação; faixa "Reserve online · Retire no Chile" | O produto principal não aparece como principal | Seção de destaque + item de menu, com texto aprovado e mídia do Orlando | Baixo | **Anderson** (texto) + **Orlando** (19/10) |
| P1-5 | **Páginas institucionais não falam do Valle Pass** (confirmado) | Termos, FAQ, Como funciona e Trocas: 0 menções; a política de reembolso é por data de retirada (aluguel); no checkout só há link de Política de privacidade | Sem regras de uso, validade, transferência e reembolso | Redigir com o Anderson (e validação jurídica); configurar as políticas na Shopify | Baixo | **Anderson**/jurídico |
| P1-6 | **Mobile: preço e botão ficam abaixo da primeira tela** (confirmado) | 375×812: a foto ocupa a primeira tela; botão em y≈1380 (de 3119) | Menos conversão | Botão fixo/ordem preço+CTA antes da foto no mobile | Baixo | — |
| P1-7 | **Checkout pede endereço de cobrança completo e telefone é opcional** (confirmado) | Formulário do checkout (País, CEP, endereço, bairro…); "Telefone (opcional)" | Atrito para um produto sem entrega; vale sem telefone = "Sem contato" no painel | Ajustar configurações do checkout na Shopify | Baixo | Titular da loja |
| P1-8 | **Capacidade do webhook sob volume** (hipótese) | Todo webhook toma o mesmo lock global (`lockOperationalBlocks`); `products/update` roda a reconciliação de catálogo (chamadas à Admin API) dentro da mesma transação de até 15 s | Em rajada de vendas, atraso/503 e reentregas | Teste de carga local com 200 pedidos sintéticos; se confirmar, tirar a reconciliação do caminho do lock | Médio | Autorização para mexer no webhook |
| P1-9 | **Estoque de pedido Pix pendente/expirado** (hipótese) | — | Pedidos Pix não pagos podem segurar unidades do estoque | Testar com a loja: criar e deixar expirar, ver o estoque | Baixo | Autorização (pedido real) |

### P2 — refinamentos

- Descrição do produto na Shopify sem formatação ("Valle Compras 500,00 - Valle Showroom 50,00- valle by closet…") e a oferta está **escrita dentro da imagem** (não acessível, não indexável).
- URL `/pecas/vs-xxx-001`; Shopify sem título/descrição de SEO, sem tipo de produto, fornecedor "Minha loja".
- Sem `robots.txt`/`sitemap.xml` (404) e sem JSON-LD; `og:description` herda a descrição crua.
- Sem retorno ao site depois do pagamento (a página final é da Shopify).
- Campanha chamada "Teste Valle Pass"; pedidos de teste #1001–#1007 no histórico (todos excluídos na Shopify).
- Webhook `orders/cancelled` de 15/09 permanece `failed` (9 tentativas, erro antigo já corrigido).

## 4. Correções feitas (Draft PR, sem pagamento/webhook/checkout)

Somente vitrine, sem tocar em nenhum fluxo financeiro:

1. Página do Valle Pass: some o rótulo **"O aluguel"** ao lado do preço.
2. Apresentação do Valle Pass: **removidas promessas sem aprovação** ("Validade conforme a campanha vigente", "Utilizável em qualquer peça do closet", "você recebe um código único", "crédito de compra", "vale-presente"). Os benefícios passam a vir só da descrição do produto na Shopify.
3. Cartão do Valle Pass na home/listagem: "Ver Valle Pass" e categoria "Valle Pass" (em vez de "Ver peça"/"Seleção do closet").
4. Teste de guarda (`valle-pass-vitrine.test.mjs`, no CI): impede a volta das promessas, do rótulo de aluguel e de troca dos ids reais.

## 5. Plano de entrega

| Quando | O que | Quem |
| --- | --- | --- |
| **17–19/10** | Anderson decide: crédito, validade, limite, estoque, cupons, canal de entrega do código. Ajustar estoque (Shopify). Implementar **edição de campanha** (P0-2) e configurar a campanha aprovada. Arquivar a peça `01`. Mergear o Draft PR da vitrine | Anderson, equipe, eu (com autorização) |
| **19–20/10** | Receber fotos/vídeos do Orlando; integrar (seção 6); home com destaque do Valle Pass; botão fixo no mobile; textos institucionais aprovados | Orlando, eu |
| **21–24/10** | Compra real controlada + reembolso (P0-4); teste de carga do webhook (P1-8); conferência de valor pago se houver cupons (P1-2); envio do código (P1-1); testes ponta a ponta no celular | Titular da loja, eu |
| **25–27/10** | Homologação com o Anderson; correções | Anderson, eu |
| **28/10** | Entrega oficial | — |

**Ameaçam o prazo:** (1) decisões do Anderson sobre valores/validade/limite — sem elas nada de P0 fecha; (2) a compra real precisa de autorização e de alguém para pagar/reembolsar; (3) canal de envio do código (provedor externo pode levar dias); (4) mídia do Orlando só em 19/10; (5) textos de política com validação jurídica.

## 6. Onde entram as fotos e vídeos do Orlando

- **Página do Valle Pass:** a galeria lê só **imagens** do produto na Shopify (`images(first: 8)`); basta subir as fotos na mídia do produto. **Vídeo não é exibido** (precisa de ajuste no código). A arte atual do produto (com a oferta escrita na imagem) deve ser substituída por foto limpa e a oferta passar para texto.
- **Home:** hero usa `/editorial/winter-campaign.webp` (marcada "Imagem editorial ilustrativa"); o código já indica a troca por `/editorial/hero.mp4`.
- **Já pode ficar pronto antes de 19/10:** seção de destaque do Valle Pass na home com área de mídia que usa a imagem atual como reserva, item de menu, botão fixo no mobile, e o texto vindo da Shopify (sem copy nova inventada).
