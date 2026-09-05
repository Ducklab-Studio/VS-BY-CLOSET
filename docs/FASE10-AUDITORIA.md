# Fase 10 — Auditoria final (segurança, performance, observabilidade)

Registro do que foi verificado antes de declarar a Fase 10 concluída. Não é
um documento de arquitetura (ver `README.md`) nem de deploy (ver
`DEPLOYMENT.md`) — é o resultado da auditoria, para referência futura.

## Segurança

| Item | Situação verificada |
| --- | --- |
| **Autenticação ClosetAdmin** | Nome + telefone + PIN. As 4 falhas possíveis (usuário inexistente, nome não confere, inativo, PIN errado) devolvem a mesma `UnauthorizedException` genérica (`AdminAuthService.login`) — testado explicitamente (`admin-auth.service.test.ts`, teste 6). |
| **Sessões** | Token aleatório de 256 bits; só o SHA-256 dele (`token_hash`) é gravado no banco (`admin_sessions`), nunca o valor puro. TTL de 12h. Logout revoga de verdade (`revokedAt`), não só apaga cookie local. |
| **Cookies** | `HttpOnly` sempre; `Secure` quando `NODE_ENV=production`; `SameSite=Lax`. Nome do cookie e valor nunca acessíveis via JS no navegador. |
| **PIN hashes** | `scrypt` (memory-hard, apropriado para segredo curto/baixa entropia — SHA-256 seria rápido demais e viável de força-bruta offline se o banco vazasse). Formato `salt:hash`, nunca texto puro, nunca devolvido em nenhuma resposta HTTP. |
| **RBAC** | `AdminRoleGuard` revalida o `adminUserId` contra a tabela `admin_users` em **toda** chamada protegida — nunca confia em um role afirmado pelo chamador. Rotas `@RequireRole('ADMIN')` (regras, bloqueios, auditoria) testadas confirmando que STAFF é recusado mesmo enviando o próprio `adminUserId` real (`admin-role.guard.test.ts`). |
| **IDOR** | Todo endpoint administrativo exige sessão válida + `adminUserId` revalidado; não há endpoint que aceite um id de outro recurso sem authorização. PDF de reserva individual usa o mesmo `getReservationDetail` já protegido — reserva inexistente devolve 404, nunca vaza dado de outra reserva. |
| **Rate limiting** | Login: `@Throttle` dedicado (5 tentativas / 60s), acima do global (`ThrottlerModule.forRoot`, 100/60s) que cobre o resto da API. |
| **CORS** | `CORS_ALLOWED_ORIGINS` explícito, fail-closed em produção (processo recusa subir sem a variável). Nunca `*`. |
| **CSRF** | Autenticação server-to-server (`apps/marketing` → `apps/reservations-api`) usa Bearer token, nunca enviado automaticamente pelo navegador — não há vetor de CSRF nesse trecho. O cookie de sessão do ClosetAdmin é `SameSite=Lax`; mutações passam por Server Actions do Next.js, que já validam `Origin`/`Host` (proteção nativa do framework). Rotas de PDF são só leitura (GET), então mesmo um CSRF hipotético não teria como exfiltrar o PDF resultante (same-origin policy). |
| **Validação de DTO** | `class-validator` + `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`) — campo não declarado é rejeitado com 400, nunca ignorado silenciosamente. |
| **Webhooks Shopify / HMAC / raw body** | Assinatura verificada sobre o corpo cru (`rawBody: true` no Nest) — nunca sobre o JSON reserializado. Testes cobrem assinatura ausente/incorreta/corpo alterado. |
| **Idempotência** | HOLD, reserva manual e webhooks têm cada um sua própria chave de idempotência (tabelas separadas de propósito — nunca compartilham espaço de chave entre canais). |
| **Capability tokens / Reservation Binding** | Nunca persistidos em texto puro; binding assinado (HMAC) recomputado sempre no servidor, nunca confiado de um valor armazenado. |
| **Secrets** | Nenhum valor de secret aparece em log (`errorCode()` só extrai código/nome do erro, nunca a mensagem completa), resposta HTTP, frontend ou bundle client-side. `ADMIN_API_TOKEN` só é lido por código marcado `server-only` — vazamento para o navegador quebraria o build, não é um risco silencioso. |
| **Erros ao cliente** | Mensagens genéricas ("Não foi possível...", "Credenciais inválidas") — nunca stack trace, nunca connection string, nunca detalhe interno. |

