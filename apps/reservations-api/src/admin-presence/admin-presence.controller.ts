import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { AdminPresenceService, type EmployeePresence } from './admin-presence.service';
import { PresenceClientDto } from './dto/presence-client.dto';

/**
 * Chamado só pelo servidor do apps/marketing (bearer ADMIN_API_TOKEN) com o
 * token de sessão do cookie em `X-Admin-Session`. Heartbeat e saída
 * identificam o funcionário SÓ pela sessão — nenhum id vem do corpo.
 * A lista é exclusiva de SUPER_ADMIN, como a tela de Funcionários.
 */
@Controller('admin/presence')
@UseGuards(AdminAuthGuard)
export class AdminPresenceController {
  constructor(private readonly presence: AdminPresenceService) {}

  @Post('heartbeat')
  @HttpCode(HttpStatus.NO_CONTENT)
  heartbeat(@Headers('x-admin-session') token: string | undefined, @Body() dto: PresenceClientDto): Promise<void> {
    return this.presence.heartbeat(requireSessionToken(token), dto.clientId);
  }

  @Post('leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  leave(@Headers('x-admin-session') token: string | undefined, @Body() dto: PresenceClientDto): Promise<void> {
    return this.presence.leave(requireSessionToken(token), dto.clientId);
  }

  @Get()
  @UseGuards(AdminRoleGuard)
  @RequireRole('SUPER_ADMIN')
  list(): Promise<EmployeePresence[]> {
    return this.presence.list();
  }
}

function requireSessionToken(token: string | undefined): string {
  if (typeof token !== 'string' || !token || token.length > 256) throw new UnauthorizedException('Sessão administrativa inválida.');
  return token;
}
