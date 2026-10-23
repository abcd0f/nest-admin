import type { AuthenticatedUser } from '@app/auth';
import type { Prisma } from '@app/database/generated/prisma/client.js';
import { toDto, toDtoList, toPageDto } from '@app/common';
import { BusinessException, isBigIntId } from '@app/core';
import { paginate, PrismaService } from '@app/database';
import { isDeptInScope, loadDataScope, withDataScope } from '@app/permission';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CreatePostDto,
  PostOptionDto,
  PostQueryDto,
  PostResponseDto,
  UpdatePostDto,
} from './dto/post.dto.js';

const postSelect = {
  postId: true,
  deptId: true,
  postCode: true,
  postName: true,
  orderNum: true,
  status: true,
  remark: true,
  createTime: true,
  updateTime: true,
} satisfies Prisma.PostSelect;

/** 岗位的数据归属：所属部门 + 创建人，对应 Java `SysPostMapper` 的 `dept_id` / `create_by`。 */
const POST_SCOPE_COLUMNS = { dept: 'deptId', owner: 'createBy' } as const;

/**
 * 岗位管理。
 *
 * 对齐 RuoYi-Vue-Plus 的 `SysPostServiceImpl`，差异：
 * - Java 物理删除（`sys_post` 无 `del_flag`），这里沿用本项目的逻辑删除，写 `delFlag='2'`；
 * - Java 的 `post_category` 字段本项目没有，未实现；
 * - Java 用 `post_sort` 排序，这里字段名统一为 `orderNum`。
 */
