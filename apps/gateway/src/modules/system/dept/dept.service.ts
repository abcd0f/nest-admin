import type { AuthenticatedUser } from '@app/auth';
import type { Prisma } from '@app/database/generated/prisma/client.js';
import { isUserId } from '@app/auth';
import { toDto, toDtoList, toTree } from '@app/common';
import { BusinessException } from '@app/core';
import { PrismaService } from '@app/database';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CreateDeptDto, DeptResponseDto, DeptTreeDto, UpdateDeptDto } from './dto/dept.dto.js';

const deptSelect = {
  deptId: true,
  parentId: true,
  ancestors: true,
  deptName: true,
  orderNum: true,
  leaderId: true,
  status: true,
  remark: true,
  createTime: true,
  updateTime: true,
} satisfies Prisma.DeptSelect;

function checkedPath(ids: bigint[]): string {
  const path = `/${ids.join('/')}/`;
  if (path.length > 512) {
    throw BusinessException.validation([
      { field: 'parentId', messages: ['部门层级路径超过 512 字符'] },
    ]);
  }
  return path;
}

@Injectable()
export class DeptService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findAll(): Promise<DeptTreeDto[]> {
    const rows = await this.prisma.dept.findMany({
      where: { delFlag: '0' },
      select: deptSelect,
      orderBy: [{ orderNum: 'asc' }, { deptId: 'asc' }],
    });
    const nodes = toDtoList(
      DeptTreeDto,
      rows.map((row) => ({ ...row, children: [] })),
    );
    try {
      return toTree(nodes, (node) => node.deptId);
    } catch (cause) {
      throw new ConflictException('树存在缺失父节点或循环，请先修复数据', { cause });
    }
  }

  async findOne(id: string) {
    if (!isUserId(id))
      throw BusinessException.validation([{ field: 'id', messages: ['部门 ID 无效'] }]);
    const row = await this.prisma.dept.findFirst({
      where: { deptId: BigInt(id), delFlag: '0' },
      select: deptSelect,
    });
    if (!row) throw new NotFoundException('部门不存在');
    return toDto(DeptResponseDto, row)!;
  }

  async create(body: CreateDeptDto, actor: AuthenticatedUser) {
    if (body.parentId !== undefined && body.parentId !== '0' && !isUserId(body.parentId)) {
      throw BusinessException.validation([{ field: 'parentId', messages: ['父部门 ID 无效'] }]);
    }
    if (body.leaderId != null && !isUserId(body.leaderId)) {
      throw BusinessException.validation([{ field: 'leaderId', messages: ['负责人 ID 无效'] }]);
    }
    const row = await this.prisma.$transaction(
      async (tx) => {
        const parentId = BigInt(body.parentId ?? '0');
        const nodes = await tx.dept.findMany({
          where: { delFlag: '0' },
          select: { deptId: true, parentId: true, status: true },
        });
        const parents = this.checkParents(nodes, parentId);
        if (body.leaderId) {
          const leader = await tx.user.findFirst({
            where: { userId: BigInt(body.leaderId), status: '0', delFlag: '0' },
            select: { userId: true },
          });
          if (!leader) {
            throw BusinessException.validation([
              { field: 'leaderId', messages: ['负责人必须是启用且未删除的用户'] },
            ]);
          }
        }
        const created = await tx.dept.create({
          data: {
            parentId,
            deptName: body.deptName,
            orderNum: body.orderNum,
            leaderId: body.leaderId ? BigInt(body.leaderId) : null,
            status: body.status,
            remark: body.remark,
            createBy: BigInt(actor.userId),
          },
          select: { deptId: true },
        });
        return tx.dept.update({
          where: { deptId: created.deptId },
          data: { ancestors: checkedPath([...parents, created.deptId]) },
          select: deptSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return toDto(DeptResponseDto, row)!;
  }

  async update(id: string, body: UpdateDeptDto, actor: AuthenticatedUser) {
    if (!isUserId(id))
      throw BusinessException.validation([{ field: 'id', messages: ['部门 ID 无效'] }]);
    if (body.parentId !== undefined && body.parentId !== '0' && !isUserId(body.parentId)) {
      throw BusinessException.validation([{ field: 'parentId', messages: ['父部门 ID 无效'] }]);
    }
    if (body.leaderId != null && !isUserId(body.leaderId)) {
      throw BusinessException.validation([{ field: 'leaderId', messages: ['负责人 ID 无效'] }]);
    }
    const deptId = BigInt(id);
    const row = await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.dept.findFirst({
          where: { deptId, delFlag: '0' },
          select: deptSelect,
        });
        if (!current) throw new NotFoundException('部门不存在');
        if (body.leaderId) {
          const leader = await tx.user.findFirst({
            where: { userId: BigInt(body.leaderId), status: '0', delFlag: '0' },
            select: { userId: true },
          });
          if (!leader) {
            throw BusinessException.validation([
              { field: 'leaderId', messages: ['负责人必须是启用且未删除的用户'] },
            ]);
          }
        }
        const paths = new Map<bigint, string>();
        if (body.parentId !== undefined || body.status === '0') {
          const nodes = await tx.dept.findMany({
            where: { delFlag: '0' },
            select: { deptId: true, parentId: true, status: true },
          });
          const parents = this.checkParents(
            nodes,
            body.parentId === undefined ? current.parentId : BigInt(body.parentId),
            deptId,
          );
          if (body.parentId !== undefined) {
            const queue = [{ id: deptId, ids: [...parents, deptId] }];
            for (let i = 0; i < queue.length; i++) {
              const node = queue[i];
              if (paths.has(node.id)) throw new ConflictException('部门树存在循环');
              paths.set(node.id, checkedPath(node.ids));
              for (const child of nodes.filter((child) => child.parentId === node.id)) {
                queue.push({ id: child.deptId, ids: [...node.ids, child.deptId] });
              }
            }
          }
        }
        const audit = { updateBy: BigInt(actor.userId) };
        const updated = await tx.dept.update({
          where: { deptId },
          data: {
            parentId: body.parentId === undefined ? undefined : BigInt(body.parentId),
            ancestors: paths.get(deptId),
            deptName: body.deptName,
            orderNum: body.orderNum,
            leaderId:
              body.leaderId === undefined
                ? undefined
                : body.leaderId === null
                  ? null
                  : BigInt(body.leaderId),
            status: body.status,
            remark: body.remark,
            ...audit,
          },
          select: deptSelect,
        });
        for (const [childId, ancestors] of paths) {
          if (childId !== deptId)
            await tx.dept.update({ where: { deptId: childId }, data: { ancestors, ...audit } });
        }
        return updated;
      },
      { isolationLevel: 'Serializable' },
    );
    return toDto(DeptResponseDto, row)!;
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    if (!isUserId(id))
      throw BusinessException.validation([{ field: 'id', messages: ['部门 ID 无效'] }]);
    const deptId = BigInt(id);
    await this.prisma.$transaction(
      async (tx) => {
        const dept = await tx.dept.findFirst({
          where: { deptId, delFlag: '0' },
          select: { deptId: true },
        });
        if (!dept) throw new NotFoundException('部门不存在');
        if (await tx.dept.count({ where: { parentId: deptId, delFlag: '0' } }))
          throw new ConflictException('部门仍有未删除子部门');
        if (await tx.user.count({ where: { deptId, delFlag: '0' } }))
          throw new ConflictException('部门仍被用户引用');
        if (await tx.roleDept.count({ where: { deptId } }))
          throw new ConflictException('部门仍被角色数据范围引用');
        await tx.dept.update({
          where: { deptId },
          data: { delFlag: '2', updateBy: BigInt(actor.userId) },
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private checkParents(
    nodes: { deptId: bigint; parentId: bigint; status: string }[],
    parentId: bigint,
    movingId?: bigint,
  ): bigint[] {
    const byId = new Map(nodes.map((node) => [node.deptId, node]));
    const seen = new Set<bigint>(movingId === undefined ? [] : [movingId]);
    const path: bigint[] = [];
    let current = parentId;
    while (current !== 0n) {
      if (seen.has(current))
        throw new ConflictException('父节点不能是自身或后代，父链不能包含循环');
      seen.add(current);
      const node = byId.get(current);
      if (!node || node.status !== '0') {
        throw BusinessException.validation([
          { field: 'parentId', messages: ['父节点及其祖先必须存在且启用'] },
        ]);
      }
      path.unshift(current);
      current = node.parentId;
    }
    return path;
  }
}
