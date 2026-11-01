# Valle Pass 2027 — liberação segura do e-mail comercial

> Preparação local. **`VALE_PASS_EMAIL_MODE` continua `dry-run` em produção; nenhum e-mail real foi enviado; nada foi ativado.** Este documento descreve o mecanismo e como usá-lo **somente quando houver autorização comercial**.

## 1. Como o envio real é decidido (resumo)
Para um e-mail de voucher sair de verdade, **todas** as condições abaixo precisam valer:
1. `VALE_PASS_EMAIL_MODE=live` (padrão `off`; hoje `dry-run`).
2. `RESEND_API_KEY` presente e `VALE_PASS_EMAIL_DOMAIN_VERIFIED=true`; remetente válido.
3. **Destinatário permitido** por uma de duas vias, exclusivas:
   - **Fase de testes:** `VALE_PASS_EMAIL_ALLOWED_RECIPIENTS` (lista de até 20 endereços; só eles recebem).
   - **Liberação comercial** (compradores legítimos): `VALE_PASS_EMAIL_COMMERCIAL_RELEASE=true` **sem** lista **e** `VALE_PASS_EMAIL_COMMERCIAL_AUTH_REF` (novo, ver §2). Lista presente sempre restringe e a liberação passa a ser irrelevante.
4. Em cada mensagem, no momento do envio: pedido ainda pago e não cancelado/reembolsado/excluído; unidade completa com os dois vouchers ativos; nenhum voucher bloqueado, usado ou em revisão de reembolso; endereço válido; limite diário e tamanho de lote (`DAILY_LIMIT`, `BATCH_SIZE`) respeitados.

> Correção: o documento `VALLE-PASS-2027-EMAIL-COMERCIAL-ATIVACAO.md` (PR #179), na versão anterior, dizia que não existia modo "todos os clientes" sem mudança de código. **Existe**: a liberação comercial acima já estava no código. A versão corrigida está neste mesmo conjunto de PRs.

## 2. O que esta mudança acrescenta (antes de qualquer liberação)
| Proteção | Comportamento | Por quê |
|---|---|---|
| **Referência da autorização** (`VALE_PASS_EMAIL_COMMERCIAL_AUTH_REF`, 8–120 caracteres: letras, números e `._:- `; sem `@`) | A liberação sem lista **só vale com a referência**; sem ela, o envio real continua bloqueado (`liveBlockers`) e o painel mostra o motivo. A referência aparece no status (não é segredo). | A liberação deixa de ser um único `true` esquecido: exige um identificador interno da aprovação (ex.: código da decisão do Anderson). **Não coloque nome ou e-mail de pessoa.** |
| **Supressão de endereço** | Se o provedor já informou *bounce*, *complaint* ou *suppressed* para o endereço, novas mensagens para ele vão a `NEEDS_ATTENTION` (`recipient_suppressed`) e **não** chamam o provedor. Falha genérica (`email.failed`) não suprime. Comparação sem diferenciar maiúsculas. | Proteger a reputação do domínio; uma pessoa decide (corrigir o endereço, reenviar de outro modo). |
| **Campanha de teste × comprador** | Sem lista (liberação comercial), mensagem de campanha **de teste** vai a `NEEDS_ATTENTION` (`test_campaign_needs_allowlist`). Com lista, o teste continua funcionando. | Vouchers de teste nunca chegam a um comprador por engano. |

**Preservado (com testes):** dry-run não chama o provedor; idempotência (duas rodadas enviam uma vez; mesma chave nas retentativas); outbox com `SENDING` antes da chamada; reservas, limite diário e lote; cancelamento/reembolso antes do envio; bloqueios por voucher bloqueado/usado/em revisão.

## 3. Como seria a ativação (NÃO executar sem "AUTORIZO" e sem as pendências)
1. Pré-requisitos comerciais: termos aprovados e publicados, texto do e-mail aprovado (sem 10% sem regras), DMARC publicado, plano da Resend compatível com o volume do lote.
2. `VALE_PASS_EMAIL_COMMERCIAL_AUTH_REF=<código da aprovação>` e `VALE_PASS_EMAIL_COMMERCIAL_RELEASE=true`, remover `VALE_PASS_EMAIL_ALLOWED_RECIPIENTS`, `VALE_PASS_EMAIL_DOMAIN_VERIFIED=true`.
3. Primeiro, **janela curta** em `live` com um pedido real de baixo valor (como o #1015); conferir um e-mail por unidade, dois vouchers, status `ACCEPTED/DELIVERED`.
4. Ajustar `DAILY_LIMIT`/`BATCH_SIZE` ao Lote 1 (padrão 80/dia e lote 10; 100 vendas no mesmo dia excedem 80).
5. Monitorar `EMAIL_FAILED`, `EMAIL_OVERDUE`, `EMAIL_QUEUE_BLOCKED` e `recipient_suppressed`.
Reversão imediata: `VALE_PASS_EMAIL_MODE=dry-run` (`variable set`, que redeploya). A fila é preservada.

## 4. Limites do que foi feito
- Não verificado: entregabilidade real, reputação do domínio, limite do plano da Resend, webhook da Resend (segredo/endpoint) — nada foi enviado nesta missão.
- A supressão só conhece o que o webhook da Resend informou; endereço que nunca devolveu mas é inválido para o provedor só falha na primeira tentativa.
- Quem pode **trocar o destinatário** num reenvio segue regra existente (ADMIN com validação); restringir a SUPER_ADMIN é decisão pendente.

## 5. Decisões pendentes (Anderson / jurídico)
- Autorizar formalmente o envio aos compradores e definir a **referência** da autorização.
- Texto final do e-mail (paleta, menção aos 10% e link de termos só depois de aprovados).
- Política de reenvio e de troca de destinatário.
- Base legal/LGPD do envio e retenção dos dados do comprador (jurídico).
