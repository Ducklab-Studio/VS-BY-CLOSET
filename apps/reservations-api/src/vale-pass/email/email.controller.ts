import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../../admin/admin-auth.guard';
import { AdminRoleGuard } from '../../admin/admin-role.guard';
import { RequireRole } from '../../admin/require-role.decorator';
import { RequireModule } from '../../admin/require-module.decorator';
import { ValePassEmailOutboxService, type EmailListItem, type EmailSummary } from './email-outbox.service';
import { ListEmailsQueryDto, ResendEmailDto } from './email.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

/**
 * Acompanhamento dos e-mails com os vouchers do Valle Pass. Ver (lista, linha do tempo, resumo/alertas): qualquer perfil com o módulo
 * VALLE_PASS — tudo mascarado (e-mail e códigos nunca saem completos daqui). Reenviar: só ADMIN, com justificativa, auditado.
 */
@Controller('admin/vale-pass/emails')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassEmailController {
  constructor(private readonly outbox: ValePassEmailOutboxService) {}

  @Get('summary')
  summary(): Promise<EmailSummary> {
    return this.outbox.summary();
  }

  @Get()
  list(@Query() query: ListEmailsQueryDto): Promise<EmailListItem[]> {
    return this.outbox.list({ status: query.status });
  }

  @Get(':id/events')
  events(@Param('id', ParseUUIDPipe) id: string): Promise<{ type: string; detail: unknown; createdAt: string }[]> {
    return this.outbox.events(id);
  }

  @Post(':id/resend')
  @RequireRole('ADMIN')
  resend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResendEmailDto, @Req() req: RequestWithAdminUser) {
    return this.outbox.requestResend(id, { note: dto.note, toEmail: dto.toEmail }, { id: req.adminUser!.id, name: req.adminUser!.name });
  }
}
