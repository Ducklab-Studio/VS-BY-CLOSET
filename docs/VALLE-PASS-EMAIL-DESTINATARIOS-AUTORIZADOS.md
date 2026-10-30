# E-mail dos vouchers: destinatários autorizados (fase de testes) e prévia administrativa

Este documento não contém segredos, dados pessoais nem códigos de vouchers.

## Para que serve
Permitir uma validação real do envio por e-mail (`VALE_PASS_EMAIL_MODE=live`) **sem que uma mensagem escape para um cliente ou saia uma mensagem antiga**, e dar ao ADMIN uma prévia do e-mail com os códigos totalmente mascarados.

## Regra de envio real (FAIL CLOSED na fase de testes)
O envio real de vouchers exige, além do que já era exigido (`live`, chave, domínio verificado, remetente válido), **uma destas duas condições**:

| Configuração | Efeito |
|---|---|
| `VALE_PASS_EMAIL_ALLOWED_RECIPIENTS` com lista **válida** | O envio vai **somente** a esses endereços. |
| Lista **ausente** | **Nenhum envio real**, para ninguém (bloqueio visível no resumo). |
| Lista presente, mas **vazia ou com item inválido** | **Nenhum envio real**, nem com a liberação comercial. |
| Lista ausente **e** `VALE_PASS_EMAIL_COMMERCIAL_RELEASE=true` | Envio ao cliente do pedido (liberação comercial). **Ainda não habilitada.** |
| Lista válida **e** liberação comercial | A lista continua restringindo (a mais restritiva vence). |

`VALE_PASS_EMAIL_COMMERCIAL_RELEASE` é uma decisão **explícita e separada**: só o valor exato `true` vale (sem diferenciar maiúsculas). Não deve ser habilitada na fase de testes.

Formato da lista: endereços completos separados por vírgula, ponto e vírgula, espaço ou quebra de linha, sem diferenciar maiúsculas. Não são aceitos nome + endereço, curingas, domínios inteiros nem mais de 20 endereços.

### Onde a regra é aplicada
1. **Reserva do worker** (`claim`): quem não está autorizado **nunca é reservado**. A mensagem continua `QUEUED`, sem alteração de tentativa, trava, chave de idempotência nem evento.
2. **Defesa em profundidade** em `processOne`: se uma mensagem não autorizada chegar até lá, o provedor não é chamado, a reserva é devolvida e a mensagem continua na fila.
3. **Reenvio administrativo** (`POST /admin/vale-pass/emails/:id/resend`): destino não autorizado é recusado (422) e **nada é criado**. A recusa vale com lista configurada (em qualquer modo) ou em `live` sem liberação comercial. Em `off`/`dry-run` sem lista nada pode ser enviado de qualquer forma, então o reenvio segue como antes.
4. A chamada ao provedor de vouchers existe em um único ponto (`email-worker.service.ts`), coberto pelos itens 1 e 2.

### Remover a lista é uma operação sensível, e agora é segura
Remover `VALE_PASS_EMAIL_ALLOWED_RECIPIENTS` **não libera** as mensagens retidas: sem lista e sem liberação comercial o envio real continua bloqueado. Só a variável separada `VALE_PASS_EMAIL_COMMERCIAL_RELEASE=true` libera, e essa é uma decisão comercial consciente. Antes dela, conferir o outbox (as mensagens `QUEUED` elegíveis sairão para os clientes).

### Modos `off` e `dry-run`
Inalterados. `off` não faz nada; `dry-run` enfileira, valida e renderiza e nunca chama o provedor, com ou sem lista e com ou sem liberação.

### Mensagens retidas
Ficam `QUEUED`, intactas. O resumo (`GET /admin/vale-pass/emails/summary`) mostra um alerta (crítico em `live`) com a quantidade retida, e o relatório do worker traz `heldByAllowlist`. Tratamento posterior seguro: cancelar a mensagem (procedimento auditado) ou autorizar o endereço.

