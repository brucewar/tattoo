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
import {
  loginInput,
  loginFactorInput,
  passwordChangeInput,
  securityProofInput,
  totpSetupInput,
  totpEnableInput,
  totpCancelInput,
} from '@tattoo/contracts';
import type { Config } from '../config';
import {
  IdentityService,
  sessionCookieName,
  sessionDurationMilliseconds,
  challengeCookieName,
  challengeDurationMilliseconds,
} from './service';
import { SessionGuard, type AuthenticatedRequest } from './session.guard';

@Controller('auth')
class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    @Inject('APP_CONFIG') private readonly config: Config,
  ) {}

  private clearChallenge(response: Response) {
    response.clearCookie(challengeCookieName, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.COOKIE_SECURE,
      path: '/api/v1/auth',
    });
  }

  private setSession(response: Response, session: { token: string; expiresAt: Date }) {
    response.cookie(sessionCookieName, session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.COOKIE_SECURE,
      path: '/api/v1',
      expires: session.expiresAt,
      maxAge: sessionDurationMilliseconds,
    });
    this.clearChallenge(response);
    response.setHeader('Cache-Control', 'no-store');
  }

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
    response.setHeader('Cache-Control', 'no-store');
    if ('mfaRequired' in result && result.mfaRequired) {
      response.cookie(challengeCookieName, result.challengeToken, {
        httpOnly: true,
        sameSite: 'strict',
        secure: this.config.COOKIE_SECURE,
        path: '/api/v1/auth',
        expires: result.expiresAt,
        maxAge: challengeDurationMilliseconds,
      });
      return { data: { mfaRequired: true, challengeExpiresAt: result.expiresAt.toISOString() } };
    }
    if (!('token' in result)) throw new Error('登录结果无效');
    this.setSession(response, result);
    return { data: { ...result.user, remoteWritesEnabled: this.config.REMOTE_WRITES_ENABLED } };
  }

  @Post('login/verify')
  @HttpCode(200)
  async verify(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const parsed = loginFactorInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请输入有效的验证码或恢复码');
    const result = await this.identity.verifyLoginChallenge(
      request.headers.cookie,
      parsed.data.code,
      request.ip ?? 'unknown',
    );
    this.setSession(response, result);
    return { data: { ...result.user, remoteWritesEnabled: this.config.REMOTE_WRITES_ENABLED } };
  }

  @Post('login/cancel')
  @HttpCode(200)
  async cancelLogin(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    await this.identity.cancelLoginChallenge(request.headers.cookie);
    this.clearChallenge(response);
    return { data: { cancelled: true } };
  }

  @Get('security')
  @UseGuards(SessionGuard)
  async security(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return { data: await this.identity.getSecurity(request.headers.cookie) };
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async password(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const parsed = passwordChangeInput.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('请检查原密码，新密码应为 12 至 256 个字符且与原密码不同');
    const result = await this.identity.changePassword(
      request.headers.cookie,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      parsed.data.code,
    );
    this.setSession(response, result.session);
    return { data: result.status };
  }

  @Post('totp/setup')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async setup(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const parsed = totpSetupInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请填写当前密码');
    return {
      data: await this.identity.startTotpSetup(request.headers.cookie, parsed.data.currentPassword),
    };
  }

  @Post('totp/enable')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async enable(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const parsed = totpEnableInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请重新开始绑定并输入验证器中的 6 位验证码');
    const result = await this.identity.confirmTotpSetup(
      request.headers.cookie,
      parsed.data.setupId,
      parsed.data.code,
    );
    this.setSession(response, result.session);
    return { data: { ...result.status, recoveryCodes: result.recoveryCodes } };
  }

  @Post('totp/cancel')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async cancelSetup(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const parsed = totpCancelInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('绑定请求无效');
    return {
      data: await this.identity.cancelTotpSetup(request.headers.cookie, parsed.data.setupId),
    };
  }

  @Post('totp/disable')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async disable(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const parsed = securityProofInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请填写当前密码和验证码或恢复码');
    const result = await this.identity.disableTotp(
      request.headers.cookie,
      parsed.data.currentPassword,
      parsed.data.code ?? '',
    );
    this.setSession(response, result.session);
    return { data: result.status };
  }

  @Post('recovery-codes/regenerate')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async recoveryCodes(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const parsed = securityProofInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请填写当前密码和验证码或恢复码');
    const result = await this.identity.regenerateRecoveryCodes(
      request.headers.cookie,
      parsed.data.currentPassword,
      parsed.data.code ?? '',
    );
    this.setSession(response, result.session);
    return { data: { ...result.status, recoveryCodes: result.recoveryCodes } };
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async revokeOthers(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const parsed = securityProofInput.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('请填写当前密码；已启用双重验证时还需验证码或恢复码');
    return {
      data: await this.identity.revokeOtherSessions(
        request.headers.cookie,
        parsed.data.currentPassword,
        parsed.data.code,
      ),
    };
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
    response.setHeader('Cache-Control', 'no-store');
    await this.identity.logout(request.headers.cookie);
    await this.identity.cancelLoginChallenge(request.headers.cookie);
    this.clearChallenge(response);
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
