# ClosetAdmin — guia do dia a dia

Guia rápido para a equipe que usa o painel operacional (`/closetadmin`) no
dia a dia. Para arquitetura técnica, ver [`README.md`](../README.md); para
deploy, ver [`DEPLOYMENT.md`](DEPLOYMENT.md).

## O essencial: o que é (e o que não é) o ClosetAdmin

O ClosetAdmin **não substitui o Shopify Admin**. Ele existe só para o que o
Shopify não faz: calendário de retirada/devolução, peças físicas, reservas
feitas por telefone/presencial, bloqueios de data e histórico do que a equipe
fez no sistema.

| Pergunta a se fazer | Se a resposta for "sim" |
| --- | --- |
| Isso é sobre **produto, preço, foto ou descrição**? | Faça no **Shopify Admin** |
| Isso é sobre **um pedido, pagamento ou reembolso**? | Faça no **Shopify Admin** |
| Isso é sobre **uma peça física específica, uma data bloqueada, ou uma reserva feita por telefone**? | Faça no **ClosetAdmin** |

Nunca crie pedido, pagamento ou reembolso pelo ClosetAdmin — essa
funcionalidade não existe ali de propósito.

## Como entrar

1. Acesse `/closetadmin/login`.
2. Informe **nome**, **telefone** (o mesmo cadastrado para você) e **PIN**.
3. Se errar qualquer um dos três, a mensagem é sempre a mesma
   ("Credenciais inválidas") — isso é proposital, para não revelar a
   ninguém de fora se um telefone existe ou não no sistema.
4. Sua conta só existe se alguém com papel **Administrador** já tiver
   cadastrado seu nome, telefone e PIN. Não há cadastro público.

Três papéis existem, e cada pessoa também tem **módulos** liberados (reservas,
calendário, peças, regras, relatórios, auditoria, Valle Pass):

- **Equipe (STAFF)**: dashboard, calendário, reservas, criar/cancelar reserva
  manual, ver peças.
- **Administrador (ADMIN)**: tudo o que a Equipe vê, mais regras de aluguel,
  bloqueios operacionais e a auditoria completa.
- **Proprietário (SUPER_ADMIN)**: acesso total, inclusive funcionários e
  permissões. Tudo é conferido no servidor a cada ação, não só escondido na tela.

## Calendário

`/closetadmin/calendario` mostra, por dia, cada peça que está em uma das
fases: **preparação → retirada → aluguel → devolução → limpeza**. Use as
setas para navegar por período. Clique em qualquer linha para abrir o
detalhe completo daquela reserva.

## Reservas

`/closetadmin/reservas` lista todas as reservas (online e manuais), com
filtros por status, origem, cliente, telefone e código da peça.

- Reservas com origem **Online** vieram do site — se precisar cancelar uma
  dessas, use o **Shopify Admin** (o cancelamento envolve pedido/pagamento
  reais, que o ClosetAdmin não mexe). A tela de detalhe mostra um link
  direto "Abrir pedido no Shopify".
- Reservas com origem **Manual** podem ser canceladas direto no ClosetAdmin
  (botão "Cancelar reserva" na tela de detalhe) — sempre pedindo um motivo,
  que fica registrado na auditoria.

### Limpar lista — só Administrador

O botão **"Limpar lista"**, ao lado dos filtros, oculta da listagem as
reservas **Expirada** e **Cancelada** mais antigas — só isso, nunca as
outras. Reservas ativas, **Aguardando pagamento** ou **Requer atenção**
nunca são afetadas, mesmo que sejam antigas.

- Nenhuma reserva é apagada do banco nem tem o status alterado — "limpar" é
  só um filtro de listagem por cima do que já existe.
- Depois de confirmar, aparece uma mensagem dizendo quantas foram ocultadas,
  com um botão **"Restaurar lista"** logo ao lado para desfazer aquele lote
  específico.
- A qualquer momento, marque o filtro **"Mostrar arquivadas"** para ver as
  reservas ocultadas junto das demais (elas aparecem com o selo
  "Arquivada"). Na tela de detalhe de qualquer uma delas há também um botão
  individual **"Restaurar reserva"**.

### Como criar uma reserva manual

1. Em Reservas, clique **Nova reserva**.
2. Preencha cliente → escolha as datas → escolha a(s) peça(s) física(s) real
   (o código, não "um sobretudo qualquer") → confira o resumo → confirme.
3. Se a data pedida quebrar alguma regra (por exemplo, menos de 15 dias de
   antecedência), o sistema mostra exatamente qual regra e pede um motivo
   para seguir mesmo assim. Duas reservas nunca podem usar a mesma peça no
   mesmo período — isso nunca pode ser "forçado", nem pela equipe.

