# Ciclo operacional de reservas

Cada `reservation_item` é a fonte de verdade da etapa operacional de sua peça.
O status da reserva é apenas o progresso agregado para listagem, arquivamento e
relatórios. O trigger `reservation_status_sync` continua sincronizando mudanças
comerciais da reserva para os itens (`confirmed`, `cancelled`, `problem` etc.),
mas não sobrescreve `returned`, `cleaning` ou `completed`, porque essas etapas
acontecem peça por peça. A constraint de exclusão impede que dois itens ocupem
a mesma peça no mesmo intervalo.

| Origem | Ação | Destino | Peça ocupada? |
| --- | --- | --- | --- |
| `manual_admin/confirmed` | Cancelar | `cancelled` | Não |
| `confirmed` ou `picked_up` | Registrar devolução de uma peça | `returned` | Sim |
| `returned` | Iniciar higienização | `cleaning` | Sim |
| `cleaning` | Concluir higienização | `completed` | Não |

O recebimento físico, o início da higienização e sua conclusão são ações
separadas por peça. A operação grava estado, horário, operador e um
`ReservationEvent` com `reservationItemId`, peça, operador e timestamp na mesma
transação. Um `UPDATE` condicionado ao estado anterior decide a corrida entre
duas solicitações e entre devolução e cancelamento. A repetição de cancelamento
manual já cancelado retorna sucesso sem novo evento; a repetição de uma etapa
operacional retorna `409`.

`hold` pertence ao checkout público: sua expiração e passagem a pagamento
seguem o mecanismo de posse por token. Não existe cancelamento administrativo
seguro para esse estado. `pending_payment` também pertence ao fluxo de pedido.
O endpoint de cancelamento administrativo aceita apenas reserva manual
confirmada. Reserva online confirmada depende da situação do pedido,
reembolso e pagamento na Shopify; o painel mantém o caminho para o pedido e
não oferece um cancelamento que deixaria sistemas divergentes. Uma reserva
online confirmada pode ser recebida fisicamente pelo novo fluxo sem alterar o
pedido ou pagamento. `expired`, `returned`, `cleaning` e demais estados
incompatíveis recebem `409` ao tentar cancelar.

`completed` já existia no enum do banco, mas era legado. Agora significa
higienização concluída e liberação da unidade. A migration adiciona colunas
de horário e operador às três ações em `reservation_items`. `returned` e
`cleaning` continuam ocupantes mesmo depois do `blocked_range` planejado; a
peça só volta à disponibilidade depois de `completed`. Uma reserva com várias
peças só vira `completed` quando todas as peças estiverem `completed`.
`returned` deixou de ser arquivável porque a limpeza está pendente. O atalho
legado `onlyReturned` do arquivamento seleciona apenas `completed` para
preservar a intenção de arquivar devoluções já encerradas.

As reservas antigas com status `returned` ou `completed` não recebem horário
nem operador inventados. Registros antigos `returned` precisam de conferência
física antes que a equipe inicie ou conclua higienização; se já estavam
arquivados, precisam ser restaurados para seguir o novo fluxo. Essa
reconciliação operacional exige decisão humana e não é feita por migration.

As novas rotas administrativas são
`POST /admin/reservations/:id/items/:itemId/receive`,
`POST /admin/reservations/:id/items/:itemId/start-cleaning` e
`POST /admin/reservations/:id/items/:itemId/complete-cleaning`. Todas exigem
credencial do servidor, sessão ativa e acesso ao módulo `RESERVATIONS`. O DTO
aceita apenas nota opcional; identidade e permissões vêm da sessão validada. O
painel revalida detalhe, lista, calendário, peças e auditoria após cada ação. O
PDF mostra o estado e os horários reais por peça, além das datas previstas.

Testes de integração e navegador usam exclusivamente PostgreSQL local. O teste
de navegador aborta se a URL do banco não apontar para loopback ou se houver
configuração de integração externa no processo. Não são criados pedido,
pagamento ou HOLD real.
