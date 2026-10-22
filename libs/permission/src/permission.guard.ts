import type { AuthenticatedRequest } from '@app/auth';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { PUBLIC_ROUTE } from '@app/auth';
import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCESS_REQUIREMENTS,
  AccessRequirement,
  AUTHENTICATED_ROUTE,
} from './permission.decorator.js';
import { PermissionService } from './permission.service.js';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PermissionService) private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new UnauthorizedException('未认证');
    const required = targets.flatMap(
      (target) =>
        this.reflector.get<readonly AccessRequirement[]>(ACCESS_REQUIREMENTS, target) ?? [],
    );
    const authenticated = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ROUTE, targets);
    // 类和方法上的每条要求均须通过；仅登录标记不能覆盖已有要求。
    // 授权判定读取会话快照，不再查库；权限变更由写操作撤销相关会话。
    if (
      (!required.length && !authenticated) ||
      (required.length && !this.permissions.isAllowed(user, required))
    ) {
      throw new ForbiddenException('无访问权限');
    }
    return true;
  }
}
