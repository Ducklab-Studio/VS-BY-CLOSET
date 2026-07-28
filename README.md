# 🛍️ Loja E-commerce de Roupas

E-commerce profissional, moderno, responsivo e escalável. Monorepo com frontend
**Next.js**, backend **NestJS** e banco **PostgreSQL** via **Prisma**.

> **Status:** Fundação de produção (Fase 1) pronta e executável. As demais features
> seguem o [ROADMAP](docs/ROADMAP.md) — a arquitetura já está preparada para todas elas.

---

## 🧱 Stack

| Camada        | Tecnologias                                            |
| ------------- | ------------------------------------------------------ |
| Frontend      | Next.js 15 (App Router), React 18, TypeScript, Tailwind |
| Backend       | NestJS 10, TypeScript, Passport JWT, class-validator    |
| Banco         | PostgreSQL 16 + Prisma ORM 5                            |
| Auth          | JWT (access) + Refresh Token rotativo, Argon2           |
| Infra (dev)   | Docker Compose (Postgres + Redis)                       |
| Deploy        | VPS Hostinger (PM2 + Nginx) — ver [DEPLOYMENT](docs/DEPLOYMENT.md) |

## 📁 Estrutura do monorepo

```
.
├── apps/
│   ├── api/          # Backend NestJS (REST /api/v1)
│   └── web/          # Frontend Next.js
├── packages/
│   └── database/     # Schema Prisma + client compartilhado + seed
├── docs/             # Arquitetura, deploy, roadmap
├── docker-compose.yml
└── .env.example
```

## 🚀 Começando (desenvolvimento)

Pré-requisitos: **Node 20+**, **pnpm 10+**, **Docker** (ou um Postgres local).

```bash
# 1. Instalar dependências
pnpm install

# 2. Configurar variáveis de ambiente
cp .env.example .env        # Windows: copy .env.example .env

# 3. Subir o banco (Postgres + Redis)
pnpm docker:up

# 4. Gerar o client e aplicar o schema
pnpm db:generate
pnpm db:migrate             # cria as tabelas
pnpm db:seed                # popula admin, produtos e cupom demo

# 5. Rodar tudo (API :3333 + Web :3000)
pnpm dev
```

Acesse:

- 🛍️ Loja: <http://localhost:3000>
- 🔌 API: <http://localhost:3333/api/v1/health>
- 🗄️ Prisma Studio: `pnpm db:studio`

### Credenciais do seed

| Papel   | E-mail                  | Senha        |
| ------- | ----------------------- | ------------ |
| Admin   | admin@loja.com.br       | `Admin@123`  |
| Cliente | cliente@loja.com.br     | `Cliente@123`|

## 📜 Scripts úteis

| Comando            | Descrição                              |
| ------------------ | -------------------------------------- |
| `pnpm dev`         | Sobe API + Web em paralelo             |
| `pnpm build`       | Build de produção de todos os pacotes  |
| `pnpm db:migrate`  | Cria/aplica migrations                 |
| `pnpm db:seed`     | Popula dados de exemplo                |
| `pnpm db:studio`   | Abre o Prisma Studio                   |
| `pnpm lint`        | Lint em todos os pacotes               |
| `pnpm format`      | Formata com Prettier                   |

## 🔐 Segurança implementada

- Senhas com **Argon2**
- **JWT + Refresh Token** com rotação e hash em banco
- **Rate limiting** global e reforçado em rotas de auth
- **Helmet** (cabeçalhos seguros), **CORS** restrito, cookies `httpOnly`
- **Validação** estrita de DTOs (whitelist anti mass-assignment)
- Proteção contra **SQL Injection** (Prisma parametrizado) e **XSS** (React + headers)
- **RBAC** por papel: Administrador, Gerente, Atendente, Cliente
- **Auditoria** completa (`AuditLog`) de ações sensíveis

## 📚 Documentação

- [Arquitetura](docs/ARCHITECTURE.md)
- [Deploy na VPS Hostinger](docs/DEPLOYMENT.md)
- [Roadmap de features](docs/ROADMAP.md)

## 📄 Licença

Projeto privado. Todos os direitos reservados.
