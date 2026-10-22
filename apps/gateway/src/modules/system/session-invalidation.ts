import type { AuthService } from '@app/auth';
import type { PrismaService } from '@app/database';
import { Logger } from '@nestjs/common';

const logger = new Logger('SessionInvalidation');

/**
 * 批量撤销指定用户的全部会话。
 *
 * 权限快照存在会话里，所以任何影响授权的写操作提交后都必须调用本方法，
 * 否则旧权限会一直生效到会话过期。对应 RuoYi `cleanOnlineUser` / `cleanOnlineUserByRole`。
 *
 * 业务事务已经提交，踢人失败不能回滚数据，也不应让调用方看到 500 后重试；
 * 因此只记录告警。残留会话会在下次权限校验时继续使用旧快照，直到过期或再次被撤销。
 */
export async function revokeSessions(
  auth: AuthService,
  userIds: Iterable<bigint>,
): Promise<void> {
  for (const userId of new Set(userIds)) {
    try {
      await auth.revokeUserSessions(String(userId));
    } catch {
      logger.warn(`撤销用户 ${String(userId)} 的会话失败，旧权限可能继续生效直到会话过期`);
    }
  }
}

/** 角色下的全部用户；角色菜单、状态或标识变更后需要让这些用户重新登录。 */
export async function usersOfRole(
  prisma: PrismaService,
  roleId: bigint,
): Promise<bigint[]> {
  const rows = await prisma.userRole.findMany({ where: { roleId }, select: { userId: true } });
  return rows.map((row) => row.userId);
}

/** 引用某个菜单的全部用户（菜单 → 角色 → 用户）。 */
export async function usersOfMenu(
  prisma: PrismaService,
  menuId: bigint,
): Promise<bigint[]> {
  const roles = await prisma.roleMenu.findMany({ where: { menuId }, select: { roleId: true } });
  if (!roles.length) return [];
  const rows = await prisma.userRole.findMany({
    where: { roleId: { in: roles.map((row) => row.roleId) } },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}
