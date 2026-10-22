import type { AuthSnapshot } from '@app/auth';
import { DatabaseModule, PrismaService } from '@app/database';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { Mode } from './permission.decorator.js';
import { PermissionModule } from './permission.module.js';
import { PermissionService } from './permission.service.js';

function snapshot(permissions: string[], roles: string[] = []): AuthSnapshot {
  return { permissions, roles };
}

/** 鉴权阶段不查库，source 只用于登录快照；这里注入空实现并断言它不被调用。 */
function service() {
  const source = vi.fn();
  return { source, value: new PermissionService({ getAuthorization: source } as never) };
}

describe('功能权限判定', () => {
  it('精确码命中；*:*:* 命中任意权限要求；角色标识不产生权限', () => {
    const { value } = service();
    const user = snapshot(['system:user:list', 'system:user:query', '*:*:*'], ['admin']);
    expect(value.hasAll(user, ['system:user:list', 'system:user:query'])).toBe(true);
    expect(value.hasAll(user, ['system:user:list', 'system:user:delete'])).toBe(true);
    expect(value.hasAll(user, ['system:role:delete', 'system:menu:add'])).toBe(true);
    expect(value.isAllowed(user, [{ kind: 'role', value: ['admin'], mode: Mode.AND }])).toBe(true);
    expect(value.isAllowed(user, [{ kind: 'role', value: ['ops'], mode: Mode.AND }])).toBe(false);
  });

  it('段级通配只覆盖对应位置，不跨段放大', () => {
    const { value } = service();
    const user = snapshot(['system:user:*']);
    expect(value.hasAll(user, ['system:user:list'])).toBe(true);
    expect(value.hasAll(user, ['system:user:list', 'system:user:delete'])).toBe(true);
    expect(value.hasAll(user, ['system:role:list'])).toBe(false);
    expect(value.hasAll(user, ['system:user'])).toBe(false);
  });

  it('不含通配的授权码保持精确语义，不做前缀匹配', () => {
    const { value } = service();
    const user = snapshot(['system:user:list'], ['admin']);
    expect(value.hasAll(user, ['system:user:list'])).toBe(true);
    expect(value.hasAll(user, ['system:user:list:export'])).toBe(false);
    expect(
      value.isAllowed(user, [{ kind: 'role', value: ['admin'], mode: Mode.AND }]),
    ).toBe(true);
    expect(
      value.isAllowed(user, [{ kind: 'role', value: ['administrator'], mode: Mode.AND }]),
    ).toBe(false);
  });

  it('通配角色兜底可满足权限注解，但不绕过其他注解', () => {
    const { value } = service();
    const user = snapshot([], ['ops:*']);
    expect(
      value.isAllowed(user, [
        { kind: 'permission', value: ['system:user:list'], mode: Mode.AND, role: ['ops:admin'] },
      ]),
    ).toBe(true);
    expect(
      value.isAllowed(user, [
        { kind: 'permission', value: ['system:user:list'], mode: Mode.AND, role: [] },
      ]),
    ).toBe(false);
  });

  it('读取快照不触发任何查询', () => {
    const { source, value } = service();
    expect(value.getAuthorization(snapshot(['a'], ['b']))).toEqual({
      permissions: ['a'],
      roles: ['b'],
    });
    expect(source).not.toHaveBeenCalled();
  });

  it('登录快照走真实 Prisma 源，空授权不放行，超管得到通配', async () => {
    const module = await Test.createTestingModule({ imports: [DatabaseModule, PermissionModule] })
      .overrideProvider(PrismaService)
      .useValue({
        user: { findUnique: vi.fn().mockResolvedValue({ status: '0', delFlag: '0', roles: [] }) },
      })
      .compile();
    try {
      const permission = module.get(PermissionService);
      const empty = await permission.snapshot('2');
      expect(empty).toEqual({ roles: [], permissions: [] });
      expect(permission.hasAll(empty, ['system:user:list'])).toBe(false);
      // 1 号用户走超管分支，无需任何角色菜单关联即可命中全部权限。
      const admin = await permission.snapshot('1');
      expect(admin).toEqual({ roles: ['superadmin'], permissions: ['*:*:*'] });
      expect(permission.hasAll(admin, ['system:user:list'])).toBe(true);
    } finally {
      await module.close();
    }
  });
});
