import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Devolução de peças no ClosetAdmin: conferência individual, atraso informativo e retenção de avaria/manutenção.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const lib = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/return-inspection.ts', root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText,
  { exports: lib, Object, Array, Number, String, Math },
);
const { CONDITION_INFO, RETURN_CONDITIONS, validateInspection, toInspectionBody, lateLabel, canReceiveItem, canRecordNotReturned, canReleaseHold, canCompleteCleaning, isReturnCondition } = lib;
const plain = (v) => JSON.parse(JSON.stringify(v));
const read = (file) => readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');
const dir = 'src/app/closetadmin/(protected)/reservas/[id]/';

test('as quatro condições de peça devolvida existem e só avaria/manutenção seguram a peça', () => {
  assert.deepEqual(plain(RETURN_CONDITIONS), ['good', 'needs_cleaning', 'needs_maintenance', 'damaged']);
  assert.deepEqual(plain(RETURN_CONDITIONS.filter((c) => CONDITION_INFO[c].holds)), ['needs_maintenance', 'damaged']);
  assert.deepEqual(plain(RETURN_CONDITIONS.filter((c) => CONDITION_INFO[c].needsNotes)), ['needs_maintenance', 'damaged']);
  for (const c of RETURN_CONDITIONS) assert.ok(CONDITION_INFO[c].label.length > 3 && CONDITION_INFO[c].hint.length > 3);
});

test('a conferência é obrigatória: sem condição válida não envia', () => {
  assert.match(validateInspection({}), /condição/i);
  assert.match(validateInspection({ condition: 'ok' }), /condição/i);
  assert.match(validateInspection({ condition: null }), /condição/i);
  assert.equal(isReturnCondition('good'), true);
  assert.equal(isReturnCondition('returned'), false);
  assert.equal(isReturnCondition(undefined), false);
});

test('avaria e manutenção exigem descrição; as demais aceitam vazio mas não texto curto', () => {
  assert.match(validateInspection({ condition: 'damaged' }), /descreva/i);
  assert.match(validateInspection({ condition: 'needs_maintenance', notes: '   ' }), /descreva/i);
  assert.match(validateInspection({ condition: 'damaged', notes: 'ab' }), /descreva/i);
  assert.equal(validateInspection({ condition: 'damaged', notes: 'Rasgo na manga.' }), null);
  assert.equal(validateInspection({ condition: 'good' }), null);
  assert.equal(validateInspection({ condition: 'needs_cleaning', notes: '' }), null);
  assert.match(validateInspection({ condition: 'good', notes: 'a' }), /3 caracteres/);
  assert.match(validateInspection({ condition: 'good', notes: 'x'.repeat(2001) }), /2000/);
});

test('o corpo enviado à API só leva condição e observação (nunca operador, data ou valor)', () => {
  assert.deepEqual(plain(toInspectionBody({ condition: 'good', notes: '   ' })), { condition: 'good' });
  assert.deepEqual(plain(toInspectionBody({ condition: 'damaged', notes: '  Rasgo.  ' })), { condition: 'damaged', notes: 'Rasgo.' });
});

test('atraso é só informação: texto no singular/plural, sem valor', () => {
  assert.equal(lateLabel(0), 'No prazo');
  assert.equal(lateLabel(-2), 'No prazo');
  assert.equal(lateLabel(1), '1 dia de atraso');
  assert.equal(lateLabel(5), '5 dias de atraso');
});

test('quem pode fazer o quê: receber, registrar não devolvida, liberar e concluir', () => {
  assert.equal(canReceiveItem({ status: 'confirmed' }, false), true);
  assert.equal(canReceiveItem({ status: 'picked_up' }, false), true);
  for (const status of ['returned', 'cleaning', 'completed', 'cancelled', 'hold', 'expired']) assert.equal(canReceiveItem({ status }, false), false, status);
  assert.equal(canReceiveItem({ status: 'confirmed' }, true), false, 'arquivada não opera');

  assert.equal(canRecordNotReturned({ status: 'picked_up', overdueDays: 2 }, false), true);
  assert.equal(canRecordNotReturned({ status: 'picked_up', overdueDays: 0 }, false), false);
  assert.equal(canRecordNotReturned({ status: 'returned', overdueDays: 2 }, false), false);

  const held = { condition: 'damaged', awaitingRelease: true };
  const freed = { condition: 'damaged', awaitingRelease: false };
  const good = { condition: 'good', awaitingRelease: false };
  assert.equal(canReleaseHold(held, 'cleaning', true, false), true);
  assert.equal(canReleaseHold(held, 'returned', true, false), true);
  assert.equal(canReleaseHold(held, 'cleaning', false, false), false, 'STAFF não libera');
  assert.equal(canReleaseHold(freed, 'cleaning', true, false), false, 'já liberada');
  assert.equal(canReleaseHold(good, 'cleaning', true, false), false);
  assert.equal(canReleaseHold(null, 'cleaning', true, false), false);
  assert.equal(canReleaseHold(held, 'cleaning', true, true), false, 'arquivada');

  assert.equal(canCompleteCleaning(good, 'cleaning', false), true);
  assert.equal(canCompleteCleaning(held, 'cleaning', false), false, 'retida não conclui higienização');
  assert.equal(canCompleteCleaning(freed, 'cleaning', false), true);
  assert.equal(canCompleteCleaning(good, 'returned', false), false);
});

