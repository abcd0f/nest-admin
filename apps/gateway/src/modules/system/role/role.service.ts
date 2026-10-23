import type { AuthenticatedUser } from '@app/auth';
import type { Prisma } from '@app/database/generated/prisma/client.js';
import { AuthService } from '@app/auth';
import { toDto, toPageDto } from '@app/common';
import { BusinessException, isBigIntId } from '@app/core';
import { paginate, PrismaService } from '@app/database';
import { RESERVED_TENANT_ADMIN_ROLE_KEY, SUPER_ADMIN_ROLE_KEY } from '@app/permission';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DeptService } from '../dept/dept.service.js';
import { MenuService } from '../menu/menu.service.js';
import {
  AssignRoleMenusDto,
  CreateRoleDto,
  RoleDataScopeDto,
  RoleDeptTreeDto,
  RoleMenuTreeDto,
  RoleQueryDto,
  RoleResponseDto,
  UpdateRoleDto,
} from './dto/role.dto.js';

const roleSelect = {
  roleId: true,
  roleName: true,
  roleKey: true,
  orderNum: true,
  dataScope: true,
  menuCheckStrictly: true,
  deptCheckStrictly: true,
  status: true,
  remark: true,
  createTime: true,
  updateTime: true,
  menus: { select: { menuId: true }, orderBy: { menuId: 'asc' } },
  depts: { select: { deptId: true }, orderBy: { deptId: 'asc' } },
} satisfies Prisma.RoleSelect;

