# E-mail dos vouchers: lista de destinatários autorizados e prévia administrativa

Este documento não contém segredos, dados pessoais nem códigos de vouchers.

## Para que serve
Permitir uma validação real do envio por e-mail (`VALE_PASS_EMAIL_MODE=live`) **sem risco de escapar uma mensagem para um cliente ou para uma mensagem antiga**. A lista restringe o envio real a endereços escolhidos; a prévia mostra o e-mail como será enviado, com os códigos mascarados.

## Variável nova: `VALE_PASS_EMAIL_ALLOWED_RECIPIENTS`

| Situação da variável | Efeito |
|---|---|
| **Ausente** | Sem restrição. É o comportamento de hoje (nenhuma mudança para quem não a usa). |
| **Lista válida** | O envio real vai **somente** a esses endereços. |
| **Presente, mas vazia ou com qualquer item inválido** | **Falha fechada.** Nenhum envio real, para ninguém. O motivo aparece nos bloqueios e no resumo (sem expor o valor). |

Formato: endereços completos separados por vírgula, ponto e vírgula, espaço ou quebra de linha. A comparação não diferencia maiúsculas de minúsculas. Não são aceitos nome + endereço (`Maria <m@x>`), curingas (`*@x`), domínios inteiros (`@x`), nem mais de 20 endereços.

### Onde a lista é aplicada
1. **Reserva do worker** (`claim`): quem não está na lista **nunca é reservado**. A mensagem continua `QUEUED`, sem alteração de tentativa, trava, chave de idempotência nem evento.
2. **Defesa em profundidade** em `processOne`: se alguma mensagem fora da lista chegar até lá, o provedor não é chamado, a reserva é devolvida e a mensagem continua na fila.
3. **Reenvio administrativo** (`POST /admin/vale-pass/emails/:id/resend`): destino fora da lista (informado ou o do cliente) é recusado com 422 e **nada é criado**.
4. A chamada ao provedor existe em um único ponto do código (`email-worker.service.ts`), coberto pelos itens 1 e 2.

Os modos `off` e `dry-run` não mudam: `off` não faz nada; `dry-run` enfileira, valida e renderiza e nunca chama o provedor, com ou sem lista.

### Mensagens fora da lista
Ficam `QUEUED`, intactas. O resumo (`GET /admin/vale-pass/emails/summary`) mostra um alerta com a quantidade retida, e o relatório do worker traz `heldByAllowlist`. Tratamento posterior seguro: cancelar a mensagem (procedimento auditado) ou autorizar o endereço. **Atenção:** se a lista for removida depois, o que estiver `QUEUED` e elegível sai para o cliente. Antes disso, confira o outbox.

## Prévia administrativa
`GET /admin/vale-pass/emails/:id/preview` (só **ADMIN**/SUPER_ADMIN, mesma autenticação e guardas do módulo `VALLE_PASS`, resposta com `Cache-Control: no-store`).
- Renderiza o **mesmo modelo** do envio com os códigos **mascarados** (`VALLE-XXXX-****`); o destinatário vem mascarado e informa se estaria autorizado.
- Não envia, não grava, não cria evento e não chama o provedor.
- Só existe enquanto o pedido está pago e a unidade completa e ativa (a mesma regra do envio). Caso contrário, 409; mensagem inexistente, 404.
- Esta entrega é só a API. Não há tela no ClosetAdmin ainda.

## Testes
Novo arquivo `email-allowlist.integration.test.ts`: leitura/validação da configuração (ausente, válida, vazia, curingas, nome+endereço, limite, status público sem endereços), destinatário permitido (com os dois vouchers) e não permitido, caixa alta/baixa, misto, lista inválida, defesa em profundidade, concorrência (3 ticks simultâneos), idempotência (vários ciclos), `off`/`dry-run` com e sem lista, reenvio (recusado, aceito, lista inválida), prévia (mascaramento, sem escrita, 404/409, ADMIN), alerta no resumo.

## Riscos
- **Baixo, por padrão:** sem a variável nada muda.
- **Falha fechada:** erro de digitação na lista bloqueia todo o envio real. É intencional e visível no resumo.
- **Mascaramento:** a máscara existente mostra os 4 primeiros caracteres do segundo grupo do código; o código completo nunca sai pela prévia.
- **Lista não restringe outros e-mails** (lembretes de retirada e alertas operacionais usam outro caminho), só os vouchers.
- A prévia revela o primeiro nome do cliente (já visível ao ADMIN no pedido).

## Plano de implantação (cada passo com autorização expressa; nada disso acontece com este PR)
1. Revisar e fazer o merge. A API reconstrói sozinha; sem a variável, o comportamento é igual ao de hoje.
2. Com `EMAIL_MODE=dry-run` ainda ativo, definir `VALE_PASS_EMAIL_ALLOWED_RECIPIENTS` com o(s) endereço(s) de teste.
3. Conferir o outbox (nenhuma mensagem `QUEUED` indevida) e o alerta do resumo.
4. Só então decidir sobre `live` e uma compra real controlada, com `VALE_PASS_EMAIL_DAILY_LIMIT=1`.

## Rollback
- Remover `VALE_PASS_EMAIL_ALLOWED_RECIPIENTS` volta ao comportamento anterior (cuidado com mensagens `QUEUED`, ver acima).
- `VALE_PASS_EMAIL_MODE=off` interrompe tudo imediatamente.
- Reverter o PR não exige migration: **não há mudança de banco**.
