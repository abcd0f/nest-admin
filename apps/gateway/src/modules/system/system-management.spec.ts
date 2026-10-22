import type { AuthenticatedUser } from '@app/auth';
import { SortOrder } from '@app/common';
import { ConflictException } from '@nestjs/common';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { DeptService } from './dept/dept.service.js';
import { DeptResponseDto, DeptTreeDto, UpdateDeptDto } from './dept/dto/dept.dto.js';
import { MenuResponseDto, MenuTreeDto, UpdateMenuDto } from './menu/dto/menu.dto.js';
import { MenuService } from './menu/menu.service.js';
import { RoleQueryDto, RoleResponseDto } from './role/dto/role.dto.js';
import { RoleService } from './role/role.service.js';
import { UpdateUserDto, UserQueryDto, UserResponseDto } from './user/dto/user.dto.js';
import { UserService } from './user/user.service.js';

const actor: AuthenticatedUser = {
  userId: '7',
  userName: 'operator',
  nickName: 'Operator',
  deptId: '3',
  sessionId: 'session',
};
const date = new Date('2026-01-02T03:04:05.000Z');

function transaction(tx: object) {
  return vi.fn((action: (client: never) => Promise<unknown>, _options?: unknown) =>
    action(tx as never),
  );
}

function userRow(extra: Record<string, unknown> = {}) {
  return {
    userId: 1n,
    userName: 'alice',
    nickName: 'Alice',
    deptId: 3n,
    email: null,
    phoneNumber: null,
    sex: '2',
    status: '0',
    remark: null,
    createTime: date,
    updateTime: null,
    roles: [{ roleId: 2n }],
    ...extra,
  };
}

function roleRow(extra: Record<string, unknown> = {}) {
  return {
    roleId: 2n,
    roleName: 'Operator',
    roleKey: 'operator',
    orderNum: 0,
    dataScope: '5',
    status: '0',
    remark: null,
    createTime: date,
    updateTime: null,
    menus: [{ menuId: 4n }],
    depts: [],
    ...extra,
  };
}

function deptRow(extra: Record<string, unknown> = {}) {
  return {
    deptId: 2n,
    parentId: 0n,
    ancestors: '/2/',
    deptName: 'Finance',
    orderNum: 0,
    leaderId: null,
    status: '0',
    remark: null,
    createTime: date,
    updateTime: null,
    ...extra,
  };
}

function menuRow(extra: Record<string, unknown> = {}) {
  return {
    menuId: 1n,
    parentId: 0n,
    menuName: 'System',
    menuType: 'M',
    orderNum: 0,
    path: null,
    component: null,
    query: null,
    isFrame: '1',
    isCache: '0',
    visible: '0',
    status: '0',
    perms: null,
    icon: null,
    remark: null,
    createTime: date,
    updateTime: null,
    ...extra,
  };
}

function administrator() {
  const permissions = [
    ...['user', 'role', 'menu', 'dept'].flatMap((resource) =>
      ['list', 'query', 'add', 'edit', 'delete'].map((action) => `system:${resource}:${action}`),
    ),
    'system:user:assignRoles',
    'system:role:assignMenus',
    'system:role:dataScope',
  ];
  return {
    roles: [
      {
        role: {
          menus: permissions.map((perms) => ({ menu: { perms } })),
        },
      },
    ],
  };
}

