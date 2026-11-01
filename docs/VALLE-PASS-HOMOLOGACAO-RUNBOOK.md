# Runbook — homologação do `AUTO_VERIFY` com compra Pix controlada

> **Procedimento executado e APROVADO em 31/10/2026 (resultado no §7).** Cada passo **[AUTORIZAÇÃO]** muda produção e só acontece com um "AUTORIZO" expresso, passo a passo. Complementa `VALLE-PASS-HOMOLOGACAO-AUTO-VERIFY.md` (plano e critérios) e `VALLE-PASS-BACKUP-NEON.md`.
>
> IDs fixos (Railway): projeto `6b943c59-89da-4371-b5a2-1641056941b9`, ambiente `8872a5a3-2457-444d-b434-df29b8825394`, API `"@valle/reservations-api"`. **Todo comando `railway` leva `-p`, `-e` e `-s` explícitos.** Rodar de uma pasta fora do repositório (nunca de dentro dele).

Atalhos usados abaixo:
```bash
RW="-p 6b943c59-89da-4371-b5a2-1641056941b9 -e 8872a5a3-2457-444d-b434-df29b8825394"
API='@valle/reservations-api'
```

## 0. Antes de tudo (somente leitura — sem autorização extra)
1. `main` com CI verde e deploy da API em `SUCCESS`: `railway deployment list $RW -s "$API"`.
2. Retrato do estado (chaves, migrações, campanhas, vouchers, retenções, outbox):
   `railway run $RW -s "$API" -- node apps/reservations-api/scripts/estado-producao.mjs`
   Esperado: `TWO_VOUCHER_FLOW=on`, `AUTO_VERIFY` **ausente**, `EMAIL_MODE=dry-run`, `COMMERCIAL_RELEASE` ausente, 47 migrações / 0 pendentes, campanha oficial **sem vouchers ativos**, 0 retenções abertas, campanha de teste **inativa**. Guardar a saída (sem dados pessoais) como "antes".
3. **Backup + restauração verificada [AUTORIZAÇÃO]** — `docs/VALLE-PASS-BACKUP-NEON.md`: primeiro `--preflight` (somente leitura), depois o backup; pasta de saída **protegida** (`C:\Users\<usuário>\BackupsNeon`, não `C:\Temp`). Aprovação: `aprovado: true`, 0 divergências, migrações origem = cópia (47). Registrar o SHA-256.
4. **Estoque de teste (somente leitura):** `railway run $RW -s "$API" -- node apps/reservations-api/scripts/shopify-estoque-teste.mjs --expect closed` → `RESULTADO: OK (closed)`: variante de teste (`67916371165284`, R$ 0,10) **rastreada**, `availableForSale=false`, **quantidade −2**, política DENY; oficial indisponível (estoque 0). O rastreamento do estoque da variante de teste já foi religado manualmente em 31/10/2026 (sem ele a Shopify ignora a quantidade e a política DENY e a variante fica à venda).
5. Cronograma: escolher a janela, avisar quem tem acesso ao ClosetAdmin e ao Pix. Ninguém mais compra durante a janela (a oficial está bloqueada).

## 1. Reativar a campanha de teste **[AUTORIZAÇÃO 1]**
- ClosetAdmin → **Valle Pass** → campanhas → "VALLE PASS TESTE" → **Reativar campanha** → confirmar.
- Shopify (proprietário, pelo Admin): **abrir a variante de teste com 1 unidade** — manter "Rastrear quantidade" LIGADO e ajustar o disponível de **−2 para 1** (ajuste de **+3**). Não desligar o rastreamento, não habilitar "continuar vendendo sem estoque" e **não tocar** na campanha oficial nem no estoque oficial.
- Confirmar: `shopify-estoque-teste.mjs --expect open` → `RESULTADO: OK (open)` (teste rastreada, `availableForSale=true`, quantidade 1; oficial indisponível).
- Conferir: `estado-producao.mjs` → campanha de teste ativa; oficial inalterada. (Os vouchers de teste continuam com **resgate bloqueado** no servidor.)

## 2. Ligar o `AUTO_VERIFY` **[AUTORIZAÇÃO 2]**
```bash
railway variable set VALE_PASS_AUTO_VERIFY=on $RW -s "$API"      # reinicia a API (aguardar SUCCESS)
railway deployment list $RW -s "$API"
railway logs $RW -s "$API" -d -n 80 | grep -i "verificação automática"
```
Esperado no log: o agendador **não** diz mais "DESLIGADA". Não alterar mais nenhuma variável (e-mail segue `dry-run`, `COMMERCIAL_RELEASE` ausente, tolerância e política padrão).
Se a API não subir: **rollback imediato** (§6).

