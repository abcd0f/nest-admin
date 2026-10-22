import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PrismaPermissionSource } from './prisma-permission.source.js';

function menu(perms: string | null, status = '0', menuType = 'F') {
  return { menu: { perms, status, menuType } };
}

function role(roleKey: string, menus: ReturnType<typeof menu>[] = [], status = '0', delFlag = '0') {
  return { role: { roleKey, status, delFlag, menus } };
}

/** 普通用户 ID。`1` 是超级管理员，普通授权用例统一用 `2`，避免走超管短路分支。 */
const USER = '2';

function setup(roles: ReturnType<typeof role>[] = []) {
  const user = { status: '0', delFlag: '0', roles };
  const findUnique = vi.fn().mockResolvedValue(user);
  const source = new PrismaPermissionSource({ user: { findUnique } } as never);
  return { source, user, findUnique };
}

describe('prisma 当前用户授权加载', () => {
  it('超级管理员直接持有 superadmin 角色与 *:*:*，不读取角色菜单关联', async () => {
    const { source } = setup();
    expect(await source.getAuthorization('1')).toEqual({
      roles: ['superadmin'],
      permissions: ['*:*:*'],
    });
  });

  it('超级管理员仍要求用户存在且启用，停用后不再拿到通配权限', async () => {
    const value = setup();
    value.findUnique.mockResolvedValue(null);
    await expect(value.source.getAuthorization('1')).rejects.toThrow(UnauthorizedException);
    value.findUnique.mockResolvedValue({ status: '1', delFlag: '0', roles: [] });
    await expect(value.source.getAuthorization('1')).rejects.toThrow(UnauthorizedException);
    value.findUnique.mockResolvedValue({ status: '0', delFlag: '2', roles: [] });
    await expect(value.source.getAuthorization('1')).rejects.toThrow(UnauthorizedException);
  });

  it('合并多个有效角色的菜单/按钮权限，去重并稳定排序', async () => {
    const { source, findUnique } = setup([
      role('operator', [menu('system:user:edit'), menu('system:user:list', '0', 'C')]),
      role('auditor', [menu('system:user:list'), menu('system:log:view')]),
      role('operator', [menu('system:user:edit')]),
    ]);
    expect(await source.getAuthorization(USER)).toEqual({
      roles: ['auditor', 'operator'],
      permissions: ['system:log:view', 'system:user:edit', 'system:user:list'],
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique.mock.calls[0][0].where).toEqual({ userId: 2n });
    expect(findUnique.mock.calls[0][0].select).not.toHaveProperty('password');
  });

  it('停用、删除或未知状态的角色不贡献角色标识和权限', async () => {
    const { source } = setup([
      role('enabled', [menu('allowed')]),
      role('disabled', [menu('denied:disabled')], '1'),
      role('deleted', [menu('denied:deleted')], '0', '2'),
      role('unknown', [menu('denied:unknown')], 'x'),
    ]);
    expect(await source.getAuthorization(USER)).toEqual({
      roles: ['enabled'],
      permissions: ['allowed'],
    });
  });

  it('保留通配权限码，排除失效菜单、目录、空值与首尾空白；不拆分、不 trim', async () => {
    const { source } = setup([
      role('operator', [
        menu('valid:menu', '0', 'C'),
        menu('valid:button'),
        menu('disabled', '1'),
        menu('unknown-status', 'x'),
        menu('directory', '0', 'M'),
        menu('unknown-type', '0', 'X'),
        menu(null),
        menu(''),
        menu('  '),
        menu(' leading'),
        menu('trailing '),
        menu('*:*:*'),
        menu('a,b'),
      ]),
    ]);
    expect((await source.getAuthorization(USER)).permissions).toEqual([
      '*:*:*',
      'a,b',
      'valid:button',
      'valid:menu',
    ]);
  });

  it('没有角色或没有菜单时返回空权限；admin 角色标识本身不产生超级权限', async () => {
    expect(await setup().source.getAuthorization(USER)).toEqual({ roles: [], permissions: [] });
    expect(await setup([role('admin')]).source.getAuthorization(USER)).toEqual({
      roles: ['admin'],
      permissions: [],
    });
  });

  it('非法角色标识不允许角色兜底，但不影响该有效角色的显式菜单权限', async () => {
    const { source } = setup([role(' admin ', [menu('allowed')]), role('*'), role('')]);
    expect(await source.getAuthorization(USER)).toEqual({ roles: [], permissions: ['allowed'] });
  });

  it.each([
    { status: '1', delFlag: '0' },
    { status: '0', delFlag: '2' },
    { status: 'x', delFlag: '0' },
  ])('用户无效时拒绝整个授权：%j', async (state) => {
    const value = setup([role('admin', [menu('allowed')])]);
    Object.assign(value.user, state);
    await expect(value.source.getAuthorization(USER)).rejects.toThrow(UnauthorizedException);
  });

  it('用户不存在返回 401', async () => {
    const value = setup();
    value.findUnique.mockResolvedValue(null);
    await expect(value.source.getAuthorization(USER)).rejects.toThrow(UnauthorizedException);
  });

  it.each(['', '0', '-1', '01', '1.0', ' 1', '9223372036854775808'])(
    '拒绝非规范用户 ID：%s',
    async (id) => {
      const value = setup();
      await expect(value.source.getAuthorization(id)).rejects.toThrow(UnauthorizedException);
      expect(value.findUnique).not.toHaveBeenCalled();
    },
  );

  it('最大 BigInt ID 不经过 Number 转换', async () => {
    const value = setup();
    await value.source.getAuthorization('9223372036854775807');
    expect(value.findUnique.mock.calls[0][0].where.userId).toBe(9223372036854775807n);
  });

  it('每次重新查询，移除菜单、角色或停用后立即反映', async () => {
    const value = setup([role('operator', [menu('allowed')])]);
    expect((await value.source.getAuthorization(USER)).permissions).toEqual(['allowed']);
    value.user.roles[0].role.menus = [];
    expect((await value.source.getAuthorization(USER)).permissions).toEqual([]);
    value.user.roles = [];
    expect(await value.source.getAuthorization(USER)).toEqual({ roles: [], permissions: [] });
    expect(value.findUnique).toHaveBeenCalledTimes(3);
  });

  it('数据库失败返回 503，不降级为空权限或放行', async () => {
    const value = setup();
    value.findUnique.mockRejectedValue(new Error('private database detail'));
    await expect(value.source.getAuthorization(USER)).rejects.toThrow(ServiceUnavailableException);
    await expect(value.source.getAuthorization(USER)).rejects.not.toThrow('private database detail');
  });
});
