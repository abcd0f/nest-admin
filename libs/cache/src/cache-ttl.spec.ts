import type { Cache } from 'cache-manager';
import type { RedisConnection } from './redis.connection.js';
import { describe, expect, it, vi } from 'vitest';
import { CacheService } from './cache.service.js';
import { RedisStore } from './redis.store.js';

describe('缓存 TTL 边界', () => {
  it.each([undefined, 1, 2147483647])('service 保留 TTL %s，Store 使用默认值或显式 PX 毫秒', async (ttl) => {
    const cache = { set: vi.fn(), wrap: vi.fn().mockResolvedValue('loaded') };
    const service = new CacheService(cache as unknown as Cache);
    const loader = vi.fn(async () => 'loaded');
    await service.set('key', 'value', ttl);
    await service.wrap('key', loader, ttl);
    expect(cache.set).toHaveBeenCalledWith('key', 'value', ttl);
    expect(cache.wrap).toHaveBeenCalledWith('key', loader, ttl);

    const set = vi.fn().mockResolvedValue('OK');
    const store = new RedisStore({ client: { set } } as unknown as RedisConnection, 60000);
    expect(await store.set('key', 'encoded value', ttl)).toBe(true);
    expect(set).toHaveBeenCalledWith('key', 'encoded value', 'PX', ttl ?? 60000);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, 2147483648, '1000', null])(
    '非法 TTL %s 在 Service 和独立 Store 入口均被拒绝',
    async (value) => {
      const ttl = value as number;
      const cache = { set: vi.fn(), wrap: vi.fn() };
      const service = new CacheService(cache as unknown as Cache);
      await expect(service.set('key', 'value', ttl)).rejects.toThrow(RangeError);
      await expect(service.wrap('key', async () => 'value', ttl)).rejects.toThrow(RangeError);
      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.wrap).not.toHaveBeenCalled();

      // 缓存关闭时，底层 Store 也必须先校验 TTL。
      const store = new RedisStore({} as RedisConnection, 60000);
      await expect(store.set('key', 'encoded value', ttl)).rejects.toThrow('缓存 TTL 必须是正整数毫秒');
    },
  );

  it('store 同样校验默认 TTL，关闭时合法写入不创建连接', async () => {
    const connection = {} as RedisConnection;
    await expect(new RedisStore(connection, 0).set('key', 'encoded')).rejects.toThrow(RangeError);
    expect(await new RedisStore(connection, 60000).set('key', 'encoded')).toBe(true);
  });
});
