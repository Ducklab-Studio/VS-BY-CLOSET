import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';

export interface ValePassCampaignItem {
  readonly id: string;
  readonly name: string;
  readonly amountCents: number;
  readonly validityDays: number;
  readonly quantityLimit: number | null;
  readonly shopifyVariantId: string;
  readonly active: boolean;
  readonly soldCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * "Permitir configurar valor, validade, quantidade e campanha" +
 * "Permitir ativar/desativar a campanha sem apagar vales já vendidos".
 * Nunca DELETE — `active=false` é a única forma de "encerrar". Nunca
 * cria produto na Shopify (mesmo padrão de RentalUnit): o
 * `shopifyVariantId` referencia uma variante já criada manualmente.
 */
@Injectable()
export class ValePassCampaignsService {
  private readonly logger = new Logger(ValePassCampaignsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ValePassCampaignItem[]> {
    const rows = await this.prisma.valePassCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { vouchers: true } } },
    });
    return rows.map((row) => toItem(row, row._count.vouchers));
  }

  async create(
    input: { name: string; amountCents: number; validityDays: number; quantityLimit?: number; shopifyVariantId: string },
    actorId: string,
    actorName: string,
  ): Promise<ValePassCampaignItem> {
    let created;
    try {
      created = await this.prisma.valePassCampaign.create({
        data: {
          name: input.name.trim(),
          amountCents: input.amountCents,
          validityDays: input.validityDays,
          quantityLimit: input.quantityLimit ?? null,
          shopifyVariantId: input.shopifyVariantId.trim(),
          active: true,
          createdBy: actorId,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('Já existe uma campanha para esta variante da Shopify.');
      this.logger.error(`Falha ao criar campanha Valle Pass: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar a campanha no momento.');
    }

    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: 'VALE_PASS_CAMPAIGN_CREATED',
      entityType: 'ValePassCampaign',
      entityId: created.id,
      after: { name: created.name, amountCents: created.amountCents, validityDays: created.validityDays, quantityLimit: created.quantityLimit, shopifyVariantId: created.shopifyVariantId },
    });

    return toItem(created, 0);
  }

  async setActive(id: string, active: boolean, actorId: string, actorName: string): Promise<ValePassCampaignItem> {
    const target = await this.requireCampaign(id);

    let updated;
    try {
      updated = await this.prisma.valePassCampaign.update({ where: { id }, data: { active } });
    } catch (err) {
      this.logger.error(`Falha ao atualizar campanha Valle Pass ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível atualizar a campanha no momento.');
    }

    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: active ? 'VALE_PASS_CAMPAIGN_ACTIVATED' : 'VALE_PASS_CAMPAIGN_DEACTIVATED',
      entityType: 'ValePassCampaign',
      entityId: id,
      before: { active: target.active },
      after: { active: updated.active },
    });

    const soldCount = await this.prisma.valePass.count({ where: { campaignId: id } });
    return toItem(updated, soldCount);
  }

  private async requireCampaign(id: string): Promise<ValePassCampaign> {
    const target = await this.prisma.valePassCampaign.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Campanha não encontrada.');
    return target;
  }
}

function toItem(row: ValePassCampaign, soldCount: number): ValePassCampaignItem {
  return {
    id: row.id,
    name: row.name,
    amountCents: row.amountCents,
    validityDays: row.validityDays,
    quantityLimit: row.quantityLimit,
    shopifyVariantId: row.shopifyVariantId,
    active: row.active,
    soldCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'P2002';
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
