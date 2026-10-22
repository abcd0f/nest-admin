import { createCache } from 'cache-manager';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redisDomain } from '../../config/src/domains/redis.domain.js';
import { CacheService } from './cache.service.js';
import { RedisClient } from './redis.client.js';

function fixture() {
  const owner = new RedisClient(redisDomain.parse({}, { environment: 'test' }));
  // 使用真实 cache-manager 内存适配器测试缓存策略，不建立网络连接。
  owner.config.enabled = true;
  const manager = createCache();
  const service = new CacheService(manager, owner);
  return { service, manager };
}

afterEach(() => vi.restoreAllMocks());

describe('缓存服务回源策略', () => {
  it.each([null, false, 0, ''])('有效缓存值 %s 不触发回源', async (value) => {
    const { service } = fixture();
    await service.set('value', value);
    const loader = vi.fn(async () => 'unexpected');
    expect(await service.wrap('value', loader)).toBe(value);
    expect(loader).not.toHaveBeenCalled();
  });

  it('合并并发加载；失败后清理占位并允许下一次重试', async () => {
    const { service } = fixture();
    const failure = new Error('database unavailable');
    const loader = vi.fn(async () => {
      throw failure;
    });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.wrap('user', loader)));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every(result => result.status === 'rejected' && result.reason === failure)).toBe(true);
    expect(await service.wrap('user', async () => ({ id: 1 }))).toEqual({ id: 1 });
  });

  it('缓存回填失败保留业务结果；显式写入失败抛出', async () => {
    const { service, manager } = fixture();
    vi.spyOn(manager, 'set').mockRejectedValue(new Error('write failed'));
    expect(await service.wrap('user', async () => ({ id: 1 }))).toEqual({ id: 1 });
    await expect(service.set('user', 1)).rejects.toThrow('Redis 缓存命令执行失败');
    expect(service.getMetrics().errors).toBe(2);
  });

  it('undefined 不缓存；参数错误在调用存储前被拒绝', async () => {
    const { service, manager } = fixture();
    const loader = vi.fn(async () => undefined);
    await service.wrap('missing', loader);
    await service.wrap('missing', loader);
    expect(loader).toHaveBeenCalledTimes(2);
    const write = vi.spyOn(manager, 'set');
    await expect(service.set('bad', undefined)).rejects.toThrow('undefined');
    await expect(service.set('bad', 1, -1)).rejects.toThrow('TTL');
    await expect(service.get(' ')).rejects.toThrow('key');
    expect(write).not.toHaveBeenCalled();
  });
});
