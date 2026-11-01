# Valle Pass 2027 — prontidão e checklist de ativação do e-mail comercial (Fase E)

> Documento de preparação. **Nada foi ativado:** `EMAIL_MODE` segue `dry-run`, nenhum e-mail real foi enviado, DNS não foi tocado. Este checklist **não** deve ser executado sem autorização expressa.

## 1. O que já existe e está homologado
- Entrega real via Resend validada no pedido #1015 (30–31/10/2026): um e-mail por unidade com os dois vouchers, janela `live` de ~2 min, `dry-run` restaurado (`docs/VALLE-PASS-HOMOLOGACAO-RUNBOOK.md` §7).
- Fila (`outbox`) com chave de idempotência por mensagem, status `SENDING` gravado **antes** da chamada ao provedor, e retentativa com a **mesma** chave (um único e-mail aceito) — testes `email-outbox.integration.test.ts`, `email-pure.test.ts`.
- Retentativas: backoff de 1, 5, 15, 60, 180, 360, 720 e 1440 min (máx. 8 tentativas, configurável); falha **permanente** não repete; resultado desconhecido (`UNKNOWN`) reagenda sem reenviar às cegas (`email-worker.service.ts`).
- Cancelamento/reembolso **antes** do envio cancela a mensagem (teste "reembolso/cancelamento ANTES do envio: o e-mail nunca sai"). Cancelamento **depois** da entrega não retira o e-mail: o voucher é cancelado no sistema e o código deixa de funcionar.
- Travas de envio real (fail closed): `MODE=live` **e** `RESEND_API_KEY` **e** `DOMAIN_VERIFIED=true` **e** remetente válido **e** lista de destinatários autorizados (`ALLOWED_RECIPIENTS`, máx. 20). Sem a lista, nada sai. Limite diário e tamanho de lote configuráveis (padrões 80/dia e lote 10).
- Código de voucher no log: sempre mascarado; a prévia nunca usa o nome completo.

## 2. Lacunas e decisões
| Item | Situação |
|---|---|
| **DMARC** | Ausente no domínio (registrado no runbook). Ação **externa** (DNS), sua. Ver §3. |
| **Lista de destinatários autorizados** | Hoje é uma trava de *teste* (máx. 20, só endereços listados). Para vender ao público é preciso uma **decisão e uma mudança de código/configuração separadas**: o modo atual **não** envia a clientes arbitrários. Não existe, por design, modo "todos os clientes" sem essa decisão. |
| **Limite diário × volume** | Padrão 80/dia; um lote de 100 vendas no mesmo dia gera 100 e-mails. Alerta `EMAIL_DAILY_LIMIT_NEAR` existe. Conferir também o limite do **plano da Resend** (não verificável daqui). |
| **Reenvio manual** | ADMIN/SUPER_ADMIN reenviam; quem pode trocar o destinatário é decisão pendente. |
| **Paleta/estilo do e-mail** | Decisão visual pendente (marsala × preto/branco). |
| **Menção aos 10% / link de termos** | O e-mail de teste não menciona nenhum dos dois. Só incluir depois de aprovados (Anderson/jurídico). |
| **Webhook da Resend** (entrega/bounce) | Verificação Svix fail closed implementada; segredo `RESEND_WEBHOOK_SECRET` e endpoint registrado na Resend: **não verificados** nesta sessão. |
| **Remetente `vallepass@`** | Padrão do código; confirmar caixa/respostas (`REPLY_TO`) com o cliente. |

## 3. DNS — registros e como verificar (não alterar sem autorização)
Registros SPF/DKIM/MX do subdomínio `send.` já estão presentes. **A publicar (DMARC), no domínio da marca:**

```
Tipo: TXT   Nome: _dmarc   Valor: v=DMARC1; p=none; rua=mailto:<caixa-de-relatórios-a-definir>
```
`p=none` só monitora (não rejeita nada). Endurecer (`quarantine`/`reject`) é decisão posterior, depois de semanas de relatórios.

Verificar propagação (de qualquer terminal):
```bash
nslookup -type=TXT _dmarc.vallebycloset.com
nslookup -type=TXT send.vallebycloset.com
nslookup -type=TXT resend._domainkey.vallebycloset.com
```
Na Resend → *Domains*, o status deve estar **Verified**.

## 4. Checklist de ativação do e-mail comercial (NÃO EXECUTAR sem autorização)
Ordem tecnicamente segura; cada passo exige um "AUTORIZO" próprio:
1. [ ] Termos aprovados e publicados; texto do e-mail revisado (sem 10% sem regras; com o que foi aprovado).
2. [ ] DMARC publicado e verificado; domínio **Verified** na Resend; limite do plano compatível com o lote.
3. [ ] Decisão de código/configuração sobre **quem pode receber** (hoje só lista autorizada). Alteração em PR próprio, com testes.
4. [ ] Backup do banco antes da abertura (ver plano de lançamento).
5. [ ] `VALE_PASS_EMAIL_DOMAIN_VERIFIED=true`; limites diário/lote ajustados ao Lote 1.
6. [ ] Janela curta em `live` com um pedido de teste (como no #1015), conferindo: um e-mail por unidade, dois vouchers, sem dados indevidos, sem código em log.
7. [ ] Voltar a `dry-run` se qualquer item falhar; só então liberar `live` contínuo.
8. [ ] Monitorar: `EMAIL_FAILED`, `EMAIL_OVERDUE`, `EMAIL_QUEUE_BLOCKED` no painel; reenvio manual conforme runbook operacional.

## 5. Não verificado nesta sessão (sem envio real, por restrição)
Reputação do domínio, comportamento de provedores de destino (spam), entregabilidade em Gmail/Outlook/Apple, bounces/complaints reais e o limite do plano Resend. Classificação: **NÃO VERIFICADO**.
