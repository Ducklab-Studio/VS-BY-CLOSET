# Fechamento tecnico do backend - 2026-09-09

Branch local: `fix/fechamento-backend-2026-09-09`.
Base auditada: `c3ccb44bf6998f9345f7b76631318556999c816f`.
O PR #11 ja estava mesclado antes desta auditoria. As alteracoes abaixo
estao locais, sem commit, push, merge ou deploy feito por esta execucao.

## Regras e limites

- Os DTOs de HOLD, disponibilidade, rental-plan e reserva manual ja usam
  `TECHNICAL_MAX_PIECES = 50` na base do PR. O limite comercial e o
  `RentalRuleConfig.maxPieces` consultado no banco, nao o teto do DTO.
- A transacao de regra + RULE_MODIFIED tambem ja existia. Foi preservada,
  com lock da linha antes da leitura para serializar PATCHes concorrentes.
- A validacao compartilhada agora protege tanto escrita quanto leitura:
  tabela nao vazia, inteiros positivos, upTo estritamente crescente,
  cobertura de maxPieces, campos nulos/invalidos, datas MM-DD reais e fuso valido.
- Dias nao monotonicos continuam permitidos. Nenhum preco, caucao, dia extra,
  duracao comercial ou data oficial foi escolhido. Defaults existentes sao
  bootstrap/fixtures, nao confirmacao das regras oficiais do Anderson.
- PICKUP_REMINDER_ENABLED permanece false por padrao. Nenhuma API de
  WhatsApp, Meta ou e-mail foi configurada; a API inicializa sem lembretes.

## Bugs corrigidos

1. PATCHes simultaneos podiam validar contra estado antigo e combinar regras invalidas.
2. Configuracao corrompida podia passar pela leitura parcial do JSONB.
3. Disponibilidade tinha margem fixa de oito dias e ignorava bloqueios operacionais.
4. HOLD ignorava bloqueios; a data final inclusiva dos bloqueios era tratada como exclusiva.
5. Criacao/remocao de bloqueios e alteracao de pecas podiam persistir sem auditoria.
6. Locks de bloqueios nao coordenavam com alocacoes; ordem de unidades foi alinhada por ID.
7. Replay de HOLD/checkout recalculava duracao usando regras posteriores ao aceite.
8. Resposta lenta ou tentativa antiga de checkout podia sobrescrever estado/carrinho.
9. Checkout vencido podia ser reutilizado. Persistencia final agora valida prazo no Postgres.
10. Pagamento tardio podia recuperar unidade inativa ou bloqueada.
11. Webhooks de pedidos distintos para a mesma reserva podiam disputar o vinculo; cancelamento/refund antes do pagamento podiam ser perdidos.
12. Registro best-effort de falha podia rebaixar webhook ja processado por outra entrega.
13. RBAC aceitava somente identidade informada; escrita manual nao exigia sessao de usuario.
14. Relatorio PDF e contagens de pecas podiam usar fuso diferente do configurado.
15. Health confirmava somente SELECT 1, nao a presenca da EXCLUDE e do trigger de status.

## Testes e CI local

Ambiente: Windows, Node 24.14.0, pnpm 10.30.3, PostgreSQL 16.13 local
descartavel, banco `closet_audit_final_test`. Nunca foram aplicadas migrations
nem alteradas regras no Neon de producao.

| Etapa | Resultado final |
| --- | --- |
| pnpm install --frozen-lockfile | PASS, lockfile inalterado |
| API db:generate | PASS, Prisma 5.22.0 |
| API db:migrate | PASS, 16 migrations em banco vazio |
| Marketing tsc --noEmit (job quality) | PASS |
| pnpm lint (todos os workspaces) | PASS, 0 erros; 1 aviso preexistente em CartDrawer.tsx:129 |
| API typecheck | PASS |
| API test | PASS, 385 testes / 37 arquivos, 46.72 s, sem skips |
| API build | PASS |
| Next.js build | PASS, 25 paginas geradas |
| API compilada: inicializacao Nest, GET /health, rota admin sem credencial | PASS; 200 / 401; lembretes desativados |
| git diff --check | PASS |

