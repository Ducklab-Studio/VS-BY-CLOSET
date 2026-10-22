/**
 * Endereço dos termos e condições OFICIAIS do Valle Pass. Enquanto não houver termos publicados, fica `null` e a página não afirma que eles
 * existem nem aponta para lugar nenhum. Quando o Anderson/jurídico entregar o texto, basta publicar a página e definir
 * `NEXT_PUBLIC_VALE_PASS_TERMS_URL` (caminho interno `/termos-valle-pass` ou URL https) na Vercel e republicar: nenhuma outra mudança de código.
 */
export function parseTermsHref(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^\/(?!\/)[\w\-./]*$/.test(value)) return value; // caminho interno
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export const VALE_PASS_TERMS_HREF: string | null = parseTermsHref(process.env.NEXT_PUBLIC_VALE_PASS_TERMS_URL);
