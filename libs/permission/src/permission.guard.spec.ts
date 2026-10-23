import type { AuthenticatedUser } from '@app/auth';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { describe, expect, it, vi } from 'vitest';
import { Authenticated, Mode, Permission, Role } from './permission.decorator.js';
import { PermissionGuard } from './permission.guard.js';
import { PermissionService } from './permission.service.js';

class ProbeController {
  @Permission({ value: ['a', 'b'] })
  defaultAnd() {}

  @Permission({ value: ['a', 'b'], mode: Mode.AND })
  explicitAnd() {}

  @Permission({ value: ['a', 'b'], mode: Mode.OR })
  either() {}

  @Permission({ value: ['a', 'b'], role: ['admin', 'operator'] })
  fallback() {}

  @Role('admin')
  @Permission('a')
  combined() {}

  @Permission({ value: ['a', 'b'], mode: Mode.OR })
  @Permission('c')
  stacked() {}

  @Role({ value: ['admin', 'operator'], mode: Mode.OR })
  @Role('auditor')
  stackedRoles() {}

  @Role({ value: ['admin', 'operator'] })
  allRoles() {}

  @Permission('c')
  @Permission({ value: 'a', role: ['admin'] })
  stackedFallback() {}

  @Authenticated()
  @Permission('a')
  authenticatedAbove() {}

  @Permission('a')
  @Authenticated()
  authenticatedBelow() {}

  @Authenticated()
  profile() {}

  unmarked() {}
}

function setup(
  controller: typeof ProbeController,
  method: keyof ProbeController,
  permissions: string[],
  roles: string[],
) {
  // 权限来自认证阶段带出的会话快照，守卫本身不查库。
  const source = vi.fn();
  const guard = new PermissionGuard(
    new Reflector(),
    new PermissionService({ getAuthorization: source } as never),
  );
  const request: { user?: AuthenticatedUser } = {
    user: {
      userId: '1',
      userName: 'alice',
      nickName: 'Alice',
      deptId: null,
      sessionId: 'sid',
      roles,
      permissions,
      dataScopes: [],
    },
  };
  const context = new ExecutionContextHost([request], controller, controller.prototype[method]);
  return { guard, context, request, source };
}

describe('权限与角色注解组合', () => {
  it.each<[keyof ProbeController, string[], string[], boolean]>([
    ['defaultAnd', ['a', 'b'], [], true],
    ['defaultAnd', ['a'], [], false],
    ['explicitAnd', ['a'], [], false],
    ['explicitAnd', ['a', 'b'], [], true],
    ['either', ['b'], [], true],
    ['either', [], [], false],
    ['fallback', ['a', 'b'], [], true],
    ['fallback', ['a'], [], false],
    ['fallback', [], ['operator'], true],
    ['fallback', [], ['guest'], false],
    ['combined', ['a'], ['admin'], true],
    ['combined', [], ['admin'], false],
    ['combined', ['a'], [], false],
    ['stacked', ['b', 'c'], [], true],
    ['stacked', ['a'], [], false],
    ['stacked', ['c'], [], false],
    ['stackedRoles', [], ['operator', 'auditor'], true],
    ['stackedRoles', [], ['admin'], false],
    ['allRoles', [], ['admin', 'operator'], true],
    ['allRoles', [], ['admin'], false],
    ['allRoles', ['admin', 'operator'], [], false],
    ['stackedFallback', ['c'], ['admin'], true],
    ['stackedFallback', [], ['admin'], false],
    ['authenticatedAbove', [], [], false],
    ['authenticatedBelow', [], [], false],
    ['profile', [], [], true],
    ['unmarked', [], [], false],
  ])('%s / permissions=%j / roles=%j => %s', async (method, permissions, roles, allowed) => {
    const { guard, context } = setup(ProbeController, method, permissions, roles);
    if (allowed) expect(await guard.canActivate(context)).toBe(true);
    else await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('类与方法要求固定 AND，Authenticated 不清除类要求', async () => {
    @Role('admin')
    class RestrictedController extends ProbeController {}
    for (const method of ['either', 'profile'] as const) {
      const value = setup(RestrictedController, method, ['a'], []);
      await expect(value.guard.canActivate(value.context)).rejects.toThrow(ForbiddenException);
      // 换成带 admin 角色的快照即可通过，守卫只读这份快照。
      value.request.user = { ...value.request.user!, roles: ['admin'] };
      expect(await value.guard.canActivate(value.context)).toBe(true);
    }
    // 派生类的声明不能污染基类。
    const base = setup(ProbeController, 'profile', [], []);
    expect(await base.guard.canActivate(base.context)).toBe(true);
  });

  it('授权判定不查库，只读会话快照', async () => {
    const value = setup(ProbeController, 'stackedFallback', ['c'], ['admin']);
    expect(await value.guard.canActivate(value.context)).toBe(true);
    expect(value.source).not.toHaveBeenCalled();
  });

  it('快照缺少所需角色时拒绝，不会退化为空角色放行', async () => {
    const value = setup(ProbeController, 'combined', ['a'], ['auditor']);
    await expect(value.guard.canActivate(value.context)).rejects.toThrow(ForbiddenException);
    expect(value.source).not.toHaveBeenCalled();
  });

  it('缺少认证用户时不进入授权判定', async () => {
    const value = setup(ProbeController, 'either', [], []);
    Reflect.deleteProperty(value.request, 'user');
    await expect(value.guard.canActivate(value.context)).rejects.toThrow(UnauthorizedException);
    expect(value.source).not.toHaveBeenCalled();
  });

  it('启动时拒绝空值、通配符和非法 mode，不静默降级', () => {
    for (const value of ['', ' a', 'a ', '*:*:*']) {
      expect(() => Permission(value)).toThrow();
      expect(() => Role(value)).toThrow();
    }
    expect(() => Permission({ value: [] })).toThrow();
    expect(() => Role({ value: [] })).toThrow();
    expect(() => Permission({ value: 'a', role: [] })).toThrow();
    expect(() => Permission({ value: 'a', role: [''] })).toThrow();
    expect(() => Permission({ value: 'a', mode: 'XOR' as Mode })).toThrow();
    expect(() => Role({ value: 'admin', mode: 'XOR' as Mode })).toThrow();
  });
});
