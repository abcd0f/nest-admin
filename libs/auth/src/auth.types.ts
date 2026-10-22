import type { FastifyRequest } from 'fastify';

export interface AuthUser {
  userId: string;
  userName: string;
  nickName: string;
  deptId: string | null;
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
