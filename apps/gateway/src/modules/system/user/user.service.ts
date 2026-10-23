import type { AuthenticatedUser } from '@app/auth';
import type { Prisma } from '@app/database/generated/prisma/client.js';
import { AuthService } from '@app/auth';
import { toDto, toPageDto } from '@app/common';
import { BusinessException, isBigIntId } from '@app/core';
import { PasswordHashService } from '@app/crypto';
import { paginate, PrismaService } from '@app/database';
import { isDeptInScope, loadDataScope, withDataScope } from '@app/permission';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { revokeSessions } from '../session-invalidation.js';
import { assertNotSuperAdmin } from '../super-admin.js';
import {
  AssignUserRolesDto,
  CreateUserDto,
  UpdateUserDto,
  UserQueryDto,
  UserResponseDto,
} from './dto/user.dto.js';

const userSelect = {
  userId: true,
  userName: true,
  nickName: true,
  deptId: true,
  email: true,
  phoneNumber: true,
  sex: true,
  status: true,
  remark: true,
  createTime: true,
  updateTime: true,
  roles: { select: { roleId: true }, orderBy: { roleId: 'asc' } },
  posts: { select: { postId: true }, orderBy: { postId: 'asc' } },
} satisfies Prisma.UserSelect;

/** 用户的数据归属：部门 + 创建人，对应 Java `@DataColumn(deptName→dept_id, userName→create_by)`。 */
const USER_SCOPE_COLUMNS = { dept: 'deptId', owner: 'createBy' } as const;