@Injectable()
export class PostService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findAll(query: PostQueryDto, actor: AuthenticatedUser) {
    if (query.deptId !== undefined && !isBigIntId(query.deptId)) {
      throw BusinessException.validation('部门 ID 无效');
    }
    const where = withDataScope<Prisma.PostWhereInput>(
      {
        delFlag: '0',
        postCode: query.postCode === undefined ? undefined : { contains: query.postCode },
        postName: query.postName === undefined ? undefined : { contains: query.postName },
        status: query.status,
        deptId: query.deptId === undefined ? undefined : BigInt(query.deptId),
      },
      await loadDataScope(this.prisma, actor),
      POST_SCOPE_COLUMNS,
    );
    return toPageDto(PostResponseDto, await paginate(this.prisma.post, { ...query, where }));
  }

  async findOne(id: bigint, actor: AuthenticatedUser) {
    const row = await this.prisma.post.findFirst({
      // 范围外按"不存在"处理，不泄露岗位是否存在。
      where: withDataScope(
        { postId: id, delFlag: '0' },
        await loadDataScope(this.prisma, actor),
        POST_SCOPE_COLUMNS,
      ),
      select: postSelect,
    });
    if (!row) throw new NotFoundException('岗位不存在');
    return toDto(PostResponseDto, row)!;
  }

  /** 岗位下拉：只返回启用且未删除的岗位，可限定部门。 */
  async options(deptId: string | undefined, actor: AuthenticatedUser): Promise<PostOptionDto[]> {
    if (deptId !== undefined && !isBigIntId(deptId)) {
      throw BusinessException.validation('部门 ID 无效');
    }
    const rows = await this.prisma.post.findMany({
      where: withDataScope<Prisma.PostWhereInput>(
        {
          delFlag: '0',
          status: '0',
          deptId: deptId === undefined ? undefined : BigInt(deptId),
        },
        await loadDataScope(this.prisma, actor),
        POST_SCOPE_COLUMNS,
      ),
      select: { postId: true, postCode: true, postName: true },
      orderBy: [{ orderNum: 'asc' }, { postId: 'asc' }],
    });
    return toDtoList(PostOptionDto, rows);
  }

  async create(body: CreatePostDto, actor: AuthenticatedUser) {
    if (body.deptId !== undefined && !isBigIntId(body.deptId))
      throw BusinessException.validation('部门 ID 无效');
    // 表单不带部门时落到当前用户部门：前端岗位表单没有部门字段，左侧部门树只做筛选。
    const target = body.deptId ?? actor.deptId;
    if (target === null) {
      throw BusinessException.validation('当前用户没有所属部门，无法确定岗位归属');
    }
    const deptId = BigInt(target);
    // 岗位归属部门必须在当前范围内，否则创建者自己看不到这个岗位。
    if (!isDeptInScope(await loadDataScope(this.prisma, actor), target)) {
      throw new ForbiddenException('无权在目标部门创建岗位');
    }
    const row = await this.prisma.$transaction(
      async (tx) => {
        await this.assertDept(tx, deptId);
        if (await tx.post.count({ where: { postCode: body.postCode, delFlag: '0' } })) {
          throw new ConflictException('岗位编码已存在');
        }
        if (await tx.post.count({ where: { postName: body.postName, deptId, delFlag: '0' } })) {
          throw new ConflictException('该部门下岗位名称已存在');
        }
        return tx.post.create({
          data: {
            deptId,
            postCode: body.postCode,
            postName: body.postName,
            orderNum: body.orderNum,
            status: body.status,
            remark: body.remark,
            createBy: BigInt(actor.userId),
          },
          select: postSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return toDto(PostResponseDto, row)!;
  }

  async update(id: bigint, body: UpdatePostDto, actor: AuthenticatedUser) {
    if (body.deptId !== undefined && !isBigIntId(body.deptId))
      throw BusinessException.validation('部门 ID 无效');
    const postId = id;
    const scope = await loadDataScope(this.prisma, actor);
    if (body.deptId !== undefined && !isDeptInScope(scope, body.deptId)) {
      throw new ForbiddenException('无权把岗位移动到目标部门');
    }
    const row = await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.post.findFirst({
          where: withDataScope({ postId, delFlag: '0' }, scope, POST_SCOPE_COLUMNS),
          select: { postId: true, deptId: true },
        });
        if (!current) throw new NotFoundException('岗位不存在');
        const deptId = body.deptId === undefined ? current.deptId : BigInt(body.deptId);
        if (body.deptId !== undefined) await this.assertDept(tx, BigInt(body.deptId));
        // 停用前确认没有在用岗位的用户，否则这些用户的岗位会指向一个停用岗位。
        if (body.status === '1' && (await tx.userPost.count({ where: { postId } }))) {
          throw new ConflictException('岗位已分配用户，不能停用');
        }
        if (
          body.postCode !== undefined &&
          (await tx.post.count({
            where: { postCode: body.postCode, delFlag: '0', postId: { not: postId } },
          }))
        ) {
          throw new ConflictException('岗位编码已存在');
        }
        if (
          body.postName !== undefined &&
          (await tx.post.count({
            where: { postName: body.postName, deptId, delFlag: '0', postId: { not: postId } },
          }))
        ) {
          throw new ConflictException('该部门下岗位名称已存在');
        }
        return tx.post.update({
          where: { postId },
          data: {
            deptId: body.deptId === undefined ? undefined : BigInt(body.deptId),
            postCode: body.postCode,
            postName: body.postName,
            orderNum: body.orderNum,
            status: body.status,
            remark: body.remark,
            updateBy: BigInt(actor.userId),
          },
          select: postSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return toDto(PostResponseDto, row)!;
  }

  async remove(id: bigint, actor: AuthenticatedUser): Promise<void> {
    const postId = id;
    const scope = await loadDataScope(this.prisma, actor);
    await this.prisma.$transaction(
      async (tx) => {
        const post = await tx.post.findFirst({
          where: withDataScope({ postId, delFlag: '0' }, scope, POST_SCOPE_COLUMNS),
          select: { postId: true },
        });
        if (!post) throw new NotFoundException('岗位不存在');
        if (await tx.userPost.count({ where: { postId } }))
          throw new ConflictException('岗位已分配用户，不能删除');
        await tx.post.update({
          where: { postId },
          data: { delFlag: '2', updateBy: BigInt(actor.userId) },
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  /** 目标部门必须存在、启用且未删除；Java 侧由 `dept_id` 非空约束和业务校验共同保证。 */
  private async assertDept(tx: Prisma.TransactionClient, deptId: bigint): Promise<void> {
    const dept = await tx.dept.findFirst({
      where: { deptId, status: '0', delFlag: '0' },
      select: { deptId: true },
    });
    if (!dept) {
      throw BusinessException.validation('部门不存在、停用或已删除');
    }
  }
}