## 3. Compra Pix controlada **[AUTORIZAÇÃO 3 — compra feita pelo proprietário]**
1. No site, comprar **1 unidade** do produto de teste. No checkout escolher **Pix**.
2. **Gerar o QR e esperar de 3 a 5 minutos antes de pagar** (é o cenário que quebrava a regra antiga). Anotar o horário em que o QR foi gerado e o horário em que pagou.
3. Pagar (R$ 0,10). Anotar o **número do pedido** (ex.: `#1015`).
4. Não repetir a compra. Não cancelar nada ainda.

## 4. Verificar (somente leitura)
Repetir a cada ~2 minutos até aprovar (a verificação roda em ciclos; novas tentativas a cada 1–60 min conforme o motivo):
```bash
railway run $RW -s "$API" -- node apps/reservations-api/scripts/homologacao-verify.mjs "#1015"
```
Critérios (todos precisam estar `OK`; saída sem dados pessoais nem códigos):
| id | O que prova |
|---|---|
| `1a/1b/1c` | pedido `CONFIRMED`; fonte `ADMIN_API_TRANSACTION_AUTO`; horário confirmado a ≤ 120 s do webhook (= **confirmação**, não a criação do QR) |
| `2a/2b/2c` | **2 vouchers** por unidade, 1 por empresa, valor = benefício da campanha, saldo cheio, ativos |
| `3a/3b/3c` | **1 mensagem** INITIAL por unidade, `QUEUED`, 0 tentativas (e-mail em dry-run), não elegível antes da confirmação |
| `4a/4b` | nenhuma retenção aberta; **1** auditoria de confirmação automática |
**Antes do pagamento** (Pix pendente) o verificador deve **reprovar** (`1b`/`2a`) — prova de que nada é emitido sem pagamento.

**Idempotência:** anotar o `fingerprint`; esperar **pelo menos 3 ciclos** (≈ 5–10 min), opcionalmente pedir à Shopify o reenvio do webhook `orders/paid` desse pedido; rodar de novo: o `fingerprint` precisa ser **idêntico**.
Também: `estado-producao.mjs` (0 retenções abertas; outbox com 1 `QUEUED`; nenhuma `ACCEPTED`) e `railway logs $RW -s "$API" -d -n 150` sem erro novo.

## 5. Encerrar a homologação
1. **Desligar o `AUTO_VERIFY`**: `railway variable delete VALE_PASS_AUTO_VERIFY $RW -s "$API"`. **Atenção: `variable delete` NÃO cria deploy** (o processo em execução continua com a verificação ativa); rodar em seguida `railway redeploy $RW -s "$API" -y` e aguardar SUCCESS. O log precisa voltar a "DESLIGADA" (observado na homologação de 31/10/2026).
2. ClosetAdmin → campanha de teste → **Encerrar campanha** (volta a inativa). Shopify (proprietário): **encerrar em estoque 0 com o rastreamento ligado** — se a compra foi feita, o estoque já caiu de 1 para 0; se não foi, ajustar de 1 para 0 (−1). Confirmar: `shopify-estoque-teste.mjs` → teste rastreada, `availableForSale=false` (quantidade 0; ou −2 se o ajuste for desfeito). Nunca encerrar desligando o rastreamento.
3. **Cancelar o pedido de teste** no ClosetAdmin (cancela os 2 vouchers e a mensagem pendente) — o Pix de R$ 0,10 não é estornado (decisão do proprietário).
4. `estado-producao.mjs` → "depois": chaves como no §0; campanha de teste inativa; oficial inalterada; outbox do teste `CANCELLED`; 0 retenções abertas.
5. Registrar o resultado (abaixo) e apagar o dump do backup quando a janela encerrar.

