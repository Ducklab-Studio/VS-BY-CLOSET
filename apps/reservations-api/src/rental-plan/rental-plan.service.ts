import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { MaxPiecesExceededError, durationForPieces } from '../rental-rules/rental-engine';

/**
 * Existe pra fechar a última duplicação de regra de negócio no frontend:
 * antes da Fase 4.1, apps/marketing/src/app/carrinho/page.tsx importava
 * `durationForPieces`/`DEFAULT_RULES` do lib LOCAL (uma cópia congelada
 * da tabela de peças→dias) só pra mostrar "período de X dias" no resumo
 * do carrinho. Se o Anderson mudasse a tabela pelo painel (fase futura),
 * o carrinho continuaria mostrando o número antigo — nunca dessincroniza
 * de propósito, ou o motor real está do lado do servidor, ou não está
 * em lugar nenhum.
 *
 * Só duração — sem data, sem checagem de temporada/domingo/antecedência
 * — porque é só isso que o carrinho precisa saber. `durationForPieces`
 * é a MESMA função (não uma cópia) usada por AvailabilityService.
 */
@Injectable()
export class RentalPlanService {
  private readonly logger = new Logger(RentalPlanService.name);

  constructor(private readonly rentalRuleConfig: RentalRuleConfigService) {}

  async getDuration(countedPieces: number): Promise<{ countedPieces: number; durationDays: number }> {
    let config;
    try {
      config = await this.rentalRuleConfig.load();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha inesperada ao carregar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível calcular a duração no momento.');
    }

    // durationForPieces valida 1..maxPieces e lança erro fora disso. O
    // DTO (1-6) cobre o caso comum, mas se um dia a config real tiver
    // maxPieces menor que 6 (o Anderson mudou pelo painel, por exemplo),
    // essa exceção pega isso e devolve um erro de API normal — não deixa
    // o Error cru virar 500.
    try {
      const durationDays = durationForPieces(countedPieces, config);
      return { countedPieces, durationDays };
    } catch (err) {
      if (err instanceof MaxPiecesExceededError) {
        throw new UnprocessableEntityException(err.message);
      }
      throw err;
    }
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
