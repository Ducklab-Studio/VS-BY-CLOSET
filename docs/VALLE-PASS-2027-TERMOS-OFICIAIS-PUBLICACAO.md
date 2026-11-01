# Valle Pass 2027 — termos oficiais: preparação da publicação fiel (versão 2027-1)

> **Nada foi publicado nem ativado.** `TERMS_APPROVED` continua `false`, a página `/termos-valle-pass` continua 404, nenhuma variável da Railway ou da Vercel foi tocada, estoque 0, sem vendas, sem e-mails. Este PR só adiciona o arquivo oficial, o manifesto, uma verificação de integridade e documentação.
> **Texto usado:** exatamente o documento enviado pelo Anderson (Seção A). **A proposta revisada (`docs/termos/VALLE-PASS-2027-TERMOS-PROPOSTA-REVISADA.md`) NÃO é texto oficial.** Qualquer mudança de texto é comunicada ao Anderson e entra como **nova versão** (2027-2…), nunca editando a 2027-1.

## 1. O documento original está completo?
**Sim.** Comparação programática entre a Seção A do arquivo original (`VALLE_PASS_2027_TERMOS_PARA_CLAUDE.md`) e o texto de `docs/termos/TERMOS_RECEBIDOS_ANDERSON_2026-11-01.md`:
- 134 linhas e 7.143 caracteres nos dois (após normalizar quebra de linha); **textos idênticos**.
- As 36 itens numerados (seções e cláusulas) do original (1.1 a 8, incluindo 5.1–5.4 e as alíneas a–e) estão todas presentes e **na mesma ordem**.
- Os cabeçalhos (`## 1.` … `## 8.`) e a assinatura "GRUPO VALLE" estão presentes. Nada foi cortado nem resumido.
- A **Seção B** (decisões complementares) e a **Seção C** (pontos de revisão) do arquivo do Anderson **não fazem parte do texto dos termos** e não foram incluídas; são instruções de trabalho.

## 2. Versão oficial, arquivo e hash
| Item | Valor |
|---|---|
| Identificação imutável | **`2027-1`** (padrão aceito pela API: `[A-Za-z0-9._-]`, até 32) |
| Arquivo | `docs/termos/oficial/2027-1.md` |
| SHA-256 | **`9d1a283f1ec5c32e96aba3baeb8dd9d56c06f8447bf6a70edb6a3585a8e482ae`** |
| Tamanho | 7.381 bytes |
| Codificação | UTF-8, **sem BOM** |
| Quebra de linha | **LF** (nunca CRLF) |
| Normalização | O texto da Seção A foi copiado sem nenhuma alteração de palavras, pontuação ou espaçamento interno. Únicas normalizações: quebras de linha → LF; remoção de espaços/linhas em branco **ao final do arquivo**; **exatamente um LF final**. O hash é o SHA-256 **dos bytes do arquivo** (não do texto renderizado). |
| Estabilidade do hash | `.gitattributes` (`docs/termos/oficial/* text eol=lf`) impede que o Git no Windows converta o arquivo para CRLF no checkout. |
O mesmo hash foi obtido de duas formas independentes: direto da Seção A do arquivo original e dos bytes gravados no repositório.

**Imutabilidade.** O manifesto (`docs/termos/oficial/manifest.json`) registra versão, arquivo, hash e tamanho. O teste `terms-official.test.ts` fixa o hash da 2027-1 **dentro do próprio teste**: mudar o texto exige alterar teste e manifesto e criar uma nova versão. Mutação conferida: trocar um único valor no texto derruba 4 testes e o script. Para conferir a qualquer momento: `node scripts/terms-official.mjs` (somente leitura).

## 3. Configuração exigida pelo backend (PR #186, já na `main`)
| Variável (serviço `@valle/reservations-api`) | Valor para a 2027-1 | Efeito |
|---|---|---|
| `VALE_PASS_TERMS_VERSION` | `2027-1` | versão vigente publicada em `GET /public/vale-pass/terms` |
| `VALE_PASS_TERMS_SHA256` | `9d1a283f…82ae` (completo acima) | hash vigente; entra no token assinado |
| `VALE_PASS_TERMS_TOKEN_SECRET` | segredo novo, ≥ 32 caracteres, **gerado só para isto** (ex.: `openssl rand -hex 32`) | assinatura do token. **Nunca** colocar no repositório, em chat ou em log |
| `VALE_PASS_TERMS_ACCEPTANCE` | `on` | **só esta** liga as rotas públicas e a verificação |
| `VALE_PASS_TERMS_TOKEN_TTL_MIN` | opcional (padrão 360) | validade do token |
| `VALE_PASS_TERMS_REQUIRED` | **não definir agora** | retém pedido pago sem aceite verificado |

