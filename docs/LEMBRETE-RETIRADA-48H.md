# Lembrete automático de retirada — 48h

O backend possui um serviço opcional de lembrete por e-mail para reservas confirmadas.

## Regra

Como `pickupDate` é uma data civil sem horário, o sistema interpreta "48h" como **dois dias civis antes da retirada**. A partir do horário configurado em `America/Santiago`, o serviço procura reservas elegíveis e envia o lembrete uma única vez.

Reservas canceladas não recebem mensagem. Antes de cada envio o status e o e-mail são revalidados no banco.

## Configuração

Variáveis esperadas no serviço `@valle/reservations-api`:

- `PICKUP_REMINDER_ENABLED=true` para ativar;
- `PICKUP_REMINDER_HOUR_SANTIAGO=10` como horário local de início do envio;
- `PICKUP_REMINDER_POLL_MINUTES=15` como frequência de verificação;
- `RESEND_API_KEY` com a credencial do provedor Resend;
- `REMINDER_FROM_EMAIL` com um remetente de domínio verificado;
- `REMINDER_FROM_NAME`, opcional, com o nome exibido do remetente.

O recurso fica desligado quando `PICKUP_REMINDER_ENABLED` não é `true`. Se for habilitado sem a configuração do provedor, o backend registra o problema e não tenta enviar.

## Segurança e idempotência

O endereço do cliente e as credenciais do provedor não são gravados nos logs de auditoria. O envio usa uma chave de idempotência derivada apenas do ID da reserva, impedindo reenvio duplicado pelo provedor. Após sucesso, o sistema registra `PICKUP_REMINDER_48H_SENT` na auditoria.

## Conteúdo

O e-mail informa a data de retirada, a data prevista de devolução quando disponível e as peças da reserva. Todo dado vindo do cliente ou catálogo é escapado antes de entrar no HTML.
