# Runbook — homologação do `AUTO_VERIFY` com compra Pix controlada

> **Somente procedimento.** Nada daqui foi executado. Cada passo **[AUTORIZAÇÃO]** muda produção e só acontece com um "AUTORIZO" expresso, passo a passo. Complementa `VALLE-PASS-HOMOLOGACAO-AUTO-VERIFY.md` (plano e critérios) e `VALLE-PASS-BACKUP-NEON.md`.
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
1. **Desligar o `AUTO_VERIFY`**: `railway variable delete VALE_PASS_AUTO_VERIFY $RW -s "$API"` (aguardar SUCCESS; log volta a "DESLIGADA").
2. ClosetAdmin → campanha de teste → **Encerrar campanha** (volta a inativa). Shopify (proprietário): **encerrar em estoque 0 com o rastreamento ligado** — se a compra foi feita, o estoque já caiu de 1 para 0; se não foi, ajustar de 1 para 0 (−1). Confirmar: `shopify-estoque-teste.mjs` → teste rastreada, `availableForSale=false` (quantidade 0; ou −2 se o ajuste for desfeito). Nunca encerrar desligando o rastreamento.
3. **Cancelar o pedido de teste** no ClosetAdmin (cancela os 2 vouchers e a mensagem pendente) — o Pix de R$ 0,10 não é estornado (decisão do proprietário).
4. `estado-producao.mjs` → "depois": chaves como no §0; campanha de teste inativa; oficial inalterada; outbox do teste `CANCELLED`; 0 retenções abertas.
5. Registrar o resultado (abaixo) e apagar o dump do backup quando a janela encerrar.

## 6. Rollback (a qualquer momento)
- **Variável:** `railway variable delete VALE_PASS_AUTO_VERIFY $RW -s "$API"` → o agendador volta a registrar "DESLIGADA"; retenções continuam e o ADMIN confere manualmente (`/admin/vale-pass/flow`).
- **Campanha:** "Encerrar campanha" (teste) — reversível.
- **Emissão indevida:** cancelar o pedido no ClosetAdmin; **nunca** apagar linhas do banco à mão.
- **Dados:** não há migração nem DDL neste procedimento; só em caso de corrupção (improvável) avaliar o backup do §0 com autorização separada.

## 7. Registro de resultados (preencher)
| Item | Valor |
|---|---|
| Data/hora, executor | |
| SHA-256 do backup / `aprovado` | |
| Estoque de teste antes (−2) / aberto (1) / depois (0) | |
| Pedido de teste / QR gerado em / pago em | |
| Critérios 1a–4b (OK/FALHA) | |
| `fingerprint` (1ª e última leitura) | |
| Erros novos no log? | |
| Estado final igual ao §0? | |
| Veredito (APROVADO / REPROVADO) e próximos passos | |

## 8. Fora deste runbook (decisões separadas)
Compra na campanha **oficial** (abrir a variante, termos aprovados, `TERMS_APPROVED=true`), e-mail `live`/`COMMERCIAL_RELEASE`, lote 1, página pública dos termos e vendas oficiais.