## 6. Rollback (a qualquer momento)
- **Variável:** `railway variable delete VALE_PASS_AUTO_VERIFY $RW -s "$API"` **seguido de `railway redeploy $RW -s "$API" -y`** (a remoção sozinha não reinicia a API) → o agendador volta a registrar "DESLIGADA"; retenções continuam e o ADMIN confere manualmente (`/admin/vale-pass/flow`). Para voltar o e-mail a `dry-run` use `railway variable set VALE_PASS_EMAIL_MODE=dry-run` (o `set` redeploya sozinho).
- **Campanha:** "Encerrar campanha" (teste) — reversível.
- **Emissão indevida:** cancelar o pedido no ClosetAdmin; **nunca** apagar linhas do banco à mão.
- **Dados:** não há migração nem DDL neste procedimento; só em caso de corrupção (improvável) avaliar o backup do §0 com autorização separada.

## 7. Registro de resultados — homologação de 31/10/2026 (**APROVADA**)
Executada em 31/10/2026 (noite) e 01/11/2026 (madrugada, UTC), com o proprietário nas ações manuais (Pix, estoque, campanha, publicação, cancelamento) e Claude nas leituras e nos passos autorizados na Railway. Horários em UTC; o Brasil é UTC−3. Sem dados pessoais nem códigos completos.

| Item | Valor |
|---|---|
| Data/hora, executor | 31/10/2026 20:03 BRT (QR) a 01/11/2026 00:37Z (auditoria final). Proprietário (ações manuais) e Claude (leituras e variáveis autorizadas). |
| SHA-256 do backup / `aprovado` | `2cf09e877c8ac261b8b0473f0fc2f38a4239f90068bba90a65b59338a10356b4` (`production-20261031T200349Z.dump`, 299.302 bytes) / **aprovado: true**, 35 tabelas, 47 migrações, 0 divergências na reverificação (a primeira verificação reprovou só por diferença de fuso na comparação por hash; corrigido com `PGTZ=UTC`, ver `VALLE-PASS-BACKUP-NEON.md` §5). Dump e relatórios preservados. |
| Estoque de teste antes (−2) / aberto (1) / depois (0) | −2 (rastreado, DENY) → 1 → 0 após a compra; rastreamento sempre ligado, `availableForSale` coerente em cada etapa (verificador `--expect closed`/`open`). |
| Pedido de teste / QR gerado em / pago em | **#1015**, R$ 0,10, Pix. QR gerado ~20:03 BRT (transação criada 23:03:21Z); Pix aprovado (`sale_success`) **20:06:36 BRT (23:06:36Z)**, ~3 min depois. |
| Critérios 1a–4b (OK/FALHA) | **Todos OK** (11 de 11): status CONFIRMED; fonte `ADMIN_API_TRANSACTION_AUTO`; confirmação a 0 s do webhook (limite 120 s); 2 vouchers por unidade, 1 por empresa, valores = benefícios da campanha, saldo cheio, ATIVOS; 1 mensagem INITIAL por unidade, QUEUED, elegível só após a confirmação; 0 retenções abertas; 1 auditoria de confirmação automática. |
| `fingerprint` (1ª e última leitura) | Verificador: `cba845ebddc431b169808e64` (idêntico em todas as leituras). Estado: `897879aee63741bb` (idêntico em **7 leituras** consecutivas, 23:08Z–23:27Z, ciclos de ~60 s). |
| Erros novos no log? | **Não** (0 ocorrências de erro/exceção/falha nos logs da API durante toda a janela). `/health` 200 em todas as verificações. |
| Estado final igual ao §0? | **Sim**, exceto o histórico do teste: `AUTO_VERIFY` ausente; `EMAIL_MODE=dry-run` (limite 1, lote 1); `COMMERCIAL_RELEASE` ausente; campanha de teste inativa; oficial intacta (ativa, sem alteração desde 27/10); produto de teste despublicado da Loja virtual, estoque 0, rastreado, indisponível; 0 vouchers ACTIVE (7 CANCELLED); 0 retenções abertas; 0 lançamentos. |
| Veredito (APROVADO / REPROVADO) e próximos passos | **APROVADO.** Próximos passos: decisões comerciais do §8 e as pendências abaixo. |

