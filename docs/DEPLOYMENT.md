# Deploy

O site e o Booqable são **duas coisas separadas**, hospedadas em lugares
diferentes, que se conversam por um script no navegador.

```
   SEU SITE                                    BOOQABLE
   Next.js → Vercel                            já no ar em booqable.com
   (este repositório)                          (você só configura a conta)
        │                                             │
        └─────────────── script JS ───────────────────┘
                    carregado no navegador
                       do visitante
```

Você **não sobe nada para dentro do Booqable**. Ele já existe como serviço; o
que se faz lá é cadastrar produtos e autorizar o domínio.

---

## Parte 1 — Configurar o Booqable

1. Crie a conta em [booqable.com](https://booqable.com). O plano **Start**
   ($29/mês) atende — API só é necessária em cenário headless, que não é o caso.
2. Cadastre os produtos como **itens de aluguel** (_rental products_), não como
   _sales items_. A operação é exclusivamente de locação.
3. Em **Settings → Online Bookings → Website integration → Custom websites**,
   copie o identificador da conta (a parte antes de `.booqable.com`).
4. Ainda em **Online Bookings**, adicione o domínio do site à lista de domínios
   permitidos.

> O passo 4 é o que mais pega gente desprevenida: sem ele o site funciona
> localmente e os componentes somem em produção.

---

## Parte 2 — Publicar o site na Vercel

A Vercel é a empresa que criou o Next.js — o encaixe é nativo, e um site
deste tamanho cabe no plano gratuito.

### 1. Subir o código para o GitHub

```bash
gh repo create valles-closet --private --source=. --push
```

Ou crie o repositório pela interface do GitHub e faça o push manual.

### 2. Importar na Vercel

Em [vercel.com/new](https://vercel.com/new), conecte o GitHub e selecione o
repositório. O `vercel.json` na raiz já define build, install e região
(São Paulo) — não é preciso configurar nada na interface.

### 3. Definir as variáveis de ambiente

Em **Settings → Environment Variables**, adicione:

| Variável | Valor |
| --- | --- |
| `NEXT_PUBLIC_BOOQABLE_COMPANY` | o identificador copiado no passo 3 acima |
| `NEXT_PUBLIC_SITE_URL` | `https://seudominio.com.br` |

> Variáveis `NEXT_PUBLIC_*` são **embutidas no bundle durante o build**. Alterar
> qualquer uma exige um novo deploy — mudar o valor e salvar não basta.

### 4. Ligar o domínio

Em **Settings → Domains**, adicione o domínio. A Vercel mostra os registros DNS
a criar no seu provedor:

| Tipo | Nome | Valor |
| --- | --- | --- |
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

O HTTPS é emitido e renovado automaticamente.

### 5. Voltar ao Booqable

Autorize o domínio final em **Settings → Online Bookings** (o passo 4 da
Parte 1). Sem isso, os componentes não carregam no site publicado.

### Deploys seguintes

```bash
git push
```

A Vercel constrói e publica sozinha. Cada pull request ganha uma URL de preview
própria.

**Mudanças de catálogo, preço ou disponibilidade não exigem deploy** — são
feitas no painel do Booqable e aparecem no site imediatamente.

---

## Alternativa — Hostinger

Funciona, mas o plano importa. Node.js não está disponível em todos eles.

| Plano | Node.js | Como publicar |
| --- | --- | --- |
| Premium (compartilhada) | ❌ Não | Só pelo **build estático** (abaixo) |
| Business / Cloud | ✅ Sim | Node.js gerenciado, deploy pelo GitHub |
| VPS | ✅ Sim | Docker (seção seguinte) ou Node direto |

### Build estático — funciona em qualquer plano

Este site não busca nada no servidor: todo o comércio acontece no navegador,
via Booqable. Isso permite gerar **HTML puro**, que roda até na hospedagem
compartilhada mais barata — sem Node, sem processo para cair.

```bash
pnpm --filter @loja/web build:static
```

Gera `apps/web/out/` (~1,5 MB). Suba o **conteúdo** dessa pasta para
`public_html` via Gerenciador de Arquivos ou FTP.

O `.htaccess` vai junto e já configura HTTPS obrigatório, redirecionamento de
`www`, cabeçalhos de segurança e cache. Confirme que arquivos ocultos estão
visíveis no gerenciador, senão ele não é enviado.

> Defina `NEXT_PUBLIC_SITE_URL` e `NEXT_PUBLIC_BOOQABLE_COMPANY` **antes** de
> gerar o build — as duas são gravadas no HTML nesse momento:
>
> ```bash
> NEXT_PUBLIC_SITE_URL=https://seudominio.com.br NEXT_PUBLIC_BOOQABLE_COMPANY=suaconta pnpm --filter @loja/web build:static
> ```

**O que se perde:** cada alteração do site exige gerar e subir tudo de novo, na
mão. Não há deploy automático por `git push` nem preview de branch. Mudanças de
catálogo e preço continuam instantâneas, porque vêm do Booqable.

### Business ou Cloud — Node.js gerenciado

Em **hPanel → Websites → Node.js**, aponte para o repositório do GitHub e
configure:

- Comando de build: `pnpm --filter @loja/web build`
- Diretório da aplicação: `apps/web`
- Comando de start: `pnpm --filter @loja/web start`

Defina `NEXT_PUBLIC_BOOQABLE_COMPANY` e `NEXT_PUBLIC_SITE_URL` nas variáveis de
ambiente do painel.

---

## Alternativa — VPS com Docker

O repositório também traz uma stack Docker completa, caso você prefira servidor
próprio.

```
Internet ──► Caddy :443 ──► web :3000
             (SSL automático)
```

```bash
cp .env.production.example .env
```

Preencha `DOMAIN`, `ACME_EMAIL` e `BOOQABLE_COMPANY`, aponte o DNS para o IP do
servidor e execute:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Atualizações depois disso:

```bash
git pull && ./scripts/deploy.sh
```

Requisitos: 1 vCPU e 1 GB de RAM bastam. Portas 80 e 443 abertas — a 80
precisa ficar aberta mesmo em site só-HTTPS, pois é por ela que o Let's Encrypt
valida o domínio.

**Quando escolher esta opção:** exigência de manter tudo em infraestrutura
própria. Para o caso comum, a Vercel sai mais simples e mais barata, já que o
site não tem backend nem banco.

---

## Onde cada componente do Booqable é usado

São divs com classe própria que o script deles hidrata, encapsuladas em
`<BooqableEmbed>`:

| Componente | Página | Papel |
| --- | --- | --- |
| `datepicker` | Home, Catálogo, Como funciona | Define o período e ativa a disponibilidade real |
| `product-list` | Home, Catálogo | Grade de produtos |
| `collections` | Home, Catálogo | Navegação por categoria |
| `product-search` | Catálogo | Busca |
| `sort` | Catálogo | Ordenação |
| `sidebar` | Header | Carrinho |

Para usar em outra página:

```tsx
import { BooqableEmbed } from '@/components/booqable/BooqableEmbed';

<BooqableEmbed component="product-list" limit={8} perPage={8} />
```

Sem `NEXT_PUBLIC_BOOQABLE_COMPANY` definida, cada um renderiza um placeholder
identificado em vez de espaço vazio.

---

## Diagnóstico

| Sintoma | Causa provável |
| --- | --- |
| Componentes aparecem como placeholder | `NEXT_PUBLIC_BOOQABLE_COMPANY` não definida, ou definida sem novo deploy. |
| Funciona local, quebra em produção | Domínio não autorizado no Booqable (Settings → Online Bookings). |
| Espaço vazio no lugar dos produtos | O script não carregou. Veja o console: bloqueio de CSP aponta para `next.config.mjs`; 404 no script indica identificador errado. |
| Funciona na home, quebra ao navegar | Reinit do Booqable falhou na navegação client-side. Veja `refreshBooqable()` em `src/lib/booqable.ts` — os nomes de método são tentativas, pois a API não é documentada. |
| Domínio não valida na Vercel | DNS ainda propagando. Confira com `dig +short seudominio.com.br`. |
