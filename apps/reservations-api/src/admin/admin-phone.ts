/**
 * Normaliza telefone antes de gravar E antes de comparar no login — item
 * 2 da Fase 9. Remove tudo que não é dígito, exceto o "+" inicial (se
 * houver). Não valida formato de país específico (a operação é BR/CL) —
 * só garante que "+56 9 1234 5678", "+56 (9) 1234-5678" e "+56912345678"
 * (variações de digitação do mesmo número) virem a mesma string.
 *
 * Com e sem "+" continuam strings diferentes ("+56912345678" ≠
 * "56912345678") — por isso o login busca pelos dois formatos
 * (`phoneLookupCandidates`): um cadastro antigo feito pelo seed-admin
 * pode ter sido gravado sem o "+".
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

/** Formatos gravados possíveis do mesmo número: com "+" (o que a tela e o
 *  cadastro de funcionários gravam) e sem. */
export function phoneLookupCandidates(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  return digits ? [`+${digits}`, digits] : [];
}
