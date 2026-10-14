import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Alerta de peça retida com reserva futura: informação para a equipe, SOMENTE LEITURA.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const lib = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/held-alerts.ts', root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText,
  { exports: lib, Object, Array, Number, String, Math, RegExp },
);
const { urgencyOf, pickupLabel, holdConditionLabel, headline, reservationLabel, otherReservationsLabel, parseHeldAlerts } = lib;
const plain = (v) => JSON.parse(JSON.stringify(v));
const read = (file) => readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');
const comp = 'src/app/closetadmin/(protected)/HeldPieceAlerts.tsx';

const alert = (over = {}) => ({
  reservationItemId: 'i1', heldReservationId: 'h1', unitId: 'u1', code: 'VS-001', name: 'Blazer', condition: 'damaged', heldSince: '2026-10-10T12:00:00.000Z', affectedCount: 1,
  nextReservation: { id: '11111111-2222-3333-4444-555555555555', status: 'confirmed', pickupDate: '2026-10-20', returnDate: '2026-10-22', customerName: 'Marina', daysUntilPickup: 7 },
  ...over,
});

test('urgência pela retirada: até 7 dias urgente, até 21 atenção, depois acompanhar', () => {
  assert.equal(urgencyOf(0), 'urgent');
  assert.equal(urgencyOf(7), 'urgent');
  assert.equal(urgencyOf(8), 'soon');
  assert.equal(urgencyOf(21), 'soon');
  assert.equal(urgencyOf(22), 'later');
});

test('textos: retirada, condição e manchete no singular/plural', () => {
  assert.equal(pickupLabel(0), 'hoje');
  assert.equal(pickupLabel(1), 'amanhã');
  assert.equal(pickupLabel(12), 'em 12 dias');
  assert.equal(holdConditionLabel('damaged'), 'Danificada');
  assert.equal(holdConditionLabel('needs_maintenance'), 'Em manutenção');
  assert.equal(headline(1), '1 peça retida tem reserva futura');
  assert.equal(headline(3), '3 peças retidas têm reservas futuras');
  assert.equal(otherReservationsLabel(1), null);
  assert.match(otherReservationsLabel(2), /1 outra reserva/);
  assert.match(otherReservationsLabel(4), /3 outras reservas/);
});

test('sem nome da cliente, a reserva é identificada pelo código curto', () => {
  assert.equal(reservationLabel({ id: 'abcdef12-0000-0000-0000-000000000000', customerName: null }), 'Reserva abcdef12');
  assert.equal(reservationLabel({ id: 'abcdef12-0000', customerName: '   ' }), 'Reserva abcdef12');
  assert.equal(reservationLabel({ id: 'x', customerName: 'Marina' }), 'Marina');
});

test('resposta válida vira lista; vazia é "nenhum alerta"; malformada NUNCA vira lista vazia', () => {
  assert.deepEqual(plain(parseHeldAlerts({ generatedAt: 'x', alerts: [] })), []);
  const ok = plain(parseHeldAlerts({ alerts: [alert()] }));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].nextReservation.pickupDate, '2026-10-20');
  for (const bad of [null, undefined, 'x', 42, {}, { alerts: 'x' }, { alerts: [null] }, { alerts: [{}] },
    { alerts: [alert({ condition: 'good' })] },
    { alerts: [alert({ nextReservation: { id: 'r', status: 'confirmed', pickupDate: '20/10/2026', daysUntilPickup: 3 } })] },
    { alerts: [alert({ nextReservation: undefined })] },
    { alerts: [alert(), { reservationItemId: 1 }] }]) {
    assert.equal(parseHeldAlerts(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('campos opcionais ausentes não derrubam: sem nome, sem devolução, total mínimo 1', () => {
  const parsed = plain(parseHeldAlerts({ alerts: [alert({ name: undefined, affectedCount: 0, nextReservation: { id: 'r', status: 'confirmed', pickupDate: '2026-10-20', daysUntilPickup: 3 } })] }));
  assert.equal(parsed[0].name, 'VS-001');
  assert.equal(parsed[0].affectedCount, 1);
  assert.equal(parsed[0].nextReservation.customerName, null);
  assert.equal(parsed[0].nextReservation.returnDate, null);
});

test('o componente é SOMENTE LEITURA: sem formulário, botão, ação de servidor ou chamada de escrita', () => {
  const source = read(comp);
  assert.doesNotMatch(source, /<form|<button|<input|'use server'|'use client'|onClick|adminPost|adminPatch|adminPut|adminDelete|method: '(POST|PUT|PATCH|DELETE)'/);
  assert.match(source, /Nenhuma reserva, pagamento ou peça foi alterado automaticamente/);
  const data = read('src/lib/admin-data.ts');
  const fn = data.slice(data.indexOf('export function getHeldPieceAlerts'), data.indexOf('\n}\n', data.indexOf('export function getHeldPieceAlerts')));
  assert.match(fn, /adminGet\(/);
  assert.doesNotMatch(fn, /adminPost|adminPatch|adminPut|adminDelete/);
});

test('privacidade: o alerta não exibe telefone, e-mail, pedido nem valores', () => {
  const source = read(comp);
  assert.doesNotMatch(source, /customerPhone|customerEmail|phone|email|shopifyOrder|checkout|R\$|price|amount/i);
  assert.doesNotMatch(read('src/lib/held-alerts.ts'), /customerPhone|customerEmail|shopifyOrder|checkout/i);
});

test('falha ao verificar aparece como aviso; API anterior (400/404) e sem permissão (403) não poluem a tela', () => {
  const source = read(comp);
  assert.match(source, /\[400, 403, 404\]\.includes\(err\.status\)\) return null/);
  assert.match(source, /data-testid="alerta-retidas-erro"/);
  assert.match(source, /parseHeldAlerts\(await getHeldPieceAlerts\(adminUserId\)\)/);
  assert.match(source, /failed = alerts === null/);
});

test('onde aparece: home (só com módulo Reservas), lista de Reservas e a peça da reserva afetada', () => {
  const dashboard = read('src/app/closetadmin/(protected)/page.tsx');
  assert.match(dashboard, /hasAdminModule\(session, 'RESERVATIONS'\) \? <HeldPieceAlerts adminUserId=\{session\.id\} \/> : null/);
  assert.match(read('src/app/closetadmin/(protected)/reservas/page.tsx'), /<HeldPieceAlerts adminUserId=\{session\.id\} \/>/);
  const detail = read('src/app/closetadmin/(protected)/reservas/[id]/page.tsx');
  assert.match(detail, /data-testid="peca-retida-em-outra-reserva"/);
  assert.match(detail, /Nada foi alterado automaticamente/);
  for (const id of ['alerta-retidas', 'alerta-retida', 'alerta-reserva-afetada']) assert.match(read(comp), new RegExp(`data-testid="${id}"`));
});

test('compatibilidade com a API anterior: unitHold ausente vira "sem aviso"', () => {
  const data = read('src/lib/admin-data.ts');
  assert.match(data, /unitHold: item\.unitHold \?\? null/);
});