@Injectable()
export class RoleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MenuService) private readonly menus: MenuService,
    @Inject(DeptService) private readonly depts: DeptService,
  ) {}

  async findAll(query: RoleQueryDto) {
    const where: Prisma.RoleWhereInput = {
      delFlag: '0',
      status: query.status,
      roleKey: query.roleKey,
      roleName: query.roleName === undefined ? undefined : { contains: query.roleName },
    };
    const page = await paginate(this.prisma.role, { ...query, where });
    const roleIds = page.items.map((row) => row.roleId);
    const [menus, depts] = await Promise.all([
      this.prisma.roleMenu.findMany({
        where: { roleId: { in: roleIds } },
        select: { roleId: true, menuId: true },
        orderBy: { menuId: 'asc' },
      }),
      this.prisma.roleDept.findMany({
        where: { roleId: { in: roleIds } },
        select: { roleId: true, deptId: true },
        orderBy: { deptId: 'asc' },
      }),
    ]);
    return toPageDto(RoleResponseDto, {
      ...page,
      items: page.items.map((row) => ({
        ...row,
        menuIds: menus.filter((menu) => menu.roleId === row.roleId).map((menu) => menu.menuId),
        deptIds: depts.filter((dept) => dept.roleId === row.roleId).map((dept) => dept.deptId),
      })),
    });
  }

  async findOne(id: bigint) {
    const row = await this.prisma.role.findFirst({
      where: { roleId: id, delFlag: '0' },
      select: roleSelect,
    });
    if (!row) throw new NotFoundException('角色不存在');
    return toDto(RoleResponseDto, {
      ...row,
      menuIds: row.menus.map((menu) => menu.menuId),
      deptIds: row.depts.map((dept) => dept.deptId),
    })!;
  }

  /**
   * 角色菜单回显。
   *
   * 对应 Java `SysMenuMapper.selectMenuListByRoleId`：`menuCheckStrictly` 为 true 时，
   * 把"作为其他已选菜单父节点"的菜单从结果里剔除，只留末级。
   * 前端树在非联动模式下只靠末级就能把父节点推导成半选；若父节点 ID 也在 `checkedKeys` 里，
   * 会被误渲染成全选，让人以为整棵子树都授权了。
   */
  async menuTreeSelect(id: bigint): Promise<RoleMenuTreeDto> {
    const roleId = id;
    const role = await this.prisma.role.findFirst({
      where: { roleId, delFlag: '0' },
      select: { menuCheckStrictly: true },
    });
    if (!role) throw new NotFoundException('角色不存在');
    const assigned = await this.prisma.roleMenu.findMany({
      where: { roleId },
      select: { menuId: true },
      orderBy: { menuId: 'asc' },
    });
    const ids = assigned.map((row) => row.menuId);
    const checked = role.menuCheckStrictly ? await this.dropParentMenus(ids) : ids;
    return {
      checkedKeys: checked.map((value) => String(value)),
      menus: await this.menus.findAll(),
    };
  }

  /**
   * 角色部门回显。
   *
   * 对应 Java `SysDeptMapper.selectDeptListByRoleId`，裁剪规则与菜单一致。
   */
  async deptTreeSelect(id: bigint, actor: AuthenticatedUser): Promise<RoleDeptTreeDto> {
    const roleId = id;
    const role = await this.prisma.role.findFirst({
      where: { roleId, delFlag: '0' },
      select: { deptCheckStrictly: true },
    });
    if (!role) throw new NotFoundException('角色不存在');
    const assigned = await this.prisma.roleDept.findMany({
      where: { roleId },
      select: { deptId: true },
      orderBy: { deptId: 'asc' },
    });
    const ids = assigned.map((row) => row.deptId);
    const checked = role.deptCheckStrictly ? await this.dropParentDepts(ids) : ids;
    return {
      checkedKeys: checked.map((value) => String(value)),
      // 部门树同样受数据范围约束：看不到的部门不能被授予。
      depts: await this.depts.findAll(actor),
    };
  }

  /** 剔除被其他已选菜单引用的父菜单；空集合直接返回，省一次查询。 */
  private async dropParentMenus(ids: readonly bigint[]): Promise<bigint[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.menu.findMany({
      where: { menuId: { in: [...ids] } },
      select: { parentId: true },
    });
    const parents = new Set(rows.map((row) => row.parentId));
    return ids.filter((menuId) => !parents.has(menuId));
  }

  private async dropParentDepts(ids: readonly bigint[]): Promise<bigint[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.dept.findMany({
      where: { deptId: { in: [...ids] } },
      select: { parentId: true },
    });
    const parents = new Set(rows.map((row) => row.parentId));
    return ids.filter((deptId) => !parents.has(deptId));
  }

  async create(body: CreateRoleDto, actor: AuthenticatedUser) {
    this.assertRoleKeyAvailable(body.roleKey);
    const row = await this.prisma.$transaction(
      async (tx) => {
        if (await tx.role.count({ where: { roleKey: body.roleKey, delFlag: '0' } })) {
          throw new ConflictException('角色标识已存在');
        }
        return tx.role.create({
          data: {
            roleName: body.roleName,
            roleKey: body.roleKey,
            orderNum: body.orderNum,
            status: body.status,
            menuCheckStrictly: body.menuCheckStrictly,
            deptCheckStrictly: body.deptCheckStrictly,
            remark: body.remark,
            createBy: BigInt(actor.userId),
          },
          select: roleSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return toDto(RoleResponseDto, { ...row, menuIds: [], deptIds: [] })!;
  }

  async update(id: bigint, body: UpdateRoleDto, actor: AuthenticatedUser) {
    const roleId = id;
    const row = await this.prisma.$transaction(
      async (tx) => {
        const role = await tx.role.findFirst({
          where: { roleId, delFlag: '0' },
          select: { roleId: true, roleKey: true },
        });
        if (!role) throw new NotFoundException('角色不存在');
        // 保留标识既不能被改名，也不能被新值占用；仅在标识实际变化时判定。
        if (body.roleKey !== undefined && body.roleKey !== role.roleKey) {
          this.assertRoleKeyNotReserved(role.roleKey);
          this.assertRoleKeyAvailable(body.roleKey);
        }
        if (
          body.roleKey !== undefined &&
          (await tx.role.count({
            where: { roleKey: body.roleKey, delFlag: '0', roleId: { not: roleId } },
          }))
        ) {
          throw new ConflictException('角色标识已存在');
        }
        const updated = await tx.role.update({
          where: { roleId },
          data: {
            roleName: body.roleName,
            roleKey: body.roleKey,
            orderNum: body.orderNum,
            status: body.status,
            menuCheckStrictly: body.menuCheckStrictly,
            deptCheckStrictly: body.deptCheckStrictly,
            remark: body.remark,
            updateBy: BigInt(actor.userId),
          },
          select: roleSelect,
        });
        return updated;
      },
      { isolationLevel: 'Serializable' },
    );
    // 状态或角色标识变更会影响该角色下所有用户的快照（含 @Role 兜底判定）。
    if (body.status !== undefined || body.roleKey !== undefined) {
      await this.auth.revokeSessionsOf(await this.usersOfRole(roleId));
    }
    return toDto(RoleResponseDto, {
      ...row,
      menuIds: row.menus.map((menu) => menu.menuId),
      deptIds: row.depts.map((dept) => dept.deptId),
    })!;
  }

  async assignMenus(id: bigint, body: AssignRoleMenusDto, actor: AuthenticatedUser) {
    if (body.menuIds.some((menuId) => !isBigIntId(menuId))) {
      throw BusinessException.validation('菜单 ID 无效');
    }
    const roleId = id;
    const row = await this.prisma.$transaction(
      async (tx) => {
        const role = await tx.role.findFirst({
          where: { roleId, delFlag: '0' },
          select: { roleId: true },
        });
        if (!role) throw new NotFoundException('角色不存在');
        const menuIds = [...new Set(body.menuIds)].map(BigInt);
        const menus = await tx.menu.findMany({
          where: { menuId: { in: menuIds }, status: '0', menuType: { in: ['M', 'C', 'F'] } },
          select: { menuId: true },
        });
        if (menus.length !== menuIds.length) {
          throw BusinessException.validation('包含不存在或停用的菜单');
        }
        await tx.roleMenu.deleteMany({ where: { roleId } });
        if (menuIds.length)
          await tx.roleMenu.createMany({ data: menuIds.map((menuId) => ({ roleId, menuId })) });
        return tx.role.update({
          where: { roleId },
          data: { updateBy: BigInt(actor.userId) },
          select: roleSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
    // 菜单集合变了，该角色下所有用户的快照作废。
    await this.auth.revokeSessionsOf(await this.usersOfRole(roleId));
    return toDto(RoleResponseDto, {
      ...row,
      menuIds: row.menus.map((menu) => menu.menuId),
      deptIds: row.depts.map((dept) => dept.deptId),
    })!;
  }

  async dataScope(id: bigint, body: RoleDataScopeDto, actor: AuthenticatedUser) {
    if (body.deptIds?.some((deptId) => !isBigIntId(deptId))) {
      throw BusinessException.validation('部门 ID 无效');
    }
    const roleId = id;
    const row = await this.prisma.$transaction(
      async (tx) => {
        const role = await tx.role.findFirst({
          where: { roleId, delFlag: '0' },
          select: { roleId: true },
        });
        if (!role) throw new NotFoundException('角色不存在');
        if (body.dataScope === '2' && !body.deptIds?.length) {
          throw BusinessException.validation('自定义数据范围必须选择部门');
        }
        if (body.dataScope !== '2' && body.deptIds?.length) {
          throw BusinessException.validation('非自定义数据范围不能指定部门');
        }
        const deptIds = body.dataScope === '2' ? [...new Set(body.deptIds)].map(BigInt) : [];
        const depts = await tx.dept.findMany({
          where: { deptId: { in: deptIds }, status: '0', delFlag: '0' },
          select: { deptId: true },
        });
        if (depts.length !== deptIds.length) {
          throw BusinessException.validation('包含不存在、停用或已删除的部门');
        }
        await tx.roleDept.deleteMany({ where: { roleId } });
        if (deptIds.length)
          await tx.roleDept.createMany({ data: deptIds.map((deptId) => ({ roleId, deptId })) });
        return tx.role.update({
          where: { roleId },
          data: {
            dataScope: body.dataScope,
            updateBy: BigInt(actor.userId),
          },
          select: roleSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return toDto(RoleResponseDto, {
      ...row,
      menuIds: row.menus.map((menu) => menu.menuId),
      deptIds: row.depts.map((dept) => dept.deptId),
    })!;
  }

  async remove(id: bigint, actor: AuthenticatedUser): Promise<void> {
    const roleId = id;
    await this.prisma.$transaction(
      async (tx) => {
        const role = await tx.role.findFirst({
          where: { roleId, delFlag: '0' },
          select: { roleId: true },
        });
        if (!role) throw new NotFoundException('角色不存在');
        if (await tx.userRole.count({ where: { roleId } }))
          throw new ConflictException('角色仍被用户引用，请先解除关联');
        await tx.roleMenu.deleteMany({ where: { roleId } });
        await tx.roleDept.deleteMany({ where: { roleId } });
        await tx.role.update({
          where: { roleId },
          data: { delFlag: '2', updateBy: BigInt(actor.userId) },
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  /** 角色下的全部用户；角色菜单、状态或标识变更后需要让这些用户重新登录。 */
  private async usersOfRole(roleId: bigint): Promise<bigint[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { roleId },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  /**
   * 系统内置角色标识不允许被新建占用。
   *
   * 本项目的超管由 `userId == 1` 判定、不依赖角色行，因此不移植 Java 的租户管理员特例。
   */
  private assertRoleKeyAvailable(roleKey: string): void {
    if (roleKey === SUPER_ADMIN_ROLE_KEY || roleKey === RESERVED_TENANT_ADMIN_ROLE_KEY) {
      throw new ConflictException('不允许使用系统内置管理员角色标识符');
    }
  }

  /** 修改角色时，原标识已是保留标识的也不允许改名。 */
  private assertRoleKeyNotReserved(roleKey: string): void {
    if (roleKey === SUPER_ADMIN_ROLE_KEY || roleKey === RESERVED_TENANT_ADMIN_ROLE_KEY) {
      throw new ConflictException('不允许修改系统内置管理员角色标识符');
    }
  }
}
