import { isUserId } from '@app/auth';
import { PrismaService } from '@app/database';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ALL_PERMISSION,
  isSuperAdmin,
  SUPER_ADMIN_ROLE_KEY,
} from './permission.constants.js';
import { PermissionSource, UserAuthorization } from './permission.source.js';

/** 角色标识保持精确语义：不允许用 `*` 冒充角色，避免角色兜底被通配放大。 */
function isRoleKey(value: string | null): value is string {
  return !!value && value === value.trim() && !value.includes('*');
}

/** 权限码允许含 `*`，按 Sa-Token 模糊匹配语义解释；但仍拒绝空值和首尾空白。 */
function isPermissionCode(value: string | null): value is string {
  return !!value && value === value.trim();
}

@Injectable()
export class PrismaPermissionSource extends PermissionSource {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async getAuthorization(userId: string): Promise<UserAuthorization> {
    if (!isUserId(userId)) throw new UnauthorizedException('未认证');
    let user;
    try {
      user = await this.prisma.user.findUnique({
        where: { userId: BigInt(userId) },
        select: {
          status: true,
          delFlag: true,
          roles: {
            select: {
              role: {
                select: {
                  roleKey: true,
                  status: true,
                  delFlag: true,
                  menus: {
                    select: {
                      menu: { select: { status: true, menuType: true, perms: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
    } catch (cause) {
      throw new ServiceUnavailableException('权限服务不可用', { cause });
    }
    if (!user || user.status !== '0' || user.delFlag !== '0') {
      throw new UnauthorizedException('未认证');
    }
    // 超级管理员直接持有全部权限，不读取角色菜单关联。
    // 对应 SysPermissionServiceImpl.getRolePermission / getMenuPermission 的超管分支。
    // 仍先校验用户有效性，避免停用或删除后的 1 号用户继续通过鉴权。
    if (isSuperAdmin(userId)) {
      return { roles: [SUPER_ADMIN_ROLE_KEY], permissions: [ALL_PERMISSION] };
    }
    const roles = new Set<string>();
    const permissions = new Set<string>();
    for (const { role } of user.roles) {
      if (role.status !== '0' || role.delFlag !== '0') continue;
      if (isRoleKey(role.roleKey)) roles.add(role.roleKey);
      for (const { menu } of role.menus) {
        if (
          menu.status === '0' &&
          (menu.menuType === 'C' || menu.menuType === 'F') &&
          isPermissionCode(menu.perms)
        ) {
          permissions.add(menu.perms);
        }
      }
    }
    return { roles: [...roles].sort(), permissions: [...permissions].sort() };
  }
}
