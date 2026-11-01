# Valle Pass 2027 — documento de aprovação comercial

> **Rascunho para revisão (01/11/2026).** Reúne só as decisões que ainda faltam para abrir as vendas. Nada aqui foi aplicado: nenhum código, Shopify, banco, Railway, Vercel ou variável foi alterado, nenhum lote foi criado e nenhuma venda foi aberta. **Nenhuma condição comercial ou jurídica foi inventada**: onde o Anderson não decidiu, o campo está em branco.
>
> Fontes: decisões do Anderson de 20/10, 26/10 e 27/10/2026 (`VALLE-PASS-2027-REGRAS-CONFIRMADAS.md` e `VALLE-PASS-2027-DECISOES-ANDERSON.md`, este último ainda numa branch local), auditoria de prontidão de 01/11, PR #165 (auditoria dos 10%) e PR #166 (conferência assistida dos 10%).

## Como usar
Cada item tem **Confirmado** (já decidido, só precisa de um "ok" final) e **Falta decidir** (precisa de resposta). Marque a resposta no campo **Decisão** e registre quem decidiu e quando. Só depois das respostas é que se planeja qualquer implementação.

## Questões que exigem validação jurídica (marcadas com ⚖ nos itens)
Este documento não dá parecer jurídico. As questões abaixo só podem ser fechadas depois de avaliadas por quem tem competência para isso:
1. ⚖ Direito de arrependimento de 7 dias (item 3), inclusive se vale "sem reembolso depois de qualquer uso" dentro desse prazo.
2. ⚖ Reembolso após uso parcial do crédito e a relação entre "crédito usado não é reembolsado" e "reembolso integral por falta de roupa ou tamanho" (item 3).
3. ⚖ Divulgação dos 10% sem condições escritas e as condições finais do benefício (itens 4 e 9).
4. ⚖ Conferência dos 10% com dados do cliente na tabela de vendas da Valle Experience (LGPD) (item 4).
5. ⚖ Intransferibilidade e eventual exigência de identificação do titular no resgate (item 5).
6. ⚖ Texto final dos termos e a forma de aceite pelo cliente (item 8).

## Situação em uma tabela
| # | Tema | Situação |
|---|---|---|
| 1 | Datas de abertura e encerramento das vendas | Parcial — abertura precisa ser reconfirmada |
| 2 | Lotes de 100 e limite de 1.000 | Parcial — falta a regra de abertura dos lotes seguintes |
| 3 | Cancelamento, arrependimento e reembolso | Parcial — depende de parecer jurídico |
| 4 | Regras dos 10% nos passeios | **Pendente** — só existe a intenção geral |
| 5 | Quem usa os benefícios e quantas vezes | Parcial |
| 6 | Responsáveis pelas retenções | Parcial — falta o substituto |
| 7 | Permissões dos funcionários | Parcial — falta o escopo |
| 8 | Texto definitivo dos termos | **Pendente** — o Anderson ainda enviará o texto |
| 9 | Comunicação comercial e envio dos vouchers | Parcial |
| 10 | Aprovação final para abrir as vendas | Pendente — depende de 1 a 9 |

---

## 1. Data oficial de abertura e encerramento das vendas
**Confirmado**
- Fim das vendas: **31/05/2027**, ou **ao esgotar as 1.000 unidades** (Anderson, 26/10).
- Validade dos vouchers: **01/04/2027 a 15/10/2027, inclusive** (Anderson, 26/10 e 27/10 por escrito). Já está configurada na campanha.

**Falta decidir**
- **Data e hora de abertura.** A intenção de 26/10 era "a partir de 01/11/2026", e hoje é 01/11 sem nada aberto. Qual é a data/hora oficial?
- O encerramento por esgotamento vale mesmo se sobrarem lotes? (Em outras palavras: o fim é o que vier primeiro, 31/05/2027 ou as 1.000 vendidas.)
- Fuso: o horário de abertura vale em Brasília? (A pendência de fuso Brasil/Chile existe nos documentos anteriores.)

**Decisão:** abertura em ____/____/______ às ____:____ (fuso ________). Encerramento: ____________________.

## 2. Lotes de 100 unidades e limite de 1.000 passes
**Confirmado**
- Lotes de **100 em 100**, limite total de **1.000** (10 lotes). A campanha já tem limite global de 1.000. Hoje não existe nenhum lote criado.
- Cada lote é aberto e fechado manualmente pelo ClosetAdmin, e o estoque da variante na Shopify é ajustado à mão para o número recomendado, nunca acima.

**Falta decidir**
- **Quando abre o lote seguinte**: somente quando o anterior esgotar, ou em datas fixas? Quem autoriza cada abertura?
- Existe um limite de passes por cliente ou por pedido? (O sistema não impõe hoje; a Shopify permite quantidade no carrinho.)
- O que fazer se um lote tiver pagamentos pendentes (Pix não pago) quando o estoque zerar?

**Decisão:** abertura dos lotes: ______________________. Limite por cliente/pedido: ______________.

