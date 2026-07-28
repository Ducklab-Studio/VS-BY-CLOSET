# Deploy em produção

O site é um container Next.js atrás de um proxy reverso com HTTPS automático.
Não há banco de dados nem API própria: o **Booqable** é o backend de negócio.

```
Internet ──► Caddy :443 ──► web :3000 ──► (navegador fala com o Booqable)
             (SSL auto)
```

Como o site é stateless, deploy nunca corre risco de perder dado e escalar é
só subir mais réplicas.

## Divisão de responsabilidades

| No Booqable | Neste site |
| --- | --- |
| Catálogo e fotos dos produtos | Design, marca e navegação |
| Estoque e disponibilidade por data | Páginas institucionais e FAQ |
| Carrinho, checkout e pagamento | SEO e performance |
| Clientes, pedidos e contratos | Textos de política e contato |
| Preço por período e caução | — |

Você administra a loja pelo painel do Booqable. Este repositório não tem
painel administrativo.

---

## 1. Configurar o Booqable

Antes de subir o site, a conta precisa existir e ter produtos.

1. Crie a conta em [booqable.com](https://booqable.com). O plano **Start**
   ($29/mês) já cobre esta integração — API só é necessária em cenários
   headless, que não é o caso aqui.
2. Cadastre os produtos como **itens de aluguel** (*rental products*), não
   como *sales items* — a operação é exclusivamente de locação.
3. Vá em **Settings → Online Bookings → Website integration → Custom
   websites** e copie o identificador da conta (a parte antes de
   `.booqable.com`).
4. Em **Settings → Online Bookings**, adicione o domínio do site à lista de
   domínios permitidos — sem isso os componentes não carregam em produção.

> Operação só de locação joga a favor: o Booqable é desenhado para isso, e a
> exigência de datas em todo pedido — que atrapalharia uma venda avulsa —
> aqui é exatamente o comportamento desejado.

## 2. Preparar o servidor

Requisitos: 1 vCPU e 1 GB de RAM bastam — o site é estático em essência.
Ubuntu 22.04 ou 24.04.

```bash
curl -fsSL https://get.docker.com | sh
```

```bash
sudo usermod -aG docker $USER && newgrp docker
```

```bash
sudo ufw allow 22,80,443/tcp && sudo ufw enable
```

A porta 80 precisa ficar aberta mesmo em site só-HTTPS: é por ela que o
Let's Encrypt valida o domínio.

## 3. Apontar o domínio

| Tipo | Nome  | Valor            |
| ---- | ----- | ---------------- |
| A    | `@`   | `IP_DO_SERVIDOR` |
| A    | `www` | `IP_DO_SERVIDOR` |

Confirme a propagação antes de seguir:

```bash
dig +short valleshowroom.com.br
```

## 4. Configurar e subir

```bash
git clone <seu-repo> /opt/valle && cd /opt/valle && cp .env.production.example .env
```

Preencha `DOMAIN`, `ACME_EMAIL` e `BOOQABLE_COMPANY`. Depois:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

> `BOOQABLE_COMPANY` é embutida no bundle em tempo de build. Trocar a conta
> exige **rebuild** (`docker compose build`), não apenas restart.

## 5. Verificar

```bash
curl -I https://valleshowroom.com.br
```

Abra o site e confirme que o catálogo carrega. Se aparecerem espaços vazios no
lugar dos produtos, veja a tabela de diagnóstico no fim desta página.

---

## Atualizações

```bash
git pull && ./scripts/deploy.sh
```

O script reconstrói a imagem e só reporta sucesso depois que o healthcheck
passa. Alterações de catálogo e preço não precisam de deploy — são feitas no
painel do Booqable e aparecem na hora.

---

## Onde cada componente é usado

Os componentes do Booqable são divs com classe própria que o script deles
hidrata. Estão encapsulados em `<BooqableEmbed>`:

| Componente | Página | Papel |
| --- | --- | --- |
| `datepicker` | Home, Catálogo, Como funciona | Define o período e ativa a disponibilidade real |
| `product-list` | Home, Catálogo | Grade de produtos |
| `collections` | Home, Catálogo | Navegação por categoria |
| `product-search` | Catálogo | Busca |
| `sort` | Catálogo | Ordenação |
| `sidebar` | Header | Carrinho |

Para adicionar em outra página:

```tsx
import { BooqableEmbed } from '@/components/booqable/BooqableEmbed';

<BooqableEmbed component="product-list" limit={8} perPage={8} />
```

Sem `NEXT_PUBLIC_BOOQABLE_COMPANY` definida, cada um renderiza um placeholder
identificado em vez de espaço vazio — útil durante o desenvolvimento.

---

## Diagnóstico

| Sintoma | Causa provável |
| --- | --- |
| Componentes aparecem como placeholder | `NEXT_PUBLIC_BOOQABLE_COMPANY` não definida, ou definida sem rebuild da imagem. |
| Espaço vazio no lugar dos produtos | O script não carregou. Abra o console: bloqueio de CSP aponta para `next.config.mjs`; erro 404 no script indica identificador de conta errado. |
| Funciona na home, quebra ao navegar | Reinit do Booqable falhou na navegação client-side. Veja `refreshBooqable()` em `src/lib/booqable.ts` — os nomes de método são tentativas, pois a API não é documentada. |
| Componentes somem em produção mas funcionam local | Domínio não autorizado no Booqable (Settings → Online Bookings). |
| Certificado não emite | DNS não propagou ou porta 80 fechada. |
