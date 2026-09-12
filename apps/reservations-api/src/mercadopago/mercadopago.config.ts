import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Mercado Pago como método de PRINCIPAL de pagamento (Shopify continua
 * como alternativa — ver checkout.module.ts). Só ambiente de TESTE
 * nesta fase — fail closed com força-bruta: qualquer valor que não
 * comece com "TEST-" é recusado, mesmo que alguém configure a variável
 * errada sem querer. Nunca existe fallback pra produção aqui.
 */
export interface MercadoPagoCredentials {
  readonly accessToken: string;
  readonly publicKey: string;
}

export function resolveMercadoPagoCredentials(): MercadoPagoCredentials {
  const accessToken = process.env.MERCADOPAGO_TEST_ACCESS_TOKEN;
  const publicKey = process.env.MERCADOPAGO_TEST_PUBLIC_KEY;

  if (!accessToken || !publicKey) {
    throw new ServiceUnavailableException('Mercado Pago (sandbox) não está configurado.');
  }
  assertIsTestCredential(accessToken, 'MERCADOPAGO_TEST_ACCESS_TOKEN');
  assertIsTestCredential(publicKey, 'MERCADOPAGO_TEST_PUBLIC_KEY');

  return { accessToken, publicKey };
}

/** Nunca lança segredo nenhum na mensagem — só o nome da variável e o
 *  prefixo esperado. */
function assertIsTestCredential(value: string, envVarName: string): void {
  if (!value.startsWith('TEST-')) {
    throw new Error(`${envVarName} não é uma credencial de TESTE do Mercado Pago (precisa começar com "TEST-"). Credenciais de produção nunca são aceitas nesta integração.`);
  }
}

/**
 * Ausente nesta fase (não foi fornecido) — sem ela, a verificação de
 * assinatura do webhook fica DESLIGADA (ver mercadopago-webhook-signature.ts):
 * o webhook ainda é seguro porque o servidor NUNCA confia no corpo da
 * notificação — sempre reconsulta o pagamento direto na API do Mercado
 * Pago antes de confirmar qualquer coisa. Mas isto é uma pendência real
 * pra homologação: configure MERCADOPAGO_TEST_WEBHOOK_SECRET assim que
 * disponível pra fechar essa camada extra de defesa.
 */
export function resolveMercadoPagoWebhookSecret(): string | null {
  return process.env.MERCADOPAGO_TEST_WEBHOOK_SECRET?.trim() || null;
}
