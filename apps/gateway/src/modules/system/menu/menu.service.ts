import type { AuthenticatedUser } from '@app/auth';
import type { Prisma } from '@app/database/generated/prisma/client.js';
import { AuthService } from '@app/auth';
import { toDto, toDtoList, toTree } from '@app/common';
import { BusinessException, isBigIntId } from '@app/core';
import { PrismaService } from '@app/database';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CreateMenuDto, MenuResponseDto, MenuTreeDto, UpdateMenuDto } from './dto/menu.dto.js';

const menuSelect = {
  menuId: true,
  parentId: true,
  menuName: true,
  menuType: true,
  orderNum: true,
  path: true,
  component: true,
  query: true,
  isFrame: true,
  isCache: true,
  visible: true,
  status: true,
  perms: true,
  icon: true,
  remark: true,
  createTime: true,
  updateTime: true,
} satisfies Prisma.MenuSelect;

function checkType(type: string, parentType?: string) {
  if (type === 'F' ? parentType !== 'C' : parentType !== undefined && parentType !== 'M') {
    throw BusinessException.validation('目录/菜单只能属于目录，按钮必须属于菜单且不能作为父节点');
  }
}

function checkPerms(type: string, perms: string | null | undefined) {
  if (type === 'F' && !perms) {
    throw BusinessException.validation('按钮必须指定操作权限码');
  }
  if (type === 'M' && perms) {
    throw BusinessException.validation('目录不能指定操作权限码');
  }
}

@Injectable()
export class MenuService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async findAll(): Promise<MenuTreeDto[]> {
    const rows = await this.prisma.menu.findMany({
      select: menuSelect,
      orderBy: [{ orderNum: 'asc' }, { menuId: 'asc' }],
    });
    const nodes = toDtoList(
      MenuTreeDto,
      rows.map((row) => ({ ...row, children: [] })),
    );
    try {
      return toTree(nodes, (node) => node.menuId);
    } catch (cause) {
      throw new ConflictException('树存在缺失父节点或循环，请先修复数据', { cause });
    }
  }

  async findOne(id: bigint) {
    const row = await this.prisma.menu.findUnique({
      where: { menuId: id },
      select: menuSelect,
    });
    if (!row) throw new NotFoundException('菜单不存在');
    return toDto(MenuResponseDto, row)!;
  }

  async create(body: CreateMenuDto, actor: AuthenticatedUser) {
    if (body.parentId !== undefined && body.parentId !== '0' && !isBigIntId(body.parentId)) {
      throw BusinessException.validation('父菜单 ID 无效');
    }
    const row = await this.prisma.$transaction(
      async (tx) => {
        const parentId = BigInt(body.parentId ?? '0');
        const nodes = await tx.menu.findMany({
          select: { menuId: true, parentId: true, menuType: true, status: true },
        });
        this.checkParents(nodes, parentId);
        checkType(body.menuType, nodes.find((node) => node.menuId === parentId)?.menuType);
        checkPerms(body.menuType, body.perms);
        return tx.menu.create({
          data: {
            parentId,
            menuName: body.menuName,
            menuType: body.menuType,
            orderNum: body.orderNum,
            path: body.path,
            component: body.component,
            query: body.query,
            isFrame: body.isFrame,
            isCache: body.isCache,
            visible: body.visible,
            status: body.status,
            perms: body.perms,
            icon: body.icon,
            remark: body.remark,
            createBy: BigInt(actor.userId),
          },
          select: menuSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return toDto(MenuResponseDto, row)!;
  }

  async update(id: bigint, body: UpdateMenuDto, actor: AuthenticatedUser) {
    if (body.parentId !== undefined && body.parentId !== '0' && !isBigIntId(body.parentId)) {
      throw BusinessException.validation('父菜单 ID 无效');
    }
    const menuId = id;
    const row = await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.menu.findUnique({ where: { menuId }, select: menuSelect });
        if (!current) throw new NotFoundException('菜单不存在');
        const parentId = body.parentId === undefined ? current.parentId : BigInt(body.parentId);
        const type = body.menuType ?? current.menuType;
        const perms = body.perms === undefined ? current.perms : body.perms;
        const nodes = await tx.menu.findMany({
          select: { menuId: true, parentId: true, menuType: true, status: true },
        });
        if (body.parentId !== undefined || body.status === '0')
          this.checkParents(nodes, parentId, menuId);
        checkType(type, nodes.find((node) => node.menuId === parentId)?.menuType);
        checkPerms(type, perms);
        for (const child of nodes.filter((node) => node.parentId === menuId))
          checkType(child.menuType, type);
        const updated = await tx.menu.update({
          where: { menuId },
          data: {
            parentId,
            menuType: type,
            menuName: body.menuName,
            orderNum: body.orderNum,
            path: body.path,
            component: body.component,
            query: body.query,
            isFrame: body.isFrame,
            isCache: body.isCache,
            visible: body.visible,
            status: body.status,
            perms: body.perms,
            icon: body.icon,
            remark: body.remark,
            updateBy: BigInt(actor.userId),
          },
          select: menuSelect,
        });
        return updated;
      },
      { isolationLevel: 'Serializable' },
    );
    // 菜单状态或权限码变了，引用它的角色下所有用户的快照作废。
    if (body.status !== undefined || body.perms !== undefined) {
      await this.auth.revokeSessionsOf(await this.usersOfMenu(menuId));
    }
    return toDto(MenuResponseDto, row)!;
  }

  async remove(id: bigint): Promise<void> {
    const menuId = id;
    await this.prisma.$transaction(
      async (tx) => {
        const menu = await tx.menu.findUnique({ where: { menuId }, select: { menuId: true } });
        if (!menu) throw new NotFoundException('菜单不存在');
        if (await tx.menu.count({ where: { parentId: menuId } }))
          throw new ConflictException('菜单仍有子节点');
        if (await tx.roleMenu.count({ where: { menuId } }))
          throw new ConflictException('菜单仍被角色引用，请先解除关联');
        await tx.menu.delete({ where: { menuId } });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private checkParents(
    nodes: { menuId: bigint; parentId: bigint; status: string }[],
    parentId: bigint,
    movingId?: bigint,
  ): void {
    const byId = new Map(nodes.map((node) => [node.menuId, node]));
    const seen = new Set<bigint>(movingId === undefined ? [] : [movingId]);
    let current = parentId;
    while (current !== 0n) {
      if (seen.has(current))
        throw new ConflictException('父节点不能是自身或后代，父链不能包含循环');
      seen.add(current);
      const node = byId.get(current);
      if (!node || node.status !== '0') {
        throw BusinessException.validation('父节点及其祖先必须存在且启用');
      }
      current = node.parentId;
    }
  }

  /** 引用某个菜单的全部用户（菜单 → 角色 → 用户）。 */
  private async usersOfMenu(menuId: bigint): Promise<bigint[]> {
    const roles = await this.prisma.roleMenu.findMany({ where: { menuId }, select: { roleId: true } });
    if (!roles.length) return [];
    const rows = await this.prisma.userRole.findMany({
      where: { roleId: { in: roles.map((row) => row.roleId) } },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }
}
