import { randomBytes, randomUUID } from 'node:crypto';
import { AuthService } from '@app/auth';
import { RedisClient, RedisService } from '@app/cache';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionStore } from '../libs/auth/src/session.store.js';
import { authDomain } from '../libs/config/src/domains/auth.domain.js';
import { redisDomain } from '../libs/config/src/domains/redis.domain.js';

const testUrl = process.env.RBAC_REDIS_TEST_URL;

describe.skipIf(!testUrl)('真实 Redis 会话与原子刷新 (e2e)', () => {
  let owner: RedisClient;
  let redis: RedisService;
  let store: SessionStore;
  let auth: AuthService;
  const created: string[] = [];

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (url.protocol !== 'redis:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('RBAC_REDIS_TEST_URL 必须指向本机 Redis；测试只写随机隔离命名空间');
    }
    const context = { environment: 'test' } as const;
    owner = new RedisClient(
      redisDomain.parse(
        {
          enabled: true,
          host: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || 6379,
          username: decodeURIComponent(url.username) || undefined,
          password: decodeURIComponent(url.password) || undefined,
          db: url.pathname.slice(1) || 0,
          'key-prefix': `rbac-test:${randomUUID()}`,
        },
        context,
      ),
    );
    await owner.onModuleInit();
    redis = new RedisService(owner);
    store = new SessionStore(redis);
    const config = authDomain.parse({ 'jwt-secret': randomBytes(32).toString('hex') }, context);
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
    auth = new AuthService(jwt, config, store, {
      user: {
        findUnique: async () => ({
          userId: 1n,
          userName: 'alice',
          nickName: 'Alice',
          deptId: null,
          status: '0',
          delFlag: '0',
        }),
      },
    } as never);
  });

  afterAll(async () => {
    try {
      for (const sid of created) await store?.revoke(sid);
    } finally {
      await owner?.onApplicationShutdown();
    }
  });

  async function login() {
    const pair = await auth.createSession('1', {
      roles: ['operator'],
      permissions: ['system:user:list'],
    });
    created.push(pair.refreshToken.split('.')[0]);
    return pair;
  }

  it('轮换保持绝对期限，摘要重放撤销该会话，其他设备继续有效', async () => {
    const original = await login();
    const other = await login();
    const sid = original.refreshToken.split('.')[0];
    const before = await store.get(sid);
    const ttlBefore = await redis.ttl(`auth:session:${sid}`);
    const next = await auth.refresh(original.refreshToken);
    expect((await store.get(sid)).expiresAt).toBe(before.expiresAt);
    expect(await redis.ttl(`auth:session:${sid}`)).toBeLessThanOrEqual(ttlBefore);
    expect(await redis.ttl(`auth:used:${sid}`)).toBeGreaterThan(0);
    expect(JSON.stringify(await store.get(sid))).not.toContain(next.refreshToken);
    expect((await auth.authenticate(next.accessToken)).userId).toBe('1');
    await expect(auth.refresh(original.refreshToken)).rejects.toThrow(UnauthorizedException);
    await expect(auth.authenticate(next.accessToken)).rejects.toThrow(UnauthorizedException);
    expect((await auth.authenticate(other.accessToken)).userId).toBe('1');
  });

  it('随机伪造的刷新令牌不撤销有效会话；登出撤销 Access/Refresh', async () => {
    const pair = await login();
    const sid = pair.refreshToken.split('.')[0];
    await expect(auth.refresh(`${sid}.${randomBytes(32).toString('base64url')}`)).rejects.toThrow(
      UnauthorizedException,
    );
    expect((await auth.authenticate(pair.accessToken)).userId).toBe('1');
    await auth.logout(sid);
    await expect(auth.authenticate(pair.accessToken)).rejects.toThrow(UnauthorizedException);
    await expect(auth.refresh(pair.refreshToken)).rejects.toThrow(UnauthorizedException);
  });

  it('同一刷新令牌并发提交至多一次成功，重放使后续会话失效', async () => {
    const pair = await login();
    const results = await Promise.allSettled([
      auth.refresh(pair.refreshToken),
      auth.refresh(pair.refreshToken),
    ]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((value) => value.status === 'rejected')).toHaveLength(1);
    const success = results.find((value) => value.status === 'fulfilled');
    if (success?.status === 'fulfilled') {
      await expect(auth.authenticate(success.value.accessToken)).rejects.toThrow(
        UnauthorizedException,
      );
    }
  });
});
