import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.types.js';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE } from './auth.decorator.js';
import { AuthService } from './auth.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // 防止其他中间件遗留的未经认证上下文被复用。
    delete request.user;
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/i.exec(header) : null;
    if (!match) throw new UnauthorizedException('未认证');
    request.user = await this.auth.authenticate(match[1]);
    return true;
  }
}
