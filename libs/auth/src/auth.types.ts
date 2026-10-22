import type { FastifyRequest } from 'fastify';

export interface AuthUser {
  userId: string;
  userName: string;
  nickName: string;
  deptId: string | null;
}

export interface AuthenticatedUser extends AuthUser {
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
