import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.types.js';
import { createParamDecorator, SetMetadata, UnauthorizedException } from '@nestjs/common';

export const PUBLIC_ROUTE = Symbol('auth:public');

/** 方法优先于控制器；@Public(false) 恢复类级公开路由的认证要求。 */
export const Public = (enabled = true) => SetMetadata(PUBLIC_ROUTE, enabled);

/** 仅返回守卫验证过的上下文，不读取 body/query 中的用户信息。 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
  if (!user) throw new UnauthorizedException('未认证');
  return user;
});
