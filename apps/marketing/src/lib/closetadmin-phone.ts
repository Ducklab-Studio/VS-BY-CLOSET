/**
 * Fase 9 — máscara visual pro campo de telefone nos formulários do
 * ClosetAdmin (login, nova reserva manual). Puramente cosmético: o
 * reservations-api já normaliza o telefone antes de gravar/comparar
 * (`normalizePhone`, remove tudo que não é dígito) — isto só faz o campo
 * PARECER um telefone real enquanto a pessoa digita, com o DDI escolhido
 * pela própria pessoa. Só Chile e Brasil (os dois países da operação —
 * ver `CORS_ALLOWED_ORIGINS`/webhooks BR/CL no reservations-api).
 */
export interface PhoneCountry {
  readonly code: string; // DDI, sem "+"
  readonly label: string;
  readonly groups: readonly number[]; // tamanho de cada grupo de dígitos após o DDI
  /** Separador ANTES de cada grupo (exceto o primeiro) — default " ".
   *  Tamanho `groups.length - 1`. */
  readonly separators?: readonly string[];
  readonly placeholder: string;
}

export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { code: '56', label: 'Chile', groups: [1, 4, 4], placeholder: '9 1234 5678' },
  // DDD + celular com hífen antes dos 4 últimos dígitos: "11 98765-4321"
  // — número de exemplo genérico, nunca um telefone real de alguém.
  { code: '55', label: 'Brasil', groups: [2, 5, 4], separators: [' ', '-'], placeholder: '11 98765-4321' },
];

export const DEFAULT_PHONE_COUNTRY = PHONE_COUNTRIES[0];

export function findPhoneCountry(code: string): PhoneCountry {
  return PHONE_COUNTRIES.find((c) => c.code === code) ?? DEFAULT_PHONE_COUNTRY;
}

/** Formata só a parte NACIONAL (sem o "+DDI") em grupos, conforme o país. */
export function formatNationalNumber(raw: string, country: PhoneCountry): string {
  const maxDigits = country.groups.reduce((a, b) => a + b, 0);
  const digits = raw.replace(/\D/g, '').slice(0, maxDigits);

  let out = '';
  let cursor = 0;
  country.groups.forEach((size, i) => {
    if (cursor >= digits.length) return;
    const separator = i === 0 ? '' : (country.separators?.[i - 1] ?? ' ');
    out += separator + digits.slice(cursor, cursor + size);
    cursor += size;
  });
  return out;
}

/** Monta o valor final ("+56 9 1234 5678") a partir do DDI + parte nacional já formatada. */
export function composePhone(countryCode: string, nationalFormatted: string): string {
  return nationalFormatted ? `+${countryCode} ${nationalFormatted}` : `+${countryCode}`;
}