@Injectable()
export class UserService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PasswordHashService) private readonly passwords: PasswordHashService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async findAll(query: UserQueryDto, actor: AuthenticatedUser) {
    if (query.deptId !== undefined && !isBigIntId(query.deptId)) {
      throw BusinessException.validation([{ field: 'deptId', messages: ['部门 ID 无效'] }]);
    }
    // 数据范围按角色 dataScope 收敛到可见部门/本人，再叠加用户自己传的筛选条件。
    const where = withDataScope<Prisma.UserWhereInput>(
      {
        delFlag: '0',
        status: query.status,
        userName: query.userName === undefined ? undefined : { contains: query.userName },
        deptId: query.deptId === undefined ? undefined : BigInt(query.deptId),
      },
      await loadDataScope(this.prisma, actor),
      USER_SCOPE_COLUMNS,
    );
    const page = await paginate(this.prisma.user, { ...query, where });
    const userIds = page.items.map((row) => row.userId);
    const [roles, posts] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, roleId: true },
        orderBy: { roleId: 'asc' },
      }),
      this.prisma.userPost.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, postId: true },
        orderBy: { postId: 'asc' },
      }),
    ]);
    return toPageDto(UserResponseDto, {
      ...page,
      items: page.items.map((row) => ({
        ...row,
        roleIds: roles.filter((role) => role.userId === row.userId).map((role) => role.roleId),
        postIds: posts.filter((post) => post.userId === row.userId).map((post) => post.postId),
      })),
    });
  }

  async findOne(id: bigint, actor: AuthenticatedUser) {
    const row = await this.prisma.user.findFirst({
      // 越权访问按"不存在"处理，不区分"没有这条"和"看不到这条"。
      where: withDataScope(
        { userId: id, delFlag: '0' },
        await loadDataScope(this.prisma, actor),
        USER_SCOPE_COLUMNS,
      ),
      select: userSelect,
    });
    if (!row) throw new NotFoundException('用户不存在');
    return toDto(UserResponseDto, {
      ...row,
      roleIds: row.roles.map((role) => role.roleId),
      postIds: row.posts.map((post) => post.postId),
    })!;
  }

  async create(body: CreateUserDto, actor: AuthenticatedUser) {
    if (body.deptId != null && !isBigIntId(body.deptId)) {
      throw BusinessException.validation([{ field: 'deptId', messages: ['部门 ID 无效'] }]);
    }
    // 不能把用户建在自己看不到的部门里，否则这条记录从此既不可见也不可维护。
    if (!isDeptInScope(await loadDataScope(this.prisma, actor), body.deptId ?? null)) {
      throw new ForbiddenException('无权在目标部门创建用户');
    }
    const password = await this.passwords.hashPassword(body.password);
    const row = await this.prisma.$transaction(
      async (tx) => {
        if (await tx.user.count({ where: { userName: body.userName, delFlag: '0' } })) {
          throw new ConflictException('账号已存在');
        }
        if (body.deptId) {
          const dept = await tx.dept.findFirst({
            where: { deptId: BigInt(body.deptId), status: '0', delFlag: '0' },
            select: { deptId: true },
          });
          if (!dept) {
            throw BusinessException.validation([
              { field: 'deptId', messages: ['部门不存在、停用或已删除'] },
            ]);
          }
        }
        const created = await tx.user.create({
          data: {
            userName: body.userName,
            nickName: body.nickName,
            password,
            deptId: body.deptId ? BigInt(body.deptId) : null,
            email: body.email,
            phoneNumber: body.phoneNumber,
            sex: body.sex,
            status: body.status,
            remark: body.remark,
            createBy: BigInt(actor.userId),
          },
          select: userSelect,
        });
        // 用户刚创建，`created.posts` 必然为空，岗位以本次提交的集合为准。
        const postIds =
          body.postIds === undefined
            ? []
            : await this.replacePosts(tx, created.userId, body.postIds);
        return { row: created, postIds };
      },
      { isolationLevel: 'Serializable' },
    );
    return toDto(UserResponseDto, {
      ...row.row,
      roleIds: row.row.roles.map((role) => role.roleId),
      postIds: row.postIds,
    })!;
  }

  async update(id: bigint, body: UpdateUserDto, actor: AuthenticatedUser) {
    assertNotSuperAdmin(id);
    if (body.deptId != null && !isBigIntId(body.deptId)) {
      throw BusinessException.validation([{ field: 'deptId', messages: ['部门 ID 无效'] }]);
    }
    const userId = id;
    const scope = await loadDataScope(this.prisma, actor);
    // 移动部门同样要落在范围内，否则可以把用户推到看不见的部门里。
    if (body.deptId !== undefined && !isDeptInScope(scope, body.deptId)) {
      throw new ForbiddenException('无权把用户移动到目标部门');
    }
    const password =
      body.password === undefined ? undefined : await this.passwords.hashPassword(body.password);
    const row = await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.user.findFirst({
          where: withDataScope({ userId, delFlag: '0' }, scope, USER_SCOPE_COLUMNS),
          select: { userId: true, status: true },
        });
        if (!current) throw new NotFoundException('用户不存在');
        if (userId === BigInt(actor.userId) && body.status === '1')
          throw new ConflictException('不能停用当前用户');
        if (
          body.userName !== undefined &&
          (await tx.user.count({
            where: { userName: body.userName, delFlag: '0', userId: { not: userId } },
          }))
        ) {
          throw new ConflictException('账号已存在');
        }
        if (body.deptId) {
          const dept = await tx.dept.findFirst({
            where: { deptId: BigInt(body.deptId), status: '0', delFlag: '0' },
            select: { deptId: true },
          });
          if (!dept) {
            throw BusinessException.validation([
              { field: 'deptId', messages: ['部门不存在、停用或已删除'] },
            ]);
          }
        }
        // 先替换岗位关联，再读用户，返回体里的 posts 就是最新集合。
        if (body.postIds !== undefined) await this.replacePosts(tx, userId, body.postIds);
        const updated = await tx.user.update({
          where: { userId },
          data: {
            userName: body.userName,
            nickName: body.nickName,
            password,
            deptId:
              body.deptId === undefined
                ? undefined
                : body.deptId === null
                  ? null
                  : BigInt(body.deptId),
            email: body.email,
            phoneNumber: body.phoneNumber,
            sex: body.sex,
            status: body.status,
            remark: body.remark,
            updateBy: BigInt(actor.userId),
          },
          select: userSelect,
        });
        return updated;
      },
      { isolationLevel: 'Serializable' },
    );
    // 状态变更后旧会话里的权限快照不再可信，撤销该用户全部设备会话。
    if (body.status !== undefined) await revokeSessions(this.auth, [userId]);
    return toDto(UserResponseDto, {
      ...row,
      roleIds: row.roles.map((role) => role.roleId),
      postIds: row.posts.map((post) => post.postId),
    })!;
  }

  async assignRoles(id: bigint, body: AssignUserRolesDto, actor: AuthenticatedUser) {
    assertNotSuperAdmin(id);
    if (body.roleIds.some((roleId) => !isBigIntId(roleId))) {
      throw BusinessException.validation([{ field: 'roleIds', messages: ['角色 ID 无效'] }]);
    }
    const userId = id;
    const scope = await loadDataScope(this.prisma, actor);
    const row = await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findFirst({
          where: withDataScope({ userId, delFlag: '0' }, scope, USER_SCOPE_COLUMNS),
          select: { userId: true },
        });
        if (!user) throw new NotFoundException('用户不存在');
        const ids = [...new Set(body.roleIds)].map(BigInt);
        const roles = await tx.role.findMany({
          where: { roleId: { in: ids }, status: '0', delFlag: '0' },
          select: { roleId: true },
        });
        if (roles.length !== ids.length) {
          throw BusinessException.validation([
            { field: 'roleIds', messages: ['包含不存在、停用或已删除的角色'] },
          ]);
        }
        await tx.userRole.deleteMany({ where: { userId } });
        if (ids.length)
          await tx.userRole.createMany({ data: ids.map((roleId) => ({ userId, roleId })) });
        return tx.user.update({
          where: { userId },
          data: { updateBy: BigInt(actor.userId) },
          select: userSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
    // 角色集合变了，快照必须作废；用户下次登录才会拿到新权限。
    await revokeSessions(this.auth, [userId]);
    return toDto(UserResponseDto, {
      ...row,
      roleIds: row.roles.map((role) => role.roleId),
      postIds: row.posts.map((post) => post.postId),
    })!;
  }

  async remove(id: bigint, actor: AuthenticatedUser): Promise<void> {
    assertNotSuperAdmin(id);
    const userId = id;
    const scope = await loadDataScope(this.prisma, actor);
    await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findFirst({
          where: withDataScope({ userId, delFlag: '0' }, scope, USER_SCOPE_COLUMNS),
          select: { userId: true },
        });
        if (!user) throw new NotFoundException('用户不存在');
        if (userId === BigInt(actor.userId)) throw new ConflictException('不能删除当前用户');
        if (await tx.dept.count({ where: { leaderId: userId, delFlag: '0' } })) {
          throw new ConflictException('用户仍是部门负责人，请先更换负责人');
        }
        await tx.userRole.deleteMany({ where: { userId } });
        await tx.userPost.deleteMany({ where: { userId } });
        await tx.user.update({
          where: { userId },
          data: { delFlag: '2', updateBy: BigInt(actor.userId) },
        });
      },
      { isolationLevel: 'Serializable' },
    );
    // 用户已逻辑删除，残留会话必须立即失效。
    await revokeSessions(this.auth, [userId]);
  }

  /**
   * 完整替换用户的岗位关联，返回去重后的岗位 ID。
   *
   * 与分配角色不同，岗位在用户创建/更新时一起提交（对齐 Java `SysUserBo.postIds`），
   * 不单独开接口。岗位必须存在、启用且未删除，否则整笔事务回滚。
   */
  private async replacePosts(
    tx: Prisma.TransactionClient,
    userId: bigint,
    postIds: readonly string[],
  ): Promise<string[]> {
    const ids = [...new Set(postIds)].map(BigInt);
    if (ids.length) {
      const posts = await tx.post.findMany({
        where: { postId: { in: ids }, status: '0', delFlag: '0' },
        select: { postId: true },
      });
      if (posts.length !== ids.length) {
        throw BusinessException.validation([
          { field: 'postIds', messages: ['包含不存在、停用或已删除的岗位'] },
        ]);
      }
    }
    await tx.userPost.deleteMany({ where: { userId } });
    if (ids.length) {
      await tx.userPost.createMany({ data: ids.map((postId) => ({ userId, postId })) });
    }
    return ids.map(String);
  }
}
