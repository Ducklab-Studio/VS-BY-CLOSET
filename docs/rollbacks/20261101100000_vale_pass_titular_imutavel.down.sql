-- Rollback de 20261101100000_vale_pass_titular_imutavel: remove o gatilho e a função. Não toca em dados.
-- Depois, apagar a linha da migration em "_prisma_migrations" (ou marcar com `prisma migrate resolve --rolled-back`).
DROP TRIGGER IF EXISTS "vale_passes_holder_guard" ON "vale_passes";
DROP FUNCTION IF EXISTS "vale_pass_holder_guard"();
