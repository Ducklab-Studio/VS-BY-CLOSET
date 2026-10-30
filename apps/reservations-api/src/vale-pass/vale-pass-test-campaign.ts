import { ConflictException } from '@nestjs/common';
import type { Prisma, ValePass } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { numericShopifyId } from './vale-pass-order-status';

/**
 * Campanha de TESTE do Valle Pass ("VALLE PASS TESTE"): serve só para provar checkout → webhook → emissão dos dois vouchers → e-mail → cancelamento
 * com centavos reais. Seus vouchers NUNCA podem funcionar como crédito comercial: o resgate é recusado no servidor para QUALQUER papel (ADMIN, SUPER_ADMIN
 * e STAFF), enquanto a emissão, o e-mail, a consulta e o CANCELAMENTO continuam normais.
 *
 * Identificação: pelo ID da campanha E/OU pelo Variant ID da Shopify do produto de teste — nunca por nome, prefixo de benefício, preço ou valor. A regra bloqueia
 * quando QUALQUER um dos dois bate (o objetivo é nunca deixar passar: se o ID da campanha bater mas alguém trocar a variante, ou o contrário, o voucher continua
 * sem valor comercial). A campanha oficial do Valle Pass 2027 tem outro ID e outra variante e não é afetada.
 *
 * Não existe exceção de resgate (nem chave de ambiente) para estes vouchers: liberá-los exigiria uma proposta separada e uma publicação própria.
 */
export const TEST_CAMPAIGN_ID = 'f6f16b3b-2ed0-4e8b-9420-e856adc1bf93';
export const TEST_CAMPAIGN_VARIANT_ID = '67916371165284';
export const TEST_CAMPAIGN_BLOCK_MESSAGE = 'Voucher da campanha de TESTE: sem valor comercial. O resgate está bloqueado (ele só serve para validar a emissão e o e-mail).';

type Reader = Pick<Prisma.TransactionClient, 'valePassCampaign'> | Pick<PrismaService, 'valePassCampaign'>;

/** É a campanha de teste? (ID da campanha ou variante da Shopify; GID e número são a mesma variante.) */
export function isTestCampaign(campaign: { readonly id: string; readonly shopifyVariantId?: string | null }): boolean {
  return campaign.id === TEST_CAMPAIGN_ID || numericShopifyId(campaign.shopifyVariantId ?? null) === TEST_CAMPAIGN_VARIANT_ID;
}

/** O voucher pertence à campanha de teste? (Uma consulta só quando o ID do voucher não bate de cara.) */
export async function isTestCampaignVoucher(db: Reader, voucher: Pick<ValePass, 'campaignId'>): Promise<boolean> {
  if (voucher.campaignId === TEST_CAMPAIGN_ID) return true;
  const campaign = await db.valePassCampaign.findUnique({ where: { id: voucher.campaignId }, select: { id: true, shopifyVariantId: true } });
  return campaign !== null && isTestCampaign(campaign);
}

/** Recusa o uso (legado "marcar como utilizado") de voucher da campanha de teste. */
export async function assertNotTestCampaignVoucher(db: Reader, voucher: Pick<ValePass, 'campaignId'>): Promise<void> {
  if (await isTestCampaignVoucher(db, voucher)) {
    throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'TEST_CAMPAIGN', message: TEST_CAMPAIGN_BLOCK_MESSAGE });
  }
}