## 3. Cancelamento, arrependimento e reembolso
**Confirmado (Anderson)**
- Arrependimento pela lei (**7 dias**), **a validar juridicamente**.
- **Crédito usado, qualquer parte, não tem reembolso.**
- **Falta de roupa ou de tamanho**: reembolso **integral de R$ 350,00**, pela **mesma forma de pagamento**, em **até 3 dias úteis** após o comparecimento à loja.
- Reembolso **somente integral**; vouchers **intransferíveis**; saldo restante pode ser usado em outras visitas.

**Falta decidir**
- ⚖ **Parecer jurídico** sobre os 7 dias, inclusive se vale "sem reembolso depois de qualquer uso" dentro desse prazo. *Não escrevemos essa condição como definitiva.*
- Quem na loja **confere e autoriza** o reembolso por falta de roupa/tamanho, e como isso fica registrado. (O estorno é feito na Shopify; o ClosetAdmin só registra a revisão.)
- ⚖ Se o voucher já foi usado na visita em que faltou roupa, o reembolso ainda é integral? (As duas regras acima se cruzam e não dizem.)
- Quem executa o estorno dentro dos 3 dias úteis e quem é o substituto.
- Cancelamento pedido pelo cliente depois dos 7 dias sem uso: pode? Em que condição?

**Decisão:** _______________________________________________

