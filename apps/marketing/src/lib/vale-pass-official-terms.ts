/**
 * Metadados e conferência de integridade dos Termos Oficiais do Valle Pass 2027.
 *
 * Versão oficial: 2027-1
 * SHA-256 (bytes do arquivo UTF-8, LF): 9d1a283f1ec5c32e96aba3baeb8dd9d56c06f8447bf6a70edb6a3585a8e482ae
 * Origem: docs/termos/oficial/2027-1.md e docs/termos/oficial/manifest.json
 * Cópia local: apps/marketing/src/content/termos-valle-pass/2027-1.md (7.381 bytes)
 *
 * Imutabilidade: a versão 2027-1 é imutável. Qualquer revisão comercial ou jurídica
 * futura receberá nova numeração (ex: 2027-2), novo arquivo e novo hash SHA-256.
 */

export const OFFICIAL_TERMS_VERSION = '2027-1' as const;
export const OFFICIAL_TERMS_SHA256 = '9d1a283f1ec5c32e96aba3baeb8dd9d56c06f8447bf6a70edb6a3585a8e482ae' as const;
export const OFFICIAL_TERMS_BYTES = 7381 as const;
export const OFFICIAL_TERMS_FILE = '2027-1.md' as const;

export interface OfficialTermsMeta {
  readonly version: typeof OFFICIAL_TERMS_VERSION;
  readonly sha256: typeof OFFICIAL_TERMS_SHA256;
  readonly bytes: typeof OFFICIAL_TERMS_BYTES;
  readonly file: typeof OFFICIAL_TERMS_FILE;
}

export const OFFICIAL_TERMS_META: OfficialTermsMeta = Object.freeze({
  version: OFFICIAL_TERMS_VERSION,
  sha256: OFFICIAL_TERMS_SHA256,
  bytes: OFFICIAL_TERMS_BYTES,
  file: OFFICIAL_TERMS_FILE,
});

/**
 * Verifica se os metadados de termos retornados pela API correspondem
 * com exatidão à versão e ao SHA-256 oficiais embutidos no frontend.
 *
 * Fail closed: se houver qualquer divergência ou ausência, retorna false,
 * impedindo que o cliente aceite termos de versão diferente ou com hash adulterado.
 */
export function isOfficialTermsMatch(
  apiTerms: { version?: string | null; sha256?: string | null } | null | undefined,
): boolean {
  if (!apiTerms) return false;
  const versionOk = typeof apiTerms.version === 'string' && apiTerms.version.trim() === OFFICIAL_TERMS_VERSION;
  const sha256Ok = typeof apiTerms.sha256 === 'string' && apiTerms.sha256.trim().toLowerCase() === OFFICIAL_TERMS_SHA256;
  return versionOk && sha256Ok;
}
