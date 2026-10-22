import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { CACHE_MANAGER, CacheModule, CacheService, RedisClient, RedisLockBusyError, RedisLockLostError, RedisService } from '@app/cache';
import { createFastifyAdapter } from '@app/common';
import { loggerConfig, redisConfig } from '@app/config';
import { Test } from '@nestjs/testing';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../apps/gateway/src/app.module.js';
import { deleteByPrefix } from '../libs/cache/src/cache.utils.js';
import { SharedRedisStore } from '../libs/cache/src/redis.store.js';
import { loggerDomain } from '../libs/config/src/domains/logger.domain.js';
import { redisDomain } from '../libs/config/src/domains/redis.domain.js';

const context = { environment: 'test' } as const;
const testUrl = process.env.REDIS_TEST_URL;

function testConfig() {
  const url = new URL(testUrl!);
  if (url.protocol !== 'redis:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('REDIS_TEST_URL 必须是无凭据的本机独立测试 Redis');
  }
  return redisDomain.parse({
    enabled: true,
    ttl: 5000,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || '6379',
    db: url.pathname.slice(1) || '0',
    'key-prefix': `test:${randomUUID()}`,
    'connect-timeout': 1000,
    'command-timeout': 500,
    'retry-delay': 250,
  }, context);
}

async function createApp(config: ReturnType<typeof redisDomain.parse>) {
  // 重复导入静态模块也必须只产生一个连接所有者。
  const module = await Test.createTestingModule({ imports: [AppModule, CacheModule] })
    .overrideProvider(redisConfig.KEY)
.useValue(config)
    .overrideProvider(loggerConfig.KEY)
.useValue(loggerDomain.parse({
      console: { enabled: true, pretty: false },
file: { enabled: false },
    }, context))
    .compile();
  return module.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), { logger: false });
}

