-- Migration A de 2 — só a expansão do enum.
--
-- O Postgres não deixa USAR um valor novo de enum (comparar, referenciar
-- em WHERE, usar como DEFAULT) na MESMA transação em que ele foi
-- adicionado com ALTER TYPE ... ADD VALUE. A próxima migration
-- (...B_rental_units_and_items) referencia estes valores num WHERE de
-- EXCLUDE constraint — por isso precisa ser um arquivo separado,
-- aplicado depois que este aqui já tiver commitado.
--
-- Aditivo puro: nenhum valor existente é removido (Postgres não permite
-- remover valor de enum de forma simples; 'pending'/'confirmed'/
-- 'cancelled'/'completed' continuam existindo, só ficam sem uso novo).
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'hold';
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'pending_payment';
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'preparing';
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'ready_for_pickup';
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'picked_up';
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'returned';
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'cleaning';
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'expired';
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'problem';
