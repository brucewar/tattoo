import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { loginInput } from '@tattoo/contracts';
import type { Config } from '../config';
import { IdentityService, sessionCookieName, sessionDurationMilliseconds } from './service';
import { SessionGuard, type AuthenticatedRequest } from './session.guard';

@Controller('auth')
class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    @Inject('APP_CONFIG') private readonly config: Config,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const parsed = loginInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请填写有效的邮箱和密码');
    const result = await this.identity.login(
      parsed.data.email,
      parsed.data.password,
      request.ip ?? 'unknown',
    );
    response.cookie(sessionCookieName, result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.COOKIE_SECURE,
      path: '/api/v1',
      expires: result.expiresAt,
      maxAge: sessionDurationMilliseconds,
    });
    response.setHeader('Cache-Control', 'no-store');
    return { data: { ...result.user, remoteWritesEnabled: this.config.REMOTE_WRITES_ENABLED } };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return { data: { ...request.user, remoteWritesEnabled: this.config.REMOTE_WRITES_ENABLED } };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.identity.logout(request.headers.cookie);
    response.clearCookie(sessionCookieName, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.COOKIE_SECURE,
      path: '/api/v1',
    });
    response.setHeader('Cache-Control', 'no-store');
    return { data: { loggedOut: true } };
  }
}

@Module({
  providers: [IdentityService, SessionGuard],
  controllers: [IdentityController],
  exports: [IdentityService, SessionGuard],
})
export class IdentityModule {}

export { IdentityService } from './service';
export { SessionGuard } from './session.guard';
export type { AuthenticatedRequest } from './session.guard';
