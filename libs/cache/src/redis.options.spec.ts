import { describe, expect, it, vi } from 'vitest';
import { redisDomain } from '../../config/src/domains/redis.domain.js';
import { createRedisOptions, redisRetryDelay } from './redis.options.js';

const context = { environment: 'test' } as const;

function config(overrides: Record<string, unknown> = {}) {
  return redisDomain.parse({ enabled: true, ...overrides }, context);
}

describe('redisRetryDelay', () => {
  it('使用指数退避并在上限处截断', () => {
    expect(redisRetryDelay(1, 1000, 30000, () => 0)).toBe(800);
    expect(redisRetryDelay(2, 1000, 30000, () => 0)).toBe(1600);
    expect(redisRetryDelay(3, 1000, 30000, () => 0)).toBe(3200);
    expect(redisRetryDelay(5, 1000, 30000, () => 0)).toBe(12800);
    expect(redisRetryDelay(6, 1000, 30000, () => 0)).toBe(24000);
    expect(redisRetryDelay(20, 1000, 30000, () => 0)).toBe(24000);
  });

  it('最多增加 20% 抖动，且不会超过上限', () => {
    expect(redisRetryDelay(1, 1000, 30000, () => 1)).toBe(1000);
    expect(redisRetryDelay(20, 1000, 30000, () => 1)).toBe(30000);
    expect(redisRetryDelay(20, 1000, 30000, () => 0.5)).toBe(27000);
  });

  it('至少返回 1 毫秒，避免 busy loop', () => {
    expect(redisRetryDelay(1, 1, 30000, () => 0)).toBe(1);
  });
});

describe('createRedisOptions', () => {
  it('映射连接、超时、地址族与连接名配置', () => {
    const options = createRedisOptions(
      config({
        host: 'redis.internal',
        port: 6380,
        username: 'cache-user',
        password: 'secret',
        db: 2,
        'connect-timeout': 500,
        'command-timeout': 250,
        'max-retries-per-request': 1,
        'keep-alive': 15000,
        family: 6,
        'connection-name': 'gateway-a',
      }),
      { shouldRetry: () => false },
    );

    expect(options).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      username: 'cache-user',
      password: 'secret',
      db: 2,
      connectTimeout: 500,
      commandTimeout: 250,
      maxRetriesPerRequest: 1,
      keepAlive: 15000,
      family: 6,
      connectionName: 'gateway-a',
      lazyConnect: true,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      enableAutoPipelining: false,
    });
  });

  it('启动阶段不重试，运行期按指数退避重连', () => {
    let shouldRetry = false;
    const options = createRedisOptions(config({ 'retry-delay': 500, 'retry-max-delay': 5000 }), {
      shouldRetry: () => shouldRetry,
    });

    expect(options.retryStrategy?.(1)).toBeNull();
    shouldRetry = true;
    expect(options.retryStrategy?.(1)).toBeGreaterThanOrEqual(400);
    expect(options.retryStrategy?.(1)).toBeLessThanOrEqual(500);
    expect(options.retryStrategy?.(10)).toBeGreaterThanOrEqual(4000);
    expect(options.retryStrategy?.(10)).toBeLessThanOrEqual(5000);
  });

  it('仅在启用 TLS 时附加证书校验选项', () => {
    expect(createRedisOptions(config(), { shouldRetry: () => false }).tls).toBeUndefined();
    expect(
      createRedisOptions(config({ 'tls-enabled': true }), { shouldRetry: () => false }).tls,
    ).toEqual({ rejectUnauthorized: true });
    expect(
      createRedisOptions(config({ 'tls-enabled': true, 'tls-reject-unauthorized': false }), {
        shouldRetry: () => false,
      }).tls,
    ).toEqual({ rejectUnauthorized: false });
  });

  it('每次调用 retryStrategy 都读取最新状态', () => {
    const state = { shouldRetry: vi.fn(() => true) };
    const options = createRedisOptions(config(), state);
    options.retryStrategy?.(1);
    options.retryStrategy?.(2);
    expect(state.shouldRetry).toHaveBeenCalledTimes(2);
  });
});
