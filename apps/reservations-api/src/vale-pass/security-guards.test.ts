import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guardas ESTÁTICAS de segurança do Valle Pass (sem banco, sem rede). Não substituem os testes de comportamento: travam, para sempre, regressões que já aconteceram
 * ou que causariam perda financeira/exposição de dados se alguém as reintroduzisse sem perceber.
 */
const SRC = join(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const productionFiles = walk(SRC).filter((file) => /\.ts$/.test(file) && !/\.(test|spec)\.ts$/.test(file) && !/integration|test-utils/.test(file));
const rel = (file: string) => relative(SRC, file).replace(/\\/g, '/');
const text = (file: string) => readFileSync(file, 'utf8');

describe('SQL: nenhuma consulta bruta montada por texto no código de produção', () => {
  test('$queryRawUnsafe/$executeRawUnsafe nunca aparecem fora dos testes (só `$queryRaw` com template parametrizado)', () => {
    const offenders = productionFiles.filter((file) => /\$(query|execute)RawUnsafe/.test(text(file))).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('RBAC: SUPER_ADMIN (o proprietário) nunca é barrado por uma checagem de ADMIN (regressão do PR #145)', () => {
  // Arquivos em que a comparação com 'ADMIN' é DELIBERADAMENTE só do papel ADMIN (gestão dos vínculos de operadores: o proprietário não precisa de vínculo).
  const ONLY_ADMIN_ON_PURPOSE = new Set(['vale-pass/ledger/operator-scope.service.ts', 'vale-pass/ledger/operator-scope.ts']);
  test('toda comparação `role ... \'ADMIN\'` do módulo também trata SUPER_ADMIN', () => {
    const offenders: string[] = [];
    for (const file of productionFiles.filter((f) => rel(f).startsWith('vale-pass/') || rel(f).startsWith('admin-reservations/'))) {
      if (ONLY_ADMIN_ON_PURPOSE.has(rel(file))) continue;
      text(file)
        .split('\n')
        .forEach((line, index) => {
          if (/role\s*(!==|===)\s*'ADMIN'/.test(line) && !/SUPER_ADMIN/.test(line)) offenders.push(`${rel(file)}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
  test('o guarda de papel promove SUPER_ADMIN acima de qualquer @RequireRole (e nunca o contrário)', () => {
    const guard = text(join(SRC, 'admin/admin-role.guard.ts'));
    expect(guard).toMatch(/actual === 'SUPER_ADMIN' && required !== 'SUPER_ADMIN'/);
  });
});

describe('Rotas administrativas do Valle Pass: autenticadas, com papel e módulo (ou papel mais alto) exigidos', () => {
  const controllers = productionFiles.filter((file) => rel(file).startsWith('vale-pass/') && /\.controller\.ts$/.test(file));
  test('existem controladores para vigiar', () => {
    expect(controllers.length).toBeGreaterThanOrEqual(12);
  });
  test('todo @Controller(\'admin/...\') usa AdminAuthGuard + AdminRoleGuard e exige o módulo VALLE_PASS ou um papel de classe', () => {
    const offenders: string[] = [];
    for (const file of controllers) {
      const source = text(file);
      if (!/@Controller\('admin\//.test(source)) continue;
      const guarded = /@UseGuards\([^)]*AdminAuthGuard[^)]*AdminRoleGuard[^)]*\)/.test(source);
      const scoped = /@RequireModule\('VALLE_PASS'\)/.test(source) || /^@RequireRole\('(ADMIN|SUPER_ADMIN)'\)/m.test(source);
      if (!guarded || !scoped) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });
  test('as únicas rotas públicas do módulo são webhooks com assinatura verificada ANTES de processar (Resend/Svix, fail closed sem segredo)', () => {
    const publicOnes = controllers.filter((file) => !/@Controller\('admin\//.test(text(file)));
    expect(publicOnes.map(rel)).toEqual(['vale-pass/email/resend-webhook.controller.ts']);
    const source = text(publicOnes[0]);
    expect(source.indexOf('verifySvixSignature')).toBeGreaterThan(-1);
    expect(source.indexOf('verifySvixSignature')).toBeLessThan(source.indexOf('applyProviderEvent'));
    expect(source).toMatch(/if \(!this\.config\.webhookSecret\) throw new ServiceUnavailableException/);
  });
  test('o resgate e a consulta de saldo têm limite de tentativas por requisição (contra enumeração de códigos)', () => {
    const ledger = text(join(SRC, 'vale-pass/ledger/ledger.controller.ts'));
    for (const route of ['vouchers/:code/balance', 'vouchers/:code/ledger', 'vouchers/:code/redeem/prepare', 'vouchers/:code/redeem']) {
      const at = ledger.indexOf(`'${route}'`);
      expect(at, route).toBeGreaterThan(-1);
      expect(ledger.slice(at, at + 160), route).toMatch(/@Throttle\(/);
    }
  });
});

describe('Logs: código de voucher completo nunca é escrito', () => {
  test('no resgate, bloqueio e e-mail todo log que cita o voucher passa por maskCode', () => {
    const offenders: string[] = [];
    for (const file of productionFiles.filter((f) => /vale-pass\/(ledger|email)\//.test(rel(f)) || /vale-pass\/vale-pass-vouchers/.test(rel(f)))) {
      text(file)
        .split('\n')
        .forEach((line, index) => {
          if (/logger\.(log|warn|error|debug|verbose)\(/.test(line) && /\$\{[^}]*\.code\b[^}]*\}/.test(line) && !/maskCode\(/.test(line)) offenders.push(`${rel(file)}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('Webhook financeiro da Shopify: HMAC sobre o corpo CRU, comparação em tempo constante', () => {
  test('a verificação usa timingSafeEqual e exige cabeçalho; o controlador verifica antes de processar', () => {
    const hmac = text(join(SRC, 'webhooks/shopify-hmac.ts'));
    expect(hmac).toMatch(/timingSafeEqual/);
    expect(hmac).toMatch(/if \(!hmacHeader\) return false/);
    const controller = text(join(SRC, 'webhooks/webhooks.controller.ts'));
    expect(controller.indexOf('verifyShopifyHmac')).toBeGreaterThan(-1);
    expect(controller.indexOf('verifyShopifyHmac')).toBeLessThan(controller.indexOf('this.webhooks.'));
  });
});
