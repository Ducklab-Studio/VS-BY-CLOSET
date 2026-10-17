import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { PASS_UNIT_KEY, formatIsoDate, loadCapacity, loadLotSold } from './vale-pass-capacity';
import { planCampaignUpdate, type CampaignUpdateInput } from './vale-pass-campaign-update';

export interface ValePassCampaignItem {
  readonly id: string;
  readonly name: string;
  readonly amountCents: number;
  readonly validityDays: number;
  /** Limite LEGADO que bloqueia a emissão (não é o limite global). */
  readonly quantityLimit: number | null;
  /** Limite GLOBAL de passes, somando os lotes. */
  readonly globalLimit: number | null;
  /** Validade fixa dos vouchers ("YYYY-MM-DD"); as duas ou nenhuma. */
  readonly voucherValidFrom: string | null;
  readonly voucherValidUntil: string | null;
  /** Encerramento das vendas — informativo, sem encerramento automático. */
  readonly salesEndDate: string | null;
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
    const rows = await this.prisma.valePassCampaign.findMany({ orderBy: { createdAt: 'desc' } });
    const units = await this.prisma.$queryRaw<{ campaignId: string; n: number }[]>`
      SELECT v.campaign_id::text AS "campaignId", count(DISTINCT ${PASS_UNIT_KEY})::int AS n FROM vale_passes v GROUP BY v.campaign_id`;
    const byCampaign = new Map(units.map((row) => [row.campaignId, row.n]));
    // "Vendidos" = UNIDADES comerciais emitidas (um Valle Pass com dois vouchers conta 1), nunca linhas de voucher.
    return rows.map((row) => toItem(row, byCampaign.get(row.id) ?? 0));
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

    const soldCount = await this.soldUnits(id);
    return toItem(updated, soldCount);
  }

  /**
   * Edita a configuração de uma campanha (ADMIN). Tudo numa transação com a campanha TRAVADA (`FOR UPDATE`): duas edições
   * ou uma edição e a abertura de um lote nunca se misturam. `expectedUpdatedAt` recusa (409) a edição de quem viu uma
   * versão antiga. NÃO altera nenhum passe já emitido: cada passe guarda o valor e a validade do momento da emissão.
   */
  async update(id: string, input: CampaignUpdateInput & { expectedUpdatedAt: string }, actorId: string, actorName: string): Promise<ValePassCampaignItem> {
    const outcome = await this.prisma
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${id}::uuid FOR UPDATE`;
        const target = await tx.valePassCampaign.findUnique({ where: { id } });
        if (!target) throw new NotFoundException('Campanha não encontrada.');
        const expected = new Date(input.expectedUpdatedAt).getTime();
        if (Number.isNaN(expected) || target.updatedAt.getTime() !== expected) {
          throw new ConflictException('A campanha foi alterada por outra pessoa. Recarregue a tela e tente de novo.');
        }

        const { totals } = await loadCapacity(tx, id);
        const openLot = await tx.valePassLot.findFirst({ where: { campaignId: id, status: 'OPEN' } });
        const openLotSold = openLot ? ((await loadLotSold(tx, id)).get(openLot.id) ?? 0) : 0;
        const plan = planCampaignUpdate(target, input, {
          // Pagos aguardando emissão também vão virar passes: entram nos dois limites.
          issued: totals.issued + totals.pending,
          sold: totals.consumed,
          openLot: openLot ? { quantity: openLot.quantity, sold: openLotSold + totals.pending } : null,
        });
        if (!plan.ok) throw new UnprocessableEntityException(plan.errors.join(' '));
        if (plan.changed.length === 0) return { row: target, changed: false };

        const updated = await tx.valePassCampaign.update({ where: { id }, data: plan.data });
        await writeAdminAuditEvent(tx, {
          adminUserId: actorId,
          adminUserName: actorName,
          action: 'VALE_PASS_CAMPAIGN_UPDATED',
          entityType: 'ValePassCampaign',
          entityId: id,
          before: plan.before,
          after: plan.after,
          detail: { fields: plan.changed, note: 'Passes já emitidos não são alterados; vale só para emissões futuras.' },
        });
        return { row: updated, changed: true };
      })
      .catch((err: unknown) => {
        if (err instanceof NotFoundException || err instanceof ConflictException || err instanceof UnprocessableEntityException) throw err;
        this.logger.error(`Falha ao editar campanha Valle Pass ${id}: ${errorCode(err)}`);
        throw new ServiceUnavailableException('Não foi possível editar a campanha no momento.');
      });

    const soldCount = await this.soldUnits(id);
    return toItem(outcome.row, soldCount);
  }

  /** Unidades comerciais emitidas da campanha (um Valle Pass com dois vouchers conta 1). */
  private async soldUnits(campaignId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`SELECT count(DISTINCT ${PASS_UNIT_KEY})::int AS n FROM vale_passes v WHERE v.campaign_id = ${campaignId}::uuid`;
    return rows[0]?.n ?? 0;
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
    globalLimit: row.globalLimit,
    voucherValidFrom: formatIsoDate(row.voucherValidFrom),
    voucherValidUntil: formatIsoDate(row.voucherValidUntil),
    salesEndDate: formatIsoDate(row.salesEndDate),
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
