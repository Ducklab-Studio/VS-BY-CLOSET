# Valle Pass 2027 — runbook: segurança, migrations e rotações de segredos

**Status:** procedimentos, **nenhum executado**. Cada passo exige autorização expressa de quem responde pela produção. Este documento **não contém credenciais**; nenhum valor de segredo deve ser colado em chat, ticket, commit ou log.

## 1. Estado de segurança conhecido (verificar de novo antes de agir)
- API em produção conecta no Neon com o papel **`vsbycloset_runtime`** (só DML; sem DDL; `_prisma_migrations` somente leitura). O `neondb_owner` **não** está na Railway.
- Logs da API do Valle Pass: 43 pontos de log auditados; só nome da classe do erro, código de voucher **mascarado** e IDs de pedido. Logs reais de produção: 0 e-mails, 0 códigos, 0 telefones, 0 tokens (24–25/10/2026).
- Endpoint de prontidão e demais rotas administrativas exigem credencial administrativa **e** sessão **e** módulo `VALLE_PASS`.
- Nenhuma tarefa do Valle Pass exige credencial do `neondb_owner`.

## 2. Migrations (manuais, com o `neondb_owner` FORA da Railway)
O pré-deploy da Railway roda `prisma migrate deploy` com o papel runtime, que **não tem DDL**: uma migration pendente **faz o deploy falhar** (a Railway mantém o deploy anterior). Procedimento:
1. Revisar a migration (aditiva, `lock_timeout`, sem `DROP`), testar em PostgreSQL descartável e criar branch/snapshot de backup no Neon (se disponível).
2. Exportar o commit em LF (`git -c core.autocrlf=false archive`) para um caminho curto (ex.: `C:\\Temp\\...`).
3. **O responsável** aplica `prisma migrate deploy` no próprio terminal, com a URL do owner digitada em entrada **mascarada** e só na sessão (nunca em arquivo, nunca no chat).
4. Conferir `_prisma_migrations` (nome, checksum, concluída) e o schema; **depois** publicar a API (o pré-deploy dirá "No pending migrations").
5. Duas migrations antigas têm checksum de CRLF no banco: conhecido, só fim de linha, **não editar o banco**.

## 3. Rotações restantes (ordem sugerida; **uma por vez**, cada uma com janela e rollback)
| Segredo | Onde vive | Cuidados |
|---|---|---|
| Senha do `neondb_owner` | Neon (console) | Depois da janela de estabilidade do runtime (24–48 h desde 24/10 19:52 UTC). Não afeta a API (usa o runtime). Guardar a nova URL só no gerenciador de senhas. O rollback do owner deixa de existir após o reset. |
| `ADMIN_API_TOKEN` | Railway (API) **e** Vercel (marketing) | Trocar nos **dois** e republicar os dois (API primeiro, depois o site) para não derrubar o ClosetAdmin. Sem o token o ClosetAdmin para de falar com a API. |
| `CATALOG_REVALIDATE_SECRET` | Railway (API) **e** Vercel | Trocar nos dois; só afeta a atualização do cache do catálogo. |
| `RESERVATION_BINDING_SECRET` | Railway (API) | **Cuidado: afeta o ALUGUEL.** Assina o vínculo pedido↔reserva; trocar com reservas em checkout/pagamento pode invalidar vínculos. Fazer com janela sem reservas pendentes (ou com verificação dupla) e conferir um pedido de teste depois. |
| `SHOPIFY_CLIENT_SECRET` | Railway (API) | Gerar o novo no app da Shopify, atualizar na Railway e reiniciar; conferir leitura do catálogo e a verificação de webhooks. |
| `RESEND_API_KEY` / segredo do webhook da Resend | Railway (API) | Só entra em vigor com deploy; e-mail deve continuar `off` até a ativação aprovada. Revogar a chave antiga depois de validar. |

Para cada rotação: (a) confirmar `/health` e logs antes; (b) gerar o novo valor fora do chat; (c) atualizar com `--skip-deploys` e fazer um único redeploy; (d) validar (health, logs sem erro de autenticação, endpoint com 401 sem credencial, painel carregando); (e) só então revogar o antigo; (f) registrar data e responsável (sem o valor).

## 4. Ordem de ativação das chaves do Valle Pass (cada uma com autorização, leitura de integridade antes/depois)
1. `VALE_PASS_TWO_VOUCHER_FLOW=on` — pagamento confirmado passa a emitir os dois vouchers (desligada: vira retenção, nunca emite voucher único).
2. `VALE_PASS_AUTO_VERIFY=on` — exige a anterior; confirma o horário do pagamento pela Shopify e retoma retenções.
3. `VALE_PASS_EMAIL_MODE=dry-run` e depois `live` — `live` só com domínio verificado na Resend e `RESEND_API_KEY` válida.
4. `VALE_PASS_ALERTS_MODE=log` (opcional) — alertas nos logs da Railway.
Rollback de qualquer chave: desligar a variável e republicar; **nunca** desliga cancelamentos, reembolsos nem a resolução manual.

## 5. Publicação segura (API primeiro)
Mudança com API **e** frontend: (1) publicar a API por `railway up` do commit exportado (ou `railway redeploy` se o deploy vier SKIPPED por "No changes to watched files"); (2) validar health, logs, rotas; (3) só então sair do Draft e fazer o merge (Create a merge commit, identidade empresarial) que publica o frontend; (4) conferir o deploy de produção da Vercel e os domínios; (5) o deploy automático da Railway no merge deve ficar SKIPPED (árvore idêntica). Rollback: `railway up` do commit anterior exportado; reverter o merge no frontend.

## 6. Checkpoints de estabilidade (tarefa separada)
24 h e 48 h após o redeploy do runtime: `/health`, logs (sem `denied`, `42501`, `P10xx`, autenticação), conexões como `vsbycloset_runtime`, baseline de dados (contagens e assinaturas) e agendadores. Só depois autorizar o reset do owner.

## 7. Credencial exposta sem origem identificada
O arquivo local `apps/reservations-api/.env` aponta para um endpoint Neon antigo cuja origem **não foi identificada** (não está nas 3 branches da VS BY CLOSET nem nos projetos Overframer e Casa do Açaí). A URL foi colada em chat em 15/09/2026: tratar como **comprometida**. Não autenticar nele. Ação futura (com ordem expressa): remover/trocar essa URL do `.env` local.
