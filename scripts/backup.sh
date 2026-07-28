#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Backup do PostgreSQL.
#
#   ./scripts/backup.sh
#
# Agende no cron do host (3h da manhã, todo dia):
#   0 3 * * * cd /opt/loja && ./scripts/backup.sh >> /var/log/loja-backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="./backups"
OUT_FILE="${OUT_DIR}/loja-${STAMP}.sql.gz"

mkdir -p "$OUT_DIR"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

echo "▸ Gerando dump…"
# --clean --if-exists deixa o dump restaurável sobre um banco já existente.
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-loja}" -d "${POSTGRES_DB:-loja}" --clean --if-exists \
  | gzip > "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"

# Um dump vazio ou minúsculo indica falha silenciosa — melhor saber agora.
if [ "$(stat -c%s "$OUT_FILE" 2>/dev/null || stat -f%z "$OUT_FILE")" -lt 1024 ]; then
  echo "✗ Dump suspeito (menor que 1 KB). Verifique o banco." >&2
  rm -f "$OUT_FILE"
  exit 1
fi

echo "✓ Backup salvo: $OUT_FILE ($SIZE)"

echo "▸ Removendo backups com mais de ${RETENTION_DAYS} dias…"
find "$OUT_DIR" -name 'loja-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete

# Envia para o object storage, se configurado — backup só no mesmo servidor
# não protege contra perda da máquina.
if [ -n "${S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
  echo "▸ Enviando para o bucket…"
  aws s3 cp "$OUT_FILE" "s3://${S3_BUCKET}/backups/" \
    ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"}
  echo "✓ Backup replicado no storage."
fi
