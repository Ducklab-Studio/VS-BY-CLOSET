import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Pagamento recebido com conflito de disponibilidade (late_payment_conflict): sempre visível para a equipe.
const root = new URL('../', import.meta.url);
const api = new URL('../../reservations-api/', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const load = (file, extra = {}) => {
  const out = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText, { exports: out, Object, Array, String, Number, Math, ...extra });
  return out;
};
const read = (file, base = root) => readFileSync(new URL(file, base), 'utf8').replace(/\r\n/g, '\n');
const lib = load('src/lib/payment-conflict.ts');
const report = load('src/lib/reconciliation-report.ts');
const dir = 'src/app/closetadmin/(protected)/';

test('o estado é reconhecido e o texto é o combinado', () => {
  assert.equal(lib.PAYMENT_CONFLICT_STATUS, 'late_payment_conflict');
  assert.equal(lib.PAYMENT_CONFLICT_LABEL, 'Pagamento recebido — conflito de disponibilidade');
  assert.equal(lib.PAYMENT_CONFLICT_LIST_HREF, '/closetadmin/reservas?status=late_payment_conflict');
  assert.equal(lib.isPaymentConflict('late_payment_conflict'), true);
  for (const other of ['problem', 'confirmed', 'pending_payment', 'expired', 'cancelled', '', null, undefined]) assert.equal(lib.isPaymentConflict(other), false, String(other));
});

test('contadores: "Requer atenção" soma revisão + conflito; reservas normais nunca entram', () => {
  const rows = [
    { status: 'problem' }, { status: 'late_payment_conflict' }, { status: 'late_payment_conflict' },
    { status: 'confirmed' }, { status: 'pending_payment' }, { status: 'expired' }, { status: 'cancelled' }, { status: 'picked_up' }, { status: 'hold' },
  ];
  assert.equal(lib.paymentConflictCount(rows), 2);
  assert.equal(lib.attentionTotal(rows), 3);
  assert.equal(lib.attentionTotal([{ status: 'confirmed' }, { status: 'pending_payment' }]), 0);
  assert.equal(lib.paymentConflictCount([]), 0);
});

test('manchete no singular e no plural', () => {
  assert.equal(lib.conflictHeadline(1), '1 reserva com pagamento recebido e conflito de disponibilidade');
  assert.equal(lib.conflictHeadline(3), '3 reservas com pagamento recebido e conflito de disponibilidade');
});

test('orientação operacional: verificar na Shopify e decidir entre atendimento alternativo ou reembolso, sem automatismo', () => {
  const steps = lib.PAYMENT_CONFLICT_STEPS.join(' ');
  assert.match(steps, /pedido da Shopify/);
  assert.match(steps, /atendimento alternativo/);
  assert.match(steps, /reembolso/);
  assert.match(steps, /Não confirme/);
  assert.match(lib.PAYMENT_CONFLICT_SUMMARY, /NÃO foi confirmada/);
  assert.match(lib.PAYMENT_CONFLICT_SUMMARY, /nada foi cancelado, liberado ou reembolsado automaticamente/);
});

test('eventos: LATE_PAYMENT_RECEIVED e LATE_PAYMENT_CONFLICT têm texto legível; os demais ficam como estavam', () => {
  assert.match(lib.eventLabel('LATE_PAYMENT_RECEIVED'), /Pagamento recebido/);
  assert.match(lib.eventLabel('LATE_PAYMENT_CONFLICT'), /Conflito de disponibilidade/);
  assert.equal(lib.eventLabel('ORDER_LINKED'), 'ORDER_LINKED');
  assert.equal(lib.eventLabel('RESERVATION_ITEM_RETURNED'), 'RESERVATION_ITEM_RETURNED');
});

test('motivo do conflito: só texto curto do evento certo; nunca outros campos do detalhe (sem dado pessoal)', () => {
  const detail = { orderId: '123', reason: '  unidade original   já comprometida por outra reserva ', email: 'x@y.z', customerName: 'Fulana' };
  assert.equal(lib.conflictReason('LATE_PAYMENT_CONFLICT', detail), 'unidade original já comprometida por outra reserva');
  assert.equal(lib.conflictReason('LATE_PAYMENT_RECEIVED', detail), null);
  assert.equal(lib.conflictReason('LATE_PAYMENT_CONFLICT', null), null);
  assert.equal(lib.conflictReason('LATE_PAYMENT_CONFLICT', { reason: 42 }), null);
  assert.equal(lib.conflictReason('LATE_PAYMENT_CONFLICT', { reason: 'a'.repeat(500) }).length, 200);
});

