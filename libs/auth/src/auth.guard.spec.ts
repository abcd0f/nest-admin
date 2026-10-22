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
  const verifiedUser = {
    userId: '1',
    userName: 'alice',
    nickName: 'Alice',
    deptId: null,
    sessionId: 'sid',
  };
  const request = { headers: { authorization: header }, user };
  const context = new ExecutionContextHost(
    [request],
    ProbeController,
    ProbeController.prototype[method],
  );
  const authenticate = vi.fn().mockResolvedValue(verifiedUser);
  const getAuthorization = vi.fn().mockResolvedValue({
    permissions: ['system:user:list', 'class:resource:read'],
    roles: [],
  });
  const authentication = new AuthGuard(new Reflector(), { authenticate } as never);
  const authorization = new PermissionGuard(
    new Reflector(),
    new PermissionService({ getAuthorization }),
  );
  return {
    request,
    context,
    authenticate,
    getAuthorization,
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
    expect(value.getAuthorization).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer a b'])(
    '拒绝无效认证头：%s',
    async (header) => {
      const value = setup('list', header);
      await expect(value.guard.canActivate(value.context)).rejects.toThrow(UnauthorizedException);
      expect(value.getAuthorization).not.toHaveBeenCalled();
    },
  );

  it('先认证后授权，使用可信用户 ID；方法与类权限同时生效', async () => {
    const value = setup('list', 'Bearer token');
    expect(await value.guard.canActivate(value.context)).toBe(true);
    expect(value.authenticate).toHaveBeenCalledExactlyOnceWith('token');
    expect(value.getAuthorization).toHaveBeenCalledExactlyOnceWith('1');
    expect(value.authenticate.mock.invocationCallOrder[0]).toBeLessThan(
      value.getAuthorization.mock.invocationCallOrder[0],
    );
  });

  it('认证失败时不执行权限查询，缺少权限时返回 403', async () => {
    const value = setup('list', 'Bearer token');
    value.authenticate.mockRejectedValueOnce(new UnauthorizedException());
    await expect(value.guard.canActivate(value.context)).rejects.toThrow(UnauthorizedException);
    expect(value.getAuthorization).not.toHaveBeenCalled();
    value.getAuthorization.mockResolvedValueOnce({ permissions: [], roles: [] });
    await expect(value.guard.canActivate(value.context)).rejects.toThrow(ForbiddenException);
  });

  it('仅登录策略不能清除类权限；无策略的路由拒绝访问', async () => {
    const value = setup('profile', 'Bearer token');
    expect(await value.guard.canActivate(value.context)).toBe(true);
    expect(value.getAuthorization).toHaveBeenCalledExactlyOnceWith('1');
    value.getAuthorization.mockResolvedValueOnce({ permissions: [], roles: [] });
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
