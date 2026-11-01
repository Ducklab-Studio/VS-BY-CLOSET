# Valle Pass 2027 — plano de lançamento comercial (Fase K)

> **Este documento NÃO autoriza o lançamento nem executa nada.** Estado de partida: estoque oficial 0, nenhum lote criado, `AUTO_VERIFY` desligado, e-mail em `dry-run`, termos não aprovados (`TERMS_APPROVED` falso). "Testes verdes" **não** equivalem a lançamento autorizado: cada passo abaixo exige "AUTORIZO" próprio de Ciello e, quando indicado, aprovação do Anderson/jurídico.

## 1. Ordem tecnicamente segura e dependências
| # | Passo | Depende de | Quem aprova |
|---|---|---|---|
| 1 | Aprovação comercial das pendências (ver §3) | — | Anderson |
| 2 | Validação jurídica: termos, reembolso (3 dias úteis/7 dias), intransferibilidade, LGPD | 1 | Jurídico |
| 3 | Integrar PRs de segurança, em ordem (ver §2) e revisar o CI | — | Ciello |
| 4 | **Backup** do banco (Neon) e teste de restauração em ambiente descartável; guardar o ponto de recuperação | 3 | Ciello |
| 5 | Aplicar migrations pendentes **em produção** (titular imutável etc.), com `lock_timeout`, na janela combinada; conferir `db:drift` | 3, 4 | Ciello |
| 6 | Verificação de integridade do banco: ledger reconcilia, nenhum voucher ativo sem pedido pago, alertas críticos zerados | 5 | Ciello |
| 7 | Publicar termos aprovados (texto oficial, `TERMS_APPROVED=true`, `VALE_PASS_TERMS_PAGE=on`, URL) | 2 | Anderson + jurídico |
| 8 | Revisar a descrição do produto na Shopify (remover/alinhar os 10% às regras aprovadas) | 1, 2 | Anderson |
| 9 | Aprovar e documentar o benefício de 10% (as 10 regras do PR #166); só então citá-lo | 1, 2 | Anderson |
| 10 | E-mail: DMARC publicado, domínio verificado, decisão sobre destinatários, janela `live` de teste (ver `…EMAIL-COMERCIAL-ATIVACAO.md`) | 7, 9 | Ciello |
| 11 | `AUTO_VERIFY` (verificação automática de pagamento): ativar só com a política decidida e teste de homologação repetido | 6 | Ciello |
| 12 | Validar o checkout ponta a ponta (compra real de teste com valor mínimo, como o #1015) já com termos publicados | 7, 8, 10, 11 | Ciello |
| 13 | Criar o **Lote 1** (100 unidades) no sistema e abrir | 12 | Anderson |
| 14 | Ajuste controlado do **estoque da variante oficial** na Shopify (Lote 1 = 100), nunca acima do limite do lote | 13 | Ciello |
| 15 | Monitorar as primeiras vendas (primeiras 24 h: painel de capacidade, e-mails, retenções, alertas críticos; ver runbook §8) | 14 | Equipe |
| 16 | Plano de reversão (§4) pronto e ensaiado antes do passo 14 | — | Ciello |

## 2. Ordem de integração dos PRs (revisar nesta ordem)
1. **#175** segurança dos vouchers (identidade no resgate, código mascarado).
2. **#177** limite por sessão + caminho legado (empilhado sobre o #175; depois do merge do #175 o GitHub reaponta para `main`).
3. **#176** titular imutável (independente; **inclui migration — só aplicar em produção no passo 5**).
4. **#178** alerta de voucher ativo com pedido não pago + auditoria C/D/F (independente).
5. PR de documentação operacional/e-mail/termos/lançamento (este).
Drafts antigos (#165/#166 sobre os 10%, #147, #105, #100) seguem pendentes de revisão própria.
**Migration:** apenas a do #176. **DNS:** apenas o DMARC (ação sua).

## 3. Pendências que impedem a primeira venda oficial
- Texto dos termos aprovado e publicado; validação jurídica.
- Regras dos 10% aprovadas **ou** remoção da menção na Shopify.
- Critério de conferência de identidade e política de STAFF (Anderson).
- Substituto e canal de aviso das retenções; política do saldo restante após cancelamento.
- Decisão sobre destinatários do e-mail comercial e sobre `AUTO_VERIFY`.
- DMARC; backup e restauração testados; migrations aplicadas.
- Abertura formal (data, Lote 1, estoque) — decisão do Anderson.

## 4. Reversão e fechamento emergencial
| Quando | Ação | Efeito |
|---|---|---|
| Qualquer incidente | Estoque da variante = 0 na Shopify | Barra novas compras na hora |
| E-mail com problema | `VALE_PASS_EMAIL_MODE=dry-run` (`variable set`, redeploya) | Para envios; fila preservada |
| Verificação automática com problema | Remover `AUTO_VERIFY` e **redeploy explícito** (`variable delete` sozinho não redeploya) | Volta à retenção de pagamentos |
| Migration com defeito | Rollback SQL em `docs/rollbacks/` (remove o gatilho; não toca dados) | Restaura comportamento anterior |
| Corrupção de dados | Restaurar do backup do passo 4 em ambiente separado, comparar, decidir | Só com decisão humana |
| Voucher/pedido específico | Bloquear (nunca apagar); histórico é imutável | Preserva trilha |

## 5. Checklist de segurança antes de abrir
- [ ] Resgate exige conferência de identidade (#175 integrado).
- [ ] Limites por sessão ativos (#177); caminho legado só ADMIN.
- [ ] Titular imutável aplicado no banco real (#176, passo 5).
- [ ] Alertas críticos zerados e ledger reconciliado (passo 6).
- [ ] Nenhuma credencial em log; códigos mascarados.
- [ ] Papéis: quem é ADMIN/STAFF, vínculos por empresa conferidos pelo proprietário.
- [ ] Estoque oficial 0 até o passo 14.
