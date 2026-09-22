# Restaurar Valle Pass cancelado

## Mapeamento (antes de editar)

- **Status** (`ValePassStatus`): `ACTIVE`, `USED`, `EXPIRED`, `CANCELLED`. Nenhum status novo — a restauração devolve o vale exatamente ao que já era o status anterior ao cancelamento (`ACTIVE`), a mesma máquina de sempre.
- **`markUsed`**: `ACTIVE → USED`, `UPDATE` condicional (`WHERE status = <lido>`), seguro contra corrida.
- **`cancel`**: `ACTIVE → CANCELLED`, mesmo padrão de `UPDATE` condicional; recusa `USED` (`ConflictException`) e `CANCELLED` já cancelado (`BadRequestException`, idempotência explícita).
- **Criação** (`ValePassWebhookService.handleOrderPaid`): nasce `ACTIVE`, ligado a `shopifyOrderId`.
- **Cancelamento automático** (`handleOrderCancelledOrRefunded`, chamado por `orders/cancelled` e `refunds/create`): também grava `CANCELLED`, mas com **`cancelledBy = null`** — nunca há um `AdminUser` autor. É o sinal que distingue "cancelado por um admin" de "cancelado porque o pedido foi cancelado/reembolsado na Shopify".
- **Expiração**: lazy, `ACTIVE` com `expiresAt` no passado vira `EXPIRED` a cada leitura (`expireStale()`), nunca por cron.
- **Auditoria**: `ValePassEvent` (trilha própria do vale) + `AdminAuditEvent` (feed geral do painel, `isCritical` esconde de STAFF).

## Status correto depois de restaurar

**`ACTIVE`** — já existe, é literalmente o estado anterior ao cancelamento. Nenhum status novo foi criado.

## Regras de elegibilidade (`assertRestorable`/`restoreEligibility`)

Só restaura se, **todas** ao mesmo tempo:

1. `status === 'CANCELLED'`.
2. `usedAt` nulo (defesa em profundidade — `CANCELLED` hoje só nasce de `ACTIVE`, nunca de `USED`, mas o serviço nunca confia só no status).
3. `expiresAt` no futuro — se já expirou, a restauração é **recusada**, não "restaura e deixa expirar sozinha" na próxima leitura. Reabrir a validade de um vale vencido exige uma ação separada e explícita, que não existe aqui de propósito.
4. `cancelledBy` preenchido — cancelado por um **admin**. Se `cancelledBy` é nulo (cancelado pelo webhook `orders/cancelled`/`refunds/create`), a restauração é **sempre recusada**: o pedido foi cancelado/reembolsado de verdade na Shopify, a fonte de verdade comercial, e essa decisão nunca é revertida por aqui.
5. Nenhum **outro** vale do **mesmo pedido Shopify** foi cancelado pelo webhook (`cancelledBy` nulo) — sinal de que o pedido inteiro foi cancelado/reembolsado, mesmo que este vale específico já estivesse cancelado por um admin antes disso acontecer ("conflito com pedido existente").

## Backend

- `POST /admin/vale-pass/vouchers/:code/restore` (novo) — mesmo controller de `cancel`, exige módulo `VALLE_PASS` + role `ADMIN` (mesma sensibilidade: reabre um crédito já vendido).
- `ValePassVouchersService.restore()` — `UPDATE` condicional (`WHERE id = X AND status = 'CANCELLED'`): duplo clique ou duas abas restaurando ao mesmo tempo, só uma grava; a outra recebe `ConflictException` (409).
- **Nunca apaga histórico**: `cancelledAt`/`cancelledBy`/`cancelReason` são limpos da linha atual (ela volta a representar um vale ativo, sem resíduo) — mesmo padrão já usado em `ReservationArchiveService.restore` (`archivedAt`/`archivedBy`/`archiveReason` limpos, motivo anterior preservado no evento). O valor anterior vai para sempre no `detail` do `ValePassEvent` tipo `RESTORED` (`previousCancelledAt`/`previousCancelledBy`/`previousCancelReason`) e no `before` do `AdminAuditEvent` — o evento `CANCELLED` original nunca é apagado.
- `list()`/`findByCode()` agora também devolvem `canBeRestored`/`restoreBlockedReason` por vale — o frontend nunca decide sozinho; só mostra o que o backend já calculou (uma consulta em lote por pedidos com irmão cancelado pelo webhook, não N+1).

## Frontend (`/closetadmin/valle-pass`)

- Card cancelado com `canBeRestored=true` → botão **"Restaurar vale"**, abre `ConfirmDialog` explicando que o vale volta a ficar ativo/disponível, mostra o motivo do cancelamento original, exige motivo da restauração.
- Card cancelado com `canBeRestored=false` → mostra `restoreBlockedReason` no lugar do botão (nunca "Nenhuma ação disponível" genérico).
- Filtros rápidos novos: **"Cancelados"** e **"Restauráveis"** (recorte client-side sobre `canBeRestored`, sem parâmetro novo na API).
- Botão desabilitado durante a requisição (mesmo `ConfirmDialog` usado em cancelar/marcar usado). Lista atualiza via refetch (`onChanged()`), sem recarregar a página.

## O que nunca muda

- Vale utilizado nunca é restaurado.
- Vale expirado nunca volta a ficar válido por esta ação.
- Cancelamento vindo da Shopify (`cancelledBy` nulo) nunca é revertido por aqui.
- Nenhum evento repetido restaura automaticamente — é sempre uma ação explícita de um `ADMIN`, nunca um efeito colateral de webhook.
- Nenhum pedido, pagamento, reserva ou HOLD é criado — Valle Pass continua um domínio totalmente separado do fluxo de aluguel.

## Testes

`vale-pass-restore.service.test.ts` (Postgres local/efêmero, dados sintéticos): cancelado por admin restaura; cancelado-utilizado (defesa em profundidade) não restaura; cancelado-expirado não restaura; cancelado pelo webhook não restaura; conflito com pedido (irmão cancelado pelo webhook) não restaura; `ACTIVE` não pode ser "restaurado"; restaurações concorrentes (5 em paralelo) geram uma única alteração/evento/auditoria; duplo clique gera uma única alteração; histórico de cancelamento nunca é apagado; permissões (`ADMIN` + módulo `VALLE_PASS`, via metadados do controller); lista reflete a restauração; filtros/estados vazios por tipo de bloqueio.

Suíte completa da API: **621/621**. Frontend: typecheck, lint e build passam. Verificado ao vivo (servidores locais reais, Postgres isolado, sem Shopify real): botão, modal, restauração sem reload, filtro "Restauráveis" e estado vazio — tudo confirmado por captura de tela e leitura do DOM.
