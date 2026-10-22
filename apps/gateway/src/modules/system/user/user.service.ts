import type { AuthenticatedUser } from '@app/auth';
import type { Prisma } from '@app/database/generated/prisma/client.js';
import { AuthService, isUserId } from '@app/auth';
import { toDto, toPageDto } from '@app/common';
import { BusinessException } from '@app/core';
import { PasswordHashService } from '@app/crypto';
import { paginate, PrismaService } from '@app/database';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
} satisfies Prisma.UserSelect;

@Injectable()
export class UserService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PasswordHashService) private readonly passwords: PasswordHashService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async findAll(query: UserQueryDto) {
    if (query.deptId !== undefined && !isUserId(query.deptId)) {
      throw BusinessException.validation([{ field: 'deptId', messages: ['部门 ID 无效'] }]);
    }
    const where: Prisma.UserWhereInput = {
      delFlag: '0',
      status: query.status,
      userName: query.userName === undefined ? undefined : { contains: query.userName },
      deptId: query.deptId === undefined ? undefined : BigInt(query.deptId),
    };
    const page = await paginate(this.prisma.user, { ...query, where });
    const roles = await this.prisma.userRole.findMany({
      where: { userId: { in: page.items.map((row) => row.userId) } },
      select: { userId: true, roleId: true },
      orderBy: { roleId: 'asc' },
    });
    return toPageDto(UserResponseDto, {
      ...page,
      items: page.items.map((row) => ({
        ...row,
        roleIds: roles.filter((role) => role.userId === row.userId).map((role) => role.roleId),
      })),
    });
  }

  async findOne(id: string) {
    if (!isUserId(id))
      throw BusinessException.validation([{ field: 'id', messages: ['用户 ID 无效'] }]);
    const row = await this.prisma.user.findFirst({
      where: { userId: BigInt(id), delFlag: '0' },
      select: userSelect,
    });
    if (!row) throw new NotFoundException('用户不存在');
    return toDto(UserResponseDto, {
      ...row,
      roleIds: row.roles.map((role) => role.roleId),
    })!;
  }

  async create(body: CreateUserDto, actor: AuthenticatedUser) {
    if (body.deptId != null && !isUserId(body.deptId)) {
      throw BusinessException.validation([{ field: 'deptId', messages: ['部门 ID 无效'] }]);
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
        return tx.user.create({
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
            createDept: actor.deptId === null ? null : BigInt(actor.deptId),
          },
          select: userSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return toDto(UserResponseDto, { ...row, roleIds: row.roles.map((role) => role.roleId) })!;
  }

  async update(id: string, body: UpdateUserDto, actor: AuthenticatedUser) {
    if (!isUserId(id))
      throw BusinessException.validation([{ field: 'id', messages: ['用户 ID 无效'] }]);
    assertNotSuperAdmin(id);
    if (body.deptId != null && !isUserId(body.deptId)) {
      throw BusinessException.validation([{ field: 'deptId', messages: ['部门 ID 无效'] }]);
    }
    const userId = BigInt(id);
    const password =
      body.password === undefined ? undefined : await this.passwords.hashPassword(body.password);
    const row = await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.user.findFirst({
          where: { userId, delFlag: '0' },
          select: { userId: true, status: true },
        });
        if (!current) throw new NotFoundException('用户不存在');
        if (id === actor.userId && body.status === '1')
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
    return toDto(UserResponseDto, { ...row, roleIds: row.roles.map((role) => role.roleId) })!;
  }

  async assignRoles(id: string, body: AssignUserRolesDto, actor: AuthenticatedUser) {
    if (!isUserId(id))
      throw BusinessException.validation([{ field: 'id', messages: ['用户 ID 无效'] }]);
    assertNotSuperAdmin(id);
    if (body.roleIds.some((roleId) => !isUserId(roleId))) {
      throw BusinessException.validation([{ field: 'roleIds', messages: ['角色 ID 无效'] }]);
    }
    const userId = BigInt(id);
    const row = await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findFirst({
          where: { userId, delFlag: '0' },
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
    return toDto(UserResponseDto, { ...row, roleIds: row.roles.map((role) => role.roleId) })!;
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    if (!isUserId(id))
      throw BusinessException.validation([{ field: 'id', messages: ['用户 ID 无效'] }]);
    assertNotSuperAdmin(id);
    const userId = BigInt(id);
    await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findFirst({
          where: { userId, delFlag: '0' },
          select: { userId: true },
        });
        if (!user) throw new NotFoundException('用户不存在');
        if (id === actor.userId) throw new ConflictException('不能删除当前用户');
        if (await tx.dept.count({ where: { leaderId: userId, delFlag: '0' } })) {
          throw new ConflictException('用户仍是部门负责人，请先更换负责人');
        }
        await tx.userRole.deleteMany({ where: { userId } });
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
}
