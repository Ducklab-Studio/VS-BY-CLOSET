import { describe, expect, it } from 'vitest';
import { assertSafeTestDatabase, readProductionUrlFromEnvFile } from './safe-database';
import { setupWith } from './global-setup';

// URLs 100% fictícias: nenhuma conexão é aberta aqui.
const PROD = 'postgresql://user:pw@ep-prod-host.example.test/neondb?sslmode=require';

describe('assertSafeTestDatabase', () => {
  it('aborta quando DATABASE_URL não foi definida explicitamente', () => {
    expect(() => assertSafeTestDatabase({ databaseUrl: undefined, productionUrls: [PROD] })).toThrow(/não está definida/);
    expect(() => assertSafeTestDatabase({ databaseUrl: '   ', productionUrls: [PROD] })).toThrow(/não está definida/);
  });

  it('aborta com URL que não é PostgreSQL', () => {
    expect(() => assertSafeTestDatabase({ databaseUrl: 'mysql://u:p@localhost/x' })).toThrow(/não é uma URL PostgreSQL/);
    expect(() => assertSafeTestDatabase({ databaseUrl: 'lixo' })).toThrow(/não é uma URL PostgreSQL/);
  });

  it('aborta quando aponta para o host+banco de produção', () => {
    expect(() =>
      assertSafeTestDatabase({ databaseUrl: PROD, allowedHosts: 'ep-prod-host.example.test', productionUrls: [PROD] }),
    ).toThrow(/mesmo host\/banco do \.env de produção/);
  });

  it('aborta host Neon não listado e sem banco TESTE', () => {
    const other = 'postgresql://u:p@ep-outro.example.test/neondb';
    expect(() => assertSafeTestDatabase({ databaseUrl: other, productionUrls: [PROD] })).toThrow(/não é local/);
  });

  it('aceita host local, host explicitamente permitido e banco TESTE', () => {
    expect(() => assertSafeTestDatabase({ databaseUrl: 'postgresql://u:p@localhost:5432/x', productionUrls: [PROD] })).not.toThrow();
    expect(() => assertSafeTestDatabase({ databaseUrl: 'postgresql://u:p@127.0.0.1/x', productionUrls: [PROD] })).not.toThrow();
    const branch = 'postgresql://u:p@ep-teste-branch.example.test/neondb';
    expect(() =>
      assertSafeTestDatabase({ databaseUrl: branch, allowedHosts: ' ep-teste-branch.example.test ,x', productionUrls: [PROD] }),
    ).not.toThrow();
    expect(() =>
      assertSafeTestDatabase({ databaseUrl: 'postgresql://u:p@ep-prod-host.example.test/TESTE', productionUrls: [PROD] }),
    ).not.toThrow();
  });

  it('nunca inclui URL, usuário ou senha na mensagem de erro', () => {
    const secret = 'postgresql://usuario-secreto:senha-secreta@db-x.example.test/appdb';
    try {
      assertSafeTestDatabase({ databaseUrl: secret });
    } catch (err) {
      expect(String((err as Error).message)).not.toMatch(/usuario-secreto|senha-secreta|db-x\.example\.test/);
    }
  });

  it('readProductionUrlFromEnvFile devolve lista vazia se o arquivo não existe', () => {
    expect(readProductionUrlFromEnvFile('/caminho/inexistente/.env')).toEqual([]);
  });
});

describe('setupWith (baseline da regra de aluguel só após a trava)', () => {
  const run = async (input: Parameters<typeof setupWith>[0]) => {
    let applied = 0;
    const baseline = async () => {
      applied += 1;
    };
    let error: unknown = null;
    try {
      await setupWith(input, baseline);
    } catch (e) {
      error = e;
    }
    return { applied, error };
  };

  it('aplica o baseline em host local, host permitido e banco TESTE', async () => {
    expect((await run({ databaseUrl: 'postgresql://u:p@localhost:5432/qualquer', productionUrls: [PROD] })).applied).toBe(1);
    expect((await run({ databaseUrl: 'postgresql://u:p@127.0.0.1/x', productionUrls: [PROD] })).applied).toBe(1);
    expect(
      (await run({ databaseUrl: 'postgresql://u:p@ep-teste-branch.example.test/neondb', allowedHosts: 'ep-teste-branch.example.test', productionUrls: [PROD] })).applied,
    ).toBe(1);
    expect((await run({ databaseUrl: 'postgresql://u:p@ep-outro.example.test/TESTE', productionUrls: [PROD] })).applied).toBe(1);
  });

  it('NUNCA aplica o baseline sem URL explícita, em host não aprovado ou no host/banco de produção', async () => {
    const cases = [
      { databaseUrl: undefined, productionUrls: [PROD] },
      { databaseUrl: 'postgresql://u:p@ep-outro.example.test/neondb', productionUrls: [PROD] },
      // Mesmo listado em TEST_DATABASE_ALLOWED_HOSTS, produção continua barrada.
      { databaseUrl: PROD, allowedHosts: 'ep-prod-host.example.test', productionUrls: [PROD] },
    ];
    for (const c of cases) {
      const { applied, error } = await run(c);
      expect(applied).toBe(0);
      expect(error).toBeInstanceOf(Error);
    }
  });
});
