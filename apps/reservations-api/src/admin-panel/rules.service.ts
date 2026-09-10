import { HttpException, Injectable, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import type { UpdateRulesDto } from './dto/update-rules.dto';
import { validateRentalConfig } from '../rental-rules/validate-rental-config';

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
          // Serialize PATCH reads so two individually valid edits cannot combine into invalid rules.
          await tx.$queryRaw`SELECT id FROM rental_rule_config WHERE id = 'default' FOR UPDATE`;
          const before = await tx.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } });

          const patch = Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));
          try {
            validateRentalConfig({ ...before, ...patch });
          } catch (err) {
            throw new UnprocessableEntityException(err instanceof Error ? err.message : 'Configuração inválida.');
          }

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

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