Foram acrescentados 39 testes: 16 de validacao pura, 22 de integracao
PostgreSQL e 1 de sessao/RBAC. Cobrem limites acima de seis e abaixo do
padrao, teto 50, rejeicao pelo motor, tabela/cobertura/ordem, leitura fail
closed, PATCH concorrente, rollback, acessorios, bloqueios inclusivos,
duracao longa, snapshot, checkout lento/expirado/substituido, pagamento
tardio, webhooks fora de ordem, health e sessao revogada/expirada/alheia.
Os testes existentes de atomicidade RULE_MODIFIED e double booking continuam passando.

Falhas intermediarias nao foram ignoradas: o mock de HOLD precisou cobrir
as novas consultas; o cleanup dos novos testes precisou remover eventos
sem reservationId e restaurar a configuracao mesmo antes da limpeza.
Uma rodada teve seis falhas em cascata por essa fixture. A validacao final
foi repetida desde migrations em outro banco vazio e passou integralmente.

## Arquivos alterados

Prefixo `apps/reservations-api/`:

- `prisma/schema.prisma`
- `prisma/migrations/20260909230000_hold_plan_snapshot/migration.sql` (novo)
- `src/rental-rules/validate-rental-config.ts` (novo)
- `src/rental-rules/validate-rental-config.test.ts` (novo)
- `src/rental-rules/rental-rule-config.ts`
- `src/rental-rule-config/rental-rule-config.service.ts`
- `src/admin-panel/rules.service.ts`
- `src/admin-panel/blocks.service.ts`
- `src/admin-panel/pieces.service.ts`
- `src/admin/operational-blocks.ts`
- `src/admin/admin-role.guard.ts`
- `src/admin/admin-role.guard.test.ts`
- `src/admin-reservations/admin-reservations.controller.ts`
- `src/admin-reservations/admin-reservations.service.ts`
- `src/availability/availability.service.ts`
- `src/holds/holds.service.ts`
- `src/holds/holds.retry.test.ts`
- `src/checkout/checkout.service.ts`
- `src/webhooks/webhooks.service.ts`
- `src/webhooks/webhooks.retry.test.ts`
- `src/pdf/operational-report-pdf.service.ts`
- `src/pdf/pdf.module.ts`
- `src/pdf/admin-pdf.integration.test.ts`
- `src/app.controller.ts`
- `src/backend-audit.integration.test.ts` (novo)

Prefixo `apps/marketing/src/lib/`: `admin-api.ts`, `admin-session.ts`,
`admin-cookie.ts` (novo). Mais este relatorio. Total: 29 arquivos.

## Riscos e implantacao

- **Caminho antigo nao certificado:** `apps/shopify-app/extensions/rental-calendar`
  ainda possui maximo seis, datas/duracao locais, modo demonstracao e
  `/cart/add.js` sem HOLD. Nao foi alterado/publicado: falta confirmar se
  esta ativo em algum tema. Se estiver, esse caminho NAO esta pronto para
  producao e deve ser desativado ou migrado ao backend antes da liberacao.
- Aplicar a migration aditiva de snapshot antes de publicar a API.
  Nao reconstruimos regras historicas: reservas antigas sem snapshot usam
  suas datas efetivas gravadas como fallback, sem recalcular regras atuais.
- Publicar frontend e backend coordenadamente: rotas administrativas agora
  exigem X-Admin-Session alem do bearer privado. Integracoes antigas que
  mandam apenas adminUserId/bearer serao recusadas.
- Validar em staging Railway/Neon e confirmar regras reais com Anderson.
  A CI remota usa Linux/Node 20; esta execucao local usou Windows/Node 24.
- Shopify foi simulada nos testes de checkout. Pagamento real, entrega de
  webhooks no dominio publicado, credenciais e cookies de producao nao
  foram certificados por esta execucao.
- O aviso React Hooks preexistente em CartDrawer.tsx e a deprecacao de
  next lint no workspace legado apps/web permanecem; nao bloqueiam os comandos.

Os cenarios exercitados do core estao passando, incluindo concorrencia e
EXCLUDE real. Isso nao certifica ausencia de bugs nem libera automaticamente
producao enquanto o caminho antigo e os requisitos de implantacao acima
nao forem verificados.
