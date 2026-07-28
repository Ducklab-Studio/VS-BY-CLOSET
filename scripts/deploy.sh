#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy no servidor.
#
#   ./scripts/deploy.sh
#
# O site é stateless — não há banco para migrar nem backup a fazer antes. Todo
# o dado de negócio vive no Booqable.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"

if [ ! -f .env ]; then
  echo "✗ .env não encontrado. Copie de .env.production.example e preencha." >&2
  exit 1
fi

echo "▸ Construindo imagem…"
$COMPOSE build

echo "▸ Subindo containers…"
# --wait bloqueia até o healthcheck passar; sem isso o script reportaria
# sucesso enquanto o site ainda poderia estar quebrando no boot.
$COMPOSE up -d --wait --remove-orphans

echo "▸ Limpando imagens órfãs…"
docker image prune -f >/dev/null

$COMPOSE ps

echo ""
echo "✓ Deploy concluído."
echo "  Logs:  $COMPOSE logs -f web"
