import { HttpException, Injectable, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import type { UpdateRulesDto } from './dto/update-rules.dto';

@Injectable()
export class AdminRulesService {
  private readonly logger = new Logger(AdminRulesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get() {
    try {
      return await this.prisma.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } });
    } catch (err) {
      this.logger.error(`Falha ao consultar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar as regras no momento.');
    }
  }

  async update(dto: UpdateRulesDto, adminUserId: string, adminUserName: string) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const before = await tx.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } });

          validateProspectiveRules(before, dto);

          const data: Prisma.RentalRuleConfigUpdateInput = {
            minAdvanceDays: dto.minAdvanceDays,
            prepDays: dto.prepDays,
            cleaningDays: dto.cleaningDays,
            blackoutStart: dto.blackoutStart,
            blackoutEnd: dto.blackoutEnd,
            maxPieces: dto.maxPieces,
            timezone: dto.timezone,
            ...(dto.piecesToDaysTable
              ? { piecesToDaysTable: dto.piecesToDaysTable as unknown as Prisma.InputJsonValue }
              : {}),
          };

          const after = await tx.rentalRuleConfig.update({ where: { id: 'default' }, data });

          // Regra + auditoria são uma única transação. Se o audit falhar,
          // a alteração de regra também volta — nunca existe regra aplicada
          // sem o respectivo evento administrativo.
          await writeAdminAuditEvent(tx, {
            adminUserId,
            adminUserName,
            action: 'RULE_MODIFIED',
            entityType: 'RentalRuleConfig',
            entityId: 'default',
            before,
            after,
          });

          return after;
        },
        { timeout: 10_000, maxWait: 5_000 },
      );
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha ao atualizar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível atualizar as regras no momento.');
    }
  }
}

/**
 * Validação cruzada da configuração FINAL (estado atual + PATCH).
 * O DTO valida cada campo isoladamente; aqui garantimos a coerência entre
 * maxPieces e a tabela de duração. Os dias NÃO precisam ser crescentes:
 * isso é decisão comercial. Apenas `upTo` deve estar em ordem estritamente
 * crescente para o motor ter uma interpretação determinística, e a tabela
 * deve cobrir todo o maxPieces configurado.
 */
function validateProspectiveRules(
  before: { maxPieces: number; piecesToDaysTable: unknown },
  dto: Pick<UpdateRulesDto, 'maxPieces' | 'piecesToDaysTable'>,
): void {
  const maxPieces = dto.maxPieces ?? before.maxPieces;
  const table = dto.piecesToDaysTable ?? before.piecesToDaysTable;

  if (!Array.isArray(table) || table.length === 0) {
    throw new UnprocessableEntityException('A tabela de duração precisa ter ao menos uma faixa.');
  }

  let previousUpTo = 0;
  for (let index = 0; index < table.length; index++) {
    const entry = table[index];
    if (typeof entry !== 'object' || entry === null) {
      throw new UnprocessableEntityException(`Faixa de duração ${index + 1} inválida.`);
    }

    const row = entry as Record<string, unknown>;
    const upTo = row.upTo;
    const days = row.days;
    if (!Number.isInteger(upTo) || Number(upTo) <= 0 || !Number.isInteger(days) || Number(days) <= 0) {
      throw new UnprocessableEntityException(`Faixa de duração ${index + 1} precisa ter upTo e days inteiros positivos.`);
    }

    if (Number(upTo) <= previousUpTo) {
      throw new UnprocessableEntityException('As faixas de duração precisam estar em ordem crescente, sem repetir upTo.');
    }
    previousUpTo = Number(upTo);
  }

  if (previousUpTo < maxPieces) {
    throw new UnprocessableEntityException(
      `A tabela de duração cobre até ${previousUpTo} peça(s), mas o máximo configurado é ${maxPieces}.`,
    );
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
