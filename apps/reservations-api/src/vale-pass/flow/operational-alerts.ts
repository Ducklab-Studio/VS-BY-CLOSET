/**
 * Alertas OPERACIONAIS do Valle Pass 2027 — para não depender de alguém abrir o ClosetAdmin. Arquivo PURO (sem banco, sem rede): o contador específico, a regra de
 * quando avisar de novo e o texto da mensagem. A coleta fica em `operational-alerts.service.ts` e o envio em `alerts-notifier.ts`.
 *
 * Idade de um pagamento sem benefício = desde o PAGAMENTO real (`payment_confirmed_at`); se desconhecido, desde que o sistema o reteve; por último, desde a
 * mudança de status do pedido. O prazo prometido ao cliente é de 3 dias (72 h); 48 h é o aviso de "faltam 24 h".
 */
export const NEAR_DEADLINE_HOURS = 48;
export const DEADLINE_HOURS = 72;
/** Reaviso enquanto nada muda: crítico a cada 6 h, atenção a cada 24 h. */
export const CRITICAL_REMINDER_HOURS = 6;
export const WARNING_REMINDER_HOURS = 24;

export type AlertSeverity = 'ok' | 'warning' | 'critical';

export interface PendingOrderRow {
  readonly orderName: string | null;
  /** Unidades pagas ainda sem os vouchers. */
  readonly missing: number;
  /** Idade (horas) desde o pagamento (ou a melhor aproximação, ver cima). */
  readonly ageHours: number;
  readonly held: boolean;
  readonly paymentTimeUnknown: boolean;
}

export interface OperationalSnapshot {
  readonly generatedAt: string;
  readonly severity: AlertSeverity;
  /** Pagamentos confirmados sem TODOS os benefícios (retidos ou sem tratamento). */
  readonly withoutBenefit: { readonly orders: number; readonly units: number };
  /** Idade entre 48 h e 72 h: faltam menos de 24 h para o prazo. */
  readonly nearDeadline: { readonly orders: number };
  /** Idade de 72 h ou mais: o prazo prometido já venceu. */
  readonly overdue: { readonly orders: number };
  readonly paymentTimeUnknown: { readonly orders: number };
  /** Mensagens iniciais de e-mail (prazo de 3 dias) vencidas sem a Resend ter aceitado. */
  readonly emailsOverdue: { readonly units: number };
  readonly oldestHours: number | null;
  /** Os mais antigos primeiro (no máximo 10). Só nome do pedido e números: sem dados pessoais. */
  readonly worst: readonly { readonly orderName: string | null; readonly ageHours: number; readonly missing: number; readonly held: boolean }[];
}

export function buildSnapshot(rows: readonly PendingOrderRow[], emailsOverdueUnits: number, now: Date = new Date()): OperationalSnapshot {
  const nearDeadline = rows.filter((row) => row.ageHours >= NEAR_DEADLINE_HOURS && row.ageHours < DEADLINE_HOURS);
  const overdue = rows.filter((row) => row.ageHours >= DEADLINE_HOURS);
  const unknown = rows.filter((row) => row.paymentTimeUnknown);
  const severity: AlertSeverity = overdue.length > 0 || emailsOverdueUnits > 0 ? 'critical' : rows.length > 0 || nearDeadline.length > 0 ? 'warning' : 'ok';
  const sorted = [...rows].sort((a, b) => b.ageHours - a.ageHours);
  return {
    generatedAt: now.toISOString(),
    severity,
    withoutBenefit: { orders: rows.length, units: rows.reduce((sum, row) => sum + row.missing, 0) },
    nearDeadline: { orders: nearDeadline.length },
    overdue: { orders: overdue.length },
    paymentTimeUnknown: { orders: unknown.length },
    emailsOverdue: { units: emailsOverdueUnits },
    oldestHours: sorted.length > 0 ? Math.floor(sorted[0].ageHours) : null,
    worst: sorted.slice(0, 10).map((row) => ({ orderName: row.orderName, ageHours: Math.floor(row.ageHours), missing: row.missing, held: row.held })),
  };
}

/** Assinatura do que o aviso mostra: só muda quando o quadro muda (outra contagem, outro pedido entre os piores). */
export function signatureOf(snapshot: OperationalSnapshot): string {
  return JSON.stringify([snapshot.severity, snapshot.withoutBenefit, snapshot.nearDeadline, snapshot.overdue, snapshot.paymentTimeUnknown, snapshot.emailsOverdue, snapshot.worst.map((w) => w.orderName)]);
}

