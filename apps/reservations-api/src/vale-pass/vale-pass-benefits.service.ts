import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma, ValePassCampaignBenefit } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { validateBenefits, type BenefitInput } from './vale-pass-benefits';

export interface BenefitItem {
  readonly id: string;
  readonly code: string;
  readonly kind: 'VOUCHER' | 'DISCOUNT';
  readonly company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' | null;
  readonly label: string;
  readonly amountCents: number | null;
  readonly discountPercent: number | null;
  readonly terms: string | null;
  readonly active: boolean;
  readonly sortOrder: number;
  /** Quantos vouchers já nasceram deste benefício: com algum, empresa e valor não mudam mais. */
  readonly vouchersIssued: number;
  readonly updatedAt: string;
}

/**
 * Benefícios por campanha (Valle Pass 2027: voucher Valle Showroom + voucher VS BY CLOSET + 10% em passeios). A configuração só VALE para
 * emissões que usarem o modelo de vários vouchers (etapa de ligação, com autorização própria); cadastrá-la NÃO altera nada que já foi vendido
 * nem a emissão em produção. Benefícios nunca são apagados: o que sai da lista fica inativo. Empresa e valor de um benefício já usado por vouchers
 * são imutáveis (também por gatilho no banco).
 */
@Injectable()
export class ValePassBenefitsService {
  private readonly logger = new Logger(ValePassBenefitsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(campaignId: string): Promise<BenefitItem[]> {
    const campaign = await this.prisma.valePassCampaign.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!campaign) throw new NotFoundException('Campanha não encontrada.');
    return this.load(this.prisma, campaignId);
  }

  async replace(campaignId: string, items: readonly BenefitInput[], actorId: string, actorName: string): Promise<BenefitItem[]> {
    const errors = validateBenefits(items);
    if (errors.length > 0) throw new UnprocessableEntityException(errors.join(' '));

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`;
          const campaign = await tx.valePassCampaign.findUnique({ where: { id: campaignId }, select: { id: true } });
          if (!campaign) throw new NotFoundException('Campanha não encontrada.');

          const before = await this.load(tx, campaignId);
          const byCode = new Map(before.map((benefit) => [benefit.code, benefit]));
          const incoming = new Set(items.map((item) => item.code));

          for (const [index, item] of items.entries()) {
            const current = byCode.get(item.code);
            const data = {
              kind: item.kind,
              company: item.kind === 'VOUCHER' ? item.company ?? null : null,
              label: item.label.trim(),
              amountCents: item.kind === 'VOUCHER' ? item.amountCents ?? null : null,
              discountPercent: item.kind === 'DISCOUNT' ? item.discountPercent ?? null : null,
              terms: item.terms?.trim() ? item.terms.trim() : null,
              active: item.active ?? true,
              sortOrder: item.sortOrder ?? index,
            };
            if (!current) {
              await tx.valePassCampaignBenefit.create({ data: { campaignId, code: item.code, createdBy: actorId, ...data } });
              continue;
            }
            if (current.vouchersIssued > 0 && (current.company !== data.company || current.amountCents !== data.amountCents)) {
              throw new ConflictException(`O benefício "${item.code}" já gerou ${current.vouchersIssued} voucher(s): empresa e valor não podem mudar. Crie outro benefício para um novo valor.`);
            }
            if (current.kind !== data.kind) throw new ConflictException(`O tipo do benefício "${item.code}" não pode mudar.`);
            await tx.valePassCampaignBenefit.update({ where: { id: current.id }, data });
          }
          // O que saiu da lista NÃO é apagado: fica inativo (histórico e vouchers emitidos intactos).
          for (const current of before) {
            if (!incoming.has(current.code) && current.active) await tx.valePassCampaignBenefit.update({ where: { id: current.id }, data: { active: false } });
          }

          const after = await this.load(tx, campaignId);
          await writeAdminAuditEvent(tx, {
            adminUserId: actorId,
            adminUserName: actorName,
            action: 'VALE_PASS_BENEFITS_UPDATED',
            entityType: 'ValePassCampaign',
            entityId: campaignId,
            before: before.map(summary),
            after: after.map(summary),
            detail: { note: 'Vale só para emissões futuras no modelo de vários vouchers; vouchers já emitidos não mudam.' },
          });
          return after;
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof ConflictException || err instanceof UnprocessableEntityException) throw err;
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : err instanceof Error ? err.name : 'unknown';
      if (code === 'P2002') throw new ConflictException('Já existe um benefício com esse código ou um voucher dessa empresa nesta campanha.');
      this.logger.error(`Falha ao salvar benefícios da campanha ${campaignId}: ${code}`);
      throw new ServiceUnavailableException('Não foi possível salvar os benefícios no momento.');
    }
  }

  private async load(client: Pick<PrismaService | Prisma.TransactionClient, 'valePassCampaignBenefit' | '$queryRaw'>, campaignId: string): Promise<BenefitItem[]> {
    const rows = await client.valePassCampaignBenefit.findMany({ where: { campaignId }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    const counts = await client.$queryRaw<{ benefitId: string; n: number }[]>`
      SELECT benefit_id::text AS "benefitId", count(*)::int AS n FROM vale_passes WHERE campaign_id = ${campaignId}::uuid AND benefit_id IS NOT NULL GROUP BY benefit_id`;
    const issued = new Map(counts.map((row) => [row.benefitId, row.n]));
    return rows.map((row) => toItem(row, issued.get(row.id) ?? 0));
  }
}

const summary = (b: BenefitItem) => ({ code: b.code, kind: b.kind, company: b.company, amountCents: b.amountCents, discountPercent: b.discountPercent, active: b.active, label: b.label });

function toItem(row: ValePassCampaignBenefit, vouchersIssued: number): BenefitItem {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    company: row.company,
    label: row.label,
    amountCents: row.amountCents,
    discountPercent: row.discountPercent,
    terms: row.terms,
    active: row.active,
    sortOrder: row.sortOrder,
    vouchersIssued,
    updatedAt: row.updatedAt.toISOString(),
  };
}
