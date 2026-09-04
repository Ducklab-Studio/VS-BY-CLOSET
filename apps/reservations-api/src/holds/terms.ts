/**
 * Versão dos termos aceitos ao criar um HOLD — centralizada aqui, nunca
 * decidida pelo cliente (o DTO de POST /holds nem aceita um campo
 * `termsVersion` vindo do payload; ver create-hold.dto.ts). Mesmo padrão
 * de fail-closed-em-produção do `allowedOrigins()` em main.ts: sem a
 * variável configurada, produção recusa subir; em dev, um valor
 * previsível evita travar quem está só testando localmente.
 */
export function currentTermsVersion(): string {
  const version = process.env.TERMS_VERSION;
  if (version) return version;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('TERMS_VERSION não configurada. Defina a versão vigente dos termos antes de subir em produção.');
  }
  return 'dev-unversioned';
}
