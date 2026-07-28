/**
 * Carrega o .env para process.env.
 *
 * Precisa ser o PRIMEIRO import do processo. Os imports de ES são içados e
 * avaliados em ordem, e o AppModule lê a configuração já no topo do arquivo —
 * se o .env não estiver carregado antes disso, a validação de ambiente vê
 * variáveis vazias e derruba o boot em desenvolvimento.
 *
 * Em produção as variáveis vêm do orquestrador e nenhum arquivo é lido.
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

if (process.env.NODE_ENV !== 'production') {
  // Roda tanto de apps/api (dev) quanto da raiz do monorepo.
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(__dirname, '../../../../.env'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      config({ path });
      break;
    }
  }
}
