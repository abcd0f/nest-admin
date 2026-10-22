import { describe, expect, it, vi } from 'vitest';
import { ensureAdministratorRemains, hasActiveAdministrator } from './administrator.js';

const permissions = [
  'system:user:list',
  'system:user:query',
  'system:user:add',
  'system:user:edit',
  'system:user:delete',
  'system:user:assignRoles',
  'system:role:list',
  'system:role:query',
  'system:role:add',
  'system:role:edit',
  'system:role:delete',
  'system:role:assignMenus',
  'system:role:dataScope',
  'system:menu:list',
  'system:menu:query',
  'system:menu:add',
  'system:menu:edit',
  'system:menu:delete',
  'system:dept:list',
  'system:dept:query',
  'system:dept:add',
  'system:dept:edit',
  'system:dept:delete',
];

function assignment(values: string[]) {
  return { role: { menus: values.map((perms) => ({ menu: { perms } })) } };
}

describe('有效管理员保护', () => {
  it('同一用户的有效角色取并集，只查询启用、未删除用户/角色和有效 C/F 菜单', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        roles: [assignment(permissions.slice(0, 10)), assignment(permissions.slice(10))],
      },
    ]);
    expect(await hasActiveAdministrator({ user: { findMany } } as never)).toBe(true);
    expect(findMany.mock.lastCall?.[0]).toMatchObject({
      where: { status: '0', delFlag: '0' },
      select: {
        roles: {
          where: { role: { status: '0', delFlag: '0' } },
          select: {
            role: {
              select: {
                menus: {
                  where: { menu: { status: '0', menuType: { in: ['C', 'F'] } } },
                },
              },
            },
          },
        },
      },
    });
  });

  it('不能合并不同用户的权限，固定 admin 名称或通配符不能代替显式授权', async () => {
    const tx = {
      user: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { roles: [assignment(permissions.slice(0, 10))] },
            { roles: [assignment(permissions.slice(10))] },
            {
              userId: 1n,
              userName: 'admin',
              roles: [{ role: { roleKey: 'admin', menus: [{ menu: { perms: '*' } }] } }],
            },
          ]),
      },
    };
    expect(await hasActiveAdministrator(tx as never)).toBe(false);
  });

  it('已有管理员时拒绝清除最后一位，其他管理员仍有效时允许修改', async () => {
    const tx = { user: { findMany: vi.fn().mockResolvedValue([]) } };
    await expect(ensureAdministratorRemains(tx as never, true)).rejects.toMatchObject({
      status: 409,
    });
    tx.user.findMany.mockResolvedValue([{ roles: [assignment(permissions)] }]);
    await expect(ensureAdministratorRemains(tx as never, true)).resolves.toBeUndefined();
  });

  it('无管理员时允许初始化，数据库查询失败时不放行', async () => {
    const tx = { user: { findMany: vi.fn().mockRejectedValue(new Error('database unavailable')) } };
    await expect(ensureAdministratorRemains(tx as never, false)).resolves.toBeUndefined();
    expect(tx.user.findMany).not.toHaveBeenCalled();
    await expect(ensureAdministratorRemains(tx as never, true)).rejects.toThrow(
      'database unavailable',
    );
  });
});
