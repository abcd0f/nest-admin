import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { CacheService } from '@app/cache';
import { createFastifyAdapter } from '@app/common';
import { loggerConfig, redisConfig } from '@app/config';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../apps/gateway/src/app.module.js';
import { RedisConnection } from '../libs/cache/src/redis.connection.js';
import { loggerDomain } from '../libs/config/src/domains/logger.domain.js';
import { redisDomain } from '../libs/config/src/domains/redis.domain.js';

const context = { environment: 'test' } as const;
const testUrl = process.env.REDIS_TEST_URL;

// 仅允许显式指定的本机独立测试 Redis；不读取应用的 Redis 配置或凭据。
function testConfig() {
  const url = new URL(testUrl!);
  if (
    url.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('REDIS_TEST_URL 必须是无凭据的本机独立测试 Redis');
  }
  return redisDomain.parse(
    {
      enabled: true,
      ttl: 5000,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || '6379',
      db: url.pathname.slice(1) || '0',
      'key-prefix': `test:${randomUUID()}`,
      'connect-timeout': 500,
      'command-timeout': 250,
    },
    context,
  );
}

async function createApp(config: ReturnType<typeof redisDomain.parse>) {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(redisConfig.KEY)
    .useValue(config)
    .overrideProvider(loggerConfig.KEY)
    .useValue(
      loggerDomain.parse(
        {
          console: { enabled: true, pretty: false },
          file: { enabled: false },
        },
        context,
      ),
    )
    .compile();
  return module.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), {
    logger: false,
  });
}