describe('禁用 Redis', () => {
  it('网关可初始化、不创建连接、缓存不存储、严格 Redis 操作报错', async () => {
    const app = await createApp(redisDomain.parse({ enabled: false }, context));
    try {
      await app.init();
      expect(app.get(RedisClient).client).toBeUndefined();
      const cache = app.get(CacheService);
      await cache.set('disabled', 'value');
      expect(await cache.get('disabled')).toBeUndefined();
      expect(await cache.health()).toEqual({ status: 'disabled' });
      await expect(app.get(RedisService).get('session')).rejects.toThrow('Redis 未就绪');
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!testUrl)('独立 Redis + 实际网关模块', () => {
  let app: NestFastifyApplication;
  let cache: CacheService;
  let redis: RedisService;
  let observer: ReturnType<typeof createClient>;
  let namespace: string;

  beforeAll(async () => {
    const config = testConfig();
    namespace = config.keyPrefix;
    app = await createApp(config);
    await app.init();
    cache = app.get(CacheService);
    redis = app.get(RedisService);
    observer = createClient({ url: testUrl, socket: { reconnectStrategy: false } });
    observer.on('error', () => {});
    await observer.connect();
  });

  afterAll(async () => {
    await app?.close();
    if (observer?.isReady) await deleteByPrefix(observer, `${namespace}:`);
    if (observer?.isOpen) observer.destroy();
  });

  it('缓存、原生 API、适配器共用一个已连接客户端，manager 不能关闭它', async () => {
    const owner = app.get(RedisClient);
    const manager = app.get<import('cache-manager').Cache>(CACHE_MANAGER);
    const store = manager.stores[0]!.store as SharedRedisStore;
    expect(store.client).toBe(owner.client);
    expect(redis.client).toBe(owner.client);
    const clients = await observer.sendCommand(['CLIENT', 'LIST']);
    expect(String(clients).split('\n').filter(line => line.includes(`name=${namespace}:${process.pid} `))).toHaveLength(1);
    await manager.disconnect();
    expect(await cache.health()).toMatchObject({ status: 'up' });
  });

  it('JSON 原始值、对象、批量读写及 TTL 0 持久化', async () => {
    const values = [null, false, 0, '', { id: 42, roles: ['reader'] }];
    const entries = values.map((value, index) => ({ key: `value:${index}`, value, ttl: 0 }));
    await cache.setMany(entries);
    expect(await cache.getMany(entries.map(entry => entry.key))).toEqual(values);
    expect(await cache.ttl('value:0')).toBe(-1);
    expect(JSON.parse((await observer.get(`${namespace}:cache:value:4`))!).value).toEqual(values[4]);
    await cache.delMany(entries.map(entry => entry.key));
    expect(await cache.getMany(['value:0', 'missing'])).toEqual([undefined, undefined]);
    expect(await cache.ttl('value:0')).toBe(-2);
  });

  it('默认与单次 TTL 使用毫秒，Redis 真正过期', async () => {
    await cache.set('default-ttl', 'value');
    expect(await cache.ttl('default-ttl')).toBeGreaterThan(0);
    expect(await cache.ttl('default-ttl')).toBeLessThanOrEqual(5000);
    await cache.set('expires', false, 80);
    expect(await cache.get('expires')).toBe(false);
    await vi.waitFor(async () => expect(await cache.get('expires')).toBeUndefined(), { timeout: 1500, interval: 20 });
  });

  it('wrap 合并同 key 并发并缓存空结果', async () => {
    const loader = vi.fn(async () => null);
    expect(await Promise.all(Array.from({ length: 20 }, () => cache.wrap('wrap', loader)))).toEqual(Array.from({ length: 20 }).fill(null));
    expect(await cache.wrap('wrap', loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('字面量前缀清理不扩展通配符，clear 只清缓存命名空间', async () => {
    await cache.setMany([{ key: 'group:*[1]\\:a', value: 1 }, { key: 'group:other', value: 2 }]);
    expect(await cache.deleteByPrefix('group:*[1]\\:')).toBe(1);
    expect(await cache.get('group:other')).toBe(2);
    await redis.set('session', 'keep');
    const lock = await redis.acquireLock('clear', 5000);
    await observer.set(`${namespace}:another:keep`, 'keep');
    await cache.clear();
    expect(await cache.get('group:other')).toBeUndefined();
    expect(await redis.get('session')).toBe('keep');
    expect(await observer.get(`${namespace}:another:keep`)).toBe('keep');
    expect(await lock!.release()).toBe(true);
  });

  it('一次性令牌只能消费一次；NX 不覆盖已有值或重置有效期', async () => {
    expect(await redis.setIfAbsent('token', 'secret', 5000)).toBe(true);
    expect(await redis.setIfAbsent('token', 'other', 10000)).toBe(false);
    expect(await redis.ttl('token')).toBeLessThanOrEqual(5000);
    const consumed = await Promise.all(Array.from({ length: 20 }, () => redis.consume('token')));
    expect(consumed.filter(value => value === 'secret')).toHaveLength(1);
    expect(consumed.filter(value => value === null)).toHaveLength(19);
    await redis.set('persistent', 'value', 0);
    expect(await redis.ttl('persistent')).toBe(-1);
    expect(await redis.expire('persistent', 5000)).toBe(true);
    expect(await redis.del('persistent')).toBe(1);
    expect(await redis.expire('persistent', 5000)).toBe(false);
  });

  it('并发计数原子递增且不延长首次窗口', async () => {
    const counts = await Promise.all(Array.from({ length: 40 }, () => redis.increment('attempts', 5000)));
    expect(counts.map(item => item.value).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    const before = await redis.ttl('attempts');
    const next = await redis.increment('attempts', 10000, 2);
    expect(next.value).toBe(42);
    expect(next.ttl).toBeLessThanOrEqual(before);
    expect(next.ttl).toBeGreaterThan(0);
  });

  it('锁互斥、续租与过期后归属校验；旧持有者不能删除新锁', async () => {
    const first = await redis.acquireLock('order', 80);
    expect(first).toBeDefined();
    expect(await redis.acquireLock('order', 5000)).toBeUndefined();
    await expect(redis.withLock('order', 5000, async () => 1)).rejects.toBeInstanceOf(RedisLockBusyError);
    await vi.waitFor(async () => expect(await observer.exists(`${namespace}:lock:order`)).toBe(0), { interval: 20 });
    const second = await redis.acquireLock('order', 5000);
    expect(await first!.release()).toBe(false);
    expect(await first!.extend(5000)).toBe(false);
    expect(await second!.extend(10000)).toBe(true);
    expect(await observer.pTTL(`${namespace}:lock:order`)).toBeGreaterThan(5000);
    expect(await second!.release()).toBe(true);
  });

  it('withLock 成功释放、业务失败保留原异常、丢失租约显式报错', async () => {
    expect(await redis.withLock('task', 5000, async () => 42)).toBe(42);
    expect(await observer.exists(`${namespace}:lock:task`)).toBe(0);
    const error = new Error('business failed');
    await expect(redis.withLock('task', 5000, async () => {
      throw error;
    })).rejects.toBe(error);
    expect(await observer.exists(`${namespace}:lock:task`)).toBe(0);
    await expect(redis.withLock('task', 5000, async () => {
      await observer.del(`${namespace}:lock:task`);
      return 1;
    })).rejects.toBeInstanceOf(RedisLockLostError);
  });

  it('原生 Hash/Set/ZSet/MULTI 使用相同连接', async () => {
    const hash = redis.key('user:42');
    await redis.client.multi().hSet(hash, { name: 'Alice', role: 'admin' }).sAdd(redis.key('roles'), 'admin').zAdd(redis.key('ranking'), { score: 10, value: '42' }).exec();
    expect(await redis.client.hGetAll(hash)).toEqual({ name: 'Alice', role: 'admin' });
    expect(await redis.client.sMembers(redis.key('roles'))).toEqual(['admin']);
    expect(await redis.client.zScore(redis.key('ranking'), '42')).toBe(10);
    expect(await redis.deleteByPrefix('user:')).toBe(1);
  });

  it('真实 ACL/类型错误：缓存读降级、显式写与严格操作报错，且指标可见', async () => {
    const client = redis.client;
    const user = `cache_test_${randomUUID().replaceAll('-', '')}`;
    await observer.sendCommand(['ACL', 'SETUSER', user, 'on', 'nopass', `~${namespace}:*`, '+get', '+ping', '+auth']);
    cache.resetMetrics();
    try {
      await client.auth({ username: user, password: '' });
      await expect(cache.set('denied', 'value')).rejects.toThrow('Redis 缓存命令执行失败');
      await expect(cache.setMany([{ key: 'denied', value: 1 }])).rejects.toThrow('Redis 缓存命令执行失败');
      await expect(cache.del('denied')).rejects.toThrow('Redis 缓存命令执行失败');
      await expect(cache.clear()).rejects.toThrow('Redis 缓存命令执行失败');
      await expect(redis.set('denied', 'value')).rejects.toThrow();
      await observer.lPush(`${namespace}:cache:wrongtype`, 'value');
      expect(await cache.get('wrongtype')).toBeUndefined();
      expect(await cache.getMany(['denied'])).toEqual([undefined]);
      expect(await cache.wrap('fallback', async () => 'business-result')).toBe('business-result');
      expect(cache.getMetrics().errors).toBeGreaterThanOrEqual(7);
    } finally {
      await client.auth({ username: 'default', password: '' });
      await observer.sendCommand(['ACL', 'DELUSER', user]);
      await observer.del(`${namespace}:cache:wrongtype`);
    }
    await cache.set('recovered', 'ok');
    expect(await cache.get('recovered')).toBe('ok');
  });

  it('断线立即拒绝离线命令，同一客户端自动重连恢复', async () => {
    const client = redis.client;
    const id = await client.clientId();
    const reconnecting = new Promise<void>(resolve => client.once('reconnecting', resolve));
    await observer.sendCommand(['CLIENT', 'KILL', 'ID', String(id)]);
    await reconnecting;
    await expect(cache.set('offline', 1)).rejects.toThrow('Redis 缓存命令执行失败');
    expect(await cache.get('offline')).toBeUndefined();
    expect(await cache.health()).toEqual({ status: 'down' });
    await vi.waitFor(() => expect(client.isReady).toBe(true), { timeout: 4000 });
    expect(redis.client).toBe(client);
    expect(await client.clientId()).not.toBe(id);
    await cache.set('online', 'value');
    expect(await cache.get('online')).toBe('value');
  });

  it('关闭网关释放 socket，禁止关闭后调用触发适配器懒连接', async () => {
    const client = redis.client;
    // 仅在独立测试连接上阻塞，验证已发送命令也有完整调用时限，关闭不等待响应。
    await expect(redis.execute(connection => connection.blPop(redis.key('blocked-test'), 0)))
      .rejects
.toThrow('Redis 命令执行超时');
    expect(await cache.get('blocked-cache')).toBeUndefined();
    expect(await cache.health()).toEqual({ status: 'down' });
    await app.close();
    expect(client.isOpen).toBe(false);
    expect(client.isReady).toBe(false);
    expect(await cache.get('online')).toBeUndefined();
    await expect(cache.set('late', 1)).rejects.toThrow('Redis 缓存命令执行失败');
    expect(client.isOpen).toBe(false);
    expect(client.listenerCount('ready')).toBe(0);
  });
});

describe('Redis 启动失败（无需 Redis）', () => {
  it.each(['disconnect', 'hang'])('握手 %s 时限时失败并释放 socket', async (mode) => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      if (mode === 'disconnect') socket.destroy();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('未获取测试端口');
    const app = await createApp(redisDomain.parse({ enabled: true, port: address.port, 'connect-timeout': 100, 'command-timeout': 100 }, context));
    try {
      await expect(app.init()).rejects.toThrow('Redis 连接失败');
      expect(app.get(RedisClient).client!.isOpen).toBe(false);
    } finally {
      await app.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
