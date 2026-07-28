# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Web (Next.js 15) — build multi-stage com output standalone
# Contexto de build: raiz do monorepo.
#   docker build -f apps/web/Dockerfile -t loja-web .
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20-alpine

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apk add --no-cache libc6-compat && corepack enable
WORKDIR /app

# ── Dependências ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY apps/web ./apps/web

# Variáveis NEXT_PUBLIC_* são embutidas no bundle em tempo de build, não lidas
# em runtime — trocar a conta do Booqable exige rebuild, não só restart.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_BOOQABLE_COMPANY
ARG NEXT_PUBLIC_BOOQABLE_SCRIPT_URL
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV NEXT_PUBLIC_BOOQABLE_COMPANY=${NEXT_PUBLIC_BOOQABLE_COMPANY}
ENV NEXT_PUBLIC_BOOQABLE_SCRIPT_URL=${NEXT_PUBLIC_BOOQABLE_SCRIPT_URL}
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Ativa o output standalone (ver comentário em next.config.mjs).
ENV NEXT_OUTPUT_STANDALONE=true

RUN pnpm --filter @loja/web build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache tini \
 && addgroup -g 1001 -S nodejs \
 && adduser -u 1001 -S nextjs -G nodejs
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# O output standalone já traz um server.js com só as dependências alcançadas
# pelo tracing — dispensa copiar node_modules inteiro.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