const RANK: Record<AlertSeverity, number> = { ok: 0, warning: 1, critical: 2 };

export interface NotifyState {
  readonly signature: string | null;
  readonly severity: AlertSeverity;
  readonly lastNotifiedAt: number | null;
}

export const INITIAL_NOTIFY_STATE: NotifyState = { signature: null, severity: 'ok', lastNotifiedAt: null };

export type NotifyDecision = { readonly notify: false; readonly next: NotifyState } | { readonly notify: true; readonly kind: 'NEW' | 'CHANGED' | 'ESCALATED' | 'REMINDER' | 'RESOLVED'; readonly next: NotifyState };

/**
 * Quando avisar: quadro novo ou diferente, piora de gravidade (imediato), reaviso periódico enquanto nada muda e um aviso de "resolvido" quando volta ao normal.
 * Nunca repete a mesma mensagem a cada rodada.
 */
export function decideNotification(state: NotifyState, snapshot: OperationalSnapshot, nowMs: number): NotifyDecision {
  const signature = signatureOf(snapshot);
  if (snapshot.severity === 'ok') {
    if (state.severity === 'ok') return { notify: false, next: state };
    return { notify: true, kind: 'RESOLVED', next: { signature, severity: 'ok', lastNotifiedAt: nowMs } };
  }
  const next: NotifyState = { signature, severity: snapshot.severity, lastNotifiedAt: nowMs };
  if (state.severity === 'ok' || state.signature === null) return { notify: true, kind: 'NEW', next };
  if (RANK[snapshot.severity] > RANK[state.severity]) return { notify: true, kind: 'ESCALATED', next };
  if (signature !== state.signature) return { notify: true, kind: 'CHANGED', next };
  const reminderMs = (snapshot.severity === 'critical' ? CRITICAL_REMINDER_HOURS : WARNING_REMINDER_HOURS) * 3_600_000;
  if (state.lastNotifiedAt !== null && nowMs - state.lastNotifiedAt >= reminderMs) return { notify: true, kind: 'REMINDER', next };
  return { notify: false, next: state };
}

const hoursText = (hours: number) => (hours >= 48 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${hours} h`);

export function alertText(snapshot: OperationalSnapshot, kind: Extract<NotifyDecision, { notify: true }>['kind']): string {
  if (kind === 'RESOLVED') return '[Valle Pass] Normalizado: nenhum pagamento confirmado sem benefício e nenhum e-mail vencido.';
  const head = snapshot.severity === 'critical' ? 'CRÍTICO' : 'ATENÇÃO';
  const parts: string[] = [];
  if (snapshot.overdue.orders > 0) parts.push(`${snapshot.overdue.orders} pedido(s) pago(s) há 72 h ou mais SEM benefício (prazo de 3 dias vencido)`);
  if (snapshot.nearDeadline.orders > 0) parts.push(`${snapshot.nearDeadline.orders} pedido(s) entre 48 h e 72 h (faltam menos de 24 h)`);
  const others = snapshot.withoutBenefit.orders - snapshot.overdue.orders - snapshot.nearDeadline.orders;
  if (others > 0) parts.push(`${others} pedido(s) pago(s) sem benefício há menos de 48 h`);
  if (snapshot.paymentTimeUnknown.orders > 0) parts.push(`${snapshot.paymentTimeUnknown.orders} com horário do pagamento desconhecido`);
  if (snapshot.emailsOverdue.units > 0) parts.push(`${snapshot.emailsOverdue.units} e-mail(s) de voucher fora do prazo`);
  const worst = snapshot.worst.slice(0, 5).map((w) => `${w.orderName ?? 'pedido'} (${hoursText(w.ageHours)}, ${w.missing} un.${w.held ? ', retido' : ''})`);
  const prefix = kind === 'REMINDER' ? 'Lembrete — ' : kind === 'ESCALATED' ? 'Piorou — ' : '';
  return `[Valle Pass] ${prefix}${head}: ${parts.join('; ')}.${worst.length ? ` Mais antigos: ${worst.join(', ')}.` : ''} Abra o ClosetAdmin > Valle Pass > Integração financeira.`;
}
