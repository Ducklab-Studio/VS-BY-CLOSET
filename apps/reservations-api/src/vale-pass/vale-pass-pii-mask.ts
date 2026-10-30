/** Máscaras de dados pessoais do cliente (nome, telefone) mostradas a quem NÃO opera o saldo (STAFF). O e-mail usa `maskEmail` (email/email-mask.ts). */

/** "Maria Teste Souza" → "Maria S."; nome único é mantido. */
export function maskName(name: string | null): string | null {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

/** "+56 9 1234 5678" → "***78". */
export function maskPhone(phone: string | null): string | null {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? `***${digits.slice(-2)}` : phone ? '***' : null;
}
