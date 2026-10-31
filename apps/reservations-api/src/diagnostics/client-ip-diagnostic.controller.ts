import { Controller, Get, Header, NotFoundException, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { describeClientIp, type ClientIpRequest } from '../client-ip';

/**
 * Diagnóstico do IP que a API enxerga (somente leitura, DESLIGADO por padrão: 404 sem `CLIENT_IP_DIAGNOSTIC=on`). Devolve apenas informações sobre a PRÓPRIA requisição
 * de quem chama (o IP que ele mesmo mandou e quais cabeçalhos chegaram) — nenhum dado de outro usuário, nenhum segredo, nenhum cabeçalho de autenticação.
 *
 * Como usar (com autorização, durante uma janela curta): ligar a chave, abrir a rota no navegador e comparar `derivedIp` com o IP público de quem abriu; repetir com
 * `curl -H "X-Real-IP: 1.2.3.4" -H "X-Forwarded-For: 5.6.7.8"`: se `derivedIp` continuar sendo o IP real, a borda sobrescreve/ignora os cabeçalhos forjados; se virar 1.2.3.4,
 * o cabeçalho NÃO é confiável e o limite por IP deve ser tratado como contornável. Depois, desligar a chave.
 */
@Controller('diagnostics')
export class ClientIpDiagnosticController {
  @Get('client-ip')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  clientIp(@Req() req: ClientIpRequest) {
    if (process.env.CLIENT_IP_DIAGNOSTIC?.trim().toLowerCase() !== 'on') throw new NotFoundException();
    return describeClientIp(req);
  }
}
