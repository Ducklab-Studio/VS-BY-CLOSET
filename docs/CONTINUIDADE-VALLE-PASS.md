# Continuidade — VS BY CLOSET / Valle Pass 2027

Resumo compacto para retomar o trabalho. **Sem credenciais.** Estado de produção aqui é um **retrato de 25/10/2026**: reverificar o que pode ter mudado (saúde da API, deploys, flags, dados) antes de agir. Legenda: **[V]** verificado por leitura no dia indicado · **[R]** relato anterior · **[H]** hipótese.

## 1. Arquitetura
Next.js (vitrine + ClosetAdmin, Vercel) · NestJS + Prisma (API `@valle/reservations-api`, Railway) · PostgreSQL Neon (API conecta com o papel `vsbycloset_runtime`, só DML) · Shopify (checkout e estoque; o app **não escreve** na Shopify) · Resend (e-mail, desligado).
Valle Pass: R$ 350 = voucher R$ 500 Valle Showroom + voucher R$ 50 VS BY CLOSET (independentes, intransferíveis) + desconto informativo de 10% (sem código/saldo). Unidade = 2 vouchers. Limite global 1.000 unidades; lotes de 100.

## 2. Estado (25/10/2026)
- **[V] Frontend:** merge `25f0c0ed` do PR #129 (painel "Pronta para vender?"), Vercel produção Ready, domínios oficiais apontando para ele.
- **[V] API Railway:** deployment `96a61d87` SUCCESS (código = commit do PR #129); deploy automático do merge ficou SKIPPED (árvore idêntica).
- **[V] Banco:** 47 migrations, sem pendentes; baseline de dados idêntico (1 voucher, 7 pedidos, 19 reservas de aluguel, 0 retenções/lotes/e-mails).
- **[V] Campanha "Valle Pass 2027":** limite 1.000, 3 benefícios, ativa, **sem validade**, sem lotes. **[V]** Vendas fechadas (vitrine "Pré-lançamento/Em breve"), estoque Shopify 0 **[R]**; `TWO_VOUCHER_FLOW`, `AUTO_VERIFY`, `UNIT_REFUNDS`, `ALERTS_MODE` ausentes; `EMAIL_MODE=off`.
- **[V] Testes locais (PostgreSQL descartável, Shopify/Resend simuladas, rede bloqueada):** 835 testes (817 da API do Valle Pass + 18 da jornada completa); 11 suítes de navegador do ClosetAdmin e aluguel; ver §5.

## 3. Branch de finalização técnica (local, NÃO publicada)
`feat/valle-pass-finalizacao-tecnica` (worktree `C:\Temp\vs-final`, base `25f0c0e`). Contém: painel de prontidão com natureza (técnico/comercial/jurídico), próximo passo e "pode concluir sem o Anderson"; correção de classificação (`valid-until` é do Anderson; `sales-end` registrado não aprova); resgate com **"Usar saldo total"** e **conferência de identidade opcional e auditável** (sem migration; só no histórico e na auditoria); retenções com **tempo decorrido, urgência e orientação por motivo**; página-estrutura de **termos** (404 por padrão; `VALE_PASS_TERMS_PAGE=on`; `noindex`); três runbooks; este resumo. **Nada disso está em produção.** Publicar exige: commit/push, PR, API primeiro (há mudança de DTO opcional e do checklist), merge — cada um com autorização.

## 4. Decisões que dependem do Anderson / jurídico (nada decidido pelo sistema)
1. Datas de início e fim da validade (30/09/2027 foi só sugestão) — o banco exige as duas juntas; sem elas todo pagamento fica retido.
2. Datas de abertura dos lotes. 3. Data final de comercialização (31/05/2027 sugerida; esgotar antes encerra?).
4. Política de reembolso (inclui direito de arrependimento de 7 dias e "sem reembolso após uso"): análise jurídica. 5. Reembolso por falta de modelo/tamanho/roupa.
6. Saldo remanescente em visitas futuras. 7. Condições do desconto de 10%. 8. Resgate por STAFF (hoje só ADMIN/SUPER_ADMIN).
9. Titular e substituto dos pagamentos retidos. 10. Texto oficial dos termos e aprovação jurídica.

## 5. Evidência de testes (não repetir sem mudança relevante)
Branch finalização: API 281/281 nos arquivos afetados (resgate 36, checklist 14, serviço 8, lotes 31, campanha oficial 11, fluxo financeiro 97, ledger/bloqueio/escopo/reversão); node: painel 14, retenções 9, termos 7; navegador (todas aprovadas): prontidão 8, saldo/resgate 13, contador 12, lotes 10, dois vouchers 8, financeiro 10, reembolsos 11, e-mails 7, pré-lançamento 8, aluguel (operational, SKU). **Instabilidade preexistente:** `operational-browser.mjs:305` falha ~1 em 6 (visibilidade de botão sem espera), também no código base.

## 6. Bloqueios reais para o lançamento
Validade e lotes sem datas; termos/jurídico; titular de retidos; **compra de teste real** (Shopify + e-mail) ainda não feita; chaves de emissão/e-mail desligadas (ligar só com autorização, na ordem do runbook); estoque Shopify é manual.

## 7. Segurança e operações
Runtime `vsbycloset_runtime` validado (leitura 35 tabelas, DML, escrita com ROLLBACK). `neondb_owner` fora da Railway; migrations manuais (runbook de segurança). Rotação do owner depois dos checkpoints de 24/48 h (25 e 26/10); depois `ADMIN_API_TOKEN`, `CATALOG_REVALIDATE_SECRET`, `RESERVATION_BINDING_SECRET` (cuidado: aluguel), `SHOPIFY_CLIENT_SECRET`, Resend. Endpoint Neon antigo no `.env` local: origem não identificada, credencial tratada como exposta, sem dependência de produção.

## 8. Próximas ações (ordem)
1. Checkpoints de estabilidade do runtime (25 e 26/10) → reset do owner (com autorização).
2. Enviar/receber as decisões do §4.
3. Publicar a branch de finalização (PR, API primeiro, merge).
4. Configurar validade e lote 1 (só com datas aprovadas); publicar termos aprovados.
5. Compra de teste real controlada → ligar chaves na ordem → abrir estoque do lote 1.

## 9. Rollback
API: `railway up` do commit anterior exportado em LF (`git -c core.autocrlf=false archive`); `railway redeploy` reaplica o deploy mais recente, não volta versão. Frontend: reverter o merge. Chaves: desligar a variável e republicar (nunca desliga cancelamentos/reembolsos/resolução manual). Não há migration pendente nem a desfazer.