describe('分页与响应 DTO', () => {
  it('用户分页直接使用 delegate 和查询参数，补齐本页角色并排除敏感字段', async () => {
    const prisma = {
      user: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            userRow({ password: 'private-hash', loginIp: 'private-ip', createBy: 7n }),
          ]),
        count: vi.fn().mockResolvedValue(3),
      },
      userRole: {
        findMany: vi.fn().mockResolvedValue([
          { userId: 1n, roleId: 2n },
          { userId: 99n, roleId: 9n },
        ]),
      },
    };
    const service = new UserService(prisma as never, {} as never);
    const page = await service.findAll({
      page: 2,
      pageSize: 1,
      userName: 'ali',
      deptId: '3',
      status: '0',
      orderByColumn: 'userName',
      isAsc: SortOrder.ASC,
    });
    const where = { delFlag: '0', status: '0', userName: { contains: 'ali' }, deptId: 3n };
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where,
      skip: 1,
      take: 1,
      orderBy: { userName: 'asc' },
    });
    expect(prisma.user.count).toHaveBeenCalledWith({ where });
    expect(prisma.userRole.findMany.mock.lastCall?.[0].where).toEqual({ userId: { in: [1n] } });
    expect(page.meta).toEqual({ page: 2, pageSize: 1, total: 3, totalPage: 3 });
    expect(page.items[0]).toBeInstanceOf(UserResponseDto);
    expect(page.items[0]).toMatchObject({
      userId: '1',
      deptId: '3',
      roleIds: ['2'],
      createTime: '2026-01-02 11:04:05',
      updateTime: null,
    });
    const plain = instanceToPlain(page);
    expect(plain.items[0]).not.toHaveProperty('password');
    expect(plain.items[0]).not.toHaveProperty('loginIp');
    expect(plain.items[0]).not.toHaveProperty('createBy');
    expect(plain.items[0]).not.toHaveProperty('roles');
    expect(() => JSON.stringify(plain)).not.toThrow();
  });

  it('角色分页使用默认分页排序，菜单及自定义部门仅归入对应角色', async () => {
    const prisma = {
      role: {
        findMany: vi.fn().mockResolvedValue([roleRow(), roleRow({ roleId: 3n })]),
        count: vi.fn().mockResolvedValue(2),
      },
      roleMenu: {
        findMany: vi.fn().mockResolvedValue([
          { roleId: 2n, menuId: 4n },
          { roleId: 3n, menuId: 5n },
        ]),
      },
      roleDept: { findMany: vi.fn().mockResolvedValue([{ roleId: 3n, deptId: 6n }]) },
    };
    const page = await new RoleService(prisma as never).findAll({});
    expect(prisma.role.findMany.mock.lastCall?.[0]).toMatchObject({
      skip: 0,
      take: 20,
      orderBy: { createTime: 'desc' },
    });
    expect(page.items[0]).toBeInstanceOf(RoleResponseDto);
    expect(page.items).toMatchObject([
      { roleId: '2', menuIds: ['4'], deptIds: [] },
      { roleId: '3', menuIds: ['5'], deptIds: ['6'] },
    ]);
    expect(instanceToPlain(page).items[0]).not.toHaveProperty('menus');
    expect(instanceToPlain(page).items[0]).not.toHaveProperty('depts');
    expect(page.meta.total).toBe(2);
  });

  it('空页返回空关联集合，所有响应 DTO 保留可空字段并精确序列化 BigInt 上限', async () => {
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      userRole: { findMany: vi.fn().mockResolvedValue([]) },
    };
    expect(await new UserService(prisma as never, {} as never).findAll({})).toMatchObject({
      items: [],
      meta: { total: 0, totalPage: 0 },
    });
    for (const cls of [UserResponseDto, RoleResponseDto, MenuResponseDto, DeptResponseDto]) {
      const dto = plainToInstance<object, object>(cls, {
        userId: 9223372036854775807n,
        roleId: 9223372036854775807n,
        menuId: 9223372036854775807n,
        deptId: 9223372036854775807n,
        parentId: 0n,
        leaderId: null,
        createTime: date,
        updateTime: null,
        password: 'private-hash',
        delFlag: '2',
      });
      const plain = instanceToPlain(dto);
      expect(Object.values(plain)).toContain('9223372036854775807');
      expect(plain).toMatchObject({ createTime: '2026-01-02 11:04:05', updateTime: null });
      expect(plain).not.toHaveProperty('password');
      expect(plain).not.toHaveProperty('delFlag');
      expect(() => JSON.stringify(plain)).not.toThrow();
    }
  });
});

