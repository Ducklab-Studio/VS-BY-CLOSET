import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma, RentalRuleConfig as RentalRuleConfigRow } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_RENTAL_RULE_CONFIG,
  type PiecesToDaysRule,
  type RentalRuleConfig,
} from '../rental-rules/rental-rule-config';
import { validateRentalConfig } from '../rental-rules/validate-rental-config';
import { civilDateFromPgDate, civilDateToISO } from '../rental-rules/civil-date';

/**
 * Ponte entre a tabela `rental_rule_config` (singleton, ver migration
 * 20260903120100) e o tipo `RentalRuleConfig` que o motor puro consome.
 *
 * FAIL CLOSED: se o banco não responder, NÃO cai pro `DEFAULT_RENTAL_RULE_CONFIG`
 * silenciosamente — isso pareceria "funcionando" com regras potencialmente
 * desatualizadas (se o Anderson tivesse acabado de mudar `minAdvanceDays`
 * pelo painel, por exemplo) e mascararia o banco estar fora do ar. Lança
 * erro; quem chama decide como responder ao cliente (ver
 * AvailabilityService).
 *
 * Sem cache: toda chamada lê o banco, então uma alteração feita no painel vale
 * na próxima consulta, sem reiniciar nada.
 */
@Injectable()
export class RentalRuleConfigService {
  private readonly logger = new Logger(RentalRuleConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** `client` = transação de quem aloca (HOLD/reserva manual): lida depois do
   *  lock de bloqueios, a regra usada é a mesma que estava valendo no commit. */
  async load(client: Pick<PrismaService | Prisma.TransactionClient, 'rentalRuleConfig'> = this.prisma): Promise<RentalRuleConfig> {
    let row;
    try {
      row = await client.rentalRuleConfig.findUnique({ where: { id: 'default' } });
    } catch (err) {
      // Só o essencial no log — nunca o erro completo, que em alguns
      // drivers Postgres pode embutir a connection string na mensagem.
      this.logger.error(`Falha ao consultar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar a disponibilidade no momento.');
    }

    if (!row) {
      // Configuração ausente é erro de operação (a migration insere a
      // linha 'default'; se sumiu, algo mexeu no banco por fora), não
      // um "usa o padrão e segue" — o padrão do código pode já estar
      // desatualizado em relação ao que o painel administrativo gravou
      // por último.
      this.logger.error('rental_rule_config sem a linha "default".');
      throw new ServiceUnavailableException('Não foi possível consultar a disponibilidade no momento.');
    }

    const config = toRentalRuleConfig(row);
    try {
      validateRentalConfig(config);
    } catch {
      this.logger.error('rental_rule_config inválida.');
      throw new ServiceUnavailableException('Não foi possível consultar a disponibilidade no momento.');
    }
    return config;
  }
}

/** Linha do banco → formato do motor (DATE vira YYYY-MM-DD; colunas legadas ficam de fora). */
export function toRentalRuleConfig(row: Pick<RentalRuleConfigRow, 'minAdvanceDays' | 'prepDays' | 'cleaningDays' | 'operationStartDate' | 'maxPieces' | 'piecesToDaysTable' | 'timezone'>): RentalRuleConfig {
  return {
    minAdvanceDays: row.minAdvanceDays,
    prepDays: row.prepDays,
    cleaningDays: row.cleaningDays,
    operationStartDate: row.operationStartDate ? civilDateToISO(civilDateFromPgDate(row.operationStartDate)) : null,
    maxPieces: row.maxPieces,
    piecesToDaysTable: row.piecesToDaysTable as unknown as PiecesToDaysRule[],
    timezone: row.timezone,
  };
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}

// Reexportado só pra quem quiser o fallback explicitamente (ex.: testes
// locais sem banco) — nunca usado como fallback silencioso aqui dentro.
export { DEFAULT_RENTAL_RULE_CONFIG };
