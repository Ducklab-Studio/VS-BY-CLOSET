import { BadRequestException, Body, Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsString, Matches } from 'class-validator';
import { AdminAuthGuard } from '../../admin/admin-auth.guard';
import { AdminRoleGuard } from '../../admin/admin-role.guard';
import { RequireModule } from '../../admin/require-module.decorator';
import { RequireRole } from '../../admin/require-role.decorator';
import { PUBLIC_WRITE_THROTTLE } from '../../public-write-throttle';
import { TERMS_SHA256_PATTERN, TERMS_VERSION_PATTERN } from './terms-acceptance-config';
import { ValePassTermsAcceptanceService, type PublicTerms, type TermsAcceptanceGrant, type TermsEvidenceView } from './terms-acceptance.service';

/** POST /public/vale-pass/terms-acceptances. `accepted` precisa ser exatamente `true` (a regra e o código de erro ficam no serviço). */
export class CreateTermsAcceptanceDto {
  @IsString()
  @Matches(TERMS_VERSION_PATTERN)
  termsVersion!: string;

  @IsString()
  @Matches(TERMS_SHA256_PATTERN)
  termsSha256!: string;

  @IsBoolean()
  accepted!: boolean;

  /** Id numérico da variante do Valle Pass que será comprada. */
  @IsString()
  @Matches(/^\d{1,20}$/)
  variantId!: string;
}

/**
 * Rotas PÚBLICAS do aceite eletrônico. Sem autenticação (a vitrine é anônima), com limite por IP. Sem termos aprovados e ligados respondem 404.
 * O token NÃO identifica quem clicou; ver terms-token.ts.
 */
@Controller('public/vale-pass')
export class ValePassTermsAcceptancePublicController {
  constructor(private readonly terms: ValePassTermsAcceptanceService) {}

  @Get('terms')
  @Header('Cache-Control', 'no-store')
  current(): PublicTerms {
    return this.terms.publicTerms();
  }

  @Post('terms-acceptances')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  @Header('Cache-Control', 'no-store')
  accept(@Body() dto: CreateTermsAcceptanceDto): Promise<TermsAcceptanceGrant> {
    return this.terms.issue(dto);
  }
}

/** Evidência do aceite por pedido: somente leitura e somente ADMIN/SUPER_ADMIN. */
@Controller('admin/vale-pass/orders')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassTermsEvidenceAdminController {
  constructor(private readonly terms: ValePassTermsAcceptanceService) {}

  @Get(':shopifyOrderId/terms-evidence')
  @RequireRole('ADMIN')
  @Header('Cache-Control', 'no-store')
  evidence(@Param('shopifyOrderId') shopifyOrderId: string): Promise<TermsEvidenceView> {
    if (!/^\d{1,20}$/.test(shopifyOrderId)) throw new BadRequestException({ code: 'INVALID_ORDER_ID', message: 'Identificador de pedido inválido.' });
    return this.terms.evidenceFor(shopifyOrderId);
  }
}
