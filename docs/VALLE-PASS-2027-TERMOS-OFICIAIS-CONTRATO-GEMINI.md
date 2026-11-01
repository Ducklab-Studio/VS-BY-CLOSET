# Valle Pass 2027 — termos oficiais: contrato de apresentação para o frontend (Gemini)

> Complementa `VALLE-PASS-2027-ACEITE-INTEGRACAO-GEMINI.md` (fluxo e endpoints do aceite, já implementado no #187). Este documento define **qual texto exibir e como provar que é o texto certo**. Nenhum arquivo de frontend foi alterado por quem escreveu este contrato.

## 1. Documento oficial
| | |
|---|---|
| Versão oficial | **`2027-1`** |
| Localização | `docs/termos/oficial/2027-1.md` (Markdown, UTF-8, LF) |
| SHA-256 (dos bytes do arquivo) | `9d1a283f1ec5c32e96aba3baeb8dd9d56c06f8447bf6a70edb6a3585a8e482ae` |
| Manifesto | `docs/termos/oficial/manifest.json` |
| Conferência | `node scripts/terms-official.mjs` |
O que a API devolve em `GET /public/vale-pass/terms` (`version` e `sha256`) **precisa ser igual** a estes valores quando a Railway for configurada. A API **não** entrega o texto.

## 2. Requisitos de apresentação
1. **Texto fiel e integral.** Renderize o conteúdo do arquivo oficial. É proibido reescrever, resumir, reordenar, corrigir ortografia, trocar "Valle By Closet", completar datas ou acrescentar cláusulas. Estilo (tipografia, espaçamento, cores) é livre.
2. **Sem tipografia automática** que altere caracteres do texto (aspas inteligentes, hifenização forçada que altere o texto copiado, conversão de `R$` etc.). O texto copiado pelo usuário deve ser o do arquivo.
3. **Numeração e hierarquia preservadas**: `##` seções 1 a 8, `###` subseções 5.1–5.4, listas com marcadores e alíneas a–e como no original. O título e a assinatura ("GRUPO VALLE …") aparecem.
4. Mostrar **"Versão 2027-1"** na página e na caixa de aceite ("Li e aceito os Termos e Condições do Valle Pass 2027 (versão 2027-1)").
5. **Conferência de hash obrigatória.** O texto exibido deve ser a origem do hash: no build (ou em teste automatizado) calcule o SHA-256 dos **bytes do arquivo-fonte** usado pela página e **falhe o build** se divergir de `9d1a283f…82ae` ou do `sha256` esperado. Em tempo de execução, se `GET /public/vale-pass/terms` devolver um `sha256` **diferente** do hash do texto embutido, **não habilite o aceite nem a compra** (mostre indisponível): é sinal de versão trocada num dos lados. Hoje o `VallePassTermsBox` apenas repassa o `sha256` da API e **não** faz essa conferência.
6. **Fonte do texto no site.** O app `apps/marketing` pode não enxergar `docs/` no build da Vercel (diretório raiz do projeto). Escolha uma de duas formas e documente: (a) importar o arquivo de `docs/termos/oficial/` se a Vercel incluir arquivos fora do diretório raiz; (b) manter uma **cópia byte a byte** dentro de `apps/marketing` com teste que compara o hash da cópia com o do manifesto. Nunca editar a cópia.
7. Se o texto de uma versão futura mudar (2027-2), a página, a caixa e o teste passam a usar o novo arquivo e hash; **a 2027-1 nunca é editada**.

## 3. Estados que dependem da configuração (nada muda sozinho)
| Situação | Comportamento esperado |
|---|---|
| Hoje: API sem termos configurados (`404 TERMS_NOT_APPROVED`) | página de termos continua 404 e o botão de compra desabilitado, como está |
| API configurada, `sha256` ≠ hash embutido | aceite e compra indisponíveis; registrar o erro para a equipe (sem expor o hash na tela) |
| API configurada e hashes iguais | exibir o texto, a caixa **desmarcada** e o fluxo do #187 |
`TERMS_APPROVED`, `VALE_PASS_TERMS_PAGE` e a URL pública **não** são alterados por este contrato: dependem de autorização expressa.

## 4. Testes sugeridos (frontend)
1. O hash do texto usado pela página é `9d1a283f…82ae`.
2. Todas as 36 itens numerados (seções e cláusulas) aparecem na ordem, e os valores `R$ 350,00`, `R$ 500,00`, `R$ 50,00`, `10%`, `31 de maio de 2027`, `7 (sete) dias` e `3 (três) dias úteis` estão no texto exibido.
3. `sha256` diferente vindo da API ⇒ compra indisponível.
4. Mobile 375 px: leitura do texto sem rolagem horizontal; foco e leitor de tela percorrem as seções.
5. A caixa continua nunca pré-marcada e o botão desabilitado até marcar.

## 5. Mudanças de texto
Pertencem ao Anderson. Qualquer correção sugerida (ver `VALLE-PASS-2027-TERMOS-OFICIAIS-PUBLICACAO.md` §7) vira uma **nova versão**; o frontend nunca corrige o texto por conta própria.
