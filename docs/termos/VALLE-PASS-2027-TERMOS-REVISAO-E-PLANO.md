# Valle Pass 2027 — Termos: revisão, matriz de divergências, auditoria do aceite e plano técnico

> **Só documentação. Nada foi publicado.** `TERMS_APPROVED` continua `false`, `VALE_PASS_TERMS_PAGE` continua desligado, estoque 0, nenhuma alteração em Shopify, banco, Railway, Vercel, variáveis ou e-mails. Nenhum arquivo de frontend foi tocado (o frontend é do Gemini).
> Estados usados, sempre distintos: **RECEBIDO** → **PROPOSTO** → **APROVADO PELO ANDERSON** → **VALIDADO JURIDICAMENTE** → **PUBLICADO**. Hoje o texto está em **RECEBIDO**, e a versão deste repositório em **PROPOSTO**.

## 1. Sobre a autorização informada
A mensagem da missão diz que o Anderson conversou com o advogado e autorizou a publicação. O documento recebido, porém, traz no cabeçalho "NÃO PUBLICADO / PENDENTE DE CONFERÊNCIA COMERCIAL E REVISÃO JURÍDICA". Não há no repositório registro dessa autorização (quem, quando, qual versão). **Tratei como informada, não comprovada.** Para promover o texto a APROVADO/VALIDADO é preciso um registro simples e rastreável: mensagem ou e-mail do Anderson e do advogado indicando a versão exata (hash do arquivo).

## 2. Resumo do documento recebido
Oito seções: (1) o programa, R$ 350,00; (2) benefícios — R$ 500 de crédito na Valle Showroom, R$ 50 na "Valle By Closet", 10% de desconto na Valle Experience; (3) vendas de 01/11/2026 a 31/05/2027 ou esgotamento; (4) validade "temporada de neve de 2027"; (5) arrependimento de 7 dias (CDC art. 49) e garantia de satisfação presencial com reembolso integral de R$ 350 em até 3 dias úteis; (6) qualquer utilização encerra o reembolso voluntário; (7) disposições gerais; (8) aceitação ("ao concluir a compra, o cliente declara...").

## 3. Matriz de divergências
Fonte "S.B" = Seção B do arquivo recebido; "DEC" = decisão já respondida registrada na missão do Valle Pass.

