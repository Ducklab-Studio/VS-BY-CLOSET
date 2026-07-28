import { Body, Controller, Post, Req, Res, HttpCode, UnauthorizedException } from '@nestjs/common';
import { Request, Response, CookieOptions } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { env } from '../config/configuration';

const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/api/v1/auth';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private meta(req: Request) {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  /**
   * Atributos do cookie de refresh.
   *
   * sameSite vem do ambiente porque a resposta certa depende da topologia:
   * com proxy de mesmo domínio, `lax` basta e é imune ao bloqueio de cookie
   * de terceiros do Safari/Brave; em domínios separados só `none` funciona,
   * e aí `secure` é obrigatório pelo navegador.
   */
  private cookieOptions(): CookieOptions {
    const cfg = env();
    return {
      httpOnly: true,
      secure: cfg.cookieSecure,
      sameSite: cfg.cookieSameSite,
      domain: cfg.cookieDomain,
      path: REFRESH_PATH,
    };
  }

  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: env().jwt.refreshTtl * 1000,
    });
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // anti brute-force
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.register(dto, this.meta(req));
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, this.meta(req));
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException('Refresh token ausente.');
    const result = await this.auth.refresh(token, this.meta(req));
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @HttpCode(200)
  @Post('logout')
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(user.sub, req.cookies?.[REFRESH_COOKIE], this.meta(req));
    // O navegador só remove o cookie se os atributos baterem com os do set.
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    return { success: true };
  }
}
