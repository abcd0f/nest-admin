import type { AuthenticatedUser } from '@app/auth';
import type { Prisma } from '@app/database/generated/prisma/client.js';
import { toDto, toDtoList, toTree } from '@app/common';
import { BusinessException, isBigIntId } from '@app/core';
import { PrismaService } from '@app/database';
import { isDeptInScope, loadDataScope, withDataScope } from '@app/permission';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

/** 部门的数据归属：部门自身 + 创建人。 */
const DEPT_SCOPE_COLUMNS = { dept: 'deptId', owner: 'createBy' } as const;

function checkedPath(ids: bigint[]): string {
  const path = `/${ids.join('/')}/`;
  if (path.length > 512) {
    throw BusinessException.validation('部门层级路径超过 512 字符');
  }
  return path;
}

@Injectable()
export class DeptService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findAll(actor: AuthenticatedUser): Promise<DeptTreeDto[]> {
    const filter = await loadDataScope(this.prisma, actor);
    const rows = await this.prisma.dept.findMany({
      where: withDataScope({ delFlag: '0' }, filter, DEPT_SCOPE_COLUMNS),
      select: deptSelect,
      orderBy: [{ orderNum: 'asc' }, { deptId: 'asc' }],
    });
    const nodes = toDtoList(
      DeptTreeDto,
      rows.map((row) => ({ ...row, children: [] })),
    );
    // 范围过滤可能把父部门裁掉。此时把可见节点挂到根上，否则 toTree 会当成数据损坏。
    // 未受范围限制时保持原样，缺父节点仍然是真实的数据问题，必须报错。
    if (filter.kind !== 'all') {
      const visible = new Set(nodes.map((node) => node.deptId));
      for (const node of nodes) {
        if (node.parentId !== '0' && !visible.has(node.parentId)) node.parentId = '0';
      }
    }
    try {
      return toTree(nodes, (node) => node.deptId);
    } catch (cause) {
      throw new ConflictException('树存在缺失父节点或循环，请先修复数据', { cause });
    }
  }

  async findOne(id: bigint, actor: AuthenticatedUser) {
    const row = await this.prisma.dept.findFirst({
      where: withDataScope(
        { deptId: id, delFlag: '0' },
        await loadDataScope(this.prisma, actor),
        DEPT_SCOPE_COLUMNS,
      ),
      select: deptSelect,
    });
    if (!row) throw new NotFoundException('部门不存在');
    return toDto(DeptResponseDto, row)!;
  }

  async create(body: CreateDeptDto, actor: AuthenticatedUser) {
    if (body.parentId !== undefined && body.parentId !== '0' && !isBigIntId(body.parentId)) {
      throw BusinessException.validation('父部门 ID 无效');
    }
    if (body.leaderId != null && !isBigIntId(body.leaderId)) {
      throw BusinessException.validation('负责人 ID 无效');
    }
    // 父部门必须在当前范围内：否则会造出自己看不见的部门子树。
    if (!isDeptInScope(await loadDataScope(this.prisma, actor), body.parentId ?? '0')) {
      throw new ForbiddenException('无权在目标父部门下创建部门');
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
            throw BusinessException.validation('负责人必须是启用且未删除的用户');
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

  async update(id: bigint, body: UpdateDeptDto, actor: AuthenticatedUser) {
    if (body.parentId !== undefined && body.parentId !== '0' && !isBigIntId(body.parentId)) {
      throw BusinessException.validation('父部门 ID 无效');
    }
    if (body.leaderId != null && !isBigIntId(body.leaderId)) {
      throw BusinessException.validation('负责人 ID 无效');
    }
    const deptId = id;
    const scope = await loadDataScope(this.prisma, actor);
    // 换父部门也要在范围内，否则可以把部门子树整体挪到自己看不见的位置。
    if (body.parentId !== undefined && !isDeptInScope(scope, body.parentId)) {
      throw new ForbiddenException('无权把部门移动到目标父部门');
    }
    const row = await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.dept.findFirst({
          where: withDataScope({ deptId, delFlag: '0' }, scope, DEPT_SCOPE_COLUMNS),
          select: deptSelect,
        });
        if (!current) throw new NotFoundException('部门不存在');
        if (body.leaderId) {
          const leader = await tx.user.findFirst({
            where: { userId: BigInt(body.leaderId), status: '0', delFlag: '0' },
            select: { userId: true },
          });
          if (!leader) {
            throw BusinessException.validation('负责人必须是启用且未删除的用户');
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

  async remove(id: bigint, actor: AuthenticatedUser): Promise<void> {
    const deptId = id;
    const scope = await loadDataScope(this.prisma, actor);
    await this.prisma.$transaction(
      async (tx) => {
        const dept = await tx.dept.findFirst({
          where: withDataScope({ deptId, delFlag: '0' }, scope, DEPT_SCOPE_COLUMNS),
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
        throw BusinessException.validation('父节点及其祖先必须存在且启用');
      }
      path.unshift(current);
      current = node.parentId;
    }
    return path;
  }
}
