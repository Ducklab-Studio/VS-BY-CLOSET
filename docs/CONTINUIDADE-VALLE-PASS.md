# Continuidade — VS BY CLOSET / Valle Pass 2027

Resumo compacto para retomar o trabalho. **Sem credenciais.** Estado de produção aqui é um **retrato de 25/10/2026**: reverificar o que pode ter mudado (saúde da API, deploys, flags, dados) antes de agir. Legenda: **[V]** verificado por leitura no dia indicado · **[R]** relato anterior · **[H]** hipótese.

## 1. Arquitetura
Next.js (vitrine + ClosetAdmin, Vercel) · NestJS + Prisma (API `@valle/reservations-api`, Railway) · PostgreSQL Neon (API conecta com o papel `vsbycloset_runtime`, só DML) · Shopify (checkout e estoque; o app **não escreve** na Shopify) · Resend (e-mail, desligado).
Valle Pass: R$ 350 = voucher R$ 500 Valle Showroom + voucher R$ 50 VS BY CLOSET (independentes, intransferíveis) + desconto informativo de 10% (sem código/saldo). Unidade = 2 vouchers. Limite global 1.000 unidades; lotes de 100.

## 2. Estado (25/10/2026)
- **[V] Frontend:** `main` em `23aee43` (merge do PR #130). Vercel produção Ready; `www.vallebycloset.com` e `vallebycloset.com` apontam para ele.
- **[V] API Railway:** deployment `6d1c35f9` SUCCESS (código = PR #130); o deploy automático do merge ficou SKIPPED (árvore idêntica).
- **[V] Banco:** 47 migrations, sem pendentes; baseline de dados idêntico (1 voucher legado cancelado, 7 pedidos, 19 reservas de aluguel, 0 retenções/lotes/e-mails).
- **[V] Campanha "Valle Pass 2027":** R$ 350, limite 1.000, 3 benefícios ativos (Showroom R$ 500, VS BY CLOSET R$ 50, 10% **sem condições aprovadas**), ativa, **sem validade**, sem lotes.
- **[V] Shopify (leitura pública do Storefront, 25/10 ~18:00 UTC):** variante `49174518595684` com estoque **0**, `availableForSale=false`, preço **R$ 350,00 BRL**; vitrine "Pré-lançamento/Em breve". Nada foi alterado.
- **[V] Chaves:** `TWO_VOUCHER_FLOW`, `AUTO_VERIFY`, `UNIT_REFUNDS`, `ALERTS_MODE` ausentes; `EMAIL_MODE=off` (desligadas **de propósito**).
- **[V] `/termos-valle-pass`:** 404 (nenhuma das variáveis `VALE_PASS_TERMS_PAGE` / `NEXT_PUBLIC_VALE_PASS_TERMS_URL` existe na Vercel).

## 3. As 7 pendências técnicas do painel "Pronta para vender?" (classificação)
| Item | Categoria | Situação | O que falta |
|---|---|---|---|
| Estoque da Shopify | **A — resolvível e comprovável agora** | o painel agora compara o estoque lido do Storefront (somente leitura) com o esperado (0 sem lote aberto): igual → aprovado, acima → bloqueado, sem resposta → pendente. Estado real hoje: 0 = esperado. | publicar o ajuste (branch `feat/valle-pass-pendencias-tecnicas`); depois do deploy o item aparece aprovado |
| Chave dos dois vouchers (`TWO_VOUCHER_FLOW`) | **B — preparada, exige autorização** | desligada de propósito; testada em ambiente isolado (jornada completa e fluxo financeiro) | autorização para ligar, na ordem do runbook da compra de teste |
| Verificação automática (`AUTO_VERIFY`) | **B** | idem; 31 testes de integração + 17 de decisão | autorização (depende da chave anterior) |
| Envio de e-mails (`EMAIL_MODE`) | **B** | desligado de propósito; fila, repetição e idempotência testadas com Resend simulada | `dry-run` e depois `live`, com autorização e destinatário da equipe |
| Aviso ativo (`ALERTS_MODE`) | **B (opcional)** | desligado; 13 testes | autorização para `log` (opcional) |
| Endereço dos termos | **C — depende de condição externa** | página-estrutura pronta e inacessível (404); integração com `NEXT_PUBLIC_VALE_PASS_TERMS_URL` pronta | texto oficial aprovado (Anderson + jurídico) |
| Compra de teste real | **C** | runbook pronto (`docs/VALLE-PASS-2027-RUNBOOK-COMPRA-TESTE-REAL.md`), com bloqueio de vendas públicas, conferência dos dois vouchers e rollback | validade configurada (**Anderson**), autorizações e pagamento real |

Os outros 12 pendentes do painel e o bloqueado (validade) são decisões do Anderson/jurídico (§5).

## 4. Branches e publicação
- **`feat/valle-pass-pendencias-tecnicas`** (local, worktree `C:\Temp\vs-pend`, base `23aee43`, **não publicada**): leitura do estoque da Shopify como evidência no painel (API informa `expectedShopifyStock`; o site lê o Storefront e compara, 3 s, somente leitura), chaves desligadas descritas como "de propósito", jornada completa de 18 testes (compra, verificação automática, e-mail com Resend simulada, retenções, reembolso, alerta), runbook da compra real de teste, correções de texto desatualizado e este resumo. Publicar exige commit/push, PR, **API primeiro** (campo novo e aditivo na resposta), merge — cada um com autorização.
- Worktrees antigas (`C:\Temp\vs-prontidao`, `C:\Temp\vs-final`) já estão em produção e podem ser removidas depois.

## 5. Decisões que dependem do Anderson / jurídico (nada decidido pelo sistema)
1. Datas de início e fim da validade (30/09/2027 foi só sugestão) — o banco exige as duas juntas; sem elas todo pagamento fica retido.
2. Datas de abertura dos lotes. 3. Data final de comercialização (31/05/2027 sugerida; esgotar antes encerra?).
4. Política de reembolso (inclui direito de arrependimento de 7 dias e "sem reembolso após uso"): análise jurídica. 5. Reembolso por falta de modelo/tamanho/roupa.
6. Saldo remanescente em visitas futuras. 7. Condições do desconto de 10%. 8. Resgate por STAFF (hoje só ADMIN/SUPER_ADMIN).
9. Titular e substituto dos pagamentos retidos. 10. Texto oficial dos termos e aprovação jurídica.

## 6. Evidência de testes (não repetir sem mudança relevante)
Branch de pendências (PostgreSQL descartável, Shopify/Resend simuladas, rede bloqueada): API **474/474** nos arquivos afetados (jornada 18, fluxo de pagamento 97, verificação automática 31+17, e-mails 47+32, alertas 13+14, filtro financeiro 12+38, emissão 44, campanha oficial 11, benefícios/validade 11, prontidão 32); node: painel 18, retenções 9, termos 7; navegador (todas aprovadas): prontidão 8, financeiro 10, e-mails 7, dois vouchers 8, lotes 10, reembolsos 11, saldo/resgate 13, pré-lançamento 8, aluguel; lint, typecheck e `build:mock` OK. **Instabilidade preexistente:** `operational-browser.mjs:305` falha ~1 em 6 (também no código base). No Windows, `valle-pass-sale.test.mjs` falha só por CRLF (passa na CI Linux).
Produção (leitura, 25/10): `/health` 200, logs do deploy `6d1c35f9` com 0 erros e 0 dados sensíveis, 0 referências ao `neondb_owner` nas 3 aplicações da Railway, baseline idêntico.

## 7. Bloqueios reais para o lançamento
Validade e lotes sem datas; termos/jurídico; titular de retidos; **compra de teste real** (Shopify + e-mail) ainda não feita (e ela precisa de validade na campanha usada); chaves de emissão/e-mail desligadas (ligar só com autorização); estoque Shopify é manual.

## 8. Segurança e operações
Runtime `vsbycloset_runtime` validado (leitura, DML, escrita com ROLLBACK). `neondb_owner` fora da Railway; migrations manuais (runbook de segurança). **Checkpoint oficial de 24 h do Neon:** a janela fecha em 25/10 às 19:52 UTC (leitura prévia às 18:11 UTC já limpa); checkpoint de 48 h em 26/10 19:52 UTC; depois reset do owner com autorização e as demais rotações (`ADMIN_API_TOKEN`, `CATALOG_REVALIDATE_SECRET`, `RESERVATION_BINDING_SECRET` — cuidado, afeta o aluguel —, `SHOPIFY_CLIENT_SECRET`, Resend). Endpoint Neon antigo no `.env` local: origem não identificada, credencial tratada como exposta, sem dependência de produção.

## 9. Próximas ações (ordem)
1. Checkpoint de 24 h (a partir de 19:52 UTC) e de 48 h → reset do owner (autorização).
2. Receber as decisões do §5.
3. Publicar `feat/valle-pass-pendencias-tecnicas` (PR, API primeiro, merge).
4. Configurar validade e lote 1 e publicar os termos aprovados (cada um com autorização).
5. Compra de teste real controlada → ligar chaves na ordem do runbook → abrir o estoque do lote 1.

## 10. Rollback
API: `railway up` da exportação LF do commit anterior (`git -c core.autocrlf=false archive`); `railway redeploy` reaplica o deploy mais recente, não volta versão. Frontend: reverter o merge. Chaves: desligar a variável e republicar (nunca desliga cancelamentos/reembolsos/resolução manual). Não há migration pendente nem a desfazer.