## Peças (`/closetadmin/pecas`)

Mostra cada peça física cadastrada, se está ativa, se pode ser reservada
online, e se está ocupada agora. Só **Administrador** pode alterar esses
três campos. Nome, preço, foto e descrição da peça continuam vindo do
Shopify — não têm campo editável aqui de propósito.

## Regras e bloqueios (`/closetadmin/regras`) — só Administrador

Duas seções na mesma tela:

- **Regras de aluguel** — antecedência mínima, dias de preparação/limpeza,
  máximo de peças, temporada bloqueada, tabela de duração por quantidade de
  peças. Qualquer alteração aqui vale imediatamente para o site público e
  para reservas manuais — não precisa de deploy.
- **Bloqueios operacionais** — bloquear a loja inteira (feriado, manutenção,
  evento) ou uma peça específica (fora de operação) por um período. Um
  bloqueio afeta de verdade a disponibilidade — o site público e a criação
  de reserva manual respeitam ele, não é só um aviso visual.

## Auditoria (`/closetadmin/auditoria`) — só Administrador

Histórico de login/logout, reservas manuais criadas/canceladas, peças
ativadas/desativadas, regras alteradas e bloqueios criados/removidos — quem
fez, quando, e o que mudou. Nunca aparece PIN, senha ou qualquer token ali.

## Valle Pass 2027 (`/closetadmin/valle-pass`) — módulo "Valle Pass"

Só aparece para quem tem o módulo **Valle Pass** liberado (o Proprietário sempre tem). **Hoje as vendas estão fechadas**: a vitrine mostra "Em breve", o estoque da variante na Shopify é 0 e as chaves de emissão e de e-mail estão desligadas de propósito. O app **nunca escreve na Shopify**.

O que cada área mostra:

- **Pronta para vender?** — lista de pendências técnicas e comerciais (aprovado / pendente / bloqueado, com responsável e próximo passo). Só leitura; nada aqui abre a venda.
- **Cartão da campanha** — preço (R$ 350), **Vendidos** (unidades emitidas e não canceladas, a mesma conta do painel de capacidade; o histórico de cancelados aparece em nota abaixo, nada é apagado), **Validade** (datas oficiais quando configuradas; **"A definir"** quando não há datas, e nesse caso todo pagamento fica **retido**, não emitido; "N dias após a compra" só em campanhas do modelo antigo) e limite.
- **Capacidade e lotes** — limite global de 1.000 unidades, lotes de 100; um lote só abre com limite global definido e nunca reabre depois de encerrado.
- **Benefícios** — dois vouchers independentes por unidade: **R$ 500 Valle Showroom** e **R$ 50 VS BY CLOSET**, mais o desconto informativo de 10% (sem código nem saldo).
- **Pedidos na Shopify / Pagamentos retidos** — o que foi pago, o que emitiu e o que ficou retido (com motivo). Retido nunca é descartado por SQL: resolver ou descartar só depois do estorno na Shopify.
- **Saldo e resgate** — consultar pelo código, **resgate parcial ou total** ("Usar saldo total" só preenche o campo), referência obrigatória, confirmação digitando o valor de novo, conferência de identidade opcional (fica no histórico), reversão com justificativa. Resgate e reversão são do **Administrador**; a Equipe só consulta (ou resgata só na loja em que foi autorizada, pelo Proprietário).
- **Reembolsos e alertas** — reembolso é sempre feito na Shopify; aqui fica a revisão (uso bloqueado até a decisão) e o alerta de cancelamento com crédito já usado.
- **E-mails** — fila, tentativas e entregas; com o envio desligado nada sai.

Os logs da API não registram dados pessoais; a auditoria registra quem fez cada ação.

## Exportar em PDF

Três lugares para gerar um PDF pronto para imprimir ou enviar:

- **Detalhe de uma reserva** → botão "Exportar PDF" no topo da tela.
- **Lista de reservas** → botão "Exportar PDF" abre um período (de/até) e
  gera o relatório das reservas daquele intervalo, respeitando os filtros já
  aplicados na tela.
- **Dashboard** → botão "Relatório do dia (PDF)": retiradas e devoluções de
  hoje, e as próximas dos dias seguintes.

O PDF é só uma cópia para consulta/impressão no momento em que é gerado — o
sistema (Postgres) continua sendo a fonte real. Nada fica salvo a partir do
PDF; gerar de novo sempre traz os dados atuais.
