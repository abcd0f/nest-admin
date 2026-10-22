import type { AuthConfig } from '@app/config';
import type {
  AccessTokenClaims,
  AuthenticatedUser,
  AuthSnapshot,
  AuthUser,
  TokenPair,
} from './auth.types.js';
import type { AuthSession } from './session.store.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { authConfig } from '@app/config';
import { PrismaService } from '@app/database';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUserId, REFRESH_TOKEN_PATTERN, SESSION_ID_PATTERN } from './auth.types.js';
import { SessionStore } from './session.store.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    @Inject(SessionStore) private readonly sessions: SessionStore,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async loadUser(userId: string): Promise<AuthUser> {
    let user;
    try {
      user = await this.prisma.user.findUnique({
        where: { userId: BigInt(userId) },
        select: {
          userId: true,
          userName: true,
          nickName: true,
          deptId: true,
          status: true,
          delFlag: true,
        },
      });
    } catch {
      throw new ServiceUnavailableException('认证服务不可用');
    }
    if (!user || user.status !== '0' || user.delFlag !== '0')
      throw new UnauthorizedException('未认证');
    return {
      userId: String(user.userId),
      userName: user.userName,
      nickName: user.nickName,
      deptId: user.deptId === null ? null : String(user.deptId),
    };
  }

  private async tokens(
    sid: string,
    session: AuthSession,
    refreshToken: string,
  ): Promise<TokenPair> {
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.min(now + this.config.accessTokenTtl, Math.floor(session.expiresAt / 1000));
    if (exp <= now) throw new UnauthorizedException('未认证');
    const accessToken = await this.jwt.signAsync({
      sub: session.userId,
      sid,
      jti: randomUUID(),
      iat: now,
      exp,
    });
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: exp - now };
  }

  /**
   * 只由账号密码验证成功后的登录业务调用；再次检查用户仍有效。
   *
   * `snapshot` 是登录时算好的角色/权限，随会话保存。之后鉴权只读会话，
   * 对应 RuoYi `SysLoginService.buildLoginUser` 把权限写进 `LoginUser` 再落 Token Session。
   */
  async createSession(userId: string, snapshot: AuthSnapshot): Promise<TokenPair> {
    if (!isUserId(userId)) throw new UnauthorizedException('未认证');
    await this.loadUser(userId);
    const sid = randomUUID();
    const refreshToken = `${sid}.${randomBytes(32).toString('base64url')}`;
    const session: AuthSession = {
      userId,
      refreshHash: this.hash(refreshToken),
      expiresAt: Date.now() + this.config.refreshTokenTtl * 1000,
      roles: [...snapshot.roles],
      permissions: [...snapshot.permissions],
    };
    const tokens = await this.tokens(sid, session, refreshToken);
    await this.sessions.create(sid, session);
    return tokens;
  }

  async authenticate(token: string): Promise<AuthenticatedUser> {
    let claims: AccessTokenClaims;
    try {
      const value = await this.jwt.verifyAsync<AccessTokenClaims>(token);
      const now = Math.floor(Date.now() / 1000);
      if (
        !isUserId(value.sub) ||
        typeof value.sid !== 'string' ||
        value.sid.length !== 36 ||
        !SESSION_ID_PATTERN.test(value.sid) ||
        typeof value.jti !== 'string' ||
        value.jti.length !== 36 ||
        !SESSION_ID_PATTERN.test(value.jti) ||
        !Number.isSafeInteger(value.iat) ||
        !Number.isSafeInteger(value.exp) ||
        value.iat < 0 ||
        value.iat > now ||
        value.exp <= now ||
        value.exp <= value.iat ||
        value.exp - value.iat > this.config.accessTokenTtl
      ) {
        throw new Error('invalid claims');
      }
      claims = value;
    } catch {
      throw new UnauthorizedException('未认证');
    }
    const session = await this.sessions.get(claims.sid);
    if (session.userId !== claims.sub || claims.exp * 1000 > session.expiresAt)
      throw new UnauthorizedException('未认证');
    const user = await this.loadUser(claims.sub);
    // 权限来自会话快照，不在鉴权阶段查角色/菜单关系。
    return {
      ...user,
      sessionId: claims.sid,
      roles: session.roles,
      permissions: session.permissions,
    };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    if (
      typeof refreshToken !== 'string' ||
      refreshToken.length !== 80 ||
      !REFRESH_TOKEN_PATTERN.test(refreshToken)
    ) {
      throw new UnauthorizedException('未认证');
    }
    const sid = refreshToken.split('.')[0];
    const session = await this.sessions.get(sid);
    await this.loadUser(session.userId);
    const nextToken = `${sid}.${randomBytes(32).toString('base64url')}`;
    const tokens = await this.tokens(sid, session, nextToken);
    await this.sessions.rotate(sid, this.hash(refreshToken), this.hash(nextToken));
    return tokens;
  }

  /** 由已认证上下文提供 sessionId；仅撤销当前设备会话。 */
  async logout(sessionId: string): Promise<void> {
    if (
      typeof sessionId !== 'string' ||
      sessionId.length !== 36 ||
      !SESSION_ID_PATTERN.test(sessionId)
    ) {
      throw new UnauthorizedException('未认证');
    }
    await this.sessions.revoke(sessionId);
  }

  /**
   * 撤销某个用户的全部设备会话，返回被撤销的数量。
   *
   * 权限快照存在会话里，任何影响该用户授权的变更提交后都要调用本方法，
   * 否则旧权限会一直生效到会话过期。对应 RuoYi `cleanOnlineUser`。
   */
  async revokeUserSessions(userId: string): Promise<number> {
    return this.sessions.revokeUser(userId);
  }
}
