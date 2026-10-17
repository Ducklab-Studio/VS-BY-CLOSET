/**
 * HMAC v2 — módulo PURO (Fase 3). NÃO é importado por checkout, webhooks nem por qualquer fluxo ativo; a integração é
 * etapa posterior, com autorização própria. O HMAC v1 (`../reservation-binding`) continua intacto.
 */
export * from './canonical-json';
export * from './money';
export * from './pieces';
export * from './signature';
