import { describe, expect, test } from 'vitest';
import { alertText, buildSnapshot, decideNotification, INITIAL_NOTIFY_STATE, type NotifyState, type PendingOrderRow } from './operational-alerts';
import { alertsConfigFromEnv, buildNotifiers, WebhookNotifier } from './alerts-notifier';

const row = (over: Partial<PendingOrderRow> = {}): PendingOrderRow => ({ orderName: '#1001', missing: 1, ageHours: 5, held: true, paymentTimeUnknown: false, ...over });
const HOUR = 3_600_000;
const now = new Date('2026-10-18T12:00:00Z');

describe('buildSnapshot — contador específico', () => {
  test('sem pendência e sem e-mail vencido: ok', () => {
    expect(buildSnapshot([], 0, now)).toMatchObject({ severity: 'ok', withoutBenefit: { orders: 0, units: 0 }, oldestHours: null });
  });
  test('faixas de idade: <48 h atenção; 48–72 h "perto do prazo"; ≥72 h crítico (fronteiras inclusivas em 48 e 72)', () => {
    expect(buildSnapshot([row({ ageHours: 47.9 })], 0, now)).toMatchObject({ severity: 'warning', nearDeadline: { orders: 0 }, overdue: { orders: 0 } });
    expect(buildSnapshot([row({ ageHours: 48 })], 0, now)).toMatchObject({ severity: 'warning', nearDeadline: { orders: 1 }, overdue: { orders: 0 } });
    expect(buildSnapshot([row({ ageHours: 71.99 })], 0, now)).toMatchObject({ severity: 'warning', nearDeadline: { orders: 1 }, overdue: { orders: 0 } });
    expect(buildSnapshot([row({ ageHours: 72 })], 0, now)).toMatchObject({ severity: 'critical', nearDeadline: { orders: 0 }, overdue: { orders: 1 } });
  });
  test('e-mail vencido sozinho já é crítico; contagens de unidades, horário desconhecido e mais antigos', () => {
    const snap = buildSnapshot([row({ ageHours: 10, missing: 2, paymentTimeUnknown: true, orderName: '#7' }), row({ ageHours: 80, orderName: '#9' })], 3, now);
    expect(snap).toMatchObject({ severity: 'critical', withoutBenefit: { orders: 2, units: 3 }, paymentTimeUnknown: { orders: 1 }, emailsOverdue: { units: 3 }, oldestHours: 80 });
    expect(snap.worst.map((w) => w.orderName)).toEqual(['#9', '#7']);
    expect(buildSnapshot([], 1, now).severity).toBe('critical');
  });
  test('"piores" limitado a 10 e sem nenhum dado pessoal no formato', () => {
    const many = Array.from({ length: 25 }, (_, i) => row({ orderName: '#' + i, ageHours: i }));
    const snap = buildSnapshot(many, 0, now);
    expect(snap.worst).toHaveLength(10);
    expect(Object.keys(snap.worst[0]).sort()).toEqual(['ageHours', 'held', 'missing', 'orderName']);
  });
});

