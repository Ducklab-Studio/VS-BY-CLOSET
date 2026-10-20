/** Máscaras para tudo que sai do envio de e-mails (logs, auditoria, painel). O código completo só existe no voucher e no e-mail do cliente. */

/** `maria.souza@gmail.com` → `m***@gmail.com`. Entrada inválida vira `***`. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '***';
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

import { maskCode } from '../vale-pass-code-mask';
export { maskCode } from '../vale-pass-code-mask';

/** Troca qualquer código de voucher (VALLE-XXXX-XXXX) e qualquer e-mail em um texto por versões mascaradas. Rede de proteção para mensagens de erro. */
export function scrubSensitive(text: string): string {
  return text
    .replace(/\bVALLE-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, (match) => maskCode(match))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (match) => maskEmail(match));
}

/** Código curto e seguro de um erro do provedor: só letras minúsculas, dígitos e `_`. */
export function safeReason(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return cleaned || fallback;
}