| # | Cláusula | Texto original | Regra complementar / conflito / lacuna | Proposta | Fonte | Quem aprova |
|---|---|---|---|---|---|---|
| 1 | cabeçalho, 2 | "Valle By Closet" | O site, os vouchers e os e-mails dizem "VS BY CLOSET". | Usar um nome só; **confirmar** a pessoa jurídica. | S.C-1 | Anderson |
| 2 | 2 | Dois créditos + 10% | Dois vouchers **independentes** e com **saldo parcial** não constam no texto. | 2.4 acrescentada. | DEC | Anderson, jurídico |
| 3 | — | (ausente) | Vouchers **intransferíveis** e conferência de nome/código/documento. | 2.5 e 2.6 acrescentadas; LGPD ao jurídico. | S.B | Anderson, jurídico |
| 4 | 2 | "10% nos passeios e serviços participantes" | Regra complementar: passeios **e transfers**, **uma utilização**, pelo **titular**, sobre o **valor final do orçamento**, aplicação **manual** com o código. | 2.7 acrescentada. | S.B, DEC | Anderson |
| 5 | 2 | (ausente) | Cumulatividade com outras promoções e uso em outro passeio se o primeiro for cancelado. | **Não incorporadas**; aguardam confirmação. | S.B | Anderson |
| 6 | 5.3(d), 6.2 | "não tenha utilizado o desconto de 10%" | **O sistema não registra o uso do desconto.** No banco é só um benefício descritivo (`DISCOUNT`); não há campo nem fluxo para marcar "usado". Hoje a verificação de 5.3(d) e 6.3 seria manual. | Decidir quem e como registra; possível mudança futura (ver §7). | código | Anderson |
| 7 | 3.1 | Vendas "terão início em 1º/11/2026" | Hoje (01/11/2026) a venda **não está aberta** (estoque 0, termos não publicados). A cláusula não pode afirmar fato ainda não ocorrido. | Confirmar a data **efetiva**; sem efeito retroativo. | S.C-8 | Anderson |
| 8 | 3.2 | "quantidade disponibilizada" | 1.000 passes em lotes de 100 não aparecem. | Opcional: informar o total. | S.B | Anderson |
| 9 | 4.1 | Validade genérica | Datas exatas 01/04–15/10/2027 decididas. | Datas acrescentadas **só na proposta**. | DEC | Anderson |
| 10 | 2, 4 | Crédito em R$ para aluguel em Santiago | **Sem regra de conversão cambial**; o sistema controla o saldo em reais. | Lacuna marcada; decisão do Anderson. | — | Anderson, jurídico |
| 11 | 5.1 | Arrependimento 7 dias | Não diz de quando corre o prazo nem trata uso parcial dentro dos 7 dias. O módulo de reembolso reage aos reembolsos feitos na Shopify e considera voucher usado como "tocado" (não cancela automaticamente). | Perguntas ao jurídico. | código, S.C-5 | Jurídico |
| 12 | 5.2–5.4 | Garantia de satisfação, 100% em 3 dias úteis | O reembolso é decidido e executado **na Shopify**; o sistema só observa e retém. "Processado em até 3 dias úteis" é compromisso de **processar**, não de liquidar (o texto já ressalva a operadora). Compatível com o plano de retenções (Anderson). | Manter; ao jurídico confirmar a formulação. | S.C-7 | Jurídico |
| 13 | 6 | Qualquer uso encerra o reembolso voluntário | Coerente com a decisão (S.B). Já refletido no sistema para vouchers; **não** para o desconto (item 6). | — | S.B | — |
| 14 | 7 | Sem lei aplicável, foro, controlador de dados, canais, CNPJ | Lacunas para contratação no Brasil com execução no Chile. | Marcadas; ao jurídico. | S.C-5 | Jurídico, Anderson |
| 15 | 8 | "Ao concluir a compra, o cliente declara..." | **Texto declarando aceite não prova clique nem consentimento.** O checkout é o nativo da Shopify, sem passo de aceite hoje. | Mecanismo de aceite (§6). | S.C-4 | Anderson, jurídico |
| 16 | — | Abertura imediata comunicada pelo Anderson | Não equivale a autorização técnica: faltam termos aprovados, aceite funcionando, parecer jurídico. | Checklist (§9). | S.B | Anderson |

## 4. Situação atual da publicação
- A página `/termos-valle-pass` **responde 404** enquanto `VALE_PASS_TERMS_PAGE` não for `on`; mesmo ligada, mostra só o **rascunho estruturado** (`vale-pass-terms-draft.ts`, sem texto oficial). `TERMS_APPROVED = false`.
- O botão de compra só vira link do checkout se a venda estiver `open` **e** houver URL de termos **e** `TERMS_APPROVED === true`. Hoje nenhuma das três condições vale.
- **Publicar o texto exige**, além da autorização expressa: levar o texto aprovado ao componente da página (trabalho do Gemini), mudar `TERMS_APPROVED`, ligar a flag e definir a URL pública. Nada disso foi feito.
- A trava real contra a compra é o **estoque 0** da variante na Shopify; o gate da vitrine não impede quem tiver o link direto do carrinho.

## 5. Estado real do aceite na Shopify
| Pergunta | Resposta |
|---|---|
| Há aceite afirmativo no fluxo do Valle Pass? | **Não.** A compra é um permalink de carrinho para o checkout nativo, sem passo de aceite. |
| O checkbox "Li e aceito" do carrinho vale para o Valle Pass? | **Não.** É do aluguel, aponta para os termos de reserva e grava na reserva. |
| O que o #182 faz? | Só **registra o que chegar** nos atributos do pedido (`ABSENT`/`DECLARED`/`MALFORMED`). Nunca bloqueia, não produz aceite. Atributos são editáveis por quem montar o link: por isso `DECLARED` nunca significa "aceito". |
| O checkout nativo da Shopify permite exigir aceite? | **NÃO VERIFICADO.** Depende do plano e da configuração da loja. A experiência pública conhecida é: personalização do checkout com caixa de aceite via extensão costuma ser restrita ao plano Plus; outras lojas dependem da configuração de termos/políticas. Confirmar no painel (leitura) e na documentação oficial antes de decidir. |
| Evidência hoje | Inexistente para o Valle Pass. |

