# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# API (NestJS + Prisma) — build multi-stage
# Contexto de build: raiz do monorepo.
#   docker build -f apps/api/Dockerfile -t loja-api .
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20-alpine

# ── Base: pnpm via corepack ──────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# openssl é exigido pelos engines do Prisma no Alpine.
RUN apk add --no-cache openssl libc6-compat \
 && corepack enable
WORKDIR /app

# ── Dependências ─────────────────────────────────────────────────────────────
# Copia só os manifests primeiro: enquanto eles não mudarem, o Docker reusa a
# camada de instalação mesmo com o código-fonte alterado.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/database/package.json ./packages/database/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/database ./packages/database
COPY apps/api ./apps/api

# Ordem obrigatória: o client do Prisma é gerado a partir do schema, o pacote
# @loja/database é compilado para JS (o runtime não interpreta TypeScript) e só
# então a API compila.
RUN pnpm --filter @loja/database build \
 && pnpm --filter @loja/api build

# Empacota a API com apenas as dependências de produção — `deploy` monta um
# node_modules autocontido, sem os symlinks do store do pnpm.
RUN pnpm --filter @loja/api --prod --legacy deploy /prod/api

# O deploy cria um node_modules novo, onde o client gerado pelo Prisma não
# existe. Sem gerar de novo aqui, a API sobe e quebra na primeira query com
# "@prisma/client did not initialize yet".
COPY packages/database/prisma /prod/api/prisma
RUN cd /prod/api && npx prisma generate --schema=./prisma/schema.prisma

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache openssl libc6-compat tini \
 && addgroup -g 1001 -S nodejs \
 && adduser -u 1001 -S nestjs -G nodejs
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3333

# /prod/api já traz dist, node_modules com o client gerado, package.json e o
# schema — é a imagem inteira em um COPY só.
COPY --from=build --chown=nestjs:nodejs /prod/api ./
COPY --chown=nestjs:nodejs apps/api/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER nestjs
EXPOSE 3333

# tini como PID 1 garante que SIGTERM chegue ao Node — sem isso o container
# leva 10s pra morrer no timeout e derruba requisições em voo a cada deploy.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
