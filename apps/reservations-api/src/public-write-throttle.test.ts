import 'reflect-metadata';
import { describe, expect, test } from 'vitest';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { HoldsController } from './holds/holds.controller';
import { CheckoutController } from './checkout/checkout.controller';
import { PUBLIC_WRITE_THROTTLE } from './public-write-throttle';

/** Lido nos metadados reais que o ThrottlerGuard consulta (`THROTTLER:LIMIT` + nome). */
function throttleOf(handler: object) {
  return {
    limit: Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler) as number | undefined,
    ttl: Reflect.getMetadata(`${THROTTLER_TTL}default`, handler) as number | undefined,
  };
}

describe('Escritas públicas que prendem estoque têm limite próprio', () => {
  test('POST /holds e POST /checkout: 10 por minuto por IP (o global é 100)', () => {
    for (const handler of [HoldsController.prototype.createHold, CheckoutController.prototype.createCheckout]) {
      expect(throttleOf(handler)).toEqual({ limit: PUBLIC_WRITE_THROTTLE.default.limit, ttl: 60_000 });
    }
    expect(PUBLIC_WRITE_THROTTLE.default.limit).toBeLessThan(100);
  });
});