test('conferência: o novo tipo existe, é gravidade alta, conta como urgente e exige ação humana', () => {
  const info = report.KIND_INFO.payment_received_availability_conflict;
  assert.equal(info.label, 'Pagamento recebido — conflito de disponibilidade');
  assert.equal(info.severity, 'alta');
  assert.match(info.guidance, /ação humana/);
  assert.match(info.guidance, /atendimento alternativo ou reembolso/);
  assert.notEqual(info.label, report.KIND_INFO.paid_in_shopify_not_confirmed.label); // não é "pago, reserva não confirmada"
  const d = (kind) => ({ kind, orderId: '1', orderName: '#1', reservationId: 'r', reservationStatus: 'late_payment_conflict', shopify: null, action: 'none', applied: false, note: 'x' });
  assert.equal(report.urgentCount({ divergences: [d('payment_received_availability_conflict'), d('closed_in_shopify')] }), 1);
  const sorted = report.sortDivergences([d('closed_in_shopify'), d('payment_received_availability_conflict')]);
  assert.equal(sorted[0].kind, 'payment_received_availability_conflict');
  // a API é a mesma lista de tipos
  assert.match(read('shopify-reconciliation/shopify-reconciliation.service.ts', new URL('src/', api)), /'payment_received_availability_conflict'/);
});

test('rótulo e cor próprios: o painel não imprime mais o identificador cru', () => {
  const ui = read('src/components/closetadmin/ui.tsx');
  assert.match(ui, /late_payment_conflict:\s*\n?\s*'bg-orange-100/);
  assert.match(ui, /late_payment_conflict: 'Pagamento recebido — conflito de disponibilidade'/);
});

test('lista: filtro próprio, "Requer atenção" soma os dois, linha destacada, alerta discreto', () => {
  assert.match(read(`${dir}reservas/ReservationFiltersForm.tsx`), /value: 'late_payment_conflict', label: 'Pagamento recebido — conflito de disponibilidade'/);
  const list = read(`${dir}reservas/page.tsx`);
  assert.match(list, /attentionTotal\(allReservations\)/);
  assert.match(list, /<PaymentConflictAlert count=\{conflictCount\} compact \/>/);
  assert.match(list, /data-payment-conflict=/);
  assert.doesNotMatch(list, /reservation\.status === 'problem'\)\.length/);
});

test('painel inicial: alerta destacado com a quantidade e link para a lista filtrada; "Alertas" soma conflito + revisão', () => {
  const home = read(`${dir}page.tsx`);
  assert.match(home, /<PaymentConflictAlert count=\{conflicts\.length\} \/>/);
  assert.match(home, /const attention = \[\.\.\.conflicts, \.\.\.problems\]/);
  assert.match(home, /value=\{attention\.length\}/);
  assert.match(home, /listReservations\(adminUserId, \{ status: PAYMENT_CONFLICT_STATUS \}\)/);
  const alert = read('src/components/closetadmin/PaymentConflictAlert.tsx');
  assert.match(alert, /PAYMENT_CONFLICT_LIST_HREF/);
  assert.match(alert, /conflictHeadline\(count\)/);
  assert.match(alert, /Nada foi confirmado, cancelado ou reembolsado automaticamente/);
});

test('o alerta é SOMENTE informação: sem formulário, botão, ação de servidor, escrita ou dado de cliente', () => {
  const alert = read('src/components/closetadmin/PaymentConflictAlert.tsx');
  assert.doesNotMatch(alert, /<form|<button|<input|'use server'|onClick|adminPost|adminPatch|fetch\(|customerName|customerEmail|customerPhone/);
  const lib2 = read('src/lib/payment-conflict.ts');
  assert.doesNotMatch(lib2, /fetch\(|adminPost|customerEmail|customerPhone|customerName/);
});

test('detalhe: orientação, número do pedido e link Shopify; eventos com texto legível; o menu de novas reservas NÃO mudou', () => {
  const detail = read(`${dir}reservas/[id]/page.tsx`);
  assert.match(detail, /isPaymentConflict\(reservation\.status\)/);
  assert.match(detail, /data-testid="conflito-pedido"/);
  assert.match(detail, /PAYMENT_CONFLICT_STEPS\.map/);
  assert.match(detail, /eventLabel\(event\.type\)/);
  assert.match(detail, /conflictReason\(event\.type, event\.detail\)/);
  // contador de "novas reservas" (menu): só pendente/confirmada, nunca o conflito
  assert.doesNotMatch(read('src/lib/reservation-attention.ts'), /late_payment_conflict/);
  const attentionSql = read('admin-reservations/reservation-attention.ts', new URL('src/', api));
  assert.match(attentionSql, /status IN \('pending_payment', 'confirmed'\)/);
  assert.doesNotMatch(attentionSql, /late_payment_conflict/);
});