## Prévia administrativa
`GET /admin/vale-pass/emails/:id/preview` (só **ADMIN**/SUPER_ADMIN, mesma autenticação e guardas do módulo `VALLE_PASS`, resposta com `Cache-Control: no-store`).
- Renderiza o **mesmo modelo** do envio com os caracteres secretos **mascarados por inteiro**: `VALLE-****-****` (fica só o prefixo público; o benefício é identificado pelo cartão, Valle Showroom ou VS BY CLOSET).
- Mostra **somente o primeiro nome** do cliente (nunca o nome completo) e o destinatário mascarado (`m***@dominio`).
- Não envia, não grava, não cria evento e não chama o provedor.
- Só existe enquanto o pedido está pago e a unidade completa e ativa. Caso contrário, 409; mensagem inexistente, 404.
- Esta entrega é só a API. Não há tela no ClosetAdmin ainda.

## Testes
`email-allowlist.integration.test.ts` (banco local descartável, sem rede): configuração (ausente, liberação só com `true`, lista válida/vazia/inválida/curinga/nome, limite, status público sem endereços, lista sempre restringe), destinatário permitido (com os dois vouchers) e não permitido, caixa alta/baixa, misto, ausência da lista em live, **remoção da lista com mensagens `QUEUED`**, lista inválida, defesa em profundidade, concorrência (3 ciclos), idempotência, `off`/`dry-run` com e sem lista, reenvio (recusado, aceito, ausente, lista inválida, dry-run), prévia (máscara total, só primeiro nome, sem escrita, 404/409, ADMIN), alertas do resumo.
Os testes existentes que usam `live` passam a declarar `VALE_PASS_EMAIL_COMMERCIAL_RELEASE: 'true'` (a liberação comercial é agora um pré-requisito explícito).

## Riscos
- **Mudança de padrão (intencional):** `live` sem lista e sem liberação passa a ser bloqueado. Em produção hoje o modo é `dry-run` e nada muda; ao ir para `live` será preciso definir a lista.
- Erro de digitação na lista bloqueia todo o envio real (visível no resumo).
- A lista cobre só os e-mails de vouchers (lembretes de retirada e alertas usam outro caminho).
- A prévia mostra o primeiro nome do cliente e o número do pedido (já visíveis ao ADMIN).

## Plano de implantação (cada passo com autorização expressa; nada disso ocorre com este PR)
1. Revisar e fazer o merge. A API reconstrói; `dry-run` permanece como está.
2. Definir `VALE_PASS_EMAIL_ALLOWED_RECIPIENTS` com o(s) endereço(s) de teste (ainda em `dry-run`) e conferir o resumo.
3. Conferir o outbox e só então decidir sobre `live` e uma compra real controlada, com `VALE_PASS_EMAIL_DAILY_LIMIT=1`.
4. Não definir `VALE_PASS_EMAIL_COMMERCIAL_RELEASE` na fase de testes.

## Rollback
`VALE_PASS_EMAIL_MODE=off` interrompe tudo. Reverter o PR não exige migration (não há mudança de banco).

## Identificação do e-mail da campanha de TESTE
- A campanha de teste é identificada pelo **mesmo critério que bloqueia o resgate** (`isTestCampaign`: ID da campanha ou variante da Shopify do produto de teste), nunca por nome, rótulo ou valor.
- Só para ela: assunto com o prefixo **`[TESTE] `** e a faixa **"VOUCHERS DE TESTE — SEM VALOR COMERCIAL"** no HTML (logo abaixo do cabeçalho) e no texto simples. Vale para o worker, para o reenvio administrativo, para o `dry-run` e para a prévia.
- A campanha **oficial** Valle Pass 2027 não recebe nenhuma marcação (assunto, HTML e texto idênticos aos de antes).
- Em "Como utilizar", saiu a frase redundante "Os vouchers pertencem a empresas diferentes…" (a mesma regra já consta no primeiro item). Nenhuma regra comercial foi alterada.
