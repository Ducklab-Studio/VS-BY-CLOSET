import { describe, expect, test, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from './webhooks.service';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';

/**
 * Itens 20/21 da Fase 7 — "erro de banco durante o processamento" e "o
 * WebhookEvent não pode ficar marcado como concluído quando a transação
 * falha". Fault injection controlada (mesmo padrão de
 * holds.retry.test.ts): mocka `$transaction` pra lançar, e prova duas
 * coisas que só dá pra provar assim — (a) `handleIncoming` propaga como
 * 503, nunca finge sucesso; (b) a tentativa de registrar a falha pra
 * auditoria é best-effort e nunca mascara o erro original.
 */
function fakePrismaThatThrows(err: Error) {
  return {
    $transaction: vi.fn().mockRejectedValue(err),
    webhookEvent: { createMany: vi.fn().mockResolvedValue({ count: 0 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as PrismaService;
}

describe('WebhooksService — erro de banco durante o processamento', () => {
  test('20) erro inesperado → propaga como ServiceUnavailableException (503), Shopify vai reentregar', async () => {
    const prisma = fakePrismaThatThrows(new Error('connection terminated unexpectedly'));
    const service = new WebhooksService(prisma, new ValePassWebhookService());

    await expect(service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: 'wh-fault-1', payload: { id: 1 } })).rejects.toMatchObject({
      status: 503,
    });
  });

  test('21) evento tratado como falha (best-effort) registra status=failed, não "processed"', async () => {
    const prisma = fakePrismaThatThrows(new Error('db down'));
    const service = new WebhooksService(prisma, new ValePassWebhookService());

    await expect(service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: 'wh-fault-2', payload: { id: 2 } })).rejects.toThrow();

    expect(prisma.webhookEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true, data: expect.objectContaining({ status: 'failed' }) }));
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { shopifyWebhookId: 'wh-fault-2', status: 'failed' } }));
  });

  test('falha no registro de auditoria (best-effort) não mascara o erro original — ainda 503', async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(new Error('original failure')),
      webhookEvent: { createMany: vi.fn().mockRejectedValue(new Error('audit write also failed')) },
    } as unknown as PrismaService;
    const service = new WebhooksService(prisma, new ValePassWebhookService());

    await expect(service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: 'wh-fault-3', payload: { id: 3 } })).rejects.toMatchObject({
      status: 503,
    });
  });
});
