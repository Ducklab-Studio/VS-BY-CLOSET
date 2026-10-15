import { Injectable, Logger } from '@nestjs/common';

const TIMEOUT_MS = 4_000;

/**
 * Avisa a vitrine (Next.js) que o catálogo mudou, para título, preço, fotos e
 * disponibilidade aparecerem em segundos em vez de esperar o cache de 60 s.
 *
 * É só um ATALHO: a vitrine continua se atualizando sozinha pelo cache. Por isso
 *  - sem `CATALOG_REVALIDATE_URL` + `CATALOG_REVALIDATE_SECRET` não faz nada;
 *  - nunca lança (falha de rede/HTTP vira um aviso no log, sem segredo nem URL);
 *  - roda DEPOIS do commit do webhook, nunca dentro da transação.
 */
@Injectable()
export class CatalogRevalidationService {
  private readonly logger = new Logger(CatalogRevalidationService.name);

  /** `handle` opcional: com ele só a página da peça é invalidada, sem ele o catálogo todo. */
  async notify(
    handle?: string | null,
    env: Record<string, string | undefined> = process.env,
    fetchImpl: typeof fetch = fetch,
  ): Promise<'sent' | 'disabled' | 'failed'> {
    const url = env.CATALOG_REVALIDATE_URL?.trim();
    const secret = env.CATALOG_REVALIDATE_SECRET?.trim();
    if (!url || !secret || env.VITEST || env.NODE_ENV === 'test') return 'disabled';
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      this.logger.warn('Aviso de atualização da vitrine ignorado: CATALOG_REVALIDATE_URL inválida.');
      return 'failed';
    }
    if (target.protocol !== 'https:' && target.hostname !== 'localhost') {
      this.logger.warn('Aviso de atualização da vitrine ignorado: a URL precisa ser https.');
      return 'failed';
    }
    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
        body: JSON.stringify(handle ? { handle } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Aviso de atualização da vitrine não aceito (HTTP ${response.status}).`);
        return 'failed';
      }
      return 'sent';
    } catch (err) {
      this.logger.warn(`Aviso de atualização da vitrine não concluído: ${err instanceof Error ? err.name : 'unknown'}`);
      return 'failed';
    }
  }
}
