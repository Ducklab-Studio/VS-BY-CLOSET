/**
 * Normaliza telefone antes de gravar E antes de comparar no login — item
 * 2 da Fase 9. Remove tudo que não é dígito, exceto o "+" inicial (se
 * houver), e colapsa zeros/espaços de formatação comuns. Não valida
 * formato de país específico (a operação é BR/CL) — só garante que
 * "+56 9 1234 5678", "56912345678" e "9 1234-5678" (variações de
 * digitação do mesmo número) comparem iguais.
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}
