import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { IdentityService, type Principal } from './service';

export type AuthenticatedRequest = Request & { user: Principal };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = await this.identity.authenticate(request.headers.cookie);
    if (!user) throw new UnauthorizedException('请先登录');
    request.user = user;
    return true;
  }
}