describe('decideNotification — não depende de alguém abrir o painel, mas também não repete a mesma mensagem', () => {
  const snapWarn = buildSnapshot([row({ ageHours: 5 })], 0, now);
  const snapWarn2 = buildSnapshot([row({ ageHours: 5 }), row({ orderName: '#1002', ageHours: 6 })], 0, now);
  const snapCrit = buildSnapshot([row({ ageHours: 80 })], 0, now);
  const t = 1_000_000_000_000;

  test('quadro normal e continua normal: nunca avisa', () => {
    const d = decideNotification(INITIAL_NOTIFY_STATE, buildSnapshot([], 0, now), t);
    expect(d.notify).toBe(false);
  });
  test('primeiro aparecimento avisa (NEW); a mesma foto na rodada seguinte NÃO avisa de novo', () => {
    const first = decideNotification(INITIAL_NOTIFY_STATE, snapWarn, t);
    expect(first).toMatchObject({ notify: true, kind: 'NEW' });
    const second = decideNotification(first.next, snapWarn, t + 15 * 60_000);
    expect(second.notify).toBe(false);
  });
  test('mudou o quadro (outro pedido): avisa CHANGED; piorou a gravidade: ESCALATED imediato', () => {
    const first = decideNotification(INITIAL_NOTIFY_STATE, snapWarn, t);
    expect(decideNotification(first.next, snapWarn2, t + 60_000)).toMatchObject({ notify: true, kind: 'CHANGED' });
    expect(decideNotification(first.next, snapCrit, t + 60_000)).toMatchObject({ notify: true, kind: 'ESCALATED' });
  });
  test('lembrete: crítico a cada 6 h; atenção a cada 24 h (nem um minuto antes)', () => {
    const crit = decideNotification(INITIAL_NOTIFY_STATE, snapCrit, t);
    expect(decideNotification(crit.next, snapCrit, t + 6 * HOUR - 1).notify).toBe(false);
    expect(decideNotification(crit.next, snapCrit, t + 6 * HOUR)).toMatchObject({ notify: true, kind: 'REMINDER' });
    const warn = decideNotification(INITIAL_NOTIFY_STATE, snapWarn, t);
    expect(decideNotification(warn.next, snapWarn, t + 23 * HOUR).notify).toBe(false);
    expect(decideNotification(warn.next, snapWarn, t + 24 * HOUR)).toMatchObject({ notify: true, kind: 'REMINDER' });
  });
  test('voltou ao normal: avisa RESOLVED uma vez só', () => {
    const crit = decideNotification(INITIAL_NOTIFY_STATE, snapCrit, t);
    const ok = buildSnapshot([], 0, now);
    const resolved = decideNotification(crit.next, ok, t + HOUR);
    expect(resolved).toMatchObject({ notify: true, kind: 'RESOLVED' });
    expect(decideNotification(resolved.next as NotifyState, ok, t + 2 * HOUR).notify).toBe(false);
  });
  test('o texto: só nomes de pedido e números; menciona prazo vencido, faixa 48–72 h, horário desconhecido e e-mails', () => {
    const snap = buildSnapshot([row({ ageHours: 80, orderName: '#1004', missing: 2, paymentTimeUnknown: true }), row({ ageHours: 50, orderName: '#1005' })], 2, now);
    const text = alertText(snap, 'NEW');
    expect(text).toMatch(/CRÍTICO/);
    expect(text).toMatch(/1 pedido\(s\) pago\(s\) há 72 h ou mais SEM benefício/);
    expect(text).toMatch(/1 pedido\(s\) entre 48 h e 72 h/);
    expect(text).toMatch(/1 com horário do pagamento desconhecido/);
    expect(text).toMatch(/2 e-mail\(s\) de voucher fora do prazo/);
    expect(text).toMatch(/#1004 \(3 d 8 h, 2 un\., retido\)/);
    expect(alertText(snap, 'REMINDER')).toMatch(/Lembrete/);
    expect(alertText(buildSnapshot([], 0, now), 'RESOLVED')).toMatch(/Normalizado/);
    expect(text).not.toMatch(/@|\+55|cliente/i);
  });
});

describe('canais — tudo desligado por padrão; serviço externo só com URL https', () => {
  test('sem variável: off e nenhum canal', () => {
    expect(alertsConfigFromEnv({})).toEqual({ mode: 'off', intervalMinutes: 15, webhookUrl: null });
    expect(buildNotifiers(alertsConfigFromEnv({}), console as never)).toEqual([]);
  });
  test('log: só o log interno; webhook exige https (http/valor ruim cai para log); intervalo validado 5–240', () => {
    expect(alertsConfigFromEnv({ VALE_PASS_ALERTS_MODE: 'log' }).mode).toBe('log');
    expect(alertsConfigFromEnv({ VALE_PASS_ALERTS_MODE: 'webhook' })).toMatchObject({ mode: 'log', webhookUrl: null });
    expect(alertsConfigFromEnv({ VALE_PASS_ALERTS_MODE: 'webhook', VALE_PASS_ALERTS_WEBHOOK_URL: 'http://exemplo.invalid/x' })).toMatchObject({ mode: 'log', webhookUrl: null });
    expect(alertsConfigFromEnv({ VALE_PASS_ALERTS_MODE: 'webhook', VALE_PASS_ALERTS_WEBHOOK_URL: 'https://hooks.exemplo.invalid/x' })).toMatchObject({ mode: 'webhook', webhookUrl: 'https://hooks.exemplo.invalid/x' });
    for (const bad of ['4', '241', 'x', '10.5']) expect(alertsConfigFromEnv({ VALE_PASS_ALERTS_MODE: 'log', VALE_PASS_ALERTS_INTERVAL_MINUTES: bad }).intervalMinutes).toBe(15);
    expect(alertsConfigFromEnv({ VALE_PASS_ALERTS_MODE: 'log', VALE_PASS_ALERTS_INTERVAL_MINUTES: '30' }).intervalMinutes).toBe(30);
  });
  test('o webhook falso: POST { text } com timeout; falha nunca lança; http recusado', async () => {
    const calls: { url: string; body: string }[] = [];
    const warns: string[] = [];
    const ok = new WebhookNotifier('https://hooks.exemplo.invalid/x', { warn: (m: string) => warns.push(m) }, (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch);
    expect(await ok.send('oi')).toBe(true);
    expect(calls).toEqual([{ url: 'https://hooks.exemplo.invalid/x', body: JSON.stringify({ text: 'oi' }) }]);
    const boom = new WebhookNotifier('https://hooks.exemplo.invalid/x', { warn: (m: string) => warns.push(m) }, (async () => { throw new Error('rede'); }) as unknown as typeof fetch);
    expect(await boom.send('oi')).toBe(false);
    expect(await new WebhookNotifier('http://x.invalid', { warn: () => undefined }).send('oi')).toBe(false);
    const bad = new WebhookNotifier('https://hooks.exemplo.invalid/x', { warn: (m: string) => warns.push(m) }, (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch);
    expect(await bad.send('oi')).toBe(false);
    expect(warns.join(' ')).toMatch(/HTTP 500/);
  });
});
