#!/usr/bin/env node
/**
 * SOMENTE LEITURA — retrato do estado de produção do Valle Pass para a homologação (ver docs/VALLE-PASS-HOMOLOGACAO-RUNBOOK.md).
 * Uso: railway run -p <projeto> -e <ambiente> -s "@valle/reservations-api" -- node apps/reservations-api/scripts/estado-producao.mjs
 * Imprime só valores de chaves NÃO secretas (e se as secretas estão definidas, sem o valor) e contagens; sem dados pessoais nem códigos de voucher.
 */
import { createRequire } from 'node:module';
const { PrismaClient } = createRequire(new URL('../package.json', import.meta.url))('@prisma/client');
const flags = ['VALE_PASS_TWO_VOUCHER_FLOW', 'VALE_PASS_AUTO_VERIFY', 'VALE_PASS_UNIT_REFUNDS', 'VALE_PASS_EMAIL_MODE', 'VALE_PASS_EMAIL_DAILY_LIMIT', 'VALE_PASS_EMAIL_BATCH_SIZE', 'VALE_PASS_PAYMENT_TIME_POLICY', 'VALE_PASS_PAYMENT_TIME_TOLERANCE_SECONDS', 'VALE_PASS_ALERTS_MODE', 'VALE_PASS_AUTO_VERIFY_SETTLE_MINUTES'];
const present = ['VALE_PASS_EMAIL_COMMERCIAL_RELEASE', 'VALE_PASS_EMAIL_ALLOWED_RECIPIENTS', 'VALE_PASS_EMAIL_REPLY_TO', 'RESEND_API_KEY', 'DATABASE_URL'];
console.log('FLAGS', JSON.stringify(Object.fromEntries(flags.map((k) => [k, process.env[k] ?? '(ausente)']))));
console.log('PRESENTES(sem valor)', JSON.stringify(Object.fromEntries(present.map((k) => [k, process.env[k] ? 'definida' : 'ausente']))));
const db = new PrismaClient({ log: [] });
try {
  const out = await db.$transaction(async (tx) => {
    const safe = async (f) => { try { return await f(); } catch (e) { return 'erro: ' + (e.meta?.message ?? e.message).slice(0, 80); } };
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const q = (s) => tx.$queryRawUnsafe(s);
    return {
      db: await safe(async () => (await q('SELECT current_user AS u, current_database() AS d'))[0]),
      migrations: await safe(async () => (await q("SELECT count(*)::int AS total, count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS pendentes_ou_falhas FROM _prisma_migrations"))[0]),
      campanhas: await safe(async () => await q('SELECT name, amount_cents, global_limit, count(*) OVER ()::int AS n FROM vale_pass_campaigns ORDER BY name')),
      vouchersPorCampanha: await safe(async () => await q('SELECT c.name, v.status, count(*)::int AS n FROM vale_passes v JOIN vale_pass_campaigns c ON c.id = v.campaign_id GROUP BY 1,2 ORDER BY 1,2')),
      retencoesAbertas: await safe(async () => await q("SELECT reason, count(*)::int AS n FROM vale_pass_issuance_holds WHERE status = 'OPEN' GROUP BY 1")),
      pedidosValePass30d: await safe(async () => await q("SELECT status, count(*)::int AS n FROM vale_pass_orders WHERE order_created_at > now() - interval '30 days' GROUP BY 1")),
      outbox: await safe(async () => await q('SELECT status, count(*)::int AS n FROM vale_pass_email_outbox GROUP BY 1')),
      webhooks7d: await safe(async () => await q("SELECT topic, status, count(*)::int AS n, max(processed_at) AS ultimo FROM webhook_events WHERE processed_at > now() - interval '7 days' GROUP BY 1,2 ORDER BY ultimo DESC LIMIT 12")),
      webhooksFalhos: await safe(async () => (await q("SELECT count(*)::int AS n FROM webhook_events WHERE status = 'failed'"))[0]),
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await db.$disconnect();
}
