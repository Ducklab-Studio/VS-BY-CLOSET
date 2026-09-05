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

Dois papéis existem:

- **Equipe (STAFF)**: dashboard, calendário, reservas, criar/cancelar reserva
  manual, ver peças.
- **Administrador (ADMIN)**: tudo o que a Equipe vê, mais regras de aluguel,
  bloqueios operacionais e a auditoria completa.

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
