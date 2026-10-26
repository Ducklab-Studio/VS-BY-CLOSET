# Entrega VS BY CLOSET — 28/10/2026 (lista curta)

Retrato de **26/10/2026** (leituras; sem credenciais). Detalhes em `docs/CONTINUIDADE-VALLE-PASS.md`.

## 1. O que já pode ser demonstrado ao Anderson (ambiente real, sem operação comercial)
Roteiro sugerido de ~15 min no ClosetAdmin, logado como Proprietário:
1. **Dashboard e calendário** — retiradas/devoluções, navegação entre datas, bloqueios de disponibilidade.
2. **Reservas** — filtros, detalhe, exportar PDF, histórico/auditoria (reservas de aluguel hoje: 19, todas encerradas; nenhuma ocupa disponibilidade).
3. **Peças** — SKU, variações, ativar/desativar (peças desativadas não aparecem no site).
4. **Funcionários e permissões** — papéis (Equipe/Administrador/Proprietário) e módulos; o servidor confere cada ação.
5. **Valle Pass → cartão da campanha** — **Vendidos 0** (nota: "1 unidade cancelada no histórico"), **Validade "A definir"** (pagamentos retidos até as datas existirem), limite **1.000**, preço **R$ 350**, benefícios (R$ 500 Valle Showroom + R$ 50 VS BY CLOSET + 10% informativo).
6. **Pronta para vender?** — o que falta para abrir, quem é o responsável e o próximo passo (é a lista da seção 2 abaixo).
7. **Capacidade e lotes** (0 de 1.000, lotes de 100) e **saldo e resgate** — **só com dados sintéticos** (ambiente de teste); em produção não há voucher ativo e não se deve resgatar nada.
Home pública: nova foto na seção do aluguel (desktop e celular) e `/pecas`. O vídeo do hero está preparado (`docs/HERO-VIDEO.md`), mas **sem vídeo publicado**.

## 2. Depende do Anderson / jurídico (nada decidido pelo sistema)
1. **Datas de início e fim da validade** — sem elas todo pagamento fica retido e a compra de teste real não emite. (**mais urgente**)
2. Datas de abertura dos lotes e data final de comercialização.
3. Política de reembolso (inclui direito de arrependimento de 7 dias e "sem reembolso após uso") e reembolso por falta de modelo/tamanho.
4. Saldo remanescente em visitas futuras e condições do desconto de 10%.
5. Resgate por STAFF (hoje: ADMIN/SUPER_ADMIN; STAFF só com autorização por loja).
6. Titular e substituto dos pagamentos retidos.
7. **Texto oficial dos termos** e aprovação jurídica (`/termos-valle-pass` continua 404 de propósito).
8. **Vídeo do Orlando**: arquivo + autorização de uso (especificação em `docs/HERO-VIDEO.md`).

## 3. Depende de validação real (só com autorização separada)
- **Compra real de teste** (Shopify + Resend reais) — checklist abaixo.
- Ligar `TWO_VOUCHER_FLOW`, `AUTO_VERIFY` e e-mail (`dry-run` → `live` só para a equipe); hoje todas desligadas de propósito.
- Webhooks reais da Shopify e agendadores de 60 s/10 min (só o de 30 min tem evidência direta em produção).
- **Neon:** checkpoint de 48 h (26/10 após 19:52 UTC) → reset do `neondb_owner` só com autorização expressa; depois as demais rotações (`ADMIN_API_TOKEN`, `CATALOG_REVALIDATE_SECRET`, `RESERVATION_BINDING_SECRET` — afeta o aluguel —, `SHOPIFY_CLIENT_SECRET`, Resend).
- Abrir o estoque do lote 1 na Shopify (manual) só depois de tudo acima.

## 4. Checklist da compra real de teste (resumo; **não executada**; passo a passo em `docs/VALLE-PASS-2027-RUNBOOK-COMPRA-TESTE-REAL.md`)
Pré-condições (todas precisam estar ✔ antes de começar):
- [ ] Validade (início e fim) configurada na campanha usada — decisão do Anderson.
- [ ] Estoque público da variante continua **0** e a vitrine em "Em breve" (a compra não pode ficar pública: pedido rascunho/link de fatura ou variante de teste, a confirmar na Shopify).
- [ ] Destinatário do e-mail = endereço da **equipe**; domínio verificado na Resend.
- [ ] Responsável pelo estorno definido; snapshot manual do Neon feito.
- [ ] Autorização expressa para cada ação abaixo.

Execução (cada item **[AUTORIZAÇÃO]**, com leitura de integridade antes e depois):
1. [ ] `EMAIL_MODE=dry-run` → `TWO_VOUCHER_FLOW=on` → (opcional) `AUTO_VERIFY=on` → `EMAIL_MODE=live` só na janela do teste; cada mudança = `railway redeploy` + `/health` + logs sem erro.
2. [ ] Pagar R$ 350,00 reais; pedido aparece como **Confirmado** em "Pedidos na Shopify".
3. [ ] Conferir **dois vouchers** do mesmo grupo (R$ 500 Valle Showroom e R$ 50 VS BY CLOSET), códigos diferentes, saldo cheio, validade correta.
4. [ ] **Um** e-mail com os dois códigos (remetente, valores, lojas, validade).
5. [ ] Resgate de R$ 1,00 no voucher VS BY CLOSET (referência "TESTE") → saldo R$ 49,00 → **reverter** com justificativa → R$ 50,00.
6. [ ] Auditoria registra resgate e reversão; painel sem retenção/alerta inesperado.
7. [ ] Reembolsar o pedido **na Shopify** (o sistema nunca reembolsa); decidir a revisão; os dois vouchers ficam **cancelados** e a capacidade volta.
8. [ ] Desligar na ordem inversa (`EMAIL_MODE=off`, depois `AUTO_VERIFY` e `TWO_VOUCHER_FLOW` ausentes), redeploy, conferir "Em breve" e estoque 0.
Sucesso = dois vouchers corretos e independentes, um e-mail, resgate/reversão corretos, reembolso cancelando ambos, baseline intacto e vendas públicas fechadas o tempo todo. Em qualquer falha: parar, não editar por SQL, seguir a seção de rollback do runbook.

## 5. Observações de infraestrutura (somente leitura, 26/10)
- `@valle/marketing` na Railway: deploys dos merges em SUCCESS (último `599db2e1`), mas o domínio da Railway responde **502**; o site oficial roda na **Vercel** e não depende dele (serviço redundante: decidir se desativa).
- `@loja/web` na Railway: FAILED desde antes (não faz parte do site oficial).
- Projeto Railway duplicado `vs-api-7e196b3`: 1 deploy ativo (SUCCESS) rodando a vitrine, **sem variáveis, sem domínio e sem acesso ao banco**; criado por engano em 25/10. Sugerida a exclusão **depois** de autorização.
