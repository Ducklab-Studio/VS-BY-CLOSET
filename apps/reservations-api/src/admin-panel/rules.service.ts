import { HttpException, Injectable, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma, RentalRuleConfig as RentalRuleConfigRow } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { lockOperationalBlocks } from '../admin/operational-blocks';
import type { UpdateRulesDto } from './dto/update-rules.dto';
import { validateRentalConfig } from '../rental-rules/validate-rental-config';
import type { RentalRuleConfig } from '../rental-rules/rental-rule-config';
import { toRentalRuleConfig } from '../rental-rule-config/rental-rule-config.service';

export interface RulesView extends RentalRuleConfig {
  readonly id: string;
  readonly updatedAt: string;
}

@Injectable()
export class AdminRulesService {
  private readonly logger = new Logger(AdminRulesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<RulesView> {
    try {
      return toRulesView(await this.prisma.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } }));
    } catch (err) {
      this.logger.error(`Falha ao consultar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar as regras no momento.');
    }
  }

  async update(dto: UpdateRulesDto, adminUserId: string, adminUserName: string): Promise<RulesView> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Exclusivo: espera HOLDs/reservas em andamento (que leem a regra
          // sob o lock compartilhado) e as próximas já leem a regra nova.
          await lockOperationalBlocks(tx, true);
          // Serialize PATCH reads so two individually valid edits cannot combine into invalid rules.
          await tx.$queryRaw`SELECT id FROM rental_rule_config WHERE id = 'default' FOR UPDATE`;
          const before = toRulesView(await tx.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } }));

          const prospective: RentalRuleConfig = {
            minAdvanceDays: dto.minAdvanceDays ?? before.minAdvanceDays,
            prepDays: dto.prepDays ?? before.prepDays,
            cleaningDays: dto.cleaningDays ?? before.cleaningDays,
            operationStartDate: dto.operationStartDate === undefined ? before.operationStartDate : dto.operationStartDate,
            maxPieces: dto.maxPieces ?? before.maxPieces,
            piecesToDaysTable: dto.piecesToDaysTable ?? before.piecesToDaysTable,
            timezone: dto.timezone ?? before.timezone,
          };
          try {
            validateRentalConfig(prospective);
          } catch (err) {
            throw new UnprocessableEntityException(err instanceof Error ? err.message : 'Configuração inválida.');
          }

          const data: Prisma.RentalRuleConfigUpdateInput = {
            minAdvanceDays: dto.minAdvanceDays,
            prepDays: dto.prepDays,
            cleaningDays: dto.cleaningDays,
            maxPieces: dto.maxPieces,
            timezone: dto.timezone,
            ...(dto.operationStartDate !== undefined
              ? { operationStartDate: prospective.operationStartDate === null ? null : new Date(prospective.operationStartDate) }
              : {}),
            ...(dto.piecesToDaysTable
              ? { piecesToDaysTable: dto.piecesToDaysTable as unknown as Prisma.InputJsonValue }
              : {}),
          };

          const after = toRulesView(await tx.rentalRuleConfig.update({ where: { id: 'default' }, data }));

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

function toRulesView(row: RentalRuleConfigRow): RulesView {
  return { id: row.id, ...toRentalRuleConfig(row), updatedAt: row.updatedAt.toISOString() };
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