describe('直接参数与字段校验', () => {
  it.each(['0', '-1', '01', '1e3', ' 1', '1.0', '9223372036854775808'])(
    '四类资源在查询前拒绝非法路径 ID %s',
    async (id) => {
      const prisma = {
        user: { findFirst: vi.fn() },
        role: { findFirst: vi.fn() },
        menu: { findUnique: vi.fn() },
        dept: { findFirst: vi.fn() },
      };
      const services = [
        new UserService(prisma as never, {} as never),
        new RoleService(prisma as never),
        new MenuService(prisma as never),
        new DeptService(prisma as never),
      ];
      for (const service of services)
        await expect(service.findOne(id)).rejects.toMatchObject({ status: 422 });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.role.findFirst).not.toHaveBeenCalled();
      expect(prisma.menu.findUnique).not.toHaveBeenCalled();
      expect(prisma.dept.findFirst).not.toHaveBeenCalled();
    },
  );

  it('各资源详情自行判断不存在，BigInt 上限字符串不经过 Number', async () => {
    const prisma = {
      user: { findFirst: vi.fn().mockResolvedValue(null) },
      role: { findFirst: vi.fn().mockResolvedValue(null) },
      menu: { findUnique: vi.fn().mockResolvedValue(null) },
      dept: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    for (const service of [
      new UserService(prisma as never, {} as never),
      new RoleService(prisma as never),
      new MenuService(prisma as never),
      new DeptService(prisma as never),
    ]) {
      await expect(service.findOne('9223372036854775807')).rejects.toMatchObject({ status: 404 });
    }
    expect(prisma.user.findFirst.mock.lastCall?.[0].where.userId).toBe(9223372036854775807n);
  });

  it('省略字段允许部分更新，非可空字段拒绝 null，可空资料允许清除', () => {
    for (const cls of [UpdateUserDto, UpdateMenuDto, UpdateDeptDto]) {
      expect(validateSync(plainToInstance(cls, {}))).toHaveLength(0);
      expect(validateSync(plainToInstance(cls, { status: null }))).not.toHaveLength(0);
    }
    expect(
      validateSync(plainToInstance(UpdateUserDto, { deptId: null, email: null })),
    ).toHaveLength(0);
    expect(validateSync(plainToInstance(UserQueryDto, { userName: null }))).not.toHaveLength(0);
    expect(validateSync(plainToInstance(UpdateDeptDto, { leaderId: null }))).toHaveLength(0);
    expect(
      validateSync(plainToInstance(RoleQueryDto, { orderByColumn: 'password' })),
    ).not.toHaveLength(0);
  });
});

describe('管理写操作的有效管理员保护', () => {
  it('停用其他账号会在事务内检查管理员变化，最后一位失效时拒绝提交', async () => {
    const tx = {
      user: {
        findMany: vi.fn().mockResolvedValueOnce([administrator()]).mockResolvedValueOnce([]),
        findFirst: vi.fn().mockResolvedValue({ userId: 8n, status: '0' }),
        update: vi.fn().mockResolvedValue(userRow({ userId: 8n, status: '1' })),
      },
    };
    const $transaction = vi.fn((action: (client: never) => Promise<unknown>, _options?: unknown) =>
      action(tx as never),
    );
    const service = new UserService({ $transaction } as never, {} as never);
    await expect(service.update('8', { status: '1' }, actor)).rejects.toMatchObject({
      status: 409,
    });
    expect($transaction).toHaveBeenCalledOnce();
    expect(tx.user.update).toHaveBeenCalledOnce();
    expect(tx.user.findMany).toHaveBeenCalledTimes(2);
    expect($transaction.mock.lastCall?.[1]).toEqual({ isolationLevel: 'Serializable' });
  });

  it('清空角色菜单会在同一事务检查管理员，最后一位仍有效时允许其他操作', async () => {
    const tx = {
      user: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([administrator()])
          .mockResolvedValueOnce([administrator()]),
      },
      role: {
        findFirst: vi.fn().mockResolvedValue({ roleId: 2n }),
        update: vi.fn().mockResolvedValue(roleRow({ menus: [] })),
      },
      menu: { findMany: vi.fn().mockResolvedValue([]) },
      roleMenu: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const $transaction = vi.fn((action: (client: never) => Promise<unknown>, _options?: unknown) =>
      action(tx as never),
    );
    const service = new RoleService({ $transaction } as never);
    await expect(service.assignMenus('2', { menuIds: [] }, actor)).resolves.toMatchObject({
      roleId: '2',
    });
    expect(tx.roleMenu.deleteMany).toHaveBeenCalledOnce();
    expect(tx.user.findMany).toHaveBeenCalledTimes(2);
    expect($transaction.mock.lastCall?.[1]).toEqual({ isolationLevel: 'Serializable' });
  });
});

describe('菜单和部门管理树', () => {
  it('将菜单查询结果转成已脱敏、递归类型化的目录菜单按钮树', async () => {
    const prisma = {
      menu: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            menuRow({ menuId: 1n, menuName: 'root', password: 'secret' }),
            menuRow({ menuId: 2n, parentId: 1n, menuName: 'page', menuType: 'C' }),
            menuRow({
              menuId: 3n,
              parentId: 2n,
              menuName: 'button',
              menuType: 'F',
              perms: 'system:save',
            }),
          ]),
      },
    };
    const tree = await new MenuService(prisma as never).findAll();
    expect(tree[0]).toBeInstanceOf(MenuTreeDto);
    expect(tree[0].children[0]).toBeInstanceOf(MenuTreeDto);
    expect(tree[0].children[0].children[0]).toBeInstanceOf(MenuTreeDto);
    expect(tree[0].children[0].children[0]).toMatchObject({ menuId: '3', perms: 'system:save' });
    expect(instanceToPlain(tree)[0]).not.toHaveProperty('password');
  });

  it('只输出未删除部门，递归 DTO 有效且缺失父节点显式返回冲突', async () => {
    const prisma = {
      dept: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            deptRow({ deptId: 1n, parentId: 0n, ancestors: '/1/' }),
            deptRow({ deptId: 2n, parentId: 1n, ancestors: '/1/2/' }),
          ]),
      },
    };
    const tree = await new DeptService(prisma as never).findAll();
    expect(tree[0]).toBeInstanceOf(DeptTreeDto);
    expect(tree[0].children[0]).toBeInstanceOf(DeptTreeDto);
    expect(instanceToPlain(tree)[0].deptId).toBe('1');
    prisma.dept.findMany.mockResolvedValue([deptRow({ deptId: 2n, parentId: 9n })]);
    await expect(new DeptService(prisma as never).findAll()).rejects.toMatchObject({ status: 409 });
  });
});

