# Valle Pass 2027 — auditoria do aceite e dos termos (Fase G)

> Só leitura. **Nenhum texto jurídico foi escrito ou publicado; `TERMS_APPROVED` continua falso e não foi alterado.** Nada do checkout real foi modificado.

## 1. O que o código faz hoje
| Pergunta | Resposta (com evidência) |
|---|---|
| A página de termos do Valle Pass é pública? | **Não.** `/termos-valle-pass` responde 404 até `VALE_PASS_TERMS_PAGE=on`; enquanto `TERMS_APPROVED` for falso, mostra apenas aviso de rascunho (`vale-pass-terms-draft.ts`). |
| Há trava de compra ligada aos termos? | **Sim, na vitrine:** `valePassPageGate` só torna o Valle Pass comprável se a venda estiver `open` **e** houver `termsHref` **e** `TERMS_APPROVED === true` (`lib/vale-pass-offer.ts`). A página também fica `noindex` sem isso. |
| Essa trava impede a compra na Shopify? | **Não.** Vale para o botão da vitrine. Quem tiver link direto/permalink do carrinho depende do **estoque da variante (0, DENY)**, que é a trava real. |
| O aceite no checkout é obrigatório? | O carrinho da vitrine exige a caixa "Li e aceito os termos de uso **da reserva**" (aluguel), com bloqueio no cliente e no servidor. Ela aponta para `/termos-de-uso` (termos da reserva), **não** para os termos do Valle Pass. |
| O aceite é registrado? | Para **reservas**: sim, `termsAcceptedAt` e `termsVersion` na reserva (e `terms_version` nos metadados do checkout). Para **Valle Pass**: **não existe registro de aceite no banco** (nenhuma coluna/tabela). |
| Há vínculo do aceite ao pedido do Valle Pass? | **Não.** |
| A versão dos termos é identificável? | Para reservas, `termsVersion`. Para Valle Pass não há versão: o texto ainda é rascunho. |
| Alteração posterior dos termos altera o aceito retroativamente? | Não há texto aceito a proteger ainda. Para o Valle Pass seria preciso registrar versão + data de aceite por pedido para poder provar o que foi aceito. |
| O checkout nativo da Shopify oferece a garantia? | **NÃO VERIFICADO.** Depende da configuração da loja (exigir aceite no checkout) e do plano; sem acesso de leitura a essa configuração nesta missão. Mesmo ativado, a Shopify registra o aceite na Shopify, não no nosso banco. |
| Há risco de publicidade dos 10% sem condições? | **Sim, enquanto a descrição do produto na Shopify citar os 10%** (registrado no runbook de homologação). O site público já usa apenas o texto aprovado (`VALE_PASS_PUBLIC_DESCRIPTION`) para título/OG; a descrição editável da Shopify não é controlada por este repositório. |

## 2. Estratégia de versionamento proposta (NÃO implementada)
Só faz sentido depois de o texto existir. Esboço para revisão:
1. Constante `VALE_PASS_TERMS_VERSION` (ex.: `2027-1`) vinculada ao texto aprovado; qualquer mudança de conteúdo exige nova versão e preserva a anterior (arquivo/arquivo-histórico), nunca sobrescreve.
2. Registrar por pedido (atributo do carrinho/nota do pedido na Shopify e linha local em `vale_pass_orders` ou tabela própria): versão, data/hora do aceite e identificador do pedido. O registro do que chegar no pedido dispensa migration (ver PR do aceite, `VALLE-PASS-2027-ACEITE-TERMOS.md`); produzir o aceite exige mudança no carrinho/checkout: decisão e autorização separadas.
3. Teste de regressão: pedido sem versão aceita não emite voucher *comercial* (decisão do Anderson: bloquear ou apenas alertar).
Não implementado: criaria schema e fluxo de checkout sobre texto que ainda não existe e dependeria de decisão jurídica sobre o que provar.

## 3. Decisões necessárias (sem repetir o que já foi respondido)
**Anderson:** texto dos termos; benefício de 10% (as 10 regras do PR #166); regras de uso do saldo parcial após cancelamento; prazo/forma de aviso de retenções (canal); substituto do Anderson; permissão de STAFF; critério de conferência de identidade no resgate; titular ausente.
**Jurídico:** validade da regra de reembolso integral em 3 dias úteis e dos 7 dias (CDC art. 49) para compra online; reembolso quando já houve uso parcial; intransferibilidade e presente a terceiros; prazo de validade dos vouchers e prorrogação; tratamento de dados pessoais (LGPD) no resgate e no e-mail; cláusulas sobre os 10% manuais.
**Já respondido (não perguntar de novo):** preço R$ 350; 1.000 passes; lotes de 100; encerramento 31/05/2027 ou esgotamento; validade 01/04–15/10/2027; dois vouchers R$ 500/R$ 50 independentes e intransferíveis; 10% manual sobre o valor final do orçamento, sem cupom nem saldo; Anderson responsável pelas retenções.
