import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Capability token do HOLD — item 1 da Fase 6. Prova de posse: hoje não
 * existe autenticação de cliente, então `reservationId` sozinho (um UUID
 * que pode vazar por log/analytics/devtools) nunca é suficiente pra
 * operar sobre um HOLD. Quem cria o HOLD recebe este token UMA vez; toda
 * operação sensível daqui pra frente (Fase 6: iniciar checkout) exige
 * `reservationId` + `holdToken` juntos.
 *
 * 32 bytes (256 bits) de `crypto.randomBytes` — gerado no servidor, nunca
 * derivado de nada previsível (não é um UUID, não é um hash de dado
 * público). Só o HASH (SHA-256) é gravado no banco — ver
 * `hold_token_hash` na migration 20260903180000_checkout_state; o token
 * em texto puro nunca toca o Postgres, só existe na resposta HTTP da
 * criação.
 */
const TOKEN_BYTES = 32;

export function generateHoldToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashHoldToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Comparação em tempo constante — um `===` normal entre strings vaza
 * quantos caracteres batem através do tempo de execução (timing attack
 * clássico contra token de posse). `timingSafeEqual` exige buffers do
 * MESMO tamanho ou lança; como os dois lados aqui são sempre um SHA-256
 * hex (64 chars), a checagem de tamanho é só defesa contra um hash
 * corrompido no banco, não um caso normal.
 */
export function verifyHoldToken(token: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const candidateHash = Buffer.from(hashHoldToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidateHash.length !== stored.length) return false;
  return timingSafeEqual(candidateHash, stored);
}
