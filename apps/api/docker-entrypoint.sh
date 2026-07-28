#!/bin/sh
set -e

# ─────────────────────────────────────────────────────────────────────────────
# Entrypoint da API.
#
# Aplica as migrações pendentes antes de subir o servidor. `migrate deploy` é a
# variante segura para produção: só aplica migrações já versionadas, nunca gera
# nem reseta nada.
#
# Com múltiplas réplicas, defina RUN_MIGRATIONS=false em todas menos uma (ou
# rode as migrações como job separado) para evitar corrida no advisory lock.
# ─────────────────────────────────────────────────────────────────────────────

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] Aplicando migrações do banco…"
  npx prisma migrate deploy --schema=./prisma/schema.prisma
  echo "[entrypoint] Migrações concluídas."
else
  echo "[entrypoint] RUN_MIGRATIONS=false — pulando migrações."
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "[entrypoint] Populando dados iniciais…"
  npx tsx prisma/seed.ts || echo "[entrypoint] Seed falhou (provavelmente já executado)."
fi

echo "[entrypoint] Iniciando API…"
exec "$@"