test('a ponte NÃO oferece recebimento sem conferência e não manda adminUserId', () => {
  const data = read('src/lib/admin-data.ts');
  assert.match(data, /const ITEM_ACTIONS = \['start-cleaning', 'complete-cleaning'\] as const;/);
  assert.doesNotMatch(data, /ITEM_ACTIONS = \[[^\]]*'receive'/);
  const fn = (name) => data.slice(data.indexOf(`export function ${name}`), data.indexOf('\n}\n', data.indexOf(`export function ${name}`)));
  for (const name of ['receiveReservationItem', 'releaseReservationItemHold', 'recordReservationItemOccurrence']) {
    assert.doesNotMatch(fn(name), /adminUserId/, name);
  }
  assert.match(fn('receiveReservationItem'), /toInspectionBody/);
});

test('server actions: sessão, módulo Reservas, liberação só ADMIN e validação antes de chamar a API', () => {
  const actions = read(`${dir}actions.ts`);
  const body = (name) => actions.slice(actions.indexOf(`export async function ${name}`), actions.indexOf('\n}\n', actions.indexOf(`export async function ${name}`)));
  for (const name of ['operationalReservationAction', 'receiveItemAction', 'releaseHoldAction', 'recordOccurrenceAction']) {
    assert.match(body(name), /requireAdminSession\(\)/, name);
    assert.match(body(name), /requireAdminModule\(session, 'RESERVATIONS'\)/, name);
  }
  assert.match(body('releaseHoldAction'), /requireAdminRole\(session, 'ADMIN'\)/);
  assert.doesNotMatch(body('receiveItemAction'), /requireAdminRole/, 'STAFF com módulo Reservas pode conferir');
  assert.match(body('receiveItemAction'), /validateInspection\(inspection\)/);
  assert.match(body('operationalReservationAction'), /'start-cleaning' \| 'complete-cleaning'/);
});

test('o diálogo de devolução: confirma antes de enviar, protege duplo clique e não promete foto nem cobrança', () => {
  const dialog = read(`${dir}ReturnDialog.tsx`);
  assert.match(dialog, /pendingRef\.current/);
  assert.match(dialog, /step === 'confirm'/);
  assert.match(dialog, /receiveItemAction\(/);
  // o envio só existe na etapa de confirmação
  assert.equal((dialog.match(/receiveItemAction\(/g) ?? []).length, 1);
  assert.match(dialog, /nenhuma cobrança é gerada/i);
  assert.match(dialog, /Anexo de fotos ainda não está disponível/);
  assert.doesNotMatch(dialog, /type="file"|FormData|<input[^>]*accept=/i, 'sem upload improvisado');
  assert.doesNotMatch(dialog, /\bR\$|multa|diária/i, 'sem valores');
});

test('a página mostra condição, retenção e ocorrências, e esconde a liberação de quem não é ADMIN', () => {
  const page = read(`${dir}page.tsx`);
  assert.match(page, /const isAdmin = hasAdminRole\(session, 'ADMIN'\)/);
  assert.match(page, /canReleaseHold\(item\.inspection, item\.status, isAdmin, archived\)/);
  for (const id of ['peca-atrasada', 'peca-retida', 'peca-conferencia', 'peca-ocorrencias', 'peca-nao-devolvida', 'aviso-atraso-reserva']) assert.match(page, new RegExp(`data-testid="${id}"`), id);
  assert.doesNotMatch(page, /<OperationalButton[^>]*action="receive"/, 'recebimento só pelo diálogo com conferência');
  // a tela avisa que NÃO calcula multa/diária; o que não pode existir é valor monetário calculado ou exibido
  assert.doesNotMatch(page, /R\$|toFixed|Intl\.NumberFormat|currency/i);
  assert.match(page, /nenhuma multa ou diária é calculada/);
});