describe('用户管理服务', () => {
  it('argon2 哈希后创建用户，仅返回脱敏字段并校验账号查重', async () => {
    const tx = {
      user: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue(userRow()) },
    };
    const prisma = { $transaction: transaction(tx) };
    const passwords = { hashPassword: vi.fn().mockResolvedValue('argon-hash') };
    const service = new UserService(prisma as never, passwords as never);
    const response = await service.create(
      { userName: 'alice', nickName: 'Alice', password: 'secret' },
      actor,
    );
    expect(passwords.hashPassword).toHaveBeenCalledWith('secret');
    expect(tx.user.create.mock.lastCall?.[0].data).toMatchObject({
      password: 'argon-hash',
      createBy: 7n,
      createDept: 3n,
    });
    expect(response).toMatchObject({
      userId: '1',
      deptId: '3',
      roleIds: ['2'],
      createTime: '2026-01-02 11:04:05',
    });
    expect(response).not.toHaveProperty('password');
    tx.user.count.mockResolvedValue(1);
    await expect(
      service.create({ userName: 'alice', nickName: 'Alice', password: 'secret' }, actor),
    ).rejects.toThrow('账号已存在');
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.lastCall?.[1]).toEqual({ isolationLevel: 'Serializable' });
  });

  it('所有角色引用有效后才替换；失效 ID 不先删除旧关联', async () => {
    const tx = {
      user: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({ userId: 1n }),
        update: vi.fn().mockResolvedValue(userRow()),
      },
      role: { findMany: vi.fn().mockResolvedValue([{ roleId: 2n }, { roleId: 3n }]) },
      userRole: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const service = new UserService({ $transaction: transaction(tx) } as never, {} as never);
    await service.assignRoles('1', { roleIds: ['2', '2', '3'] }, actor);
    expect(tx.userRole.deleteMany).toHaveBeenCalledOnce();
    expect(tx.userRole.createMany.mock.lastCall?.[0].data).toEqual([
      { userId: 1n, roleId: 2n },
      { userId: 1n, roleId: 3n },
    ]);
    tx.role.findMany.mockResolvedValue([{ roleId: 2n }]);
    tx.userRole.deleteMany.mockClear();
    await expect(service.assignRoles('1', { roleIds: ['2', '3'] }, actor)).rejects.toMatchObject({
      status: 422,
    });
    expect(tx.userRole.deleteMany).not.toHaveBeenCalled();
  });

  it('禁止停用或删除本人，拒绝删除仍担任负责人的用户', async () => {
    const tx = {
      user: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn(({ where }) =>
          Promise.resolve(where.userId === 7n ? { userId: 7n } : null),
        ),
        update: vi.fn(),
      },
      dept: { count: vi.fn().mockResolvedValue(0) },
      userRole: { deleteMany: vi.fn() },
    };
    const service = new UserService({ $transaction: transaction(tx) } as never, {} as never);
    await expect(service.update('7', { status: '1' }, actor)).rejects.toThrow('不能停用当前用户');
    await expect(service.remove('7', actor)).rejects.toThrow('不能删除当前用户');
    tx.user.findFirst.mockResolvedValue({ userId: 8n });
    tx.dept.count.mockResolvedValue(1);
    await expect(service.remove('8', actor)).rejects.toThrow('用户仍是部门负责人');
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe('角色和菜单管理服务', () => {
  it('自定义范围与部门集合在单事务中替换，非自定义范围拒绝部门 ID', async () => {
    const tx = {
      role: {
        findFirst: vi.fn().mockResolvedValue({ roleId: 2n }),
        update: vi.fn().mockResolvedValue(roleRow({ dataScope: '2', depts: [{ deptId: 5n }] })),
      },
      dept: { findMany: vi.fn().mockResolvedValue([{ deptId: 5n }]) },
      roleDept: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const prisma = { $transaction: transaction(tx) };
    const service = new RoleService(prisma as never);
    expect(
      (await service.dataScope('2', { dataScope: '2', deptIds: ['5'] }, actor)).deptIds,
    ).toEqual(['5']);
    expect(tx.roleDept.createMany.mock.lastCall?.[0].data).toEqual([{ roleId: 2n, deptId: 5n }]);
    tx.roleDept.deleteMany.mockClear();
    await expect(
      service.dataScope('2', { dataScope: '5', deptIds: ['5'] }, actor),
    ).rejects.toMatchObject({ status: 422 });
    expect(tx.roleDept.deleteMany).not.toHaveBeenCalled();
  });

  it('先校验菜单引用再完整替换角色菜单', async () => {
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      role: {
        findFirst: vi.fn().mockResolvedValue({ roleId: 2n }),
        update: vi.fn().mockResolvedValue(roleRow()),
      },
      menu: { findMany: vi.fn().mockResolvedValue([{ menuId: 4n }]) },
      roleMenu: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const service = new RoleService({ $transaction: transaction(tx) } as never);
    await expect(service.assignMenus('2', { menuIds: ['4', '5'] }, actor)).rejects.toMatchObject({
      status: 422,
    });
    expect(tx.roleMenu.deleteMany).not.toHaveBeenCalled();
  });

  it('菜单创建拒绝错误父类型；物理删除前保护子节点和角色关联', async () => {
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      menu: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ menuId: 1n, parentId: 0n, menuType: 'M', status: '0' }]),
        findUnique: vi.fn().mockResolvedValue({ menuId: 2n }),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn(),
        delete: vi.fn(),
      },
      roleMenu: { count: vi.fn().mockResolvedValue(1) },
    };
    const service = new MenuService({ $transaction: transaction(tx) } as never);
    await expect(
      service.create({ parentId: '1', menuName: 'button', menuType: 'F', perms: 'save' }, actor),
    ).rejects.toMatchObject({ status: 422 });
    await expect(service.remove('2')).rejects.toThrow(ConflictException);
    expect(tx.menu.delete).not.toHaveBeenCalled();
  });
});