describe('统一 Redis 配置', () => {
  it('默认关闭缓存并使用 60000 毫秒 TTL', () => {
    expect(redisDomain.parse({}, context)).toMatchObject({ enabled: false, ttl: 60000 });
  });

  it('从 redis 域解析开关和默认 TTL', () => {
    expect(redisDomain.parse({ enabled: 'true', ttl: '5000' }, context)).toMatchObject({
      enabled: true,
      ttl: 5000,
    });
  });

  it.each([0, -1, 1.5, 2147483648, true, ''])('拒绝非法 redis.ttl：%s', (ttl) => {
    expect(() => redisDomain.parse({ ttl }, context)).toThrow('redis.ttl');
  });

  it('关闭时网关可初始化且不创建 Redis 连接', async () => {
    const app = await createApp(redisDomain.parse({ enabled: false }, context));
    try {
      await app.init();
      expect(app.get(RedisConnection).client).toBeUndefined();
      const cache = app.get(CacheService);
      await cache.set('disabled', 'value');
      expect(await cache.get('disabled')).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!testUrl)('独立 Redis + 实际网关模块 (e2e)', () => {
  let app: NestFastifyApplication;
  let cache: CacheService;
  let observer: Redis;
  let namespace: string;

  beforeAll(async () => {
    const config = testConfig();
    namespace = config.keyPrefix;
    app = await createApp(config);
    await app.init();
    cache = app.get(CacheService);
    observer = new Redis({
      host: config.host,
      port: config.port,
      db: config.db,
      lazyConnect: true,
    });
    await observer.connect();
  });

  afterAll(async () => {
    await app?.close();
    observer?.disconnect();
  });

  it('网关模块初始化，并在 Redis 中完成 JSON 写入、读取、失效', async () => {
    const key = 'users:v1:42';
    await cache.set(key, { id: 42, roles: ['reader'] });
    expect(await cache.get(key)).toEqual({ id: 42, roles: ['reader'] });
    expect(await observer.get(`${namespace}:${key}`)).toContain('"id":42');
    const ttl = await observer.pttl(`${namespace}:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5000);
    await cache.del(key);
    expect(await cache.get(key)).toBeUndefined();
    expect(await observer.exists(`${namespace}:${key}`)).toBe(0);
  });

  it('自定义 TTL 由 Redis 真正过期，使用有界轮询验证', async () => {
    await cache.set('expires', false, 80);
    expect(await cache.get('expires')).toBe(false);
    await vi.waitFor(
      async () => {
        expect(await observer.exists(`${namespace}:expires`)).toBe(0);
      },
      { timeout: 1500, interval: 20 },
    );
    expect(await cache.get('expires')).toBeUndefined();
  });

  it('wrap 复用缓存并合并进程内并发加载', async () => {
    const loader = vi.fn(async () => ({ id: 7 }));
    await Promise.all([cache.wrap('wrap', loader, 1000), cache.wrap('wrap', loader, 1000)]);
    expect(await cache.wrap('wrap', loader, 1000)).toEqual({ id: 7 });
    expect(loader).toHaveBeenCalledTimes(1);
    await cache.del('wrap');
  });

  it('真实服务端命令错误：读为未命中，set/del 报错，连接恢复后可继续读写', async () => {
    const client = app.get(RedisConnection).client!;
    // 仅切换当前测试连接为只读权限：不会停止或更改 Redis 全局配置。
    const user = `cache_test_${randomUUID().replaceAll('-', '')}`;
    await observer.acl(
      'SETUSER',
      user,
      'on',
      'nopass',
      `~${namespace}:*`,
      '+get',
      '+ping',
      '+quit',
      '+auth',
    );
    try {
      await client.auth(user, '');
      await expect(cache.set('denied', 'value')).rejects.toThrow('Redis 缓存命令执行失败');
      await expect(cache.del('denied')).rejects.toThrow('Redis 缓存命令执行失败');
      // List 类型使 GET 返回 WRONGTYPE，确认实际读取异常按约定降级。
      await observer.lpush(`${namespace}:wrongtype`, 'value');
      expect(await cache.get('wrongtype')).toBeUndefined();
    } finally {
      await client.auth('default', '');
      await observer.acl('DELUSER', user);
      await observer.del(`${namespace}:wrongtype`);
    }
    await cache.set('recovered', 'ok');
    expect(await cache.get('recovered')).toBe('ok');
    await cache.del('recovered');
  });

  it('实际 socket 断开后拒绝离线写入，客户端自动重连并恢复', async () => {
    const client = app.get(RedisConnection).client!;
    const closed = new Promise<void>((resolve) => client.once('close', resolve));
    const id = await client.client('ID');
    await observer.client('KILL', 'ID', String(id));
    await closed;
    await expect(cache.set('offline', 'value')).rejects.toThrow('Redis 缓存命令执行失败');
    expect(await cache.get('offline')).toBeUndefined();
    await vi.waitFor(
      () => {
        expect(client.status).toBe('ready');
      },
      { timeout: 3000 },
    );
    await cache.set('online', 'value');
    expect(await cache.get('online')).toBe('value');
    await cache.del('online');
  });

  it('关闭应用释放真实 socket 且移除自有监听器', async () => {
    const client = app.get(RedisConnection).client!;
    await app.close();
    await vi.waitFor(() => {
      expect(client.status).toBe('end');
    });
    expect(client.listenerCount('ready')).toBe(0);
    expect(client.listenerCount('error')).toBe(0);
    expect(client.listenerCount('close')).toBe(0);
  });
});

describe('Redis 启动失败 (e2e，无需 Redis)', () => {
  it('启用缓存时连接失败阻止网关初始化，并释放连接', async () => {
    // 测试服务器接受连接后立即断开，不会误连本机已有 Redis 服务。
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('未获取测试端口');
    const port = address.port;
    const app = await createApp(
      redisDomain.parse(
        { enabled: true, port, 'connect-timeout': 100, 'command-timeout': 100 },
        context,
      ),
    );
    try {
      await expect(app.init()).rejects.toThrow('Redis 连接失败');
      await vi.waitFor(() => {
        expect(app.get(RedisConnection).client!.status).toBe('end');
      });
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
