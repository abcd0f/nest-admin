import type { AuthenticatedUser } from '@app/auth';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SystemAuthService } from './auth.service.js';

const user = {
  userId: 9223372036854775807n,
  userName: 'alice',
  nickName: 'Alice',
  deptId: 9007199254740993n,
  password: 'stored-hash',
  status: '0',
  delFlag: '0',
};
const context: AuthenticatedUser = {
  userId: String(user.userId),
  userName: user.userName,
  nickName: user.nickName,
  deptId: String(user.deptId),
  sessionId: 'internal-session',
};

function menu(menuId: bigint, parentId = 0n, extra = {}) {
  return {
    menuId,
    parentId,
    menuName: `menu-${menuId}`,
    menuType: 'C',
    orderNum: 0,
    path: '/users',
    component: 'system/users',
    query: null,
    isFrame: '1',
    isCache: '0',
    visible: '0',
    status: '0',
    perms: null,
    icon: null,
    ...extra,
  };
}

async function fixture() {
  const prisma = {
    user: {
      findMany: vi.fn().mockResolvedValue([user]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ status: '0', delFlag: '0', roles: [] }),
    },
  };
  const passwords = {
    verifyPassword: vi.fn().mockResolvedValue(true),
    hashPassword: vi.fn().mockResolvedValue('dummy-hash'),
  };
  const auth = { createSession: vi.fn().mockResolvedValue({ accessToken: 'access' }) };
  const permissions = {
    getAuthorization: vi
      .fn()
      .mockResolvedValue({ roles: ['operator'], permissions: ['user:list'] }),
  };
  const service = new SystemAuthService(
    prisma as never,
    passwords as never,
    auth as never,
    permissions as never,
  );
  await service.onModuleInit();
  return { service, prisma, passwords, auth, permissions };
}

