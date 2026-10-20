/** Máscara do código do voucher para auditoria/eventos/logs: `VALLE-AB12-CD34` → `VALLE-AB12-****`. Módulo neutro (sem dependência do e-mail). */
export function maskCode(code: string | null | undefined): string {
  if (!code) return '****';
  const parts = code.split('-');
  if (parts.length < 2) return '****';
  return [...parts.slice(0, -1), '****'].join('-');
}
