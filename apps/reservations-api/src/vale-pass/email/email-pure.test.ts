import { describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { DEFAULT_FROM, canSendLive, liveBlockers, loadEmailConfig, publicEmailStatus, senderAddress } from './email-config';
import { maskCode, maskEmail, safeReason, scrubSensitive } from './email-mask';
import { ResendEmailProvider, type SendEmailInput } from './email-provider';
import { EMAIL_TERMS, OFFICIAL_LOGO_URL, escapeHtml, renderVoucherEmail } from './email-template';
import { BACKOFF_MINUTES, backoffMs } from './email-worker.service';
import { parseResendEvent, verifySvixSignature } from './resend-webhook';
import { isValidRecipient } from './email-outbox.service';

const liveEnv = { VALE_PASS_EMAIL_MODE: 'live', RESEND_API_KEY: 're_test_key_123', VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true', VALE_PASS_EMAIL_COMMERCIAL_RELEASE: 'true', VALE_PASS_EMAIL_COMMERCIAL_AUTH_REF: 'AUTORIZACAO-TESTE-001' };

describe('configuração: fail closed', () => {
  test('o padrão é DESLIGADO e nenhum envio real é possível', () => {
    const config = loadEmailConfig({});
    expect(config.mode).toBe('off');
    expect(config.from).toBe(DEFAULT_FROM);
    expect(config.dailyLimit).toBe(80);
    expect(canSendLive(config)).toBe(false);
    expect(liveBlockers(config).join(' ')).toMatch(/modo "off".*RESEND_API_KEY ausente.*não marcado como verificado/s);
  });

  test('ter RESEND_API_KEY (lembretes de retirada) ou domínio cadastrado NÃO liga o envio de vouchers', () => {
    expect(canSendLive(loadEmailConfig({ RESEND_API_KEY: 're_x' }))).toBe(false);
    expect(canSendLive(loadEmailConfig({ RESEND_API_KEY: 're_x', VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true' }))).toBe(false); // falta o modo
    expect(canSendLive(loadEmailConfig({ VALE_PASS_EMAIL_MODE: 'live', RESEND_API_KEY: 're_x' }))).toBe(false); // falta domínio verificado
    expect(canSendLive(loadEmailConfig({ VALE_PASS_EMAIL_MODE: 'live', VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true' }))).toBe(false); // falta a chave
    expect(canSendLive(loadEmailConfig({ ...liveEnv, VALE_PASS_EMAIL_MODE: 'dry-run' }))).toBe(false);
    expect(canSendLive(loadEmailConfig({ ...liveEnv, VALE_PASS_EMAIL_MODE: 'qualquer-coisa' }))).toBe(false);
    expect(canSendLive(loadEmailConfig({ ...liveEnv, VALE_PASS_EMAIL_FROM: 'sem-arroba' }))).toBe(false);
    expect(canSendLive(loadEmailConfig(liveEnv))).toBe(true);
  });

  test('remetente parametrizado e valores numéricos com limites', () => {
    expect(senderAddress('Valle Pass <vallepass@vallebycloset.com>')).toBe('vallepass@vallebycloset.com');
    expect(senderAddress('vallepass@vallebycloset.com')).toBe('vallepass@vallebycloset.com');
    expect(senderAddress('Valle Pass <>')).toBeNull();
    const config = loadEmailConfig({ VALE_PASS_EMAIL_DAILY_LIMIT: '999999999', VALE_PASS_EMAIL_MAX_ATTEMPTS: '0', VALE_PASS_EMAIL_BATCH_SIZE: 'abc', VALE_PASS_EMAIL_TIMEOUT_MS: '1' });
    expect(config).toMatchObject({ dailyLimit: 100_000, maxAttempts: 1, batchSize: 10, requestTimeoutMs: 1_000 });
  });

  test('worker: desligado em teste e com 0; intervalo mínimo de 10 s', () => {
    expect(loadEmailConfig({ VITEST: '1' }).workerIntervalSeconds).toBeNull();
    expect(loadEmailConfig({ VALE_PASS_EMAIL_WORKER_INTERVAL_SECONDS: '0' }).workerIntervalSeconds).toBeNull();
    expect(loadEmailConfig({ VALE_PASS_EMAIL_WORKER_INTERVAL_SECONDS: '3' }).workerIntervalSeconds).toBe(10);
    expect(loadEmailConfig({}).workerIntervalSeconds).toBe(60);
  });

  test('o que o painel vê da configuração nunca contém a chave nem o segredo do webhook', () => {
    const config = loadEmailConfig({ ...liveEnv, RESEND_WEBHOOK_SECRET: 'whsec_super_secreto' });
    const json = JSON.stringify(publicEmailStatus(config));
    expect(json).not.toContain('re_test_key_123');
    expect(json).not.toContain('super_secreto');
    expect(publicEmailStatus(config)).toMatchObject({ canSend: true, providerConfigured: true, webhookConfigured: true, domainVerified: true });
  });
});

describe('máscaras', () => {
  test('e-mail e código', () => {
    expect(maskEmail('maria.souza@gmail.com')).toBe('m***@gmail.com');
    expect(maskEmail('')).toBe('***');
    expect(maskEmail('sem-arroba')).toBe('***');
    expect(maskCode('VALLE-AB12-CD34')).toBe('VALLE-AB12-****');
    expect(maskCode(null)).toBe('****');
  });

  test('scrubSensitive remove códigos e e-mails de qualquer texto; safeReason só deixa código curto', () => {
    const dirty = 'falha para maria@exemplo.com com VALLE-AB12-CD34 e VALLE-ZZ99-QQ11';
    const clean = scrubSensitive(dirty);
    expect(clean).not.toMatch(/maria@exemplo\.com|CD34|QQ11/);
    expect(clean).toContain('m***@exemplo.com');
    expect(safeReason('Validation Error: maria@x.com', 'x')).toBe('validation_error_maria_x_com');
    expect(safeReason(undefined, 'http_500')).toBe('http_500');
    expect(safeReason('A'.repeat(200), 'x').length).toBe(60);
  });

  test('validação de destinatário', () => {
    for (const ok of ['a@b.co', 'maria.souza+vp@gmail.com']) expect(isValidRecipient(ok)).toBe(true);
    for (const bad of ['', null, undefined, 'a@b', 'a b@c.com', '<a@b.com>', 'x'.repeat(320) + '@b.com']) expect(isValidRecipient(bad as string)).toBe(false);
  });
});

describe('adaptador da Resend (fetch simulado, nenhuma rede)', () => {
  const input: SendEmailInput = { to: 'cliente@exemplo.com', from: DEFAULT_FROM, subject: 'S', html: '<p>h</p>', text: 't', idempotencyKey: 'vpe-123' };
  type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: Error; badJson?: boolean };
  function provider(reply: Reply, calls: { url: string; init: Record<string, unknown> }[] = []) {
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => {
      calls.push({ url, init });
      if (reply.throws) throw reply.throws;
      return {
        status: reply.status ?? 200,
        ok: (reply.status ?? 200) < 300,
        headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
        json: async () => {
          if (reply.badJson) throw new Error('bad json');
          return reply.body ?? {};
        },
      };
    };
    return new ResendEmailProvider({ apiKey: 're_segredo_xyz', timeoutMs: 1_000, fetchImpl });
  }

  test('aceito: devolve o id; envia chave de idempotência e autorização, e a chave NUNCA vai no corpo', async () => {
    const calls: { url: string; init: Record<string, unknown> }[] = [];
    expect(await provider({ body: { id: 'em_1' } }, calls).send({ ...input, replyTo: 'suporte@vallebycloset.com' })).toEqual({ kind: 'accepted', messageId: 'em_1' });
    const init = calls[0].init as { headers: Record<string, string>; body: string };
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(init.headers['Idempotency-Key']).toBe('vpe-123');
    expect(init.headers.Authorization).toBe('Bearer re_segredo_xyz');
    expect(init.body).not.toContain('re_segredo_xyz');
    expect(JSON.parse(init.body)).toMatchObject({ to: ['cliente@exemplo.com'], subject: 'S', reply_to: 'suporte@vallebycloset.com' });
  });

  test('2xx sem id ou com corpo ilegível é DESCONHECIDO (pode ter sido enviado), nunca falha', async () => {
    expect(await provider({ body: {} }).send(input)).toEqual({ kind: 'unknown', reason: 'invalid_response' });
    expect(await provider({ badJson: true }).send(input)).toEqual({ kind: 'unknown', reason: 'invalid_response' });
  });

  test('recusas: validação permanente; 429 com e sem Retry-After; cota excedida; credencial', async () => {
    expect(await provider({ status: 422, body: { name: 'validation_error', message: 'cliente@exemplo.com inválido' } }).send(input)).toEqual({ kind: 'rejected', status: 422, reason: 'validation_error', permanent: true });
    expect(await provider({ status: 429, body: { name: 'rate_limit_exceeded' }, headers: { 'retry-after': '30' } }).send(input)).toEqual({ kind: 'rejected', status: 429, reason: 'rate_limited', permanent: false, retryAfterSeconds: 30 });
    expect(await provider({ status: 429, body: { name: 'rate_limit_exceeded' } }).send(input)).toEqual({ kind: 'rejected', status: 429, reason: 'rate_limited', permanent: false });
    expect(await provider({ status: 429, body: { name: 'daily_quota_exceeded' } }).send(input)).toEqual({ kind: 'rejected', status: 429, reason: 'quota_exceeded', permanent: false, retryAfterSeconds: 3600 });
    expect(await provider({ status: 401, body: { name: 'missing_api_key' } }).send(input)).toMatchObject({ kind: 'rejected', permanent: true, authProblem: true });
    expect(await provider({ status: 403 }).send(input)).toMatchObject({ kind: 'rejected', reason: 'auth_error', authProblem: true });
  });

  test('o texto livre do provedor (pode conter o e-mail do cliente) nunca sai do adaptador', async () => {
    const result = await provider({ status: 422, body: { name: 'validation_error', message: 'The to address maria@exemplo.com is invalid' } }).send(input);
    expect(JSON.stringify(result)).not.toContain('maria@exemplo.com');
  });

  test('5xx, conflito de idempotência, timeout e erro de rede são DESCONHECIDOS', async () => {
    expect(await provider({ status: 500 }).send(input)).toEqual({ kind: 'unknown', reason: 'http_5xx' });
    expect(await provider({ status: 503 }).send(input)).toEqual({ kind: 'unknown', reason: 'http_5xx' });
    expect(await provider({ throws: Object.assign(new Error('x'), { name: 'AbortError' }) }).send(input)).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(await provider({ throws: new TypeError('fetch failed') }).send(input)).toEqual({ kind: 'unknown', reason: 'network_error' });
  });

  test('409 tem DOIS significados: conteúdo diferente com a mesma chave → intervenção; requisição concorrente → transitório', async () => {
    // mesma Idempotency-Key com OUTRO conteúdo: repetir igual nunca resolve e a original pode já ter saído
    expect(await provider({ status: 409, body: { name: 'invalid_idempotent_request', message: 'x' } }).send(input)).toEqual({ kind: 'rejected', status: 409, reason: 'invalid_idempotent_request', permanent: true, intervention: true });
    // a original ainda está em andamento: tenta de novo com espera (resultado desconhecido, nunca falha)
    expect(await provider({ status: 409, body: { name: 'concurrent_idempotent_requests' } }).send(input)).toEqual({ kind: 'unknown', reason: 'concurrent_idempotent_requests' });
    // 409 sem nome conhecido (ou sem corpo): continua desconhecido — nunca assume falha
    expect(await provider({ status: 409, body: { name: 'algo_novo' } }).send(input)).toEqual({ kind: 'unknown', reason: 'idempotency_conflict' });
    expect(await provider({ status: 409, badJson: true }).send(input)).toEqual({ kind: 'unknown', reason: 'idempotency_conflict' });
    // chave inválida (400): defeito nosso, também exige uma pessoa
    expect(await provider({ status: 400, body: { name: 'invalid_idempotency_key' } }).send(input)).toEqual({ kind: 'rejected', status: 400, reason: 'invalid_idempotency_key', permanent: true, intervention: true });
    // outro 400 continua sendo erro permanente comum (sem intervenção)
    expect(await provider({ status: 400, body: { name: 'validation_error' } }).send(input)).toEqual({ kind: 'rejected', status: 400, reason: 'validation_error', permanent: true });
  });

  test('timeout real: um fetch que nunca responde é abortado e vira "desconhecido"', async () => {
    const hanging = new ResendEmailProvider({
      apiKey: 're_x',
      timeoutMs: 30,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    });
    expect(await hanging.send(input)).toEqual({ kind: 'unknown', reason: 'timeout' });
  });
});

describe('template do e-mail', () => {
  const vouchers = [
    { company: 'VS_BY_CLOSET' as const, amountCents: 5_000, code: 'VALLE-AAAA-1111', validFrom: new Date('2027-01-01T03:00:00Z'), expiresAt: new Date('2028-01-01T03:00:00Z') },
    { company: 'VALLE_SHOWROOM' as const, amountCents: 50_000, code: 'VALLE-BBBB-2222', validFrom: new Date('2027-01-01T03:00:00Z'), expiresAt: new Date('2028-01-01T03:00:00Z') },
  ];

  test('traz os DOIS vouchers separados (Valle Showroom primeiro), com valor, código, empresa e validade de 2027', () => {
    const email = renderVoucherEmail({ customerName: 'Maria Souza', orderName: '#1001', vouchers, replyTo: 'suporte@vallebycloset.com', timeZone: 'America/Sao_Paulo' });
    expect(email.subject).toBe('Seus vouchers do Valle Pass 2027');
    for (const part of ['R$ 500,00', 'R$ 50,00', 'VALLE-BBBB-2222', 'VALLE-AAAA-1111', 'Voucher Valle Showroom', 'Voucher VS BY CLOSET', 'Uso exclusivo na Valle Showroom.', 'Uso exclusivo na VS BY CLOSET.', 'Olá, Maria!', '#1001']) {
      expect(email.html, part).toContain(part);
    }
    expect(email.html.indexOf('VALLE-BBBB-2222')).toBeLessThan(email.html.indexOf('VALLE-AAAA-1111'));
    expect(email.html).toContain('Válido de 01/01/2027 a 31/12/2027');
    expect(email.text).toContain('Código: VALLE-BBBB-2222');
    expect(email.text).toContain('Válido de 01/01/2027 a 31/12/2027');
    expect(email.html).toContain('width=device-width');
    expect(email.html).toContain('max-width:600px');
    for (const line of EMAIL_TERMS) expect(email.html).toContain(escapeHtml(line));
  });

  test('NÃO promete o que não está confirmado: sem desconto de 10%, uso parcial, transferência ou reembolso', () => {
    const email = renderVoucherEmail({ customerName: null, orderName: null, vouchers, timeZone: 'America/Sao_Paulo' });
    for (const text of [email.html, email.text]) {
      expect(text).not.toMatch(/10\s?%|desconto|passeio|parcial|transfer|reembols|saldo/i);
    }
  });

  test('link dos termos: NUNCA por padrão (termos ainda não publicados); só com URL https válida; qualquer outra coisa é ignorada e nada promete o que não está aprovado', () => {
    const render = (termsUrl?: string | null) => renderVoucherEmail({ customerName: null, orderName: null, vouchers, timeZone: 'America/Sao_Paulo', termsUrl, logoUrl: null });
    for (const none of [undefined, null, '', 'http://inseguro.example/termos', 'javascript:alert(1)', '/termos-valle-pass', 'https://x.example/"onmouseover="x', 'https://x.example/<b>']) {
      const email = render(none);
      if (none === undefined) delete process.env.VALE_PASS_EMAIL_TERMS_URL;
      expect(email.html, String(none)).not.toContain('Ler os termos');
      expect(email.text, String(none)).not.toContain('Termos e condições do Valle Pass:');
    }
    const email = render('https://vsbycloset.example/termos-valle-pass?a=1&b=2');
    expect(email.html).toContain('<a href="https://vsbycloset.example/termos-valle-pass?a=1&amp;b=2"');
    expect(email.html).toContain('Ler os termos e condições do Valle Pass');
    expect(email.text).toContain('Termos e condições do Valle Pass: https://vsbycloset.example/termos-valle-pass?a=1&b=2');
    for (const text of [email.html, email.text]) expect(text).not.toMatch(/10\s?%|desconto|passeio|parcial|transfer|reembols|saldo/i);
  });

  test('o link dos termos também pode vir da configuração (VALE_PASS_EMAIL_TERMS_URL), e some quando a variável é removida', () => {
    process.env.VALE_PASS_EMAIL_TERMS_URL = 'https://vsbycloset.example/termos-valle-pass';
    try {
      expect(renderVoucherEmail({ customerName: null, orderName: null, vouchers, timeZone: 'America/Sao_Paulo' }).html).toContain('https://vsbycloset.example/termos-valle-pass');
    } finally {
      delete process.env.VALE_PASS_EMAIL_TERMS_URL;
    }
    expect(renderVoucherEmail({ customerName: null, orderName: null, vouchers, timeZone: 'America/Sao_Paulo' }).html).not.toContain('Ler os termos');
  });

  test('a validade independe do fuso do servidor e a data final é o último dia (31/12/2027)', () => {
    const tz = (zone: string) => renderVoucherEmail({ customerName: null, orderName: null, vouchers, timeZone: zone }).text;
    expect(tz('America/Sao_Paulo')).toContain('a 31/12/2027');
    expect(tz('UTC')).toContain('a 01/01/2028'); // outro fuso comercial muda o dia: por isso o fuso é parametrizado, e o padrão é o provisório
  });

  test('várias unidades: assunto e linha indicam "n de N"; HTML do nome do cliente é escapado', () => {
    const email = renderVoucherEmail({ customerName: '<script>alert(1)</script> Silva', orderName: '#2', vouchers, unit: { index: 2, total: 3 }, timeZone: 'America/Sao_Paulo' });
    expect(email.subject).toBe('Seus vouchers do Valle Pass 2027 (2 de 3)');
    expect(email.html).toContain('Valle Pass 2 de 3 do seu pedido.');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('nome absurdamente longo ou ausente cai para a saudação neutra', () => {
    expect(renderVoucherEmail({ customerName: 'x'.repeat(80), orderName: null, vouchers, timeZone: 'UTC' }).text).toContain('Olá!');
    expect(renderVoucherEmail({ customerName: '  ', orderName: null, vouchers, timeZone: 'UTC' }).text).toContain('Olá!');
  });
});

describe('template do e-mail — redesign editorial (compatibilidade, segurança e acessibilidade)', () => {
  const base = { company: 'VALLE_SHOWROOM' as const, amountCents: 50_000, code: 'VALLE-AAAA-1111', validFrom: new Date('2027-01-01T03:00:00Z'), expiresAt: new Date('2028-01-01T03:00:00Z') };
  const two = [base, { ...base, company: 'VS_BY_CLOSET' as const, amountCents: 5_000, code: 'VALLE-BBBB-2222' }];
  const render = (over: Record<string, unknown> = {}) => renderVoucherEmail({ customerName: 'Maria', orderName: '#1001', vouchers: two, timeZone: 'America/Sao_Paulo', ...over });

  test('estrutura editorial: título, subtítulo, selo, "Como utilizar seus benefícios", e encerramento', () => {
    const { html, text } = render();
    for (const part of ['Sua experiência começa aqui.', 'Seus benefícios exclusivos Valle Pass 2027 estão prontos para acompanhar você.', 'Valle Pass &bull; 2027', 'Como utilizar seus benefícios', 'Obrigada por escolher o Valle Pass 2027.']) expect(html, part).toContain(part);
    for (const part of ['SUA EXPERIÊNCIA COMEÇA AQUI.', 'Seus benefícios exclusivos Valle Pass 2027 estão prontos para acompanhar você.', 'COMO UTILIZAR SEUS BENEFÍCIOS', 'Obrigada por escolher o Valle Pass 2027.', 'Voucher Valle Showroom — R$ 500,00', 'Voucher VS BY CLOSET — R$ 50,00', 'Código: VALLE-AAAA-1111', 'Código: VALLE-BBBB-2222']) expect(text, part).toContain(part);
    for (const line of EMAIL_TERMS) expect(text).toContain(line); // a versão texto é completa
  });

  test('campanha de TESTE: assunto "[TESTE]" e faixa visível no HTML e no texto; a oficial não recebe nenhuma marcação; a frase redundante saiu', () => {
    const banner = 'VOUCHERS DE TESTE — SEM VALOR COMERCIAL';
    const test = render({ testCampaign: true });
    expect(test.subject).toBe('[TESTE] Seus vouchers do Valle Pass 2027');
    expect(test.html).toContain(banner);
    expect(test.text).toContain(banner);
    expect(test.html).toContain('<title>[TESTE] Seus vouchers do Valle Pass 2027</title>');
    expect(render({ testCampaign: true, unit: { index: 1, total: 2 } }).subject).toBe('[TESTE] Seus vouchers do Valle Pass 2027 (1 de 2)');
    for (const official of [render(), render({ testCampaign: false }), render({ testCampaign: undefined })]) {
      expect(official.subject).toBe('Seus vouchers do Valle Pass 2027');
      expect((official.html + official.text + official.subject).toUpperCase()).not.toMatch(/TESTE|SEM VALOR COMERCIAL/);
    }
    for (const rendered of [test, render()]) {
      expect(rendered.html + rendered.text).not.toContain('empresas diferentes');
      expect(rendered.html).toContain('Cada voucher vale somente na empresa indicada e não pode ser usado na outra.');
    }
  });

  test('compatibilidade: tabelas + estilos inline, 600 px, sem JavaScript, CSS/fonte/imagem externa ou imagem de fundo; códigos são TEXTO (selecionável), nunca imagem', () => {
    const { html } = render();
    expect(html).toMatch(/<table role="presentation"/);
    expect(html).toContain('max-width:600px');
    expect(html).toContain('width=device-width');
    expect(html).not.toMatch(/<script|<link|@import|@font-face|background-image|url\(|<iframe|javascript:/i);
    // a única imagem é o logotipo oficial (HTTPS, decorativo); nada essencial depende dela e os códigos são texto
    expect(html.match(/<img/gi)).toHaveLength(2);
    expect([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1])).toEqual([OFFICIAL_LOGO_URL, OFFICIAL_LOGO_URL]);
    expect(html).toMatch(/<td[^>]*class="code"[^>]*>VALLE-BBBB-2222<\/td>/);
    expect(html).toContain('@media only screen and (max-width:480px)');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('word-break:break-all'); // código longo nunca estoura o cartão
  });

  test('redação: nunca promete transferência nem inventa procedimento de transferência (vouchers intransferíveis); a validade vem dos dados do voucher', () => {
    const { html, text } = render();
    for (const content of [html, text]) {
      expect(content).not.toMatch(/(pode|podem|permit[a-z]*|poder[aá])[^.<]{0,40}transfer/i);
      expect(content).not.toMatch(/(?<!in)transfer[ií]ve/i); // 'transferíveis' nunca; 'intransferíveis' fica para a redação aprovada
    }
    expect(EMAIL_TERMS).toContain('Guarde este e-mail com segurança: ele contém os códigos dos seus vouchers.');
    // validade dinâmica: outra janela no voucher muda o texto (nenhuma data fixa no template)
    const other = render({ vouchers: [{ ...base, validFrom: new Date('2026-12-15T03:00:00Z'), expiresAt: new Date('2027-10-01T03:00:00Z') }] }).html;
    expect(other).toContain('Válido de 15/12/2026 a 30/09/2027');
    expect(other).not.toContain('31/12/2027');
  });

  test('logotipo oficial por padrão (HTTPS); VALE_PASS_EMAIL_LOGO_URL troca; vazio ou logoUrl nulo desliga; sem a imagem o e-mail funciona igual (texto alternativo e monograma)', () => {
    expect(OFFICIAL_LOGO_URL).toBe('https://vsbycloset.vercel.app/brand/logo-horizontal-cream.png');
    const original = process.env.VALE_PASS_EMAIL_LOGO_URL;
    try {
      delete process.env.VALE_PASS_EMAIL_LOGO_URL;
      expect(render().html).toContain(`src="${OFFICIAL_LOGO_URL}"`);
      process.env.VALE_PASS_EMAIL_LOGO_URL = 'https://logo.exemplo.invalid/l.png';
      expect(render().html).toContain('src="https://logo.exemplo.invalid/l.png"');
      process.env.VALE_PASS_EMAIL_LOGO_URL = '';
      expect(render().html).not.toMatch(/<img/i);
      delete process.env.VALE_PASS_EMAIL_LOGO_URL;
      expect(render({ logoUrl: null }).html).not.toMatch(/<img/i);
    } finally {
      if (original === undefined) delete process.env.VALE_PASS_EMAIL_LOGO_URL;
      else process.env.VALE_PASS_EMAIL_LOGO_URL = original;
    }
    // sem carregar a imagem: texto alternativo legível sobre a faixa vinho (cor creme no próprio <img>) e todo o conteúdo essencial como texto
    const { html, text } = render();
    expect(html).toMatch(/<img[^>]*alt="VS BY CLOSET"[^>]*color:#FFFCF6/);
    for (const code of ['VALLE-AAAA-1111', 'VALLE-BBBB-2222']) {
      expect(html).toContain(code);
      expect(text).toContain(code);
    }
  });

  test('logotipo opcional: só HTTPS e escapado; qualquer outra coisa cai para o monograma em texto (sem imagem)', () => {
    const withLogo = render({ logoUrl: 'https://vsbycloset.exemplo.invalid/brand/logo-horizontal-cream.png' }).html;
    expect(withLogo).toContain('<img class="logo" src="https://vsbycloset.exemplo.invalid/brand/logo-horizontal-cream.png"');
    expect(withLogo).toContain('alt="VS BY CLOSET"');
    for (const bad of ['http://x.invalid/a.png', 'javascript:alert(1)', 'https://x.invalid/a.png" onerror="alert(1)', 'https://x.invalid/a b.png', "https://x.invalid/<a>.png", 'data:image/png;base64,AAAA', '']) {
      const html = render({ logoUrl: bad }).html;
      expect(html, bad).not.toMatch(/<img/i);
      expect(html).not.toContain('onerror');
      expect(html).toContain('CLOSET'); // monograma em texto
    }
  });

  test('injeção de HTML: nome, pedido, código, contato e logotipo são escapados em TODOS os pontos; o texto simples não é HTML', () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const { html, text } = render({ customerName: evil.slice(0, 30), orderName: evil, replyTo: evil, vouchers: [{ ...base, code: evil }, { ...two[1], code: '</td><script>x</script>' }], logoUrl: 'https://x.invalid/l.png' });
    expect(html).not.toMatch(/<script|<img src=x/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;/td&gt;&lt;script&gt;x&lt;/script&gt;');
    expect(text).toContain('<img src=x onerror=alert(1)>'); // texto puro: sem escape HTML
  });

  test('textos longos: nome acima de 40 letras vira saudação neutra; pedido, código e contato longos continuam no layout (quebra permitida) e aparecem inteiros', () => {
    const longCode = 'VALLE-' + 'A'.repeat(80);
    const { html, text } = render({ orderName: '#' + '9'.repeat(60), replyTo: 'suporte-' + 'x'.repeat(60) + '@vallebycloset.com', vouchers: [{ ...base, code: longCode }, two[1]] });
    expect(html).toContain(longCode);
    expect(text).toContain(longCode);
    expect(html).toContain('Olá, Maria!');
    expect(html).toMatch(/word-break:break-all/);
  });

  test('o contrato de retorno e as promessas continuam: { subject, html, text }; sem desconto, uso parcial, transferência ou reembolso; contato só se configurado', () => {
    const email = render();
    expect(Object.keys(email).sort()).toEqual(['html', 'subject', 'text']);
    for (const text of [email.html, email.text]) expect(text).not.toMatch(/10\s?%|desconto|passeio|parcial|transfer|reembols|saldo/i);
    expect(email.text).toContain('Dúvidas? Responda este e-mail.');
    expect(render({ replyTo: 'suporte@vallebycloset.com' }).text).toContain('escreva para suporte@vallebycloset.com');
    expect(email.html).not.toMatch(/instagram|facebook|whatsapp|href=/i); // nada de links ou redes sociais inventados
  });
});

describe('espera entre tentativas', () => {
  test('cresce de 1 min a 24 h e o jitter fica em ±10%', () => {
    expect(BACKOFF_MINUTES).toEqual([1, 5, 15, 60, 180, 360, 720, 1440]);
    BACKOFF_MINUTES.forEach((minutes, index) => {
      expect(backoffMs(index + 1, () => 0.5)).toBe(minutes * 60_000);
      expect(backoffMs(index + 1, () => 0)).toBe(Math.round(minutes * 60_000 * 0.9));
      expect(backoffMs(index + 1, () => 1)).toBe(Math.round(minutes * 60_000 * 1.1));
    });
    expect(backoffMs(99, () => 0.5)).toBe(1440 * 60_000);
    expect(backoffMs(0, () => 0.5)).toBe(60_000);
  });
});

describe('assinatura do webhook da Resend (Svix)', () => {
  const secretBytes = Buffer.from('uma-chave-secreta-de-teste-1234567890');
  const secret = `whsec_${secretBytes.toString('base64')}`;
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_9' } });
  const sign = (id: string, ts: string, payload: string, key = secretBytes) => `v1,${createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64')}`;
  const now = 1_800_000_000;
  const base = { secret, id: 'msg_1', timestamp: String(now), rawBody: body, nowSeconds: now };

  test('aceita a assinatura correta (inclusive entre várias)', () => {
    expect(verifySvixSignature({ ...base, signature: sign('msg_1', String(now), body) })).toBe(true);
    expect(verifySvixSignature({ ...base, signature: `v1,AAAA ${sign('msg_1', String(now), body)}` })).toBe(true);
    expect(verifySvixSignature({ ...base, rawBody: Buffer.from(body), signature: sign('msg_1', String(now), body) })).toBe(true);
  });

  test('recusa corpo alterado, outro segredo, outro id, carimbo velho/futuro e cabeçalhos ausentes', () => {
    const good = sign('msg_1', String(now), body);
    expect(verifySvixSignature({ ...base, rawBody: body + ' ', signature: good })).toBe(false);
    expect(verifySvixSignature({ ...base, signature: sign('msg_1', String(now), body, Buffer.from('outro')) })).toBe(false);
    expect(verifySvixSignature({ ...base, id: 'msg_2', signature: good })).toBe(false);
    expect(verifySvixSignature({ ...base, nowSeconds: now + 301, signature: good })).toBe(false);
    expect(verifySvixSignature({ ...base, nowSeconds: now - 301, signature: good })).toBe(false);
    expect(verifySvixSignature({ ...base, signature: undefined })).toBe(false);
    expect(verifySvixSignature({ ...base, id: undefined, signature: good })).toBe(false);
    expect(verifySvixSignature({ ...base, timestamp: 'abc', signature: good })).toBe(false);
    expect(verifySvixSignature({ ...base, secret: '', signature: good })).toBe(false);
    expect(verifySvixSignature({ ...base, signature: 'v2,' + good.slice(3) })).toBe(false);
  });

  test('interpreta só eventos bem formados', () => {
    expect(parseResendEvent(body)).toEqual({ type: 'email.delivered', emailId: 'em_9' });
    expect(parseResendEvent('não é json')).toBeNull();
    expect(parseResendEvent(JSON.stringify({ type: 'email.delivered' }))).toBeNull();
    expect(parseResendEvent(JSON.stringify({ type: 5, data: { email_id: 'x' } }))).toBeNull();
    expect(parseResendEvent(undefined)).toBeNull();
  });
});
