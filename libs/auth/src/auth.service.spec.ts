import type { AuthSnapshot } from './auth.types.js';
import type { AuthSession } from './session.store.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authDomain } from '../../config/src/domains/auth.domain.js';
import { AuthService } from './auth.service.js';

const config = authDomain.parse(
  { 'jwt-secret': randomBytes(32).toString('hex') },
  { environment: 'test' },
);
const jwt = new JwtService({
  secret: config.jwtSecret,
  signOptions: {
    algorithm: config.jwtAlgorithm,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  },
  verifyOptions: {
    algorithms: [config.jwtAlgorithm],
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  },
});

/** 登录时算出的授权快照，写进会话后由 authenticate 原样带出。 */
const snapshot: AuthSnapshot = {
  roles: ['operator'],
  permissions: ['system:user:list', '*:*:*'],
};

function fixture() {
  let stored: AuthSession;
  const sessions = {
    create: vi.fn(async (_sid: string, session: AuthSession) => {
      stored = { ...session };
    }),
    get: vi.fn(async () => stored),
    rotate: vi
      .fn<(sid: string, oldHash: string, newHash: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    revokeUser: vi.fn().mockResolvedValue(2),
  };
  const prisma = {
    user: {
      findUnique: vi.fn<(args: { select: object }) => Promise<any>>().mockResolvedValue({
        userId: 1n,
        userName: 'alice',
        nickName: 'Alice',
        deptId: 2n,
        status: '0',
        delFlag: '0',
        roles: [],
      }),
    },
  };
  const auth = new AuthService(jwt, config, sessions as never, prisma as never);
  return { auth, sessions, prisma };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('jWT 与会话认证', () => {
  it('签发受限 claims，把授权快照写进会话，并以字符串 ID 和脱敏字段返回认证用户', async () => {
    const { auth, sessions, prisma } = fixture();
    const pair = await auth.createSession('1', snapshot);
    expect(pair).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(pair.refreshToken).toMatch(/^[a-f0-9-]{36}\.[\w-]{43}$/);
    const claims = await jwt.verifyAsync(pair.accessToken);
    expect(claims).toMatchObject({ sub: '1', iss: config.jwtIssuer, aud: config.jwtAudience });
    expect(claims.exp - claims.iat).toBe(900);
    // 鉴权结果直接来自会话快照，不再查角色/菜单关系。
    expect(await auth.authenticate(pair.accessToken)).toEqual({
      userId: '1',
      userName: 'alice',
      nickName: 'Alice',
      deptId: '2',
      sessionId: claims.sid,
      roles: ['operator'],
      permissions: ['system:user:list', '*:*:*'],
      // 数据范围随用户实时加载，不进会话快照。
      dataScopes: [],
    });
    expect(sessions.create.mock.calls[0][1]).toMatchObject({
      userId: '1',
      roles: ['operator'],
      permissions: ['system:user:list', '*:*:*'],
    });
    expect(sessions.create.mock.calls[0][1].refreshHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(sessions.create.mock.calls)).not.toContain(pair.refreshToken);
    expect(prisma.user.findUnique.mock.calls[0][0].select).not.toHaveProperty('password');
    // 只读角色和自定义部门用于数据范围，不读菜单（功能权限走登录快照）。
    expect(prisma.user.findUnique.mock.calls[0][0].select.roles).toEqual({
      select: {
        role: {
          select: {
            roleId: true,
            dataScope: true,
            status: true,
            delFlag: true,
            depts: { select: { deptId: true } },
          },
        },
      },
    });
  });

  it.each([null, { status: '1', delFlag: '0' }, { status: '0', delFlag: '2' }])(
    '拒绝不存在、禁用或删除的用户：%s',
    async (user) => {
      const { auth, prisma } = fixture();
      const pair = await auth.createSession('1', snapshot);
      prisma.user.findUnique.mockResolvedValue(user);
      await expect(auth.authenticate(pair.accessToken)).rejects.toThrow(UnauthorizedException);
      await expect(auth.refresh(pair.refreshToken)).rejects.toThrow(UnauthorizedException);
    },
  );

  it('拒绝过期、伪造、错误签发方/接收方/算法和缺失 claims 的令牌', async () => {
    const { auth } = fixture();
    const pair = await auth.createSession('1', snapshot);
    const claims = await jwt.verifyAsync(pair.accessToken);
    const payload = {
      sub: claims.sub,
      sid: claims.sid,
      jti: claims.jti,
      iat: claims.iat,
      exp: claims.exp,
    };
    const invalid = [
      'not-a-jwt',
      await jwt.signAsync(payload, { secret: randomBytes(32).toString('hex') }),
      await jwt.signAsync(payload, { issuer: 'other' }),
      await jwt.signAsync(payload, { audience: 'other' }),
      await jwt.signAsync(payload, { algorithm: 'HS512' }),
      await jwt.signAsync({ sub: '1', sid: claims.sid }),
      await jwt.signAsync({ ...payload, sub: 1 }),
      await jwt.signAsync({ ...payload, sub: '1\n' }),
      await jwt.signAsync({ ...payload, sid: `${claims.sid}\n` }),
      await jwt.signAsync({ ...payload, sub: '9223372036854775808' }),
      await jwt.signAsync({ ...payload, jti: 'invalid' }),
      await jwt.signAsync({ ...payload, iat: claims.iat + 10 }),
      await jwt.signAsync({ ...payload, exp: claims.exp + 100 }),
    ];
    for (const token of invalid)
      await expect(auth.authenticate(token)).rejects.toThrow(UnauthorizedException);
    vi.advanceTimersByTime(900_000);
    await expect(auth.authenticate(pair.accessToken)).rejects.toThrow(UnauthorizedException);
  });

  it('校验会话主体，撤销或会话存储不可用不会放行', async () => {
    const { auth, sessions } = fixture();
    const pair = await auth.createSession('1', snapshot);
    sessions.get.mockResolvedValueOnce({
      userId: '2',
      refreshHash: '0'.repeat(64),
      expiresAt: Date.now() + 999999,
      roles: [],
      permissions: [],
    });
    await expect(auth.authenticate(pair.accessToken)).rejects.toThrow(UnauthorizedException);
    sessions.get.mockRejectedValueOnce(new UnauthorizedException());
    await expect(auth.authenticate(pair.accessToken)).rejects.toThrow(UnauthorizedException);
    sessions.get.mockRejectedValueOnce(new ServiceUnavailableException());
    await expect(auth.authenticate(pair.accessToken)).rejects.toThrow(ServiceUnavailableException);
  });

  it('刷新轮换摘要、保持绝对过期时间，Access Token 不超过会话期限', async () => {
    const { auth, sessions } = fixture();
    const pair = await auth.createSession('1', snapshot);
    vi.advanceTimersByTime(config.refreshTokenTtl * 1000 - 60_000);
    const next = await auth.refresh(pair.refreshToken);
    expect(next.refreshToken).not.toBe(pair.refreshToken);
    expect(next.expiresIn).toBe(60);
    const [sid, oldHash, newHash] = sessions.rotate.mock.calls[0];
    expect(sid).toBe(pair.refreshToken.split('.')[0]);
    expect(oldHash).not.toBe(newHash);
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it('非法 Refresh Token、无效 ID 不访问存储；登出仅撤销指定会话', async () => {
    const { auth, sessions } = fixture();
    await expect(auth.refresh('bad-token')).rejects.toThrow(UnauthorizedException);
    await expect(auth.createSession('0', snapshot)).rejects.toThrow(UnauthorizedException);
    expect(sessions.get).not.toHaveBeenCalled();
    const sid = randomUUID();
    await auth.logout(sid);
    expect(sessions.revoke).toHaveBeenCalledExactlyOnceWith(sid);
  });

  it('按用户撤销全部会话用于权限变更踢人', async () => {
    const { auth, sessions } = fixture();
    expect(await auth.revokeUserSessions('7')).toBe(2);
    expect(sessions.revokeUser).toHaveBeenCalledExactlyOnceWith('7');
  });
});
