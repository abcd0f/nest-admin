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
import { PostService } from './post/post.service.js';
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
  roles: ['operator'],
  permissions: ['system:user:list'],
  // 全部数据范围：既有用例的 where 断言保持原样，范围行为在 data-scope.spec.ts 单独覆盖。
  dataScopes: [{ roleId: '2', dataScope: '1', deptIds: [] }],
};
/** 会话撤销桩：影响权限的写操作提交后会按用户踢人。 */
const auth = { revokeUserSessions: vi.fn().mockResolvedValue(1) };
/** 角色回显要返回完整菜单树/部门树，这里只关心被调用，不关心树内容。 */
const menuService = { findAll: vi.fn().mockResolvedValue([]) };
const deptService = { findAll: vi.fn().mockResolvedValue([]) };
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
    posts: [],
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
    menuCheckStrictly: true,
    deptCheckStrictly: true,
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
      userPost: {
        findMany: vi.fn().mockResolvedValue([{ userId: 1n, postId: 4n }]),
      },
    };
    const service = new UserService(prisma as never, {} as never, auth as never);
    const page = await service.findAll({
      page: 2,
      pageSize: 1,
      userName: 'ali',
      deptId: '3',
      status: '0',
      orderByColumn: 'userName',
      isAsc: SortOrder.ASC,
    }, actor);
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
    const page = await new RoleService(prisma as never, auth as never, menuService as never, deptService as never).findAll({});
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
      userPost: { findMany: vi.fn().mockResolvedValue([]) },
    };
    expect(await new UserService(prisma as never, {} as never, auth as never).findAll({}, actor)).toMatchObject({
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
  // 路径 ID 的格式校验已统一收敛到 core 的全局 `BigIntIdPipe`（见
  // libs/core/src/pipes/bigint-id.pipe.spec.ts 与 test/rbac.e2e-spec.ts 的端到端用例），
  // 服务层只接收管道转换好的 bigint，不再重复校验。

  it('各资源详情自行判断不存在，BigInt 上限字符串不经过 Number', async () => {
    const prisma = {
      user: { findFirst: vi.fn().mockResolvedValue(null) },
      role: { findFirst: vi.fn().mockResolvedValue(null) },
      menu: { findUnique: vi.fn().mockResolvedValue(null) },
      dept: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    await expect(
      new UserService(prisma as never, {} as never, auth as never).findOne(
        9223372036854775807n,
        actor,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new RoleService(
        prisma as never,
        auth as never,
        menuService as never,
        deptService as never,
      ).findOne(9223372036854775807n),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new MenuService(prisma as never, auth as never).findOne(9223372036854775807n),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new DeptService(prisma as never).findOne(9223372036854775807n, actor),
    ).rejects.toMatchObject({ status: 404 });
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

describe('权限变更后的会话失效', () => {
  it('角色菜单变更后撤销该角色下所有用户的会话', async () => {
    const tx = {
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
    // 踢人走事务外的索引查询，与事务内的 tx 分开。
    const prisma = {
      $transaction,
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 2n }, { userId: 3n }]) },
    };
    auth.revokeUserSessions.mockClear();
    const service = new RoleService(prisma as never, auth as never, menuService as never, deptService as never);
    await expect(service.assignMenus(2n, { menuIds: [] }, actor)).resolves.toMatchObject({
      roleId: '2',
    });
    expect(tx.roleMenu.deleteMany).toHaveBeenCalledOnce();
    expect($transaction.mock.lastCall?.[1]).toEqual({ isolationLevel: 'Serializable' });
    // 菜单集合变了，该角色下所有用户的快照作废。
    expect(auth.revokeUserSessions.mock.calls).toEqual([['2'], ['3']]);
  });

  it('停用用户后撤销该用户的会话，不影响事务提交', async () => {
    const tx = {
      user: {
        findFirst: vi.fn().mockResolvedValue({ userId: 8n, status: '0' }),
        update: vi.fn().mockResolvedValue(userRow({ userId: 8n, status: '1' })),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const $transaction = vi.fn((action: (client: never) => Promise<unknown>, _options?: unknown) =>
      action(tx as never),
    );
    auth.revokeUserSessions.mockClear();
    const service = new UserService({ $transaction } as never, {} as never, auth as never);
    await expect(service.update(8n, { status: '1' }, actor)).resolves.toMatchObject({
      userId: '8',
    });
    expect(tx.user.update).toHaveBeenCalledOnce();
    expect(auth.revokeUserSessions.mock.calls).toEqual([['8']]);
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
    const tree = await new MenuService(prisma as never, auth as never).findAll();
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
    const tree = await new DeptService(prisma as never).findAll(actor);
    expect(tree[0]).toBeInstanceOf(DeptTreeDto);
    expect(tree[0].children[0]).toBeInstanceOf(DeptTreeDto);
    expect(instanceToPlain(tree)[0].deptId).toBe('1');
    prisma.dept.findMany.mockResolvedValue([deptRow({ deptId: 2n, parentId: 9n })]);
    await expect(new DeptService(prisma as never).findAll(actor)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('用户管理服务', () => {
  it('argon2 哈希后创建用户，仅返回脱敏字段并校验账号查重', async () => {
    const tx = {
      user: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue(userRow()) },
    };
    const prisma = { $transaction: transaction(tx) };
    const passwords = { hashPassword: vi.fn().mockResolvedValue('argon-hash') };
    const service = new UserService(prisma as never, passwords as never, auth as never);
    const response = await service.create(
      { userName: 'alice', nickName: 'Alice', password: 'secret' },
      actor,
    );
    expect(passwords.hashPassword).toHaveBeenCalledWith('secret');
    expect(tx.user.create.mock.lastCall?.[0].data).toMatchObject({
      password: 'argon-hash',
      createBy: 7n,
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
        findFirst: vi.fn().mockResolvedValue({ userId: 2n }),
        update: vi.fn().mockResolvedValue(userRow()),
      },
      role: { findMany: vi.fn().mockResolvedValue([{ roleId: 2n }, { roleId: 3n }]) },
      userRole: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const service = new UserService({ $transaction: transaction(tx) } as never, {} as never, auth as never);
    await service.assignRoles(2n, { roleIds: ['2', '2', '3'] }, actor);
    expect(tx.userRole.deleteMany).toHaveBeenCalledOnce();
    expect(tx.userRole.createMany.mock.lastCall?.[0].data).toEqual([
      { userId: 2n, roleId: 2n },
      { userId: 2n, roleId: 3n },
    ]);
    tx.role.findMany.mockResolvedValue([{ roleId: 2n }]);
    tx.userRole.deleteMany.mockClear();
    await expect(service.assignRoles(2n, { roleIds: ['2', '3'] }, actor)).rejects.toMatchObject({
      status: 422,
    });
    expect(tx.userRole.deleteMany).not.toHaveBeenCalled();
  });

  it('超级管理员账号不允许被修改、改角色或删除，且在事务外直接拒绝', async () => {
    const tx = {
      user: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({ userId: 1n }),
        update: vi.fn(),
      },
      userRole: { deleteMany: vi.fn() },
    };
    const prisma = { $transaction: transaction(tx) };
    const service = new UserService(prisma as never, {} as never, auth as never);
    await expect(service.update(1n, { nickName: 'x' }, actor)).rejects.toThrow(
      '不允许操作超级管理员用户',
    );
    await expect(service.assignRoles(1n, { roleIds: [] }, actor)).rejects.toThrow(
      '不允许操作超级管理员用户',
    );
    await expect(service.remove(1n, actor)).rejects.toThrow('不允许操作超级管理员用户');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
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
    const service = new UserService({ $transaction: transaction(tx) } as never, {} as never, auth as never);
    await expect(service.update(7n, { status: '1' }, actor)).rejects.toThrow('不能停用当前用户');
    await expect(service.remove(7n, actor)).rejects.toThrow('不能删除当前用户');
    tx.user.findFirst.mockResolvedValue({ userId: 8n });
    tx.dept.count.mockResolvedValue(1);
    await expect(service.remove(8n, actor)).rejects.toThrow('用户仍是部门负责人');
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
    const service = new RoleService(prisma as never, auth as never, menuService as never, deptService as never);
    expect(
      (await service.dataScope(2n, { dataScope: '2', deptIds: ['5'] }, actor)).deptIds,
    ).toEqual(['5']);
    expect(tx.roleDept.createMany.mock.lastCall?.[0].data).toEqual([{ roleId: 2n, deptId: 5n }]);
    tx.roleDept.deleteMany.mockClear();
    await expect(
      service.dataScope(2n, { dataScope: '5', deptIds: ['5'] }, actor),
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
    const service = new RoleService(
      { $transaction: transaction(tx) } as never,
      auth as never,
      menuService as never,
      deptService as never,
    );
    await expect(service.assignMenus(2n, { menuIds: ['4', '5'] }, actor)).rejects.toMatchObject({
      status: 422,
    });
    expect(tx.roleMenu.deleteMany).not.toHaveBeenCalled();
  });

  it('拒绝新建或改名占用系统内置角色标识，且不进入事务', async () => {
    const tx = {
      role: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue({ roleId: 2n, roleKey: 'superadmin' }),
        update: vi.fn(),
      },
    };
    const prisma = { $transaction: transaction(tx) };
    const service = new RoleService(prisma as never, auth as never, menuService as never, deptService as never);
    for (const roleKey of ['superadmin', 'admin']) {
      await expect(
        service.create({ roleName: 'reserved', roleKey } as never, actor),
      ).rejects.toThrow('不允许使用系统内置管理员角色标识符');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    // 原标识已是保留标识时，改成任何新值都不允许。
    for (const roleKey of ['admin', 'operator']) {
      await expect(service.update(2n, { roleKey }, actor)).rejects.toThrow(
        '不允许修改系统内置管理员角色标识符',
      );
    }
    expect(tx.role.update).not.toHaveBeenCalled();
  });

  it('角色回显按联动开关裁剪父节点：true 只留末级，false 返回全部已选', async () => {
    const prisma = {
      role: { findFirst: vi.fn().mockResolvedValue({ menuCheckStrictly: true, deptCheckStrictly: true }) },
      roleMenu: {
        findMany: vi.fn().mockResolvedValue([{ menuId: 1n }, { menuId: 2n }, { menuId: 3n }]),
      },
      roleDept: {
        findMany: vi.fn().mockResolvedValue([{ deptId: 10n }, { deptId: 11n }]),
      },
      // 菜单 1 是 2、3 的父节点；部门 10 是 11 的父节点。
      menu: { findMany: vi.fn().mockResolvedValue([{ parentId: 0n }, { parentId: 1n }, { parentId: 1n }]) },
      dept: { findMany: vi.fn().mockResolvedValue([{ parentId: 0n }, { parentId: 10n }]) },
    };
    const service = new RoleService(
      prisma as never,
      auth as never,
      menuService as never,
      deptService as never,
    );
    expect(await service.menuTreeSelect(2n)).toEqual({ checkedKeys: ['2', '3'], menus: [] });
    expect(await service.deptTreeSelect(2n, actor)).toEqual({ checkedKeys: ['11'], depts: [] });

    prisma.role.findFirst.mockResolvedValue({ menuCheckStrictly: false, deptCheckStrictly: false });
    prisma.menu.findMany.mockClear();
    prisma.dept.findMany.mockClear();
    expect(await service.menuTreeSelect(2n)).toEqual({ checkedKeys: ['1', '2', '3'], menus: [] });
    expect(await service.deptTreeSelect(2n, actor)).toEqual({ checkedKeys: ['10', '11'], depts: [] });
    // 不裁剪时不应再查父节点。
    expect(prisma.menu.findMany).not.toHaveBeenCalled();
    expect(prisma.dept.findMany).not.toHaveBeenCalled();
  });

  it('角色不存在时回显返回 404，空关联直接返回空数组', async () => {
    const prisma = {
      role: { findFirst: vi.fn().mockResolvedValue(null) },
      roleMenu: { findMany: vi.fn() },
      roleDept: { findMany: vi.fn() },
      menu: { findMany: vi.fn() },
      dept: { findMany: vi.fn() },
    };
    const service = new RoleService(
      prisma as never,
      auth as never,
      menuService as never,
      deptService as never,
    );
    await expect(service.menuTreeSelect(2n)).rejects.toMatchObject({ status: 404 });
    await expect(service.deptTreeSelect(2n, actor)).rejects.toMatchObject({ status: 404 });
    expect(prisma.roleMenu.findMany).not.toHaveBeenCalled();

    prisma.role.findFirst.mockResolvedValue({ menuCheckStrictly: true, deptCheckStrictly: true });
    prisma.roleMenu.findMany.mockResolvedValue([]);
    prisma.roleDept.findMany.mockResolvedValue([]);
    expect(await service.menuTreeSelect(2n)).toEqual({ checkedKeys: [], menus: [] });
    expect(await service.deptTreeSelect(2n, actor)).toEqual({ checkedKeys: [], depts: [] });
    expect(prisma.menu.findMany).not.toHaveBeenCalled();
  });

  it('创建与更新角色写入树联动开关，未传字段不覆盖已有值', async () => {
    const tx = {
      role: {
        count: vi.fn().mockResolvedValue(0),
        create: vi
          .fn()
          .mockResolvedValue(roleRow({ menuCheckStrictly: false, deptCheckStrictly: false })),
        findFirst: vi.fn().mockResolvedValue({ roleId: 2n, roleKey: 'operator' }),
        update: vi.fn().mockResolvedValue(roleRow()),
      },
    };
    const prisma = { $transaction: transaction(tx) };
    const service = new RoleService(
      prisma as never,
      auth as never,
      menuService as never,
      deptService as never,
    );
    await service.create(
      { roleName: '审计', roleKey: 'auditor', menuCheckStrictly: false, deptCheckStrictly: false },
      actor,
    );
    expect(tx.role.create.mock.lastCall?.[0].data).toMatchObject({
      menuCheckStrictly: false,
      deptCheckStrictly: false,
    });
    await service.update(2n, { menuCheckStrictly: true }, actor);
    expect(tx.role.update.mock.lastCall?.[0].data).toMatchObject({
      menuCheckStrictly: true,
      deptCheckStrictly: undefined,
    });
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
    const service = new MenuService({ $transaction: transaction(tx) } as never, auth as never);
    await expect(
      service.create({ parentId: '1', menuName: 'button', menuType: 'F', perms: 'save' }, actor),
    ).rejects.toMatchObject({ status: 422 });
    await expect(service.remove(2n)).rejects.toThrow(ConflictException);
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
    const response = await service.update(1n, { parentId: '3' }, actor);
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
    await expect(service.update(1n, { parentId: '2' }, actor)).rejects.toThrow(ConflictException);
    expect(tx.dept.update).not.toHaveBeenCalled();
    await expect(service.remove(1n, actor)).rejects.toThrow('部门仍被用户引用');
    expect(tx.dept.update).not.toHaveBeenCalled();
  });
});

describe('数据范围落地到管理查询', () => {
  /** 本部门（3）范围的普通管理员：只能看到部门 3 的数据。 */
  const scoped: AuthenticatedUser = {
    ...actor,
    userId: '7',
    deptId: '3',
    dataScopes: [{ roleId: '2', dataScope: '3', deptIds: [] }],
  };

  it('用户分页把范围条件用 AND 合入，不覆盖筛选条件', async () => {
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      userRole: { findMany: vi.fn().mockResolvedValue([]) },
      userPost: { findMany: vi.fn().mockResolvedValue([]) },
    };
    await new UserService(prisma as never, {} as never, auth as never).findAll(
      { userName: 'ali' },
      scoped,
    );
    expect(prisma.user.findMany.mock.lastCall?.[0].where).toEqual({
      AND: [{ delFlag: '0', userName: { contains: 'ali' } }, { deptId: { in: [3n] } }],
    });
    expect(prisma.user.count.mock.lastCall?.[0].where).toEqual({
      AND: [{ delFlag: '0', userName: { contains: 'ali' } }, { deptId: { in: [3n] } }],
    });
  });

  it('范围外用户按不存在处理，不会泄露存在性', async () => {
    const prisma = { user: { findFirst: vi.fn().mockResolvedValue(null) } };
    await expect(
      new UserService(prisma as never, {} as never, auth as never).findOne(9n, scoped),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.user.findFirst.mock.lastCall?.[0].where).toEqual({
      AND: [{ userId: 9n, delFlag: '0' }, { deptId: { in: [3n] } }],
    });
  });

  it('部门树被裁掉父节点时把可见子节点挂到根上', async () => {
    const prisma = {
      dept: { findMany: vi.fn().mockResolvedValue([deptRow({ deptId: 2n, parentId: 1n })]) },
    };
    const tree = await new DeptService(prisma as never).findAll(scoped);
    expect(prisma.dept.findMany.mock.lastCall?.[0].where).toEqual({
      AND: [{ delFlag: '0' }, { deptId: { in: [3n] } }],
    });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ deptId: '2', parentId: '0' });
  });

  it('受限用户不能把用户或部门建到范围外', async () => {
    const prisma = { user: { count: vi.fn() }, dept: { findFirst: vi.fn() } };
    await expect(
      new UserService(prisma as never, {} as never, auth as never).create(
        { userName: 'bob', nickName: 'Bob', password: 'secret', deptId: '9' },
        scoped,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      new DeptService(prisma as never).create({ deptName: 'Ops', parentId: '9' }, scoped),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('受限用户不能把用户或部门移动到范围外', async () => {
    const prisma = { user: { findFirst: vi.fn() }, dept: { findFirst: vi.fn() } };
    await expect(
      new UserService(prisma as never, {} as never, auth as never).update(
        9n,
        { deptId: '8' },
        scoped,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      new DeptService(prisma as never).update(9n, { parentId: '8' }, scoped),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.dept.findFirst).not.toHaveBeenCalled();
  });
});

describe('岗位管理与用户岗位分配', () => {
  function postRow(extra: Record<string, unknown> = {}) {
    return {
      postId: 5n,
      deptId: 3n,
      postCode: 'ceo',
      postName: '董事长',
      orderNum: 0,
      status: '0',
      remark: null,
      createTime: date,
      updateTime: null,
      ...extra,
    };
  }

  it('岗位分页受数据范围约束，并按部门/编码/名称过滤', async () => {
    const prisma = {
      post: { findMany: vi.fn().mockResolvedValue([postRow()]), count: vi.fn().mockResolvedValue(1) },
    };
    const page = await new PostService(prisma as never).findAll(
      { postCode: 'ce', postName: '董', deptId: '3', status: '0' },
      actor,
    );
    expect(prisma.post.findMany.mock.lastCall?.[0].where).toEqual({
      delFlag: '0',
      postCode: { contains: 'ce' },
      postName: { contains: '董' },
      status: '0',
      deptId: 3n,
    });
    expect(page.items[0]).toMatchObject({ postId: '5', deptId: '3', postCode: 'ceo' });
  });

  it('岗位编码全局唯一、岗位名称在部门内唯一', async () => {
    const tx = {
      dept: { findFirst: vi.fn().mockResolvedValue({ deptId: 3n }) },
      post: { count: vi.fn().mockResolvedValue(1), create: vi.fn() },
    };
    const service = new PostService({ $transaction: transaction(tx) } as never);
    await expect(
      service.create({ deptId: '3', postCode: 'ceo', postName: '董事长' }, actor),
    ).rejects.toThrow('岗位编码已存在');
    expect(tx.post.create).not.toHaveBeenCalled();
  });

  it('已分配用户的岗位不能停用，也不能删除', async () => {
    const tx = {
      post: {
        findFirst: vi.fn().mockResolvedValue({ postId: 5n, deptId: 3n }),
        update: vi.fn(),
      },
      userPost: { count: vi.fn().mockResolvedValue(2) },
    };
    const service = new PostService({ $transaction: transaction(tx) } as never);
    await expect(service.update(5n, { status: '1' }, actor)).rejects.toThrow(
      '岗位已分配用户，不能停用',
    );
    await expect(service.remove(5n, actor)).rejects.toThrow('岗位已分配用户，不能删除');
    expect(tx.post.update).not.toHaveBeenCalled();
  });

  it('删除岗位写逻辑删除标记，不物理删除', async () => {
    const tx = {
      post: {
        findFirst: vi.fn().mockResolvedValue({ postId: 5n }),
        update: vi.fn().mockResolvedValue(postRow()),
      },
      userPost: { count: vi.fn().mockResolvedValue(0) },
    };
    await new PostService({ $transaction: transaction(tx) } as never).remove(5n, actor);
    expect(tx.post.update.mock.lastCall?.[0].data).toMatchObject({ delFlag: '2', updateBy: 7n });
  });

  it('创建用户时一并写入岗位关联，返回体带 postIds', async () => {
    const tx = {
      user: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue(userRow()) },
      post: { findMany: vi.fn().mockResolvedValue([{ postId: 5n }]) },
      userPost: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const passwords = { hashPassword: vi.fn().mockResolvedValue('argon-hash') };
    const response = await new UserService(
      { $transaction: transaction(tx) } as never,
      passwords as never,
      auth as never,
    ).create({ userName: 'alice', nickName: 'Alice', password: 'secret', postIds: ['5'] }, actor);
    expect(tx.userPost.createMany).toHaveBeenCalledWith({ data: [{ userId: 1n, postId: 5n }] });
    expect(response.postIds).toEqual(['5']);
  });

  it('引用不存在或停用的岗位时整笔事务回滚', async () => {
    const tx = {
      user: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue(userRow()) },
      post: { findMany: vi.fn().mockResolvedValue([]) },
      userPost: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const service = new UserService(
      { $transaction: transaction(tx) } as never,
      { hashPassword: vi.fn().mockResolvedValue('argon-hash') } as never,
      auth as never,
    );
    await expect(
      service.create(
        { userName: 'alice', nickName: 'Alice', password: 'secret', postIds: ['9'] },
        actor,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(tx.userPost.createMany).not.toHaveBeenCalled();
  });

  it('岗位下拉只返回启用岗位，并同样受数据范围约束', async () => {
    const prisma = {
      post: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ postId: 5n, postCode: 'ceo', postName: '董事长' }]),
      },
    };
    const options = await new PostService(prisma as never).options('3', actor);
    expect(prisma.post.findMany.mock.lastCall?.[0].where).toEqual({
      delFlag: '0',
      status: '0',
      deptId: 3n,
    });
    expect(options[0]).toMatchObject({ postId: '5', postCode: 'ceo' });
  });
});