## 6. Solução técnica recomendada
Princípio: **o aceite precisa nascer de um ato do cliente, antes da compra, ligado à versão exata do texto, e chegar ao pedido de forma que não possa ser forjada com um link montado à mão.**

**Opções**
| | Descrição | Força da prova | Custo / limite |
|---|---|---|---|
| A | Aceite no **nosso site**, antes do redirecionamento; o backend emite um **token assinado** (versão, hash do texto, hora, nonce) que vai nos atributos do carrinho; o webhook confere a assinatura. | Média-alta: prova que o servidor registrou "aceitei" para aquela versão e que o atributo não foi adulterado. **Não** prova quem clicou. | Sem migration; precisa do frontend; quem usar o link direto da Shopify fica sem token. |
| B | Caixa de aceite **dentro do checkout da Shopify** (extensão/configuração). | Alta (registro da própria Shopify). | **Não verificado** se o plano permite; o registro fica na Shopify, não no nosso banco. |
| C | Confirmação por **e-mail após a compra**, com link para aceitar, antes de liberar os vouchers. | Alta para vincular ao e-mail do comprador. | Atrasa a liberação; conflita com o prazo de 3 dias; exige regra de reenvio. |

**Recomendação (para decisão):** **A** como mecanismo principal + política para pedidos **sem token**: pôr o pedido em **retenção** (mecanismo de retenção que já existe) até a equipe conferir, em vez de emitir ou recusar; **C** só se o jurídico exigir prova mais forte; **B** se a Shopify confirmar viabilidade. Dados mínimos: versão, hash, instante, id do pedido; **sem IP, sem agente de usuário, sem documento**. Retenção: pelo prazo que o jurídico definir (pelo menos a validade do passe mais o prazo de reclamação).

**Contrato de API proposto para o Gemini (NÃO implementado; não depende de migration)**
- `GET /public/vale-pass/terms` → `{ version, sha256, publishedAt, html }` (o texto completo aprovado; 404 enquanto `TERMS_APPROVED` falso).
- `POST /public/vale-pass/terms-acceptances` com `{ termsVersion, termsSha256, accepted: true }` → `201 { token, issuedAt, expiresAt }`.
  - 400 se `accepted !== true`; 409 se versão/hash não forem os vigentes; 404 enquanto não aprovados; limite por origem; não grava dado pessoal.
  - `token` = assinatura HMAC de `v1|version|sha256|issuedAt|nonce`; validade curta (ex.: 2 h).
