/**
 * Teto técnico anti-abuso aceito pelos DTOs. NÃO é a regra comercial.
 * O limite real de cada reserva continua vindo de RentalRuleConfig.maxPieces
 * e é validado pelo motor com a configuração fresca do banco.
 */
export const TECHNICAL_MAX_PIECES = 50;
