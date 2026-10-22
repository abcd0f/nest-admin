import type { Prisma } from '@app/database/generated/prisma/client.js';
import { ConflictException } from '@nestjs/common';

const managementPermissions = [
  ...['user', 'role', 'menu', 'dept'].flatMap((resource) =>
    ['list', 'query', 'add', 'edit', 'delete'].map((action) => `system:${resource}:${action}`),
  ),
  'system:user:assignRoles',
  'system:role:assignMenus',
  'system:role:dataScope',
];

export async function hasActiveAdministrator(tx: Prisma.TransactionClient): Promise<boolean> {
  const users = await tx.user.findMany({
    where: { status: '0', delFlag: '0' },
    select: {
      roles: {
        where: { role: { status: '0', delFlag: '0' } },
        select: {
          role: {
            select: {
              menus: {
                where: { menu: { status: '0', menuType: { in: ['C', 'F'] } } },
                select: { menu: { select: { perms: true } } },
              },
            },
          },
        },
      },
    },
  });

  return users.some((user) => {
    const permissions = new Set(
      user.roles.flatMap(({ role }) => role.menus.map(({ menu }) => menu.perms)),
    );
    return managementPermissions.every((permission) => permissions.has(permission));
  });
}

export async function ensureAdministratorRemains(
  tx: Prisma.TransactionClient,
  hadAdministrator: boolean,
): Promise<void> {
  if (hadAdministrator && !(await hasActiveAdministrator(tx))) {
    throw new ConflictException('不能移除最后一位有效管理员的管理权限');
  }
}
