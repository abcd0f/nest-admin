import { isUserId } from '@app/auth';
import { PrismaService } from '@app/database';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PermissionSource, UserAuthorization } from './permission.source.js';

function isExactCode(value: string | null): value is string {
  return !!value && value === value.trim() && !value.includes('*');
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
    const roles = new Set<string>();
    const permissions = new Set<string>();
    for (const { role } of user.roles) {
      if (role.status !== '0' || role.delFlag !== '0') continue;
      if (isExactCode(role.roleKey)) roles.add(role.roleKey);
      for (const { menu } of role.menus) {
        if (
          menu.status === '0' &&
          (menu.menuType === 'C' || menu.menuType === 'F') &&
          isExactCode(menu.perms)
        ) {
          permissions.add(menu.perms);
        }
      }
    }
    return { roles: [...roles].sort(), permissions: [...permissions].sort() };
  }
}
