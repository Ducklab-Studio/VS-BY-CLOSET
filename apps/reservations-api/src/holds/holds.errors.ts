/**
 * Sinais internos usados só dentro de HoldsService pra decidir o que fazer
 * DEPOIS que a transação aborta — nunca vazam pro cliente como estão
 * (sempre viram uma HttpException apropriada em createHold). Ver o loop de
 * retry lá: cada um destes dois tem uma resposta diferente.
 */

/** Calculado ANTES de qualquer INSERT (dentro da transação, depois do
 *  FOR UPDATE): não existem unidades livres suficientes pra algum item.
 *  NÃO é retentado — se a contagem real é insuficiente, tentar de novo
 *  não muda isso. Vira 409 direto. */
export class InsufficientCapacityError extends Error {
  constructor(readonly shortfallVariantIds: readonly string[]) {
    super(`Capacidade insuficiente para: ${shortfallVariantIds.join(', ')}`);
    this.name = 'InsufficientCapacityError';
  }
}

/**
 * Duas requisições com a MESMA Idempotency-Key inseriram ao mesmo tempo;
 * o Postgres rejeitou uma pela PK de `hold_idempotency_keys`. Quem perdeu
 * essa corrida não deve tentar de novo com unidades diferentes — deve
 * simplesmente devolver o HOLD que a outra já criou. Ver createHold.
 */
export class IdempotencyRaceLostError extends Error {
  constructor(readonly key: string) {
    super(`Corrida de idempotência perdida para a chave ${key}.`);
    this.name = 'IdempotencyRaceLostError';
  }
}
