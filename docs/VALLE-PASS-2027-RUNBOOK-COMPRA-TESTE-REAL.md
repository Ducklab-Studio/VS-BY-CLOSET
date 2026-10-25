# Valle Pass 2027 — runbook: compra real de teste controlada

**Status:** procedimento PREPARADO, **não executado**. Cada passo marcado **[AUTORIZAÇÃO]** exige confirmação expressa de quem responde pela produção. Pagamento, reembolso, ligar chaves e e-mail real são ações reais. Nada aqui define política comercial.

**Objetivo:** provar, com Shopify e Resend reais, que um pagamento de R$ 350,00 gera os **dois vouchers independentes** (Valle Showroom R$ 500 e VS BY CLOSET R$ 50), com códigos, saldos e e-mail corretos, **sem abrir a venda ao público** e com caminho de volta em qualquer falha.

## 0. Pré-condições (todas verificáveis; se alguma faltar, NÃO começar)
| # | Condição | Como verificar | Quem destrava |
|---|---|---|---|
| 1 | Campanha **com validade** (início e fim juntos) | painel "Pronta para vender?" → "Início da validade" aprovado | **Anderson** (datas) — sem validade o pagamento é **retido**, não emite |
| 2 | Benefícios, limite 1.000, preço R$ 350 | painel (já aprovados hoje) | pronto |
| 3 | Estoque Shopify da variante usada = 0 e vitrine "Em breve" (estado atual) | painel (leitura do Storefront) e vitrine pública | pronto |
| 4 | Destinatário do e-mail de teste = endereço da equipe (nunca de cliente) | quem compra | equipe |
| 5 | Domínio de e-mail verificado na Resend e `RESEND_API_KEY` válida | painel ("e-mail": `VALE_PASS_EMAIL_DOMAIN_VERIFIED=true` já está) + painel da Resend | equipe |
| 6 | Responsável pelo estorno e pelo acompanhamento (titular/substituto) | combinado | **Anderson** |
| 7 | Backup lógico/snapshot recente do banco | console do Neon (snapshot manual) | equipe |

**Sobre a validade (ponto crítico):** a campanha real **não tem validade** hoje. Opções, a decidir (**[DECISÃO PENDENTE]**):
- **A.** Esperar as datas aprovadas pelo Anderson e testar na campanha real (caminho mais fiel).
- **B.** Campanha de TESTE separada (variante própria, nome claramente "TESTE", validade curta fictícia só nela, benefícios idênticos). Não conta no limite de 1.000 da campanha real. Exige criar a variante na Shopify (fora do app) e a campanha no ClosetAdmin.
- **C. (Fase 0, opcional)** Compra na campanha real **sem validade**: prova a **retenção** (pagamento aparece em "Pagamentos retidos" com motivo "Campanha sem validade/benefícios prontos", nada é emitido, nada some) e termina em estorno. Não prova a emissão.

## 1. Como a compra NÃO fica pública
A vitrine só habilita o botão quando a Shopify diz `availableForSale`; hoje a variante está em estoque 0. **Não** abrir estoque da variante pública para o teste. Alternativas a confirmar na própria Shopify pela equipe (**[A CONFIRMAR]**, não verificado por mim):
1. **Pedido rascunho (draft order)** com a variante do teste, enviado por link de fatura só para a pessoa que paga; o estoque público permanece 0.
2. **Variante/produto de teste** (opção B acima) não listado na vitrine e comprado por link direto.
Se nenhuma das duas for possível, o plano muda: janela curta com estoque 1 **somente** com autorização e aviso interno, e o risco de um terceiro comprar nesse intervalo precisa ser aceito por escrito.

