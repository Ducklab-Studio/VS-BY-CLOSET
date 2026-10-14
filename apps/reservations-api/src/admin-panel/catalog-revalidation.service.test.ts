import { describe, expect, test, vi } from 'vitest';
import { CatalogRevalidationService } from './catalog-revalidation.service';

const SECRET = 'segredo-de-teste-com-mais-de-16';
const env = { CATALOG_REVALIDATE_URL: 'https://vsbycloset.example/api/revalidate-catalog', CATALOG_REVALIDATE_SECRET: SECRET };
const service = new CatalogRevalidationService();
const ok = () => vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

describe('aviso à vitrine após webhook de produto', () => {
  test('sem URL ou sem segredo: desligado, nenhuma chamada de rede', async () => {
    const fetchImpl = ok();
    expect(await service.notify('x', {}, fetchImpl)).toBe('disabled');
    expect(await service.notify('x', { CATALOG_REVALIDATE_URL: env.CATALOG_REVALIDATE_URL }, fetchImpl)).toBe('disabled');
    expect(await service.notify('x', { CATALOG_REVALIDATE_SECRET: SECRET }, fetchImpl)).toBe('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('em teste (VITEST) nunca sai para a rede, mesmo configurado', async () => {
    const fetchImpl = ok();
    expect(await service.notify('x', { ...env, VITEST: 'true' }, fetchImpl)).toBe('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('configurado: POST com o segredo no cabeçalho (nunca na URL) e o handle no corpo', async () => {
    const fetchImpl = ok();
    expect(await service.notify('jaqueta-firenze', env, fetchImpl)).toBe('sent');
    const [target, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(target)).toBe(env.CATALOG_REVALIDATE_URL);
    expect(String(target)).not.toContain(SECRET);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-revalidate-secret']).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ handle: 'jaqueta-firenze' });
  });

  test('sem handle: corpo vazio (invalida o catálogo todo)', async () => {
    const fetchImpl = ok();
    await service.notify(null, env, fetchImpl);
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string)).toEqual({});
  });

  test('URL inválida ou http (fora localhost): recusa sem chamar', async () => {
    const fetchImpl = ok();
    expect(await service.notify('x', { ...env, CATALOG_REVALIDATE_URL: 'não é url' }, fetchImpl)).toBe('failed');
    expect(await service.notify('x', { ...env, CATALOG_REVALIDATE_URL: 'http://vsbycloset.example/api' }, fetchImpl)).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('falha de rede, timeout ou HTTP de erro: nunca lança e o log não vaza segredo nem URL', async () => {
    const warnings: string[] = [];
    const quiet = new CatalogRevalidationService();
    (quiet as unknown as { logger: { warn: (m: string) => void } }).logger = { warn: (m) => warnings.push(m) };
    expect(await quiet.notify('x', env, vi.fn(async () => { throw new TypeError('fetch failed'); }))).toBe('failed');
    expect(await quiet.notify('x', env, vi.fn(async () => new Response('', { status: 401 })))).toBe('failed');
    expect(await quiet.notify('x', env, vi.fn(async () => new Response('', { status: 503 })))).toBe('failed');
    expect(warnings.length).toBe(3);
    for (const line of warnings) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain('vsbycloset.example');
    }
  });
});
