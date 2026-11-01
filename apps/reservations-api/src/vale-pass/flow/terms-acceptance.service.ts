import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { numericShopifyId } from '../vale-pass-order-status';
import { approvedTerms, loadTermsAcceptanceConfig, TERMS_ACCEPTANCE_CONFIG, type TermsAcceptanceConfig } from './terms-acceptance-config';
import { TERMS_EVIDENCE_EVENT } from './terms-evidence';
import { issueTermsToken } from './terms-token';

export interface PublicTerms {
  readonly version: string;
  readonly sha256: string;
  readonly acceptanceRequired: boolean;
  readonly tokenTtlMinutes: number;
}

export interface TermsAcceptanceGrant {
  readonly token: string;
  readonly termsVersion: string;
  readonly termsSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface TermsEvidenceView {
  readonly shopifyOrderId: string;
  /** Só `VERIFIED` conta como comprovado. */
  readonly proven: boolean;
  readonly status: string;
  readonly reason: string | null;
  readonly version: string | null;
  readonly sha256: string | null;
  readonly issuedAt: string | null;
  readonly verifiedAt: string | null;
  readonly recordedAt: string | null;
  readonly policy: { readonly acceptanceRequired: boolean };
  readonly history: readonly { readonly status: string; readonly reason: string | null; readonly recordedAt: string }[];
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Aceite eletrônico dos termos (backend). Tudo depende de configuração APROVADA (versão + hash + segredo + chave ligada): sem ela, as rotas respondem 404 e nada é
 * emitido. Este serviço NÃO guarda nada ao emitir o token (sem tabela, sem migration): o registro durável nasce no webhook, no histórico do pedido, e nunca
 * contém dado pessoal.
 */
@Injectable()
export class ValePassTermsAcceptanceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(TERMS_ACCEPTANCE_CONFIG) private readonly config: () => TermsAcceptanceConfig = () => loadTermsAcceptanceConfig(),
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  /** Versão e hash vigentes. 404 enquanto os termos não estiverem aprovados e ligados (nada vaza do estado interno). */
  publicTerms(): PublicTerms {
    const config = this.config();
    const approved = approvedTerms(config);
    if (approved === null) throw new NotFoundException({ code: 'TERMS_NOT_APPROVED', message: 'Os termos ainda não estão disponíveis para aceite.' });
    return { version: approved.version, sha256: approved.sha256, acceptanceRequired: config.required, tokenTtlMinutes: Math.round(approved.ttlMs / 60_000) };
  }

  /** Registra o pedido AFIRMATIVO de aceite e emite o token assinado. Não grava dado pessoal nem identifica quem clicou. */
  async issue(input: { termsVersion: string; termsSha256: string; accepted: boolean; variantId: string }): Promise<TermsAcceptanceGrant> {
    const approved = approvedTerms(this.config());
    if (approved === null) throw new NotFoundException({ code: 'TERMS_NOT_APPROVED', message: 'Os termos ainda não estão disponíveis para aceite.' });
    if (input.accepted !== true) throw new BadRequestException({ code: 'ACCEPTANCE_NOT_AFFIRMATIVE', message: 'O aceite precisa ser expresso (accepted = true).' });
    if (input.termsVersion !== approved.version || input.termsSha256 !== approved.sha256) {
      throw new ConflictException({ code: 'TERMS_VERSION_MISMATCH', message: 'A versão dos termos exibida não é a vigente. Recarregue a página e leia o texto atual.' });
    }
    const campaigns = await this.prisma.valePassCampaign.findMany({ select: { shopifyVariantId: true } });
    if (!campaigns.some((campaign) => numericShopifyId(campaign.shopifyVariantId) === input.variantId)) {
      throw new BadRequestException({ code: 'UNKNOWN_VARIANT', message: 'Produto não reconhecido.' });
    }
    const now = this.now();
    const { token, claims } = issueTermsToken({ secret: approved.secret, version: approved.version, sha256: approved.sha256, variant: input.variantId, now, ttlMs: approved.ttlMs });
    return { token, termsVersion: claims.ver, termsSha256: claims.sha, issuedAt: new Date(claims.iat).toISOString(), expiresAt: new Date(claims.exp).toISOString() };
  }

  /** Estado da evidência de um pedido, para ADMIN. Somente leitura; sem nome, e-mail, telefone, código de voucher nem o nonce. */
  async evidenceFor(shopifyOrderId: string): Promise<TermsEvidenceView> {
    const order = await this.prisma.valePassOrder.findUnique({ where: { shopifyOrderId }, select: { id: true } });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Pedido não encontrado.' });
    const events = await this.prisma.valePassOrderEvent.findMany({ where: { valePassOrderId: order.id, type: TERMS_EVIDENCE_EVENT }, orderBy: { createdAt: 'desc' }, take: 10 });
    const rows = events.map((event) => {
      const detail = (event.detail ?? {}) as Record<string, unknown>;
      return { status: str(detail.status) ?? 'UNKNOWN', reason: str(detail.reason), version: str(detail.version), sha256: str(detail.sha256), issuedAt: str(detail.issuedAt), verifiedAt: str(detail.verifiedAt), recordedAt: event.createdAt.toISOString() };
    });
    const latest = rows[0];
    return {
      shopifyOrderId,
      proven: latest?.status === 'VERIFIED',
      status: latest?.status ?? 'ABSENT',
      reason: latest?.reason ?? null,
      version: latest?.version ?? null,
      sha256: latest?.sha256 ?? null,
      issuedAt: latest?.issuedAt ?? null,
      verifiedAt: latest?.verifiedAt ?? null,
      recordedAt: latest?.recordedAt ?? null,
      policy: { acceptanceRequired: this.config().required },
      history: rows.map((row) => ({ status: row.status, reason: row.reason, recordedAt: row.recordedAt })),
    };
  }
}
