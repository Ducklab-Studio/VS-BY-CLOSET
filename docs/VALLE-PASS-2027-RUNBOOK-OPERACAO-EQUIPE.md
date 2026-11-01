# Valle Pass 2027 — runbook de operação da equipe (Fase J)

> Escrito para a equipe operar sem depender do desenvolvedor. **Cada procedimento está classificado.** Não trate como operacional o que não está em "A".
> Regras sempre valem: nunca copiar/colar códigos de voucher em conversas, nunca enviar dados do cliente por canal aberto, nunca usar o painel com a senha de outra pessoa.

**Classificação:** **A** = já funciona e foi homologado/testado · **B** = tecnicamente pronto, depende de aprovação · **C** = bloqueado por decisão comercial ou jurídica.

## 1. Localizar um pedido e seus vouchers — A
ClosetAdmin → Valle Pass → *Pedidos*: buscar pelo número do pedido (ex.: `#1015`). Mostra status (pago, retido, cancelado, reembolsado), vouchers emitidos e e-mails. Quem não é ADMIN vê códigos mascarados (`VALLE-AB12-****`) e só encontra por **código exato ou número do pedido**.

## 2. Consultar saldo de um voucher — A
*Saldo e resgate* → digitar o código que o **cliente apresenta** → a tela mostra empresa, saldo, validade, status e dados do titular **mascarados**. Voucher bloqueado, cancelado, expirado, em revisão de reembolso ou de campanha de teste aparece com o motivo e não permite resgate.

## 3. Conferir a titularidade — A (procedimento) / C (critério)
O voucher é **intransferível**. O código sozinho **não** prova quem é o titular. Antes de resgatar, o operador confere **presencialmente** que quem está no balcão é o titular e marca a caixa "Conferi presencialmente a identidade do titular" (obrigatória; o sistema não guarda documento nem foto).
**C — bloqueado por decisão do Anderson:** *o que* conferir (documento com foto? nome?) e o que fazer se o titular estiver ausente. **Enquanto não houver regra, recusar o resgate de quem não for o titular.**

## 4. Resgatar um voucher — A
*Saldo e resgate* → informar o valor → **Prévia** → redigitar o valor → marcar a conferência de identidade → **Confirmar resgate**. O valor nunca passa do saldo; só vale na empresa do voucher; operação repetida (duplo clique, internet lenta) não resgata duas vezes. ADMIN precisa de vínculo com a empresa; STAFF só resgata se o proprietário vinculou a pessoa a uma empresa (política técnica atual, **ainda sem aprovação comercial do Anderson — C**).

## 5. Reverter um resgate (erro de operador) — A (só ADMIN)
No histórico do voucher, escolher a entrada do resgate → informar motivo → confirmar. Não reverte duas vezes nem acima do crédito. Sempre registra quem e por quê.

## 6. Bloquear / desbloquear — A (só ADMIN)
Para fraude ou dúvida. Congela o saldo e impede resgate; desbloquear exige motivo. Não cancela nada.

## 7. Cancelar ou reembolsar — misto
- **Pedido cancelado antes de uso:** os dois vouchers são cancelados sozinhos — **A**.
- **Reembolso total/parcial:** o sistema **não cancela sozinho**; abre uma *revisão* para ADMIN decidir (manter / cancelar apenas os ativos) — **A**.
- **Cancelamento depois de uso (total ou parcial):** o sistema cria um **alerta** com o valor já consumido e **não mexe no que foi usado** — **A**; quem decide o que fazer com o saldo restante e com o valor devolvido ao cliente: **C** (decisão comercial/jurídica pendente).
- **Reembolso automático dos R$ 350 em até 3 dias úteis:** **C** — regra informada, validação jurídica pendente; nada é automatizado.
O estorno em dinheiro é sempre feito **na Shopify, por uma pessoa**.

## 8. Identificar divergências — A
Painel de capacidade (alertas críticos): pedidos pagos sem voucher; retenções abertas e idade; voucher **ativo** com pedido não pago; crédito usado após cancelamento; reembolsos aguardando decisão; e-mails atrasados/falhos. Alerta crítico = parar de vender (ver §12) e tratar.

## 9. Resolver retenções — A (ADMIN) / C (responsável)
Retenção = pagamento confirmado, mas o sistema recusou emitir (capacidade, valor divergente, horário do pagamento desconhecido, etc.). O ADMIN confere o pedido na Shopify e usa *Retomar*/*Regularizar* com justificativa, ou descarta após reembolso. Anderson é o responsável principal pelas retenções financeiras; substituto e canal de aviso: **C**. Prazos: alerta aos 48 h e crítico aos 72 h do pagamento.

## 10. Conferir e-mails — A
Em cada pedido: status por unidade (na fila, enviado, falhou, cancelado). Reenvio manual: ADMIN ou SUPER_ADMIN (rota `resend` exige ADMIN; o serviço recusa STAFF e inativos). Trocar o destinatário do reenvio: restrição a SUPER_ADMIN é decisão pendente. Hoje o envio real está **desligado** (dry-run): ver a seção 3 de `VALLE-PASS-2027-EMAIL-COMERCIAL-ATIVACAO.md` antes de qualquer ativação — **B/C**.

## 11. Monitorar capacidade e esgotamento — A
Painel de capacidade da campanha: global (1.000), lote aberto (100), vendidos, pagos aguardando, saldo. Lote esgotado gera alerta. **Lote não bloqueia a compra:** quem barra a venda é o **estoque na Shopify**.

## 12. Interromper novas vendas rapidamente — A (fora do sistema)
1. Shopify → produto *Valle Pass 2027* → variante → estoque **0** (política "não vender sem estoque"). Efeito imediato no checkout.
2. (Opcional) despublicar o produto do canal Loja virtual.
3. Conferir no painel que nada novo entrou. Pedidos já pagos continuam sendo processados.
Nenhum botão do ClosetAdmin encerra vendas; `COMMERCIAL_RELEASE` e `salesEndDate` **não** são travas funcionais.

## 13. Resposta a incidentes — A
| Situação | Ação imediata | Depois |
|---|---|---|
| Suspeita de voucher usado por outra pessoa | Bloquear o voucher (§6) | Conferir histórico e auditoria; registrar |
| Alerta crítico de vouchers ativos com pedido não pago | Parar vendas (§12); **não resgatar** esses vouchers | Conferir pedido na Shopify; bloquear/cancelar |
| Resgate feito por engano | Reverter (§5) | Registrar motivo |
| E-mail não chegou | Ver status por unidade (§10) | Reenvio por ADMIN, se autorizado |
| Cliente pede reembolso | Seguir §7; pedir decisão do Anderson | Estorno manual na Shopify |
| Dado pessoal exposto | Parar, avisar o proprietário | Registrar; tratar conforme LGPD (jurídico) |
