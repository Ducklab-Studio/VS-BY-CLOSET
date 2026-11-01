# Valle Pass 2027 — titular do voucher imutável (B1) e achados de B2–B4

> Preparação local. **Nada foi aplicado em Neon/produção.** A migration só foi executada em PostgreSQL local descartável. Aplicar em produção exige backup, janela e autorização expressa.

## 1. Problema (B1)
`customer_name`, `customer_email` e `customer_phone` de `vale_passes` ficavam fora do gatilho `vale_passes_immutable_fields`. Qualquer UPDATE (manual, script ou bug futuro) trocava o titular de um voucher já emitido. O titular é a base da regra de intransferibilidade confirmada pelo Anderson.

## 2. Evidência levantada (código)
- Nenhum código da API altera esses campos depois da emissão (`vale-pass-issuance.service.ts` só os grava no `create`; todos os `updateMany` de `valePass` tocam só status/uso/cancelamento).
- O **registro do pedido** (`vale_pass_orders`, outra tabela) é reescrito por webhooks posteriores (`vale-pass-order-registry.ts`: dado novo e não vazio da Shopify substitui). Isso **não** toca o voucher.
- O e-mail comercial lê o destinatário do **pedido** (`email-outbox.service.ts`), gravando `to_email` na fila no momento do enfileiramento; o reenvio reaproveita o destinatário original quando válido. Logo, uma alteração posterior do e-mail no pedido pode mudar o destino de um **novo** envio gerado depois, mas não o voucher.
- Pedido sem dados completos: o voucher nasce com campos NULL e continua válido.

## 3. Correção preparada
Migration `20261101100000_vale_pass_titular_imutavel` (`apps/reservations-api/prisma/migrations/`):
- gatilho `vale_passes_holder_guard` (BEFORE UPDATE OF as 3 colunas): valor já definido **não muda e não vira NULL**; campo vazio **pode ser preenchido uma vez**; regravar o mesmo valor é aceito;
- **não altera nenhuma linha** (sem backfill, sem DML), nem saldo, status, ledger ou voucher existente; UPDATEs que não citam as 3 colunas nem disparam o gatilho;
- reexecução segura (`CREATE OR REPLACE` + `DROP TRIGGER IF EXISTS`); aditiva (sem coluna/FK), compatível com código antigo;
- rollback: `docs/rollbacks/20261101100000_vale_pass_titular_imutavel.down.sql` (remove gatilho e função, sem tocar dados).

**Não decidido (depende do Anderson/jurídico):** qual dado prevalece num conflito (cliente corrige o e-mail depois da compra?). A migration apenas impede a reescrita silenciosa; a correção legítima de titular precisaria de um procedimento próprio e auditado, ainda não definido.

## 4. Testes (PostgreSQL local descartável `closet_ensaio_test`)
`vale-pass-holder-immutable.integration.test.ts` (12 testes): troca de nome/e-mail/telefone recusada; apagar recusado; UPDATE por SQL direto recusado; mesmo valor aceito; preencher vazio uma vez; cancelar/expirar continuam funcionando e não tocam o titular; voucher sem dados continua operável; registro do pedido segue editável sem reescrever o voucher.
Prova do teste: **sem o gatilho 8 falham; com o gatilho 12/12 passam**; migration aplicada 2 vezes sem erro.

## 5. B2 — código do voucher nas URLs (somente leitura)
- As rotas administrativas recebem o código no caminho (`/admin/vale-pass/vouchers/:code/...`), mas o navegador **nunca** chama a API diretamente: o ClosetAdmin usa server actions (POST) e a chamada ao Railway é servidor-a-servidor (`admin-data.ts`). Logo o código não aparece no histórico do navegador nem em analytics do cliente.
- O código da API não registra URL/rota (sem morgan, sem `req.url` fora de testes) e as mensagens de erro não repetem o código.
- **Não verificável daqui:** retenção de URLs nos logs HTTP da Railway/Vercel e em tracing de terceiros. Classificação: **PENDENTE (baixo risco)**. Mitigação sem quebrar contrato, se a retenção for comprovada: aceitar o código também no corpo (POST) mantendo as rotas atuais, e depois migrar o cliente. Não implementado: seria mudança contratual sem evidência de risco concreto.

## 6. B3 e B4
Ver PR dedicado (depende do #175, pois altera o mesmo controlador).
