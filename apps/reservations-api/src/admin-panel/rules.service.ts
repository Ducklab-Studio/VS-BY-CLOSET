import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import type { UpdateRulesDto } from './dto/update-rules.dto';

/**
 * Fase 9, item 12 — /closetadmin/regras. Editor SÓ pra
 * `RentalRuleConfig` (singleton já usado pelo RentalPlanEngine desde a
 * Fase 3) — o frontend não implementa regra nenhuma, só edita os
 * NÚMEROS que o motor já consome. `RentalPlanEngine` continua sendo a
 * autoridade final: como `RentalRuleConfigService.load()` já lê fresco
 * do banco a cada chamada (sem cache), uma alteração aqui vale pra
 * próxima consulta de disponibilidade/HOLD/reserva manual imediatamente,
 * sem precisar de deploy.
 */
@Injectable()
export class AdminRulesService {
  private readonly logger = new Logger(AdminRulesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get() {
    try {
      const row = await this.prisma.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } });
      return row;
    } catch (err) {
      this.logger.error(`Falha ao consultar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar as regras no momento.');
    }
  }

  async update(dto: UpdateRulesDto, adminUserId: string, adminUserName: string) {
    const before = await this.get();

    const data: Prisma.RentalRuleConfigUpdateInput = {
      minAdvanceDays: dto.minAdvanceDays,
      prepDays: dto.prepDays,
      cleaningDays: dto.cleaningDays,
      blackoutStart: dto.blackoutStart,
      blackoutEnd: dto.blackoutEnd,
      maxPieces: dto.maxPieces,
      timezone: dto.timezone,
      ...(dto.piecesToDaysTable ? { piecesToDaysTable: dto.piecesToDaysTable as unknown as Prisma.InputJsonValue } : {}),
    };
    let after;
    try {
      after = await this.prisma.rentalRuleConfig.update({ where: { id: 'default' }, data });
    } catch (err) {
      this.logger.error(`Falha ao atualizar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível atualizar as regras no momento.');
    }

    // Item 12: "Toda alteração deve registrar: adminUserId, before,
    // after, timestamp" — nunca aplicado silenciosamente.
    await writeAdminAuditEvent(this.prisma, {
      adminUserId,
      adminUserName,
      action: 'RULE_MODIFIED',
      entityType: 'RentalRuleConfig',
      entityId: 'default',
      before,
      after,
    });

    return after;
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