## 2. Ordem das chaves (cada uma **[AUTORIZAÇÃO]**, leitura de integridade antes e depois)
1. `VALE_PASS_EMAIL_MODE=dry-run`: o worker "envia" para simulação; nenhum e-mail sai. Validar a fila.
2. `VALE_PASS_TWO_VOUCHER_FLOW=on`: pagamento confirmado passa a emitir os dois vouchers.
3. `VALE_PASS_AUTO_VERIFY=on` (opcional): confere o horário do pagamento na Shopify e retoma retenções. Sem ela, usar **Conferir na Shopify** no painel de integração financeira (manual).
4. `VALE_PASS_EMAIL_MODE=live` **somente** para a janela do teste e só com o destinatário da equipe. Ao final voltar a `off`.
Cada mudança de variável exige redeploy da API (`railway redeploy`) e validação (`/health`, logs sem erro).

## 3. Execução
1. **[AUTORIZAÇÃO]** Pagar R$ 350,00 de verdade (cartão/Pix da equipe) pelo caminho do item 1.
2. Pedido aparece em "Pedidos na Shopify" (ClosetAdmin → Valle Pass) como **Confirmado**.
3. Com a política estrita, se a verificação automática estiver desligada: **Conferir na Shopify** (ADMIN) para confirmar o horário do pagamento.
4. Conferir **dois vouchers** do mesmo grupo: um **Valle Showroom R$ 500,00** e um **VS BY CLOSET R$ 50,00**, códigos diferentes, saldo cheio, validade da campanha, status ativo.
5. E-mail: **uma** mensagem com os dois códigos (primeiro em dry-run/fila; depois, se autorizado, `live` para a equipe). Conferir remetente, valores, lojas e validade no corpo.
6. **Resgate de teste** (ADMIN, na mesa "Saldo e resgate"): R$ 1,00 no voucher VS BY CLOSET com referência "TESTE"; saldo R$ 49,00 (a tela só oferece a empresa do próprio voucher; a recusa de empresa errada é coberta pelos testes automatizados, pela API); **reverter** o resgate com justificativa e conferir saldo de volta a R$ 50,00.
7. Conferir auditoria (resgate e reversão) e que o painel "Pronta para vender?" não mostrou retenção nem alerta inesperado.

## 4. Encerramento e reembolso (**[AUTORIZAÇÃO]**, na Shopify; o sistema nunca reembolsa)
1. Fazer o reembolso do pedido de teste **na Shopify**. O sistema cria a revisão do reembolso (uso bloqueado até a decisão) ou cancela os vouchers ativos conforme o evento.
2. Em "Reembolsos aguardando decisão": decidir (ADMIN, justificativa ≥ 10 caracteres) e conferir que os dois vouchers ficam **cancelados** e a capacidade volta.
3. Se houve crédito usado e revertido, não deve haver alerta de crédito consumido; se houver, conferir e marcar.
4. Desligar na ordem inversa: `EMAIL_MODE=off`, `AUTO_VERIFY` e `TWO_VOUCHER_FLOW` ausentes (**[AUTORIZAÇÃO]**), redeploy e validar. Confirmar vitrine "Em breve" e estoque 0.

## 5. Rollback (qualquer falha)
1. **Parar:** estoque público continua 0; não abrir nada.
2. Se um pagamento ficou retido ou sem voucher: **não** editar por SQL; usar o runbook de retenções (justificativa, "Resolver"/"Descartar" só depois do estorno na Shopify).
3. Desligar as chaves na ordem inversa e redeployar; API anterior: `railway up` da exportação LF do commit anterior.
4. Reembolsar o pedido de teste na Shopify (decisão humana) e registrar o ocorrido.

## 6. Critério de sucesso (todos obrigatórios)
Dois vouchers corretos e independentes; uma mensagem de e-mail com os dois códigos; resgate parcial e reversão corretos; recusa de empresa errada; reembolso cancelando os dois vouchers; baseline de dados do restante intacto (reservas de aluguel e demais pedidos); vendas públicas fechadas durante todo o teste; chaves de volta ao estado desligado. O resultado é registrado **fora do sistema** (o painel continua tratando "compra de teste real" como pendente até alguém decidir marcá-la).

## 7. O que este runbook não decide
Política de reembolso/arrependimento, uso do saldo remanescente, condições dos 10%, STAFF e titular de retidos continuam **[DECISÃO PENDENTE — Anderson/jurídico]**.
