import { extractOrderLineVariants, type ShopifyOrderPayload } from '../../webhooks/shopify-order-payload';
import { approvedTerms, type TermsAcceptanceConfig } from './terms-acceptance-config';
import { verifyTermsToken, type TermsTokenFailure } from './terms-token';

/**
 * Evidência do aceite dos termos do Valle Pass, lida dos atributos do pedido (`note_attributes`) que a Shopify devolve no webhook.
 *
 * O que é: o REGISTRO do que a vitrine DECLAROU no carrinho (versão dos termos e instante do aceite). O status é `DECLARED`, nunca "aceito": este sistema
 * não vê o clique do cliente, só o que veio no pedido. Não é prova jurídica por si só — a validade do aceite depende de texto aprovado, de um ato afirmativo do
 * cliente na vitrine e da configuração do checkout da Shopify (ver docs/VALLE-PASS-2027-ACEITE-TERMOS.md).
 *
 * O que NÃO faz: não inventa consentimento (sem atributos = `ABSENT`), não bloqueia emissão, não publica termos e não grava dado pessoal.
 */
export const TERMS_ATTR_VERSION = 'valle_pass_terms_version';
export const TERMS_ATTR_ACCEPTED_AT = 'valle_pass_terms_accepted_at';
export const TERMS_ATTR_TOKEN = 'valle_pass_terms_token';
export const TERMS_EVIDENCE_EVENT = 'TERMS_EVIDENCE_RECORDED';
/** Código da retenção (antes da emissão) quando `VALE_PASS_TERMS_REQUIRED=on` e o pedido pago não traz aceite VERIFICADO. */
export const TERMS_ACCEPTANCE_REQUIRED = 'TERMS_ACCEPTANCE_REQUIRED';

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Tolerância para relógio do cliente/Shopify: um aceite "no futuro" além disso é incoerente. */
const CLOCK_SKEW_MS = 5 * 60_000;

export type TermsEvidence =
  | { readonly status: 'ABSENT' }
  | { readonly status: 'MALFORMED'; readonly reason: 'version_invalid' | 'accepted_at_invalid' | 'accepted_at_in_future' | 'incomplete' }
  | { readonly status: 'DECLARED'; readonly version: string; readonly acceptedAt: string }
  /** Token assinado pelo servidor: assinatura, versão, hash, variante, janela de tempo e uso único conferidos. É o ÚNICO estado que conta como comprovado. */
  | { readonly status: 'VERIFIED'; readonly version: string; readonly sha256: string; readonly issuedAt: string; readonly nonce: string }
  /** Havia token, mas não passou nas conferências (ou não há configuração aprovada para conferi-lo). */
  | { readonly status: 'REJECTED'; readonly reason: TermsRejectionReason; readonly nonce?: string };

export type TermsRejectionReason = TermsTokenFailure | 'reused' | 'order_time_unknown' | 'not_configured';

function attribute(payload: Pick<ShopifyOrderPayload, 'note_attributes'>, name: string): string | null {
  const value = payload.note_attributes?.find((item) => item.name === name)?.value;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
}

export function readTermsEvidence(payload: Pick<ShopifyOrderPayload, 'note_attributes'>, now: Date = new Date()): TermsEvidence {
  const version = attribute(payload, TERMS_ATTR_VERSION);
  const acceptedRaw = attribute(payload, TERMS_ATTR_ACCEPTED_AT);
  if (version === null && acceptedRaw === null) return { status: 'ABSENT' };
  if (version === null || acceptedRaw === null) return { status: 'MALFORMED', reason: 'incomplete' };
  if (!VERSION_RE.test(version)) return { status: 'MALFORMED', reason: 'version_invalid' };
  const accepted = new Date(acceptedRaw);
  if (Number.isNaN(accepted.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(acceptedRaw)) return { status: 'MALFORMED', reason: 'accepted_at_invalid' };
  if (accepted.getTime() > now.getTime() + CLOCK_SKEW_MS) return { status: 'MALFORMED', reason: 'accepted_at_in_future' };
  return { status: 'DECLARED', version, acceptedAt: accepted.toISOString() };
}

/** Atributos que a vitrine DEVERÁ enviar no carrinho quando houver texto aprovado E um ato afirmativo do cliente. Sem versão aprovada, devolve vazio (nunca fabrica aceite). */
export function buildTermsCartAttributes(input: { approvedVersion: string | null; customerAcceptedAt: Date | null }): { key: string; value: string }[] {
  if (!input.approvedVersion || !VERSION_RE.test(input.approvedVersion) || !input.customerAcceptedAt) return [];
  return [
    { key: TERMS_ATTR_VERSION, value: input.approvedVersion },
    { key: TERMS_ATTR_ACCEPTED_AT, value: input.customerAcceptedAt.toISOString() },
  ];
}

/**
 * Avalia a evidência do pedido contra a configuração APROVADA. Com token: confere assinatura/versão/hash/variante/validade (referência = `created_at` do pedido).
 * Sem token: cai no registro legado (ABSENT / DECLARED / MALFORMED), que nunca conta como comprovado. O uso único do nonce é conferido por quem tem o banco.
 */
export function evaluateTermsEvidence(payload: Pick<ShopifyOrderPayload, 'note_attributes' | 'created_at' | 'line_items'>, config: TermsAcceptanceConfig, now: Date = new Date()): TermsEvidence {
  const token = attribute(payload, TERMS_ATTR_TOKEN);
  if (token === null) return readTermsEvidence(payload, now);
  const approved = approvedTerms(config);
  if (approved === null) return { status: 'REJECTED', reason: 'not_configured' };
  const createdAt = payload.created_at ? new Date(payload.created_at) : null;
  if (createdAt === null || Number.isNaN(createdAt.getTime())) return { status: 'REJECTED', reason: 'order_time_unknown' };
  const variantIds = extractOrderLineVariants(payload as ShopifyOrderPayload).map((line) => line.variantId.replace(/^.*\//, ''));
  const check = verifyTermsToken(token, { secret: approved.secret, version: approved.version, sha256: approved.sha256, variantIds, at: createdAt });
  if (!check.ok) return { status: 'REJECTED', reason: check.reason };
  return { status: 'VERIFIED', version: check.claims.ver, sha256: check.claims.sha, issuedAt: new Date(check.claims.iat).toISOString(), nonce: check.claims.nonce };
}

/** Chave de comparação do estado (idempotência: só grava um novo registro quando algo mudou). */
export function termsEvidenceKey(evidence: TermsEvidence): string {
  return JSON.stringify([
    evidence.status,
    'version' in evidence ? evidence.version : null,
    'reason' in evidence ? evidence.reason : null,
    'nonce' in evidence ? (evidence.nonce ?? null) : null,
  ]);
}
