# Valle Pass 2027 — prorrogação coletiva da validade (preparação)

> **Contém migration** `20261028100000_vale_pass_prorrogacao_validade` (aditiva: uma tabela vazia + funções/gatilhos + uma função substituída). **Nada é prorrogado por este PR**: nenhuma data é definida ou sugerida, nenhum voucher é alterado, não há botão na tela (só API do proprietário). Aplicar em produção só com autorização expressa. Prorrogar de verdade depende da **nova data final** e das decisões abaixo.

## Auditoria (antes)
- `vale_passes.expires_at` e `valid_from` eram **imutáveis** por gatilho (`vale_pass_immutable_fields`): nenhuma forma de prorrogar, nem por SQL.
- A validade da campanha (`voucher_valid_until`) só vale para vouchers **futuros**; os emitidos guardam a própria.
- A expiração é **preguiçosa**: `ACTIVE` com `expires_at` no passado vira `EXPIRED` na próxima leitura; o resgate (serviço e gatilho do ledger) recusa `expires_at <= now()`.
- Saldo vive em `balance_cents` (cache) + ledger imutável; reembolsos/cancelamentos mudam `status` para `CANCELLED`; bloqueio é independente do status. Nada disso depende da validade para ser consistente.

## Regras implementadas (banco = última linha; serviço e API só de SUPER_ADMIN)
1. **Histórico imutável** `vale_pass_validity_extensions` (só INSERT; UPDATE/DELETE/TRUNCATE recusados): data anterior, **nova data**, fuso, instante de vencimento, justificativa (10–500), quem autorizou, chave de idempotência (única por campanha), numeração por campanha e um **retrato**: quantos vouchers ganharam a nova validade, quantos ficaram de fora (já expirados / cancelados / com validade igual ou maior) e a **soma dos saldos** dos prorrogados.
2. **Só aumenta**: a nova data tem de ser **posterior** à validade atual da campanha (CHECK + gatilho); `previous_until` precisa ser a validade vigente (prévia antiga é recusada). Para cada voucher, `expires_at` só sobe, nunca desce.
3. **Sem alteração direta**: `expires_at` só muda **dentro do gatilho da própria prorrogação** (profundidade de gatilho ≥ 2, voucher `ACTIVE`/`USED`, mesmo status, instante igual ao da prorrogação existente da mesma campanha). UPDATE direto, até conhecendo o id de uma prorrogação real, é recusado (testado).
4. **Tudo ou nada**: o registro e o efeito (vouchers, eventos, campanha) acontecem na **mesma transação**; falha no meio desfaz tudo (testado). Não existe "execução parcial".
5. **Concorrência**: ordem fixa de travas (campanha → vouchers por id) e a mesma contagem no serviço e no gatilho; resgates e cancelamentos simultâneos não geram impasse nem inconsistência (testados; em caso de impasse a operação é recusada inteira, "nada foi alterado", e pode ser repetida).
6. **Idempotência**: mesma chave + mesmo conteúdo = resultado original (`replayed`); mesma chave com outro conteúdo = 409; confirmações simultâneas = uma só prorrogação.
7. **Autorização e confirmação**: somente SUPER_ADMIN (guard e serviço); prévia (nada gravado) + confirmação com **justificativa**, **nova data redigitada** e a **contagem** vista na prévia (se mudou, 409).
8. **Preserva** saldos, ledger, status, bloqueios, benefícios, empresa, código, valor e `valid_from`; cada voucher ganha um evento `VALIDITY_EXTENDED` (validade anterior e nova); auditoria crítica `VALE_PASS_VALIDITY_EXTENDED`; a validade final da campanha passa a ser a nova (emissões futuras).
9. **Não reativa nada**: cancelados e reembolsados continuam cancelados; expirados (por status **ou por data**) ficam de fora. O banco valida o instante de vencimento no fuso informado (padrão `America/Sao_Paulo`, igual ao emissor; testado também para `America/Santiago` e UTC).

## API (somente proprietário)
`POST /admin/vale-pass/campaigns/:id/validity-extension/prepare` `{ newUntil: "AAAA-MM-DD" }` → contagens e `operationId` (nada gravado) · `POST …/validity-extension` `{ newUntil, reason, operationId, confirmDate, expectedEligibleCount }` · `GET …/validity-extension` (histórico).

## Procedimento operacional (quando a data for definida)
1. Anderson/jurídico definem a **nova data final** por escrito e as decisões abaixo. 2. Proprietário gera a prévia e confere: validade atual, nova data, quantos vouchers por empresa, soma dos saldos, quantos ficam de fora. 3. Confirma com a justificativa (cite a decisão), redigitando a data. 4. Conferir o histórico, a auditoria e uma leitura de integridade (saldos/ledger iguais). 5. Avisar clientes só se for decidido (e-mail **não** é enviado por este fluxo). Erro/"nada foi alterado": repetir a prévia.
**Rollback**: não há "desfazer" de uma prorrogação aplicada (só aumenta, por desenho); o `down.sql` remove a estrutura (só sem prorrogações reais) e **não** devolve datas. Antes de aplicar em produção, ensaiar em banco descartável.

## Decisões comerciais pendentes (não assumidas)
1. A **nova data final** (e se haverá mais de uma prorrogação).
2. **Vouchers já expirados**: reativar/incluir? (hoje ficam de fora; o relatório da prévia conta quantos são).
3. **Cancelados/reembolsados**: confirmado como nunca reativar; **restaurar** um cancelado depois da prorrogação recebe a nova validade? (hoje volta com a validade antiga).
4. **USED**: incluídos hoje (podem voltar a ACTIVE por reversão de resgate) — confirmar.
5. **Vouchers bloqueados**: prorrogados (bloqueio é independente) — confirmar.
6. Fuso da validade (Brasil × Chile) — afeta o instante de vencimento (a diferença é de horas).
7. Comunicação ao cliente (e-mail/WhatsApp) e quem autoriza (hoje só o proprietário).
8. Tela no ClosetAdmin (não implementada nesta etapa).

## Testes
`validity-extension.integration.test.ts` (15, banco descartável): prévia sem gravar, datas inválidas, prorrogação com saldos/ledger/benefícios preservados e eventos, exclusão de cancelados/expirados/mais longos, legado, sequência e prévia vencida, fuso, UPDATE direto recusado (inclusive com contexto forjado), histórico imutável, falha no meio, só SUPER_ADMIN, confirmação explícita, idempotência/concorrência, e prorrogação simultânea a resgates e cancelamentos (sem impasse). Suíte completa da API, typecheck, lint e builds verdes.
