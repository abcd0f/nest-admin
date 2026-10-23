import type { AuthenticatedUser } from './auth.types.js';
import { Public } from '@app/auth';
import {
  Authenticated,
  PermissionGuard,
  PermissionService,
  RequirePermissions,
} from '@app/permission';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from './auth.guard.js';

@RequirePermissions('class:resource:read')
class ProbeController {
  @Public()
  open() {}

  @Authenticated()
  profile() {}

  @RequirePermissions('system:user:list')
  list() {}
}

@Public()
class OpenController {
  @Public(false)
  @Authenticated()
  protected() {}
}

function setup(method: keyof ProbeController, header?: string, user?: AuthenticatedUser) {
  // 认证阶段从会话快照带出的用户；权限判定只读这份数据。
  const verifiedUser: AuthenticatedUser = {
    userId: '1',
    userName: 'alice',
    nickName: 'Alice',
    deptId: null,
    sessionId: 'sid',
    roles: [],
    permissions: ['system:user:list', 'class:resource:read'],
    dataScopes: [],
  };
  const request = { headers: { authorization: header }, user };
  const context = new ExecutionContextHost(
    [request],
    ProbeController,
    ProbeController.prototype[method],
  );
  const authenticate = vi.fn().mockResolvedValue(verifiedUser);
  // PermissionSource 只在登录时使用，鉴权阶段不应被调用。
  const source = vi.fn();
  const authentication = new AuthGuard(new Reflector(), { authenticate } as never);
  const authorization = new PermissionGuard(
    new Reflector(),
    new PermissionService({ getAuthorization: source } as never),
  );
  return {
    request,
    context,
    authenticate,
    source,
    verifiedUser,
    // 单元测试串行调用两个守卫；实际 AppModule 注册顺序由 HTTP e2e 验证。
    guard: {
      async canActivate(context: ExecutionContextHost) {
        return (await authentication.canActivate(context)) && authorization.canActivate(context);
      },
    },
  };
}

describe('认证与权限守卫', () => {
  it('公开方法覆盖类权限，并丢弃未经认证的 request.user', async () => {
    const value = setup('open', undefined, { userId: 'attacker' } as never);
    expect(await value.guard.canActivate(value.context)).toBe(true);
    expect(value.request.user).toBeUndefined();
    expect(value.authenticate).not.toHaveBeenCalled();
    expect(value.source).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer a b'])(
    '拒绝无效认证头：%s',
    async (header) => {
      const value = setup('list', header);
      await expect(value.guard.canActivate(value.context)).rejects.toThrow(UnauthorizedException);
      expect(value.source).not.toHaveBeenCalled();
    },
  );

  it('先认证后授权，权限来自会话快照且不查库；方法与类权限同时生效', async () => {
    const value = setup('list', 'Bearer token');
    expect(await value.guard.canActivate(value.context)).toBe(true);
    expect(value.authenticate).toHaveBeenCalledExactlyOnceWith('token');
    expect(value.source).not.toHaveBeenCalled();
  });

  it('认证失败时不执行授权，快照缺少权限时返回 403', async () => {
    const value = setup('list', 'Bearer token');
    value.authenticate.mockRejectedValueOnce(new UnauthorizedException());
    await expect(value.guard.canActivate(value.context)).rejects.toThrow(UnauthorizedException);
    expect(value.source).not.toHaveBeenCalled();
    value.authenticate.mockResolvedValueOnce({ ...value.verifiedUser, permissions: [], roles: [] });
    await expect(value.guard.canActivate(value.context)).rejects.toThrow(ForbiddenException);
  });

  it('仅登录策略不能清除类权限；无策略的路由拒绝访问', async () => {
    const value = setup('profile', 'Bearer token');
    expect(await value.guard.canActivate(value.context)).toBe(true);
    expect(value.source).not.toHaveBeenCalled();
    value.authenticate.mockResolvedValueOnce({ ...value.verifiedUser, permissions: [], roles: [] });
    await expect(value.guard.canActivate(value.context)).rejects.toThrow(ForbiddenException);
    class UnmarkedController {
      update() {}
    }
    const context = new ExecutionContextHost(
      [value.request],
      UnmarkedController,
      UnmarkedController.prototype.update,
    );
    await expect(value.guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('快照里的通配权限可满足任意要求', async () => {
    const value = setup('list', 'Bearer token');
    value.authenticate.mockResolvedValueOnce({
      ...value.verifiedUser,
      permissions: ['*:*:*'],
      roles: ['superadmin'],
    });
    expect(await value.guard.canActivate(value.context)).toBe(true);
    expect(value.source).not.toHaveBeenCalled();
  });

  it('方法 Public(false) 恢复类级公开路由的认证要求', async () => {
    const value = setup('open');
    const context = new ExecutionContextHost(
      [value.request],
      OpenController,
      OpenController.prototype.protected,
    );
    await expect(value.guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('不能用空权限或通配符声明获得授权', () => {
    expect(() => RequirePermissions()).toThrow();
    expect(() => RequirePermissions('*:*:*')).toThrow();
  });
});
