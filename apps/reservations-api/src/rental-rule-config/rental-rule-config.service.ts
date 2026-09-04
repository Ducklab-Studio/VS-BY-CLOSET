import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_RENTAL_RULE_CONFIG,
  type PiecesToDaysRule,
  type RentalRuleConfig,
} from '../rental-rules/rental-rule-config';

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
 */
@Injectable()
export class RentalRuleConfigService {
  private readonly logger = new Logger(RentalRuleConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  async load(): Promise<RentalRuleConfig> {
    let row;
    try {
      row = await this.prisma.rentalRuleConfig.findUnique({ where: { id: 'default' } });
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
      // desatualizado em relação ao que o painel administrativo (fase
      // futura) gravou por último.
      this.logger.error('rental_rule_config sem a linha "default".');
      throw new ServiceUnavailableException('Não foi possível consultar a disponibilidade no momento.');
    }

    return {
      minAdvanceDays: row.minAdvanceDays,
      prepDays: row.prepDays,
      cleaningDays: row.cleaningDays,
      blackoutStart: row.blackoutStart,
      blackoutEnd: row.blackoutEnd,
      maxPieces: row.maxPieces,
      piecesToDaysTable: parsePiecesToDaysTable(row.piecesToDaysTable),
      timezone: row.timezone,
    };
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}

/**
 * `piecesToDaysTable` é JSONB — chega como `unknown` do ponto de vista
 * do TypeScript. Valida o formato explicitamente em vez de fazer um
 * cast direto: uma linha de config corrompida ou editada à mão errado
 * no banco tem que virar um erro claro aqui, não um `undefined.days`
 * explodindo em algum lugar aleatório do motor mais adiante.
 */
function parsePiecesToDaysTable(value: unknown): PiecesToDaysRule[] {
  if (!Array.isArray(value)) {
    throw new Error('rental_rule_config.pieces_to_days_table não é um array.');
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>).upTo !== 'number' ||
      typeof (entry as Record<string, unknown>).days !== 'number'
    ) {
      throw new Error(`rental_rule_config.pieces_to_days_table[${index}] tem formato inválido.`);
    }
    return entry as PiecesToDaysRule;
  });
}

// Reexportado só pra quem quiser o fallback explicitamente (ex.: testes
// locais sem banco) — nunca usado como fallback silencioso aqui dentro.
export { DEFAULT_RENTAL_RULE_CONFIG };
