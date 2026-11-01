/**
 * Apoio puro (sem rede, sem React) da fila de pagamentos retidos do Valle Pass: tempo decorrido com urgência e orientação administrativa por motivo.
 * Só ORIENTA quem resolve: nenhuma regra comercial nova, nenhum reembolso automático e nenhuma decisão tomada aqui. Os limites de tempo repetem os da API
 * (`vale-pass-lots.service.ts`: retenção parada > 24 h, perto do prazo > 48 h, prazo de 3 dias = 72 h contado do PAGAMENTO).
 */

export const HOLD_STALE_HOURS = 24;
export const HOLD_NEAR_DEADLINE_HOURS = 48;
export const HOLD_DEADLINE_HOURS = 72;

export type HoldUrgency = 'NORMAL' | 'ATTENTION' | 'CRITICAL' | 'OVERDUE';
export type HoldReason = 'CAPACITY_EXCEEDED' | 'CAMPAIGN_NOT_READY' | 'FINANCIAL_MISMATCH';

export interface HoldTimingInput {
  /** Quando a retenção foi criada (ISO). */
  readonly createdAt: string;
  /** Instante REAL do pagamento (ISO); ausente/nulo = desconhecido. */
  readonly paymentConfirmedAt?: string | null;
}

export interface HoldElapsed {
  /** De onde o relógio conta: o pagamento (prazo de 3 dias) ou, se ele é desconhecido, a criação da retenção. */
  readonly basis: 'PAYMENT' | 'RETENTION';
  readonly hours: number;
  readonly urgency: HoldUrgency;
  readonly label: string;
  readonly text: string;
}

const MINUTE = 60_000;

/** "há 25 min", "há 3 h 20 min", "há 2 dias 5 h". */
export function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest === 0 ? `há ${hours} h` : `há ${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `há ${days} dias` : `há ${days} dias ${restHours} h`;
}

export function urgencyOf(hours: number): HoldUrgency {
  if (hours >= HOLD_DEADLINE_HOURS) return 'OVERDUE';
  if (hours >= HOLD_NEAR_DEADLINE_HOURS) return 'CRITICAL';
  if (hours >= HOLD_STALE_HOURS) return 'ATTENTION';
  return 'NORMAL';
}

const URGENCY_TEXT: Record<HoldUrgency, string> = {
  NORMAL: '',
  ATTENTION: 'Retenção parada há mais de 24 h: resolver hoje.',
  CRITICAL: 'Mais de 48 h: o prazo de 3 dias do cliente está a menos de 24 h. Falar diretamente com o cliente.',
  OVERDUE: 'O prazo de 3 dias a partir do pagamento VENCEU. Prioridade máxima: falar com o cliente e resolver agora.',
};

/** Tempo decorrido da retenção com a urgência. Datas ausentes ou inválidas viram `null` (nunca inventa um tempo). */
export function holdElapsed(hold: HoldTimingInput, nowMs: number): HoldElapsed | null {
  const paid = hold.paymentConfirmedAt ? Date.parse(hold.paymentConfirmedAt) : Number.NaN;
  const created = Date.parse(hold.createdAt);
  const basis: 'PAYMENT' | 'RETENTION' = Number.isNaN(paid) ? 'RETENTION' : 'PAYMENT';
  const start = basis === 'PAYMENT' ? paid : created;
  if (Number.isNaN(start) || !Number.isFinite(nowMs)) return null;
  const ms = Math.max(0, nowMs - start);
  const hours = ms / 3_600_000;
  const urgency = urgencyOf(hours);
  const label = formatElapsed(ms);
  const since = basis === 'PAYMENT' ? `${label} desde o pagamento` : `${label} desde a retenção (instante do pagamento desconhecido: o prazo de 3 dias não é calculável)`;
  return { basis, hours, urgency, label, text: [since, URGENCY_TEXT[urgency]].filter(Boolean).join('. ') };
}

/** Orientação administrativa por motivo (texto fixo; não toma decisão). Códigos de divergência acrescentam só o que é fato da retenção. */
export function holdGuidance(reason: HoldReason, issues: readonly string[] = []): string {
  const parts: string[] = [];
  if (reason === 'CAMPAIGN_NOT_READY') {
    parts.push(
      'Retido porque a campanha ainda não tem a validade (início e fim) e os benefícios completos. Nada é emitido até a validade aprovada pelo Anderson estar configurada. O pagamento fica guardado aqui, sem reembolso automático.',
    );
  } else if (reason === 'CAPACITY_EXCEEDED') {
    parts.push(
      'Retido porque o pedido não cabe no limite global de unidades: o sistema nunca emite acima do teto. A decisão é humana e comercial (por exemplo, reembolso na Shopify, se o Anderson aprovar, e só depois "Descartar").',
    );
  } else {
    parts.push(
      'Retido porque o valor, a moeda, a quantidade ou o desconto não batem com o esperado. Conferir o pedido na Shopify antes de decidir; emitir exige justificativa, e devolver o dinheiro é feito na Shopify (o sistema nunca reembolsa).',
    );
  }
  if (issues.includes('INTEGRATION_DISABLED')) parts.push('O pagamento chegou com a integração dos dois vouchers desligada: ele só é retomado quando a chave for ligada com autorização.');
  if (issues.includes('PAYMENT_TIME_UNKNOWN')) parts.push('O instante real do pagamento é desconhecido: conferir o horário na Shopify ("Conferir na Shopify", no painel de integração financeira) antes de emitir.');
  if (issues.includes('SALES_CLOSED')) parts.push('O pedido foi criado depois do encerramento das vendas. Nada foi cancelado nem reembolsado: um administrador decide (emitir com justificativa ou devolver o valor pela Shopify).');
  if (issues.includes('SALES_ORDER_DATE_UNKNOWN')) parts.push('A data de criação do pedido não pôde ser confirmada: conferir na Shopify se foi criado antes do encerramento das vendas.');
  if (issues.includes('TEST_ORDER')) parts.push('É um pedido de teste da Shopify: não deve gerar voucher comercial.');
  return parts.join(' ');
}
