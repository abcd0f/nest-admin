import type { AuthenticatedUser } from '@app/auth';
import type { OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuthService } from '@app/auth';
import { PasswordHashService } from '@app/crypto';
import { PrismaService } from '@app/database';
import { PermissionService } from '@app/permission';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthMenuDto, LoginDto, LoginResponseDto, ProfileResponseDto } from './dto/auth.dto.js';

@Injectable()
export class SystemAuthService implements OnModuleInit {
  private dummyPasswordHash!: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PasswordHashService) private readonly passwords: PasswordHashService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
  ) {}

  async onModuleInit(): Promise<void> {
    // 无匹配账号也执行同参数的 Argon2id 校验，避免通过快速失败枚举账号。
    this.dummyPasswordHash = await this.passwords.hashPassword(randomBytes(32).toString('hex'));
  }

  async login(body: LoginDto, ip: string): Promise<LoginResponseDto> {
    let users;
    try {
      // 账号名没有唯一约束；不得任取一条同名账号登录。
      users = await this.prisma.user.findMany({
        where: { userName: body.userName, delFlag: '0' },
        take: 2,
        orderBy: { userId: 'asc' },
        select: {
          userId: true,
          userName: true,
          nickName: true,
          deptId: true,
          password: true,
          status: true,
          delFlag: true,
        },
      });
    } catch {
      throw new ServiceUnavailableException('认证服务不可用');
    }
    const user = users.length === 1 ? users[0] : undefined;
    const active = user?.status === '0' && user.delFlag === '0';
    let verified = false;
    try {
      verified = await this.passwords.verifyPassword(
        active ? user.password : this.dummyPasswordHash,
        body.password,
      );
    } catch {
      // 损坏的密码哈希和错误密码使用相同的公开错误。
    }
    if (!user || !active || !verified) throw new UnauthorizedException('账号或密码错误');

    let updated;
    try {
      updated = await this.prisma.user.updateMany({
        where: { userId: user.userId, status: '0', delFlag: '0', password: user.password },
        data: { loginIp: ip, loginDate: new Date() },
      });
    } catch {
      throw new ServiceUnavailableException('认证服务不可用');
    }
    if (updated.count !== 1) throw new UnauthorizedException('账号或密码错误');
    const tokens = await this.auth.createSession(String(user.userId));
    return {
      ...tokens,
      user: {
        userId: String(user.userId),
        userName: user.userName,
        nickName: user.nickName,
        deptId: user.deptId === null ? null : String(user.deptId),
      },
    };
  }

  async profile(user: AuthenticatedUser): Promise<ProfileResponseDto> {
    const { roles, permissions } = await this.permissions.getAuthorization(user.userId);
    return {
      userId: user.userId,
      userName: user.userName,
      nickName: user.nickName,
      deptId: user.deptId,
      roles: [...roles],
      permissions: [...permissions],
    };
  }

  async menus(userId: string): Promise<AuthMenuDto[]> {
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
                  status: true,
                  delFlag: true,
                  menus: {
                    select: {
                      menu: {
                        select: {
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
                          icon: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
    } catch {
      throw new ServiceUnavailableException('权限服务不可用');
    }
    if (!user || user.status !== '0' || user.delFlag !== '0')
      throw new UnauthorizedException('未认证');

    const nodes = new Map<string, AuthMenuDto>();
    for (const { role } of user.roles) {
      if (role.status !== '0' || role.delFlag !== '0') continue;
      for (const { menu } of role.menus) {
        if (
          menu.status !== '0' ||
          menu.visible !== '0' ||
          (menu.menuType !== 'M' && menu.menuType !== 'C')
        ) {
          continue;
        }
        const menuId = String(menu.menuId);
        nodes.set(menuId, {
          menuId,
          parentId: String(menu.parentId),
          menuName: menu.menuName,
          menuType: menu.menuType,
          orderNum: menu.orderNum,
          path: menu.path,
          component: menu.component,
          query: menu.query,
          isFrame: menu.isFrame,
          isCache: menu.isCache,
          visible: menu.visible,
          icon: menu.icon,
          children: [],
        });
      }
    }
    const sorted = [...nodes.values()].sort(
      (a, b) => a.orderNum - b.orderNum || (BigInt(a.menuId) < BigInt(b.menuId) ? -1 : 1),
    );
    const roots: AuthMenuDto[] = [];
    for (const node of sorted) {
      if (node.parentId === '0') roots.push(node);
      else nodes.get(node.parentId)?.children.push(node);
    }
    // 只返回根可达节点；缺失父节点、失效父分支以及环均不会进入响应。
    return roots;
  }
}
