-- Sincronização Shopify → reserva: guarda o `updated_at` do último estado de
-- pedido aplicado, para que uma entrega atrasada/fora de ordem de
-- `orders/updated` nunca desfaça um estado mais novo.
ALTER TABLE "reservations" ADD COLUMN "shopify_order_updated_at" timestamptz;

-- Uma reserva com peças em etapas diferentes do ciclo de devolução (recebida,
-- em higienização, concluída) não pode ter TODAS as peças reescritas quando o
-- agregado vai para `problem`/`cancelled`: o progresso físico de cada peça é
-- preservado. Peças ainda não recebidas continuam espelhando a reserva.
CREATE OR REPLACE FUNCTION sync_reservation_item_status() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('returned', 'cleaning', 'completed') THEN
    RETURN NEW;
  END IF;

  UPDATE "reservation_items" SET "status" = NEW."status"
  WHERE "reservation_id" = NEW."id"
    AND "status" NOT IN ('returned', 'cleaning', 'completed');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
