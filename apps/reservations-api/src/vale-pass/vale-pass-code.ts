import { randomBytes } from 'crypto';

/** Sem 0/O/1/I — ambíguos ao ditar por telefone/ler numa etiqueta,
 *  mesmo motivo de todo código "pra humano" deste tipo de sistema. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Código de resgate do Valle Pass — nunca sequencial/previsível
 * (`randomBytes`, não `Math.random`). Formato `VALLE-XXXX-XXXX` (8
 * caracteres úteis, ~40 bits de entropia — suficiente pra nunca
 * colidir por acaso; unicidade real é garantida pela constraint
 * `UNIQUE` no banco, checada por quem chama antes de gravar).
 */
export function generateValePassCode(): string {
  const bytes = randomBytes(8);
  let chars = '';
  for (let i = 0; i < 8; i++) chars += ALPHABET[bytes[i] % ALPHABET.length];
  return `VALLE-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}
