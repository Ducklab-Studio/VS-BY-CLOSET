#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy no servidor.
#
#   ./scripts/deploy.sh
#
# Faz backup do banco antes de qualquer coisa, constrói as imagens novas e
# troca os containers. As migrações rodam no entrypoint da API.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"

if [ ! -f .env ]; then
  echo "✗ .env não encontrado. Copie de .env.production.example e preencha." >&2
  exit 1
fi

echo "▸ Backup do banco antes do deploy…"
./scripts/backup.sh || {
  echo "✗ Backup falhou — deploy abortado." >&2
  exit 1
}

echo "▸ Construindo imagens…"
$COMPOSE build

echo "▸ Subindo containers…"
# --wait bloqueia até os healthchecks passarem; sem isso o script "termina com
# sucesso" enquanto a API ainda pode estar quebrando no boot.
$COMPOSE up -d --wait --remove-orphans

echo "▸ Limpando imagens órfãs…"
docker image prune -f >/dev/null

echo "▸ Estado atual:"
$COMPOSE ps

echo ""
echo "✓ Deploy concluído."
echo "  Logs:  $COMPOSE logs -f api web"