## 4. Regras dos 10% de desconto nos passeios
**Confirmado (Anderson)**
- Vale em **passeios e transfers da Valle Experience**, mediante **apresentação do voucher**, **10% sobre o valor final do orçamento**. **O desconto NÃO é automático**: não é cupom, não é código de desconto e não é aplicado pelo sistema nem pela Shopify. O cliente apresenta o voucher e a equipe da Valle Experience confere e aplica manualmente.
- **Hoje nada está implementado**: o benefício é só informativo (PR #165). O site e o e-mail não o prometem.

**Falta decidir** (as 10 perguntas do PR #166, em resumo)
1. Onde vale: só passeios e transfers da Valle Experience, ou mais algum produto/serviço? De qual empresa?
2. Quantas vezes: uma por passe, uma por unidade comprada, ou em todo passeio no período?
3. Quantas pessoas: só o titular ou acompanhantes?
4. Sobre o quê: preço de tabela ou valor líquido? Soma com outras promoções? Vale na mesma compra em que se usa o voucher?
5. Período: 01/04/2027 a 15/10/2027 ou outro? Passeio comprado antes de 01/04 e feito depois vale?
6. Quem aplica na Valle Experience e o que o cliente apresenta (código do voucher, e-mail)?
7. Passe cancelado ou reembolsado perde o direito? E o desconto já concedido?
8. Quem paga o desconto (Valle Experience ou VS BY CLOSET) e como querem o relatório de usos?
9. **Texto oficial** ao cliente e **o que se pode dizer** em redes sociais e WhatsApp até lá.
10. ⚖ Os dados que guardam do cliente na tabela de vendas podem ser compartilhados, ou o sistema registra só a referência da venda (LGPD)?

**Pendência imediata:** a descrição pública do produto Valle Pass na Shopify (e a página do produto na vitrine, que é indexável) cita "10% de desconto – Valle Experience" **sem condições**. Decidir: (a) manter e publicar as condições; (b) retirar a linha até haver texto aprovado; (c) manter e deixar a página sem indexação.

**Decisão:** ________________________________________________

## 5. Quem pode usar os benefícios e quantas vezes
**Confirmado**
- Dois vouchers **por unidade**: **R$ 500,00 Valle Showroom** e **R$ 50,00 VS BY CLOSET**, cada loja concede o seu benefício; o valor de uma loja nunca vira saldo da outra.
- **Intransferíveis** (20/10). **Saldo restante pode ser usado em visitas seguintes** (26/10); o sistema já suporta resgate parcial.
- Prorrogação futura da validade, se houver, vale para **todos** os vouchers.

**Falta decidir**
- ⚖ "Intransferível" significa **titular fixo**? Na loja, será exigido documento ou comprovação da identidade do comprador no resgate?
- Pode ser usado por acompanhante do titular?
- Há valor mínimo de compra ou de resgate por visita?
- Texto ao cliente sobre intransferibilidade (a página do produto hoje fala em "vale-presente… em qualquer peça").

**Decisão:** ________________________________________________

## 6. Responsáveis pela conferência de retenções e substitutos
**Confirmado**
- Responsável pelos pagamentos retidos: **a administração — o próprio Anderson** (26/10).

**Falta decidir**
- **Substituto** (nome/perfil) quando o Anderson não estiver disponível.
- **Canal de aviso** das retenções (hoje elas só aparecem no painel; o aviso ativo em log é opcional e está desligado).
- **Prazo** máximo para resolver uma retenção.

**Decisão:** titular ______________  substituto ______________  canal ______________  prazo ______________

## 7. Permissões dos funcionários para resgates
**Confirmado**
- O Anderson disse que os **funcionários também podem validar** vouchers (26/10).
- Hoje só **ADMIN e SUPER_ADMIN** resgatam; STAFF apenas consulta. Mudar isso exige alteração de código e publicação, com autorização separada.

**Falta decidir**
- **Todos** os funcionários, ou só alguns? Em todas as lojas ou **cada um só na sua** (Valle Showroom ou VS BY CLOSET)? O desenho recomendado é um escopo por empresa por usuário, sem escopo = sem resgate.
- O funcionário pode **reverter** um resgate ou só registrar? (Hoje reversão é de ADMIN.)
- **Valle Experience**: os funcionários dela conferem os 10%? Precisam de acesso ao sistema?

**Decisão:** ________________________________________________

## 8. Texto definitivo dos termos e condições
**Confirmado**
- O Anderson **enviará o texto**, com base nas respostas dele. **Nada foi recebido.** A página dos termos continua em rascunho e desligada (404), e o botão de aceite não existe.

**Falta decidir**
- O **texto oficial** dos termos.
- ⚖ **Revisão jurídica** do texto: arrependimento, reembolso após uso, informação ao consumidor, intransferibilidade.
- Quem **aprova por escrito** o texto final, e quando fica pronto.
- Onde fica publicado e se o cliente precisa **aceitar** antes de pagar.

**Depois de aprovado** (cada passo com autorização expressa): publicar a página e configurar o endereço no site; marcar os termos como aprovados.

**Decisão:** texto recebido em ____/____; parecer jurídico em ____/____; aprovado por ____________.

## 9. Comunicação comercial e envio dos vouchers
**Confirmado**
- O envio dos vouchers por e-mail foi **homologado em 31/10** (assunto, remetente, conteúdo e entrega aprovados no teste do #1015). Hoje o e-mail está em **dry-run**, com 1 destinatário permitido e limite de 1 por dia: nada vai a clientes.
- O e-mail **não menciona os 10%** nem link de termos.

**Falta decidir**
- Paleta do e-mail: **marsala** ou **preto e branco**.
- Quando o e-mail passa a **valer** para clientes (ao abrir o lote 1) e com qual **limite diário** e tamanho de lote.
- Quem pode **reenviar** a um cliente (hoje a recomendação é só SUPER_ADMIN) e se o endereço pode ser alterado.
- **DMARC**: publicar `p=none` no domínio do remetente (ação no DNS, de vocês).
- **Texto de venda**: descrição do produto, redes sociais e WhatsApp. O que pode ser dito sobre os 10% antes do texto oficial?
- Quando e como as **primeiras vendas** serão anunciadas.

**Decisão:** ________________________________________________

## 10. Aprovação final para abertura das vendas
Só com os itens 1 a 9 respondidos. Depois da aprovação, a sequência técnica é feita **um passo por vez, cada um com autorização expressa**:

1. Termos publicados e descrição da Shopify ajustada.
2. DMARC publicado (DNS).
3. E-mail comercial configurado em dry-run e validado.
4. `AUTO_VERIFY` ligado, depois e-mail em `live`, depois alertas (opcional).
5. Lote 1 (100 unidades) criado e aberto no ClosetAdmin; só então o estoque da variante oficial sobe para o número recomendado.
6. Acompanhamento das primeiras vendas, com plano de parada (estoque 0 e fechar o lote).

| Aprovação | Nome | Data | Observação |
|---|---|---|---|
| Comercial (Anderson) | | | |
| Jurídico (termos e reembolso) | | | |
| Técnica (VS BY CLOSET) | | | |

---

# Mensagem curta para o Anderson (WhatsApp)

> Anderson, bom dia. Para abrir as vendas do Valle Pass preciso só destas respostas (pode responder pelo número):
>
> 1) *Abertura*: qual dia e hora oficial? (Fim continua 31/05/2027 ou ao esgotar os 1.000.)
> 2) *Lotes de 100*: o próximo lote abre só quando o anterior esgotar?
> 3) *Reembolso*: o jurídico já validou os 7 dias de arrependimento? Quem confere e autoriza o reembolso integral quando faltar roupa ou tamanho?
> 4) *10% da Valle Experience*: só passeios e transfers? Quantas vezes por passe e para quantas pessoas? Sobre o valor final do orçamento, certo? Quem arca com o desconto?
> 5) *Quem usa*: o voucher é só do titular ou pode ir acompanhante?
> 6) *Retenções de pagamento*: quem é o seu substituto e por onde quer ser avisado?
> 7) *Funcionários*: podem resgatar em todas as lojas, ou cada um só na sua?
> 8) *Termos*: quando consegue enviar o texto final?
> 9) *Divulgação*: pode ficar "10% de desconto" na descrição do produto até termos o texto? Posso mandar o e-mail dos vouchers em preto e branco ou prefere marsala?
>
> Enquanto isso nada é aberto nem vendido. Obrigado!

---

## Anexo: o que não foi decidido por nós
Este documento não define prazos de reembolso, condições dos 10%, texto dos termos nem regras jurídicas. Onde aparece "a validar" ou "falta decidir", a resposta é do Anderson ou do jurídico.
