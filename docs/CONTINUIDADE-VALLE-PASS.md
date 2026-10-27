# Continuidade — VS BY CLOSET / Valle Pass 2027

Resumo compacto para retomar o trabalho. **Sem credenciais.** Estado de produção aqui é um **retrato de 26/10/2026**: reverificar o que pode ter mudado (saúde da API, deploys, flags, dados) antes de agir. Legenda: **[V]** verificado por leitura no dia indicado · **[R]** relato anterior · **[H]** hipótese.

## 1. Arquitetura
Next.js (vitrine + ClosetAdmin, Vercel) · NestJS + Prisma (API `@valle/reservations-api`, Railway) · PostgreSQL Neon (API conecta com o papel `vsbycloset_runtime`, só DML) · Shopify (checkout e estoque; o app **não escreve** na Shopify) · Resend (e-mail, desligado).
Valle Pass: R$ 350 = voucher R$ 500 Valle Showroom + voucher R$ 50 VS BY CLOSET (independentes, intransferíveis) + desconto informativo de 10% (sem código/saldo). Unidade = 2 vouchers. Limite global 1.000 unidades; lotes de 100.

## 2. Estado (26/10/2026)
- **[V] Frontend e API:** `main` em `134db22` (merge do PR #132, indicadores da campanha). Vercel produção READY (`www.vallebycloset.com`, `vallebycloset.com` redireciona). API Railway no deployment `8a2be2a4` (SUCCESS; os deploys automáticos dos merges ficam SKIPPED porque a árvore é idêntica), `/health` 200.
- **[V] Banco:** 47 migrations, sem pendentes; papel `vsbycloset_runtime`. Baseline: 1 voucher legado **cancelado**, 0 retenções/e-mails/lotes, 19 reservas de aluguel **todas encerradas** (4 canceladas, 1 concluída, 14 expiradas — nenhuma ocupa disponibilidade). Duas migrations antigas com checksum divergente por CRLF (`20260911220000_reservation_archive`, `20261028100000_vale_pass_prorrogacao_validade`): item conhecido, sem efeito em runtime.
- **[V] Campanha "Valle Pass 2027":** R$ 350, limite global 1.000, 3 benefícios ativos (10% **sem condições aprovadas**), ativa, **sem validade**, sem lotes. O cartão mostra **Vendidos 0** (+ "1 unidade cancelada no histórico"), **Validade "A definir"** (pagamentos retidos até configurar) e capacidade 0 de 1.000.
- **[V] Chaves:** `TWO_VOUCHER_FLOW`, `AUTO_VERIFY`, `UNIT_REFUNDS`, `ALERTS_MODE` ausentes; `EMAIL_MODE=off` (desligadas **de propósito**). Agendadores sobem (expiração 60 s, catálogo 30 min — última sincronização lida às 04:03 UTC de 26/10).
- **[V] Shopify (leitura pública do Storefront):** variante do Valle Pass com estoque 0, `availableForSale=false`, R$ 350,00; vitrine "Pré-lançamento/Em breve". O app nunca escreve na Shopify.
- **[V] `/termos-valle-pass`:** 404 (nenhuma das variáveis de termos existe na Vercel).
- **[V] Projeto Railway duplicado `vs-api-7e196b3`** (criado por engano em 25/10; sem variáveis, sem domínio): **não tocar** até decisão sobre a exclusão.

## 3. As 7 pendências técnicas do painel "Pronta para vender?" (classificação)
| Item | Categoria | Situação | O que falta |
|---|---|---|---|
| Estoque da Shopify | **A — resolvido** | publicado (PR #131): o painel compara o estoque lido do Storefront com o esperado | conferir logado que aparece aprovado |
| Chave dos dois vouchers (`TWO_VOUCHER_FLOW`) | **B — exige autorização** | desligada de propósito; testada em ambiente isolado | autorização para ligar, na ordem do runbook da compra de teste |
| Verificação automática (`AUTO_VERIFY`) | **B** | idem (depende da chave anterior) | autorização |
| Envio de e-mails (`EMAIL_MODE`) | **B** | desligado de propósito; fila, repetição e idempotência testadas com Resend simulada | `dry-run` e depois `live`, com autorização e destinatário da equipe |
| Aviso ativo (`ALERTS_MODE`) | **B (opcional)** | desligado | autorização para `log` |
| Endereço dos termos | **C — externo** | página-estrutura pronta e inacessível (404) | texto oficial aprovado (Anderson + jurídico) |
| Compra de teste real | **C** | runbook pronto (`docs/VALLE-PASS-2027-RUNBOOK-COMPRA-TESTE-REAL.md`) | validade configurada (**Anderson**), autorizações e pagamento real |

## 4. Decisões que dependem do Anderson / jurídico (nada decidido pelo sistema)
1. ~~Datas de início e fim da validade~~ — **confirmadas** (01/04/2027 a 15/10/2027; Anderson, 27/10/2026): falta configurá-las juntas na campanha (autorização; `VALLE-PASS-2027-VALIDADE-15-10.md`). Sem elas todo pagamento fica retido.
2. Datas de abertura dos lotes. 3. Data final de comercialização (31/05/2027 sugerida; esgotar antes encerra?).
4. Política de reembolso (inclui direito de arrependimento de 7 dias e "sem reembolso após uso"): análise jurídica. 5. Reembolso por falta de modelo/tamanho/roupa.
6. Saldo remanescente em visitas futuras. 7. Condições do desconto de 10%. 8. Resgate por STAFF (hoje: ADMIN/SUPER_ADMIN; STAFF só com autorização por estabelecimento).
9. Titular e substituto dos pagamentos retidos. 10. Texto oficial dos termos e aprovação jurídica.

## 5. Auditoria final do ClosetAdmin (26/10/2026) — resumo
Ambiente: PostgreSQL local descartável, Shopify/Resend simuladas, rede externa bloqueada. **API 2.120/2.120** (135 arquivos, 0 puladas). **Navegador:** operacional, peças/SKU, contador do Valle Pass, prontidão, variantes, pré-lançamento, lotes, dois vouchers, reembolsos, saldo, financeiro, e-mails, contador de reservas, pedidos excluídos e painel de sincronização — todos aprovados. Node: 365/366 (a falha é `valle-pass-sale` por CRLF no Windows; passa na CI Linux). Typecheck e lint dos 3 pacotes e `build:mock` OK.
- **RBAC caixa-preta** (API compilada + banco local, 109 rotas `/admin`): sem credenciais 109/109 → 401; só com o token de serviço e sem sessão 107 → 401 (as 2 de presença `heartbeat`/`leave` respondem 400 de validação: confiam só no token de serviço, sem expor dados); sessão forjada = mesmo resultado; STAFF 66 × 403; ADMIN 18 × 403; SUPER_ADMIN 0. O limite global (100 req/min por IP) responde 429 antes da autenticação — esperado.
- **Achado corrigido (P2):** em `BalanceDesk`, a atualização em segundo plano após um resgate reescrevia o campo de código e podia sobrescrever uma consulta mais nova → teste `valle-pass-balance-browser` instável (~1 em 4). Correção: guarda de sequência + a atualização de fundo não mexe no campo; teste de regressão `valle-pass-balance-stale-lookup.test.mjs`; saldo 8/8 e 13/13 verificações em cada rodada depois da correção.
- **Hardening P2 sem correção (precisa de migration, só com autorização):** `admin_audit_events` e `reservation_events` não têm gatilho "append-only" no banco (as tabelas do Valle Pass têm). Nenhum código as apaga/atualiza, exceto a anonimização do funcionário removido (`updateMany` em `admin_user_id`), que um gatilho teria de permitir só nessa coluna.
- **Não comprovável sem produção/terceiros:** compra real na Shopify, e-mail real (Resend), webhooks reais, agendadores de 60 s/10 min (só o de 30 min tem evidência direta), sessões de outros papéis no Neon, 48 h do Neon.

## 6. Evidência de testes (não repetir sem mudança relevante)
Ver §5. Instabilidade preexistente: `operational-browser.mjs:305` falha ~1 em 6 (passou na auditoria). No Windows, `valle-pass-sale.test.mjs` falha só por CRLF.

## 7. Bloqueios reais para o lançamento
Validade e lotes sem datas; termos/jurídico; titular de retidos; **compra de teste real** (Shopify + e-mail) ainda não feita (precisa de validade na campanha usada); chaves de emissão/e-mail desligadas (ligar só com autorização); estoque Shopify é manual.

## 8. Segurança e operações
Runtime `vsbycloset_runtime` validado. `neondb_owner` fora da Railway; migrations manuais (runbook de segurança). **Checkpoint de 24 h do Neon:** aprovado com ressalvas; **48 h em 26/10 após 19:52 UTC**, depois reset do owner **só com autorização expressa** e as demais rotações (`ADMIN_API_TOKEN`, `CATALOG_REVALIDATE_SECRET`, `RESERVATION_BINDING_SECRET` — afeta o aluguel —, `SHOPIFY_CLIENT_SECRET`, Resend). Endpoint Neon antigo no `.env` local: credencial tratada como exposta, sem dependência de produção.

## 9. Próximas ações (ordem)
1. Publicar a correção do saldo (PR, API não muda; só front) — com autorização.
2. Checkpoint de 48 h do Neon → reset do owner (autorização).
3. Receber as decisões do §4.
4. Configurar validade e lote 1 e publicar os termos aprovados (cada um com autorização).
5. Compra de teste real controlada → ligar chaves na ordem do runbook → abrir o estoque do lote 1.

## 10. Rollback
API: `railway up` da exportação LF do commit anterior (`git -c core.autocrlf=false archive`, com `-p/-s/-e` explícitos e `--path-as-root`, **nunca** de uma pasta sem vínculo: cria projeto novo); `railway redeploy` reaplica o deploy mais recente, não volta versão. Frontend: reverter o merge. Chaves: desligar a variável e republicar (nunca desliga cancelamentos/reembolsos/resolução manual). Não há migration pendente nem a desfazer.
