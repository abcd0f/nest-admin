import type { AuthenticatedUser } from '@app/auth';
import type { Prisma } from '@app/database/generated/prisma/client.js';
import type { OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuthService } from '@app/auth';
import { PasswordHashService } from '@app/crypto';
import { PrismaService } from '@app/database';
import { isSuperAdmin, PermissionService } from '@app/permission';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthMenuDto, LoginDto, LoginResponseDto, ProfileResponseDto } from './dto/auth.dto.js';

/** 路由菜单需要的字段；超管分支与角色分支共用同一份投影。 */
const AUTH_MENU_SELECT = {
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
} satisfies Prisma.MenuSelect;

type AuthMenuRow = Prisma.MenuGetPayload<{ select: typeof AUTH_MENU_SELECT }>;

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
    // 登录时计算一次授权快照，随会话保存；对应 SysLoginService.buildLoginUser。
    const snapshot = await this.permissions.snapshot(String(user.userId));
    const tokens = await this.auth.createSession(String(user.userId), snapshot);
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
    // 读取登录时写入会话的快照，与鉴权使用同一份数据。
    const { roles, permissions } = this.permissions.getAuthorization(user);
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
    const nodes = isSuperAdmin(userId)
      ? await this.superAdminMenus(userId)
      : await this.grantedMenus(userId);
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

  /**
   * 超级管理员的菜单：全部启用的目录/菜单，不依赖角色关联。
   *
   * 对应 `SysMenuServiceImpl.selectMenuTreeByUserId` 的 `selectMenuTreeAll()` 分支。
   * 该 SQL 只过滤 `menu_type in (M,C)` 与 `status='0'`，**不过滤 `visible`**，
   * 此处保持一致；可见性由前端根据 `visible` 字段自行处理。
   */
  private async superAdminMenus(userId: string): Promise<Map<string, AuthMenuDto>> {
    await this.assertActiveUser(userId);
    let rows;
    try {
      rows = await this.prisma.menu.findMany({
        where: { status: '0', menuType: { in: ['M', 'C'] } },
        select: AUTH_MENU_SELECT,
      });
    } catch {
      throw new ServiceUnavailableException('权限服务不可用');
    }
    return this.toNodes(rows);
  }

  /** 普通用户的菜单：仅取有效角色关联、启用且可见的目录/菜单。 */
  private async grantedMenus(userId: string): Promise<Map<string, AuthMenuDto>> {
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
                  menus: { select: { menu: { select: AUTH_MENU_SELECT } } },
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
        if (menu.status !== '0' || menu.visible !== '0') continue;
        this.putNode(nodes, menu);
      }
    }
    return nodes;
  }

  /** 超管分支只用于校验 1 号用户仍然存在且启用，避免停用后继续拿到全量菜单。 */
  private async assertActiveUser(userId: string): Promise<void> {
    let user;
    try {
      user = await this.prisma.user.findUnique({
        where: { userId: BigInt(userId) },
        select: { status: true, delFlag: true },
      });
    } catch {
      throw new ServiceUnavailableException('权限服务不可用');
    }
    if (!user || user.status !== '0' || user.delFlag !== '0')
      throw new UnauthorizedException('未认证');
  }

  private toNodes(rows: AuthMenuRow[]): Map<string, AuthMenuDto> {
    const nodes = new Map<string, AuthMenuDto>();
    for (const row of rows) this.putNode(nodes, row);
    return nodes;
  }

  private putNode(nodes: Map<string, AuthMenuDto>, menu: AuthMenuRow): void {
    if (menu.menuType !== 'M' && menu.menuType !== 'C') return;
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