### 7.1 Cronologia resumida (UTC)
| Hora | Evento |
|---|---|
| 23:03:21Z / 23:03:53Z | Transação Pix criada (QR) / pedido #1015 criado (`orders/create` processado). |
| 23:06:36Z | `sale_success` na Shopify = aprovação real do Pix; o pedido estava pago e ficou **confirmado** com horário do evento, a 0 s do webhook. |
| 23:06:39Z | Retenção `PAYMENT_TIME_UNKNOWN` aberta (o webhook `orders/paid` chegou antes da leitura do evento; comportamento previsto). |
| 23:07:25Z | `AUTO_VERIFY` leu o `sale_success`, confirmou o pagamento e retomou a retenção ("emitido automaticamente em reprocessamento"); **2 vouchers emitidos** (R$ 5,00 Valle Showroom e R$ 0,50 VS BY CLOSET) e 1 mensagem INITIAL enfileirada. Auditorias `VALE_PASS_HOLD_RESUMED` e `VALE_PASS_PAYMENT_TIME_AUTO_CONFIRMED` ("Sistema (verificação automática)"), 23:07:26Z. |
| 23:08Z–23:27Z | 7 leituras: estado idêntico, sem emissão extra, sem nova retenção. |
| 23:57Z | `AUTO_VERIFY` desligado (variável removida + `redeploy`; log "DESLIGADA"). |
| 00:15Z / 00:17Z | Campanha de teste encerrada / produto despublicado (`products/update`). |
| 00:25:11Z | `VALE_PASS_EMAIL_MODE=live` (único destinatário autorizado, limite 1, lote 1). |
| 00:27:20Z–00:27:24Z | **1 tentativa** (`SEND_ATTEMPT`), `ACCEPTED` pela Resend (com `provider_message_id`) e `DELIVERED` (webhook). Conteúdo confirmado pelo proprietário na caixa de entrada do Gmail. |
| 00:27:25Z–00:28:09Z | `EMAIL_MODE=dry-run` restaurado (log "DRY-RUN"); janela em `live` de cerca de 2 min; nenhuma outra mensagem enviada. |
| 00:36:22Z | Pedido #1015 cancelado na Shopify; ClosetAdmin: pedido e os 2 vouchers CANCELLED; nenhuma mensagem nova. |

### 7.2 E-mail (Resend)
- Remetente padrão do código (`vallepass@` no domínio da marca); DKIM e SPF/MX (subdomínio `send.`) presentes. **DMARC ausente** (`_dmarc`), recomendado `p=none`. A chave da Resend é restrita a envio e não lê o estado do domínio pela API (conferir no painel).
- Assunto `[TESTE] Seus vouchers do Valle Pass 2027`, faixa "VOUCHERS DE TESTE — SEM VALOR COMERCIAL", dois vouchers com valores, empresas, códigos individuais e validade 30/10/2026 a 28/01/2027. Não menciona os 10% nem link de termos.
- Salvaguardas observadas: lista de destinatários com 1 endereço; única mensagem elegível; chave de idempotência por mensagem; `SENDING` gravado antes da chamada; limite diário 1 usado.

### 7.3 Lições para a próxima execução
1. `railway variable delete` não redeploya; usar `railway redeploy -y` e confirmar "DESLIGADA" no log (ver §5 e §6). Para o e-mail, usar `variable set` (redeploya).
2. A retenção `PAYMENT_TIME_UNKNOWN` de ~46 s entre o webhook e o `AUTO_VERIFY` é esperada; o verificador só deve ser executado depois da resolução.
3. O produto de teste precisa estar **publicado no canal Loja virtual** para o checkout público funcionar (o checkout pela pré-visualização falha com "Falha na transação"); despublicar ao final.
4. O app Shopify não tem `read_publications`, `read_markets` nem escrita em pedidos: a publicação é inferida por `onlineStoreUrl` e pela resposta HTTP da página pública, e o cancelamento é manual.
5. O Pix de R$ 0,10 do teste não é estornado (decisão do proprietário); o pedido fica cancelado e `PAID` na Shopify.

### 7.4 Pendências comerciais restantes (fora desta homologação)
- Texto oficial dos termos e `TERMS_APPROVED` (a página pública dos termos segue desligada).
- Regras do benefício de 10% em passeios (10 perguntas no PR #166) e a descrição do produto na Shopify, que ainda cita os 10%.
- Paleta do e-mail (marsala × preto/branco) e destinatário em reenvios (apenas SUPER_ADMIN).
- Publicar DMARC; prova do `X-Real-IP` na Railway (rota de diagnóstico desligada).
- Abertura de vendas oficiais, `COMMERCIAL_RELEASE`, e-mail `live` em lote e liberação da variante oficial: decisões separadas (§8).

## 8. Fora deste runbook (decisões separadas)
Compra na campanha **oficial** (abrir a variante, termos aprovados, `TERMS_APPROVED=true`), e-mail `live`/`COMMERCIAL_RELEASE`, lote 1, página pública dos termos e vendas oficiais.
