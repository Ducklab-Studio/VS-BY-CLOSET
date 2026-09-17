import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ValePass, ValePassStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';

export interface ValePassVoucherItem {
  readonly id: string;
  readonly code: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly amountCents: number;
  readonly status: ValePassStatus;
  readonly purchasedAt: string;
  readonly expiresAt: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly shopifyOrderId: string | null;
  readonly shopifyOrderName: string | null;
  readonly usedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
}

export interface ValePassVoucherFilters {
  readonly status?: ValePassStatus;
  readonly campaignId?: string;
  /** Busca livre: código, nome, telefone, e-mail ou nº do pedido. */
  readonly search?: string;
}

/**
 * "Listar, buscar, validar e marcar o Valle Pass como utilizado" —
 * nunca DELETE; "usar"/"cancelar" são transições de status
 * (`ValePassStatus`), sempre com trilha em `ValePassEvent` +
 * `AdminAuditEvent`. Expiração é LAZY (mesmo padrão já usado pra
 * `pending_payment` → `expired` em reservas): `ACTIVE` com `expiresAt`
 * no passado vira `EXPIRED` no próximo `list()`/`findByCode()`, nunca
 * por um cron separado.
 */
@Injectable()
export class ValePassVouchersService {
  private readonly logger = new Logger(ValePassVouchersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(filters: ValePassVoucherFilters): Promise<ValePassVoucherItem[]> {
    await this.expireStale();

    const search = filters.search?.trim();
    const rows = await this.prisma.valePass.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: 'insensitive' } },
                { customerName: { contains: search, mode: 'insensitive' } },
                { customerPhone: { contains: search, mode: 'insensitive' } },
                { customerEmail: { contains: search, mode: 'insensitive' } },
                { shopifyOrderName: { contains: search, mode: 'insensitive' } },
                { shopifyOrderId: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { campaign: { select: { name: true } } },
      orderBy: { purchasedAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => toItem(row, row.campaign.name));
  }

  async findByCode(code: string): Promise<ValePassVoucherItem> {
    await this.expireStale();
    const row = await this.requireByCode(code);
    return toItem(row, (await this.prisma.valePassCampaign.findUniqueOrThrow({ where: { id: row.campaignId }, select: { name: true } })).name);
  }

  async markUsed(code: string, actorId: string, actorName: string): Promise<ValePassVoucherItem> {
    await this.expireStale();
    const target = await this.requireByCode(code);

    if (target.status !== 'ACTIVE') {
      throw new BadRequestException(`Este Valle Pass não pode ser utilizado — status atual: ${STATUS_LABELS[target.status]}.`);
    }

    let updated;
    try {
      updated = await this.prisma.valePass.update({ where: { id: target.id }, data: { status: 'USED', usedAt: new Date(), usedBy: actorId } });
    } catch (err) {
      this.logger.error(`Falha ao marcar Valle Pass ${target.id} como utilizado: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível marcar o Valle Pass como utilizado no momento.');
    }

    await this.prisma.valePassEvent.create({ data: { valePassId: target.id, type: 'USED', detail: { actorId } } });
    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: 'VALE_PASS_MARKED_USED',
      entityType: 'ValePass',
      entityId: target.id,
      before: { status: target.status },
      after: { status: 'USED' },
      detail: { code: target.code },
    });

    return toItem(updated, (await this.prisma.valePassCampaign.findUniqueOrThrow({ where: { id: updated.campaignId }, select: { name: true } })).name);
  }

  async cancel(code: string, reason: string, actorId: string, actorName: string): Promise<ValePassVoucherItem> {
    await this.expireStale();
    const target = await this.requireByCode(code);

    if (target.status === 'USED') throw new ConflictException('Este Valle Pass já foi utilizado — não pode ser cancelado.');
    if (target.status === 'CANCELLED') throw new BadRequestException('Este Valle Pass já está cancelado.');

    let updated;
    try {
      updated = await this.prisma.valePass.update({
        where: { id: target.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actorId, cancelReason: reason },
      });
    } catch (err) {
      this.logger.error(`Falha ao cancelar Valle Pass ${target.id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível cancelar o Valle Pass no momento.');
    }

    await this.prisma.valePassEvent.create({ data: { valePassId: target.id, type: 'CANCELLED', detail: { actorId, reason } } });
    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: 'VALE_PASS_CANCELLED_BY_ADMIN',
      entityType: 'ValePass',
      entityId: target.id,
      before: { status: target.status },
      after: { status: 'CANCELLED' },
      detail: { code: target.code, reason },
    });

    return toItem(updated, (await this.prisma.valePassCampaign.findUniqueOrThrow({ where: { id: updated.campaignId }, select: { name: true } })).name);
  }

  private async requireByCode(code: string): Promise<ValePass> {
    const normalized = code.trim().toUpperCase();
    const row = await this.prisma.valePass.findUnique({ where: { code: normalized } });
    if (!row) throw new NotFoundException('Valle Pass não encontrado para este código.');
    return row;
  }

  /** Mesmo padrão já usado pra `pending_payment` → `expired`: um
   *  UPDATE escopado, disparado a cada leitura, nunca um cron
   *  separado. */
  private async expireStale(): Promise<void> {
    await this.prisma.valePass.updateMany({ where: { status: 'ACTIVE', expiresAt: { lte: new Date() } }, data: { status: 'EXPIRED' } });
  }
}

const STATUS_LABELS: Record<ValePassStatus, string> = { ACTIVE: 'ativo', USED: 'utilizado', EXPIRED: 'expirado', CANCELLED: 'cancelado' };

function toItem(row: ValePass, campaignName: string): ValePassVoucherItem {
  return {
    id: row.id,
    code: row.code,
    campaignId: row.campaignId,
    campaignName,
    amountCents: row.amountCents,
    status: row.status,
    purchasedAt: row.purchasedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    customerEmail: row.customerEmail,
    shopifyOrderId: row.shopifyOrderId,
    shopifyOrderName: row.shopifyOrderName,
    usedAt: row.usedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
  };
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