describe('认证业务登录与当前用户', () => {
  it('精确匹配账号，限制歧义查询，成功后记录审计并仅返回脱敏字符串 ID', async () => {
    const { service, prisma, passwords, auth } = await fixture();
    const response = await service.login({ userName: 'alice', password: ' secret ' }, '127.0.0.1');
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userName: 'alice', delFlag: '0' },
        take: 2,
      }),
    );
    expect(passwords.verifyPassword).toHaveBeenCalledWith('stored-hash', ' secret ');
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { userId: user.userId, status: '0', delFlag: '0', password: user.password },
      data: { loginIp: '127.0.0.1', loginDate: expect.any(Date) },
    });
    expect(auth.createSession).toHaveBeenCalledWith(String(user.userId));
    expect(response).toEqual({
      accessToken: 'access',
      user: {
        userId: context.userId,
        userName: 'alice',
        nickName: 'Alice',
        deptId: context.deptId,
      },
    });
  });

  it.each(
    [
      [],
      [user, { ...user, userId: 2n }],
      [{ ...user, status: '1' }],
      [{ ...user, delFlag: '2' }],
    ].map((users) => ({ users })),
  )('缺失、同名歧义、禁用和删除统一拒绝，且不更新审计或创建会话：$users', async ({ users }) => {
    const { service, prisma, passwords, auth } = await fixture();
    prisma.user.findMany.mockResolvedValue(users);
    await expect(
      service.login({ userName: 'alice', password: 'secret' }, '127.0.0.1'),
    ).rejects.toMatchObject({ message: '账号或密码错误', status: 401 });
    expect(passwords.verifyPassword).toHaveBeenCalledWith('dummy-hash', 'secret');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it.each([false, new Error('invalid hash detail')])(
    '密码不匹配或哈希损坏统一拒绝：%s',
    async (result) => {
      const { service, passwords, auth } = await fixture();
      if (result instanceof Error) passwords.verifyPassword.mockRejectedValue(result);
      else passwords.verifyPassword.mockResolvedValue(result);
      await expect(
        service.login({ userName: 'alice', password: 'secret' }, '127.0.0.1'),
      ).rejects.toMatchObject({ message: '账号或密码错误', status: 401 });
      expect(auth.createSession).not.toHaveBeenCalled();
    },
  );

  it('验证后账号状态或密码改变时拒绝建立会话', async () => {
    const { service, prisma, auth } = await fixture();
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.login({ userName: 'alice', password: 'secret' }, '127.0.0.1'),
    ).rejects.toThrow(UnauthorizedException);
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it.each(['findMany', 'updateMany'] as const)('数据库 %s 故障失败关闭', async (method) => {
    const { service, prisma, auth } = await fixture();
    prisma.user[method].mockRejectedValue(new Error('private database detail'));
    await expect(
      service.login({ userName: 'alice', password: 'secret' }, '127.0.0.1'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it('当前用户资料只合并实时角色和权限，不暴露内部会话标识', async () => {
    const { service, permissions } = await fixture();
    expect(await service.profile(context)).toEqual({
      userId: context.userId,
      userName: 'alice',
      nickName: 'Alice',
      deptId: context.deptId,
      roles: ['operator'],
      permissions: ['user:list'],
    });
    expect(permissions.getAuthorization).toHaveBeenCalledWith(context.userId);
  });
});

describe('当前用户菜单树', () => {
  it('有效角色菜单取并集、去重排序，排除按钮及失效分支，不扩展未授权父子节点', async () => {
    const { service, prisma } = await fixture();
    const menus = [
      menu(4n, 1n, { orderNum: 2 }),
      menu(1n, 0n, { menuType: 'M' }),
      menu(3n, 1n, { orderNum: 1 }),
      menu(2n, 1n, { orderNum: 1 }),
      menu(5n, 1n, { menuType: 'F' }),
      menu(6n, 0n, { status: '1' }),
      menu(7n, 6n),
      menu(8n, 0n, { visible: '1' }),
      menu(9n, 8n),
      menu(10n, 99n),
      menu(11n, 0n, { menuType: '?' }),
      menu(12n, 11n),
      menu(13n, 14n),
      menu(14n, 13n),
      menu(15n, 15n),
      menu(9007199254740993n),
    ];
    const assignment = (status: string, delFlag: string, items: typeof menus) => ({
      role: { status, delFlag, menus: items.map((item) => ({ menu: item })) },
    });
    prisma.user.findUnique.mockResolvedValue({
      status: '0',
      delFlag: '0',
      roles: [
        assignment('0', '0', menus),
        assignment('0', '0', [menus[0]]),
        assignment('1', '0', [menu(20n)]),
        assignment('0', '2', [menu(21n)]),
      ],
    });
    const result = await service.menus(context.userId);
    expect(result.map((item) => item.menuId)).toEqual(['1', '9007199254740993']);
    expect(result[0].children.map((item) => item.menuId)).toEqual(['2', '3', '4']);
    expect(result[0]).toMatchObject({ menuType: 'M', parentId: '0' });
    expect(result[0].children[0].children).toEqual([]);
    expect(prisma.user.findUnique.mock.lastCall?.[0].select).not.toHaveProperty('password');
    expect(JSON.stringify(result)).not.toContain('status');
  });

  it('无角色返回空菜单，每次调用重新查询', async () => {
    const { service, prisma } = await fixture();
    expect(await service.menus(context.userId)).toEqual([]);
    expect(await service.menus(context.userId)).toEqual([]);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it.each([null, { status: '1', delFlag: '0' }, { status: '0', delFlag: '2' }])(
    '无效主体拒绝菜单查询：%s',
    async (value) => {
      const { service, prisma } = await fixture();
      prisma.user.findUnique.mockResolvedValue(value);
      await expect(service.menus(context.userId)).rejects.toThrow(UnauthorizedException);
    },
  );

  it('菜单查询故障返回服务不可用', async () => {
    const { service, prisma } = await fixture();
    prisma.user.findUnique.mockRejectedValue(new Error('private database detail'));
    await expect(service.menus(context.userId)).rejects.toThrow(ServiceUnavailableException);
  });
});
