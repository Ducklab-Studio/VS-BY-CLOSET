-- "Limpar históricos": arquivamento (soft delete) de reservas em estado
-- terminal. Nenhuma coluna existente é alterada; nada é apagado.
ALTER TABLE reservations ADD COLUMN archived_at timestamptz;
ALTER TABLE reservations ADD COLUMN archived_by uuid;
ALTER TABLE reservations ADD COLUMN archive_reason text;

CREATE INDEX reservations_archived_at_idx ON reservations (archived_at);
