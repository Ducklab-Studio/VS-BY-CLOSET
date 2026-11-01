import type { ShopifyOrderPayload } from '../../webhooks/shopify-order-payload';

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
export const TERMS_EVIDENCE_EVENT = 'TERMS_EVIDENCE_RECORDED';

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Tolerância para relógio do cliente/Shopify: um aceite "no futuro" além disso é incoerente. */
const CLOCK_SKEW_MS = 5 * 60_000;

export type TermsEvidence =
  | { readonly status: 'ABSENT' }
  | { readonly status: 'MALFORMED'; readonly reason: 'version_invalid' | 'accepted_at_invalid' | 'accepted_at_in_future' | 'incomplete' }
  | { readonly status: 'DECLARED'; readonly version: string; readonly acceptedAt: string };

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