**Achado corrigido nesta fase**: os DTOs de query dos relatórios PDF não
declaravam `adminUserId`, e o `ValidationPipe` (`forbidNonWhitelisted`)
rejeitava a chamada com 400 antes do guard rodar — mesmo padrão que os
outros DTOs administrativos já seguem, ajustado.

## Performance

Nenhum problema real identificado — não foi feita otimização preventiva.

- Calendário: intervalo máximo de 120 dias por consulta (nunca "toda reserva
  do banco").
- Listagem de reservas: `LIMIT 300`.
- Relatório PDF por período: `LIMIT 500` linhas / 366 dias, com **recusa
  explícita** (nunca truncamento silencioso) se o período pedido exceder.
- Índices relevantes já existentes: `reservation_items(rental_unit_id, status)`,
  `reservations(status)`, `admin_sessions(admin_user_id)`,
  `admin_audit_events(admin_user_id/action/created_at)`,
  `operational_blocks(rental_unit_id)`, `operational_blocks(start_date, end_date)`.
- Nenhum padrão N+1 (loop com `await` por item) encontrado nos services
  administrativos — subqueries correlacionadas (`EXISTS`, `array_agg`) rodam
  numa única ida ao banco.

**Achado, não corrigido (fora de escopo, sem risco funcional)**: a tabela
`reservations` ainda carrega uma `EXCLUDE` constraint legada
(`reservations_no_overlap_per_sku`, Fase 1, sobre as colunas `sku`/`date_range`)
e um índice órfão (`reservations_sku_status_idx`) — nenhum dos dois é usado
por reserva nova (essas colunas são sempre nulas desde a Fase 4). A proteção
real e ativa contra double-booking é `reservation_items_no_overlap_per_unit`.
Peso morto inofensivo; não removido sem aprovação explícita, por não ser
aditivo.

## Observabilidade

- `GET /health` confirma conectividade real com o Postgres (`SELECT 1`), não
  só que o processo respondeu.
- Logs de erro sempre reduzidos ao essencial (`errorCode()`), nunca o objeto
  de erro completo — alguns drivers Postgres embutem a connection string na
  mensagem de erro.
- Falhas de webhook, conflito de correlação e erro de binding já geravam
  log estruturado desde a Fase 7 — mantido sem alteração.

## Teste operacional controlado

Executado de ponta a ponta no navegador, contra o backend real (Neon):

1. Criada uma `RentalUnit` de teste.
2. Criada uma reserva manual via wizard do ClosetAdmin.
3. Confirmada em Reservas e no Calendário, com as fases corretas
   (preparação → retirada → aluguel → devolução → limpeza).
4. Gerados os 3 PDFs (reserva individual, relatório por período, relatório
   operacional) — todos `200 OK`.
5. Reserva cancelada pelo ClosetAdmin (motivo obrigatório).
6. Calendário confirmado liberado após o cancelamento.
7. Auditoria confirmada completa (criação + cancelamento, com `adminUserId`
   e motivo).
8. Dados de teste removidos do banco ao final — nenhum dado real tocado.

Também testado com um produto real do catálogo: UX de temporada bloqueada
(ver seção abaixo) e geração de PDF a partir de dados reais.

## UX de temporada bloqueada

Achado da auditoria inicial: `AvailabilityDay.reason` já vinha calculado
pelo backend por dia, mas o componente público (`RentalCalendar.tsx`) nunca
o exibia — um mês inteiro bloqueado por temporada mostrava a mesma
mensagem genérica de "sem estoque" que uma falta pontual de peças.

Corrigido para mostrar "Reservas online indisponíveis nesta temporada..."
com CTA "Consultar em loja" quando nenhum dia do mês é reservável **e** a
temporada é (ao menos parte) do motivo. Testado contra um produto real do
catálogo: a primeira versão da condição exigia que *todos* os dias do mês
fossem exatamente por temporada, o que falhava no mês de transição (onde
antecedência mínima e temporada se sobrepõem) — corrigido para considerar
qualquer dia de temporada quando não há nenhum dia reservável no mês.
