/**
 * POST /admin/catalog/sync não recebe corpo de negócio nenhum — quais peças
 * desativar/reativar é decidido inteiramente pelo servidor, comparando o
 * banco com a Admin API. Classe vazia (em vez de aceitar `unknown`) pra
 * `ValidationPipe({ forbidNonWhitelisted: true })` recusar qualquer campo
 * extra que o cliente tente mandar (ex.: um `active` ou `adminUserId`
 * forjado) — nenhum dado administrativo vem do cliente.
 */
export class CatalogSyncDto {}