- A vitrine monta o carrinho com o atributo `valle_pass_terms_token` (e os dois que o #182 já lê, só para compatibilidade). O botão **só** vira link depois do `201`.
- Webhook (backend): valida a assinatura, a validade e o **nonce não reutilizado**; grava `VERIFIED_SERVER_ISSUED` no histórico do pedido (evolução do #182), ou `ABSENT`/`INVALID`.
- Admin (somente leitura, ADMIN/SUPER_ADMIN): evidência do aceite por pedido, sem dado pessoal.

**O que o Gemini precisa implementar (frontend):** exibir o texto completo antes da compra; caixa **não pré-marcada** "Li e aceito os Termos (versão 2027-1)"; botão de compra desabilitado até marcar; chamada ao `POST` e uso do token no carrinho; mensagem de erro para 409/404; layout móvel; tela de consulta da evidência para o ClosetAdmin.

**Por que o backend não foi implementado agora:** (1) depende do **texto aprovado** (hash e versão); (2) o #182, que a evolução estende, ainda não está na `main`; (3) a escolha entre A, B e C e a política de pedido sem token são decisões do Anderson/jurídico; (4) sem o frontend o fluxo não pode ser exercitado de ponta a ponta. Fazê-lo agora geraria código sobre premissas ainda não decididas.

## 7. Funcionalidades que o sistema ainda não tem
1. Registro do **uso do desconto de 10%** (necessário para aplicar 5.3(d) e 6.3 com segurança).
2. **Aceite** (§6).
3. Regra de **conversão cambial** para o crédito em reais.
4. Texto oficial na página de termos e hash/versão do documento.
5. Política para pedido **sem** evidência de aceite (reter, alertar ou bloquear).

## 8. Perguntas ao advogado
1. Direito de arrependimento (art. 49): o prazo de 7 dias corre da compra ou do recebimento dos vouchers? Como tratar uso parcial dentro do prazo?
2. A garantia presencial de satisfação e o reembolso integral após **qualquer utilização**: validade da vedação e da redação de 6.1/6.3.
3. Lei aplicável e foro para contratação no Brasil com prestação no Chile; informações obrigatórias do fornecedor.
4. Proteção de dados: finalidade e base legal da conferência de identidade; retenção da evidência de aceite; texto de privacidade.
5. Aceite eletrônico: o mecanismo A (token assinado) é suficiente? Ou exige B/C?
6. "Processado em até 3 dias úteis" e a responsabilidade por liquidação pela operadora/Pix.
7. Intransferibilidade e presente a terceiros; o que fazer com titular divergente.
8. Conversão cambial do crédito e eventual cobrança de diferença (2.2).
9. Cláusulas dos 10%: acumulação com promoções, passeio cancelado, "uma utilização".

## 9. Checklist do que impede a publicação
- [ ] Registro rastreável da aprovação do Anderson e do parecer do jurídico para a **versão exata** (hash).
- [ ] Respostas às lacunas marcadas ⟦CONFIRMAR⟧/⟦LACUNA⟧ da proposta (nome da empresa, câmbio, 10%, data de início, identificação do fornecedor).
- [ ] Mecanismo de aceite decidido (A/B/C) e política para pedido sem evidência.
- [ ] Frontend (Gemini): página de termos com o texto aprovado, caixa de aceite, estados de erro, mobile.
- [ ] Backend do aceite (após a decisão) com testes; #182 integrado e evoluído.
- [ ] Verificação, no painel da Shopify, do que o checkout permite.
- [ ] `TERMS_APPROVED`, `VALE_PASS_TERMS_PAGE` e a URL pública alterados **somente** com autorização expressa.
- [ ] Descrição do produto na Shopify sem a promessa de 10% sem condições (hoje fora do repositório).
- [ ] Teste de compra de baixo valor com o aceite funcionando, antes de abrir lote.

## 10. Quais PRs se relacionam diretamente aos termos
- **#182** (evidência de aceite): relaciona-se diretamente; é a base que o plano estende. Continua separado.
- **#179** (docs de e-mail, termos, runbook, plano de lançamento): relaciona-se; contém a auditoria `VALLE-PASS-2027-TERMOS-AUDITORIA.md` e o plano de lançamento.
- **#180** (encerramento de vendas, 31/05/2027): relaciona-se à cláusula 3.2, mas é funcionalidade distinta.
- **#181** (e-mail comercial): relaciona-se só porque o e-mail deve apontar para os termos aprovados; independente.
Este PR é **só documentação** e não toca nenhum deles.

## 11. Testes
Não há código novo, então não há testes novos. Os testes do aceite (acesso ao texto, versão, ausência de pré-marcação, bloqueio sem aceite, vínculo ao pedido, impossibilidade de aceite fictício, privacidade, mobile) foram especificados no §6 e só podem ser escritos depois das decisões e do frontend.

## 12. Veredito
**NO-GO para publicar os termos e abrir vendas agora.** **GO para continuar a preparação** com este pacote. Motivos: texto ainda RECEBIDO/PROPOSTO; autorização do advogado não registrada; o aceite afirmativo não existe; o sistema não registra o uso dos 10%; câmbio e identificação do fornecedor em aberto.
