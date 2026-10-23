import type { FastifyRequest } from 'fastify';

/**
 * 一个有效角色贡献的数据范围配置。
 *
 * 对应 RuoYi `LoginUser.roles[].dataScope`，但**不进会话快照**：
 * 认证守卫每次请求都会重新加载用户，这里一并读出来，所以调整数据范围立即生效，
 * 不需要像功能权限那样撤销会话。功能权限要 join 角色→菜单，成本高才走快照；
 * 数据范围只需要角色和 `RoleDept`，挂在已有的用户查询上几乎零成本。
 */
export interface RoleScope {
  /** 角色 ID（十进制字符串）。 */
  roleId: string;
  /** 数据范围：1 全部、2 自定义、3 本部门、4 本部门及以下、5 本人、6 部门及以下或本人。 */
  dataScope: string;
  /** `dataScope=2` 时 `RoleDept` 指定的部门；其他范围为空。 */
  deptIds: readonly string[];
}

export interface AuthUser {
  userId: string;
  userName: string;
  nickName: string;
  deptId: string | null;
  /** 当前有效角色的数据范围配置，按角色 ID 升序。超管由 `isSuperAdmin` 短路，不依赖此数组。 */
  dataScopes: readonly RoleScope[];
}

/**
 * 登录时计算、随会话保存的授权快照。
 *
 * 对应 RuoYi `LoginUser.menuPermission` / `rolePermission`：权限在登录时算一次，
 * 后续鉴权只读会话，不再查库。权限变更后必须撤销相关会话，否则旧快照继续生效。
 */
export interface AuthSnapshot {
  /** 有效角色标识（`roleKey`）。超管为 `['superadmin']`。 */
  readonly roles: readonly string[];
  /** 有效菜单/按钮的权限码，可含 `*` 通配。超管为 `['*:*:*']`。 */
  readonly permissions: readonly string[];
}

export interface AuthenticatedUser extends AuthUser, AuthSnapshot {
  sessionId: string;
}

export interface AuthenticatedRequest extends FastifyRequest {
  user?: AuthenticatedUser;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  jti: string;
  iat: number;
  exp: number;
}

export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const REFRESH_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[\w-]{43}$/;

export function isUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    /^[1-9]\d{0,18}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
