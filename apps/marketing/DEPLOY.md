# Deploy — apps/marketing

O deploy sai **de dentro desta pasta**, não da raiz do monorepo:

```bash
cd apps/marketing
npx vercel          # preview
npx vercel --prod   # produção
```

## Por que daqui e não da raiz

A Vercel detecta o framework pelo `package.json` do diretório em que roda.
Da raiz ela não encontra o `next` (que está aqui) e falha com *"No Next.js
version detected"*, mesmo com `buildCommand` apontando pro lugar certo.

## Por que `installCommand` usa npm e não pnpm

A Vercel escolhe o gerenciador pelo lockfile presente. O `pnpm-lock.yaml`
fica na raiz do monorepo, que não sobe neste deploy — sem lockfile ela caía
num pnpm antigo que quebra com Node 20+ (`ERR_INVALID_THIS: Value of "this"
must be of type URLSearchParams` ao consultar o registry).

Isso só é seguro porque esta pasta **não depende de nenhum pacote interno**
do workspace (`grep workspace: package.json` → nada). Se um dia passar a
depender, este atalho quebra e o caminho certo vira integração com Git +
Root Directory (abaixo).

## Por que `outputDirectory` está explícito

Uma primeira tentativa de deploy foi feita da raiz e gravou
`apps/marketing/.next` nas configurações do projeto na Vercel. Essa
configuração fica do lado deles e não some ao apagar o `vercel.json` local
— por isso o valor certo precisa vir declarado aqui.

## O caminho melhor, quando houver repositório remoto

Hoje o projeto não tem `git remote`. Quando tiver, o setup correto é
conectar o repositório na Vercel e definir **Root Directory =
`apps/marketing`** nas configurações do projeto. Aí ela usa o pnpm do
monorepo, aproveita o lockfile, e cada push vira deploy — e este
`vercel.json` pode sumir.

## Variáveis de ambiente

Precisam ser cadastradas no painel da Vercel (não sobem do `.env.local`):

```
NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN
NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN
NEXT_PUBLIC_SHOPIFY_STORE_URL
NEXT_PUBLIC_SITE_URL
```

Sem as duas primeiras o site sobe normalmente, mas o catálogo aparece
vazio com um aviso — de propósito, em vez de erro.
