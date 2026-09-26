-- Presença online/offline do ClosetAdmin (uma linha por aba/página aberta).
-- Aditivo puro: tabela nova, nenhuma coluna ou dado existente alterado.
-- Some junto com a sessão (ON DELETE CASCADE) — ex.: exclusão permanente de
-- funcionário, que já apaga as sessões dele.

CREATE TABLE "admin_presence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_presence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_presence_last_seen_at_idx" ON "admin_presence"("last_seen_at");

CREATE UNIQUE INDEX "admin_presence_session_id_client_id_key" ON "admin_presence"("session_id", "client_id");

ALTER TABLE "admin_presence" ADD CONSTRAINT "admin_presence_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "admin_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
