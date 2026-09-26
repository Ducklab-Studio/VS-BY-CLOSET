import { IsUUID } from 'class-validator';

/**
 * Só o id aleatório da aba/página (gerado no navegador a cada carregamento).
 * Nunca um adminUserId: quem é o funcionário vem exclusivamente da sessão
 * (`X-Admin-Session`) — com o ValidationPipe global (forbidNonWhitelisted),
 * mandar qualquer outro campo é recusado com 400.
 */
export class PresenceClientDto {
  @IsUUID('4')
  clientId!: string;
}