**Nada se ativa sozinho.** Verificado por teste (`terms-official.test.ts` e os testes do #186): versão + hash + segredo **sem** `VALE_PASS_TERMS_ACCEPTANCE=on` não aprovam nada (as rotas seguem 404); com a ativação ligada a exigência **continua desligada** (`required = false`) até `VALE_PASS_TERMS_REQUIRED=on`. Nenhuma configuração abre vendas: o que vende é o estoque da variante na Shopify (0), o estado de venda e o `TERMS_APPROVED` do site, todos fora deste PR.

## 4. Conteúdo do `GET /public/vale-pass/terms`
Com a configuração acima e a ativação ligada: `200 {"version":"2027-1","sha256":"9d1a283f…82ae","acceptanceRequired":false,"tokenTtlMinutes":360}`. **A API não serve o texto**: só versão e hash. O texto fica em `docs/termos/oficial/2027-1.md` e o site precisa exibi-lo e provar que ele corresponde ao hash (ver contrato do Gemini).

## 5. Instruções para a Railway (NÃO executadas; exigem autorização expressa a cada passo)
Pré-condições: (a) registro formal do Anderson/advogado anexado (ver §7); (b) o site já exibe o texto oficial com a conferência de hash (Gemini); (c) autorização do dono do projeto.
1. **Gerar o segredo localmente** e guardá-lo só no cofre/Railway. Não imprimir.
2. **Definir `VERSION`, `SHA256` e `TOKEN_SECRET`** (sem `ACCEPTANCE`). Efeito esperado: `GET /public/vale-pass/terms` ainda **404**. Cada alteração de variável na Railway reinicia o serviço (breve indisponibilidade da API).
3. **Definir `VALE_PASS_TERMS_ACCEPTANCE=on`.** Efeito: `GET` passa a 200 e `POST` a emitir tokens. Não abre vendas.
4. **Compra de teste de baixo valor, com autorização**, para provar que o atributo chega ao webhook (`proven: true` no ClosetAdmin).
5. **Só depois**, decidir `VALE_PASS_TERMS_REQUIRED=on`.
Modelo de comando (sempre com os identificadores explícitos; o valor do segredo vem de um arquivo/entrada segura, nunca digitado em histórico):
`railway variables --set "VALE_PASS_TERMS_VERSION=2027-1" --set "VALE_PASS_TERMS_SHA256=<hash>" -p 6b943c59-89da-4371-b5a2-1641056941b9 -e 8872a5a3-2457-444d-b434-df29b8825394 -s "@valle/reservations-api"`
Rollback: remover `VALE_PASS_TERMS_ACCEPTANCE` (e `REQUIRED`) restaura 404 e interrompe novas retenções; retenções já abertas são resolvidas por um ADMIN.

## 6. O que falta para PUBLICAR a página (fora deste PR)
Frontend (Gemini): página `/termos-valle-pass` com o texto oficial e conferência do hash; depois, com autorização, `TERMS_APPROVED`, `VALE_PASS_TERMS_PAGE=on` e a URL pública. **Publicar os termos não abre vendas** e continua dependendo da liberação separada do estoque e do lote.

## 7. Inconsistências e pontos a comunicar ao Anderson (o texto NÃO foi alterado)
Detalhes e fontes na matriz de `docs/termos/VALLE-PASS-2027-TERMOS-REVISAO-E-PLANO.md` §3. Resumo:
1. **"Valle By Closet"** no texto × **"VS BY CLOSET"** no site, nos vouchers e nos e-mails. Confirmar se é a mesma empresa e qual nome usar.
2. **3.1** diz que as vendas "terão início em 1º de novembro de 2026"; hoje a venda ainda não abriu. Confirmar a data efetiva.
3. **4.1** diz "datas de utilização previamente estabelecidas e informadas"; a decisão registrada é **01/04/2027 a 15/10/2027**, que não aparece no texto.
4. **Intransferibilidade** e **conferência de identidade** (decididas) não constam no texto.
5. **10%**: o texto não limita a uso único, ao titular, a passeios e transfers nem ao valor final do orçamento (decisões comunicadas) e não trata acumulação nem passeio cancelado.
6. **5.3(d) e 6.3** dependem de saber se o desconto de 10% foi usado; o **sistema não registra** esse uso (hoje seria conferência manual).
7. **Moeda:** créditos em R$ para aluguel em Santiago, sem regra de câmbio.
8. **5.4:** diz "100% do valor efetivamente pago, correspondente a R$ 350,00"; se algum dia o preço pago for diferente, as duas expressões divergem.
9. **Cláusula 8** declara o aceite, mas isso não prova clique; o aceite eletrônico (#186/#187) é o mecanismo de prova.
10. Faltam identificação do fornecedor (razão social, CNPJ), canais oficiais, lei aplicável e foro.
11. O texto não menciona o prazo operacional de entrega dos vouchers (3 dias após o pagamento) que o sistema acompanha.
12. O arquivo recebido do Anderson ainda traz o rótulo "pendente de conferência comercial e revisão jurídica"; a autorização foi **informada** pelo dono do projeto. Recomenda-se anexar o registro formal (e-mail/mensagem do Anderson e do advogado indicando a versão 2027-1 e o hash).
**Processo de mudança:** qualquer alteração sugerida vira nova versão proposta, comunicada diretamente ao Anderson; só depois de aprovada recebe número novo (2027-2), arquivo novo e hash novo. A 2027-1 permanece como está.

## 8. Veredito
**GO para publicar os termos oficiais (versão 2027-1) sem abrir vendas**, condicionado a: registro formal da autorização anexado, página do Gemini com conferência de hash e autorização expressa para cada passo de configuração. **NO-GO** para ligar `VALE_PASS_TERMS_REQUIRED` e para qualquer abertura de vendas neste momento.