describe('部门树维护', () => {
  it('移动部门时在事务内重算所有未删除后代路径', async () => {
    const nodes = [
      { deptId: 1n, parentId: 0n, status: '0' },
      { deptId: 2n, parentId: 1n, status: '0' },
      { deptId: 3n, parentId: 0n, status: '0' },
    ];
    const tx = {
      dept: {
        findFirst: vi.fn().mockResolvedValue(deptRow({ deptId: 1n, ancestors: '/1/' })),
        findMany: vi.fn().mockResolvedValue(nodes),
        update: vi.fn(async (args) =>
          args.where.deptId === 1n
            ? deptRow({ deptId: 1n, parentId: 3n, ancestors: '/3/1/' })
            : deptRow(args.data),
        ),
      },
      user: { count: vi.fn().mockResolvedValue(0) },
    };
    const prisma = { $transaction: transaction(tx) };
    const service = new DeptService(prisma as never);
    const response = await service.update('1', { parentId: '3' }, actor);
    expect(response.ancestors).toBe('/3/1/');
    expect(
      tx.dept.update.mock.calls.map(([args]) => [args.where.deptId, args.data.ancestors]),
    ).toEqual([
      [1n, '/3/1/'],
      [2n, '/3/1/2/'],
    ]);
    expect(prisma.$transaction.mock.lastCall?.[1]).toEqual({ isolationLevel: 'Serializable' });
  });

  it('拒绝把部门移入自身后代，也拒绝删除仍引用的部门', async () => {
    const tx = {
      dept: {
        findFirst: vi.fn().mockResolvedValue(deptRow({ deptId: 1n })),
        findMany: vi.fn().mockResolvedValue([
          { deptId: 1n, parentId: 0n, status: '0' },
          { deptId: 2n, parentId: 1n, status: '0' },
        ]),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn(),
      },
      user: { count: vi.fn().mockResolvedValue(1) },
      roleDept: { count: vi.fn().mockResolvedValue(0) },
    };
    const service = new DeptService({ $transaction: transaction(tx) } as never);
    await expect(service.update('1', { parentId: '2' }, actor)).rejects.toThrow(ConflictException);
    expect(tx.dept.update).not.toHaveBeenCalled();
    await expect(service.remove('1', actor)).rejects.toThrow('部门仍被用户引用');
    expect(tx.dept.update).not.toHaveBeenCalled();
  });
});
