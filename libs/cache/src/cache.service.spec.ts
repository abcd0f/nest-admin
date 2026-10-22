import { describe, expect, it, vi } from 'vitest';
import { redisDomain } from '../../config/src/domains/redis.domain.js';
import { encodeCacheValue } from './cache-codec.js';
import { CacheService } from './cache.service.js';
import { RedisService } from './redis.service.js';

const context = { environment: 'test' } as const;

class FakeRedis {
  enabled = true;
  readonly store = new Map<string, string>();
  readonly getCalls: string[] = [];
  readonly setCalls: Array<{ key: string; value: string; ttl: number }> = [];
  readonly delCalls: string[] = [];
  readonly delManyCalls: string[][] = [];

  async get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    return this.store.get(key) ?? null;
  }

  async mget(keys: readonly string[]): Promise<(string | null)[]> {
    return keys.map((key) => this.store.get(key) ?? null);
  }

  async set(key: string, value: string, ttl: number): Promise<void> {
    this.setCalls.push({ key, value, ttl });
    this.store.set(key, value);
  }

  async del(key: string): Promise<boolean> {
    this.delCalls.push(key);
    return this.store.delete(key);
  }

  async delMany(keys: readonly string[]): Promise<number> {
    this.delManyCalls.push([...keys]);
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) deleted++;
    }
    return deleted;
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async pttl(key: string): Promise<number> {
    return this.store.has(key) ? 1000 : -2;
  }

  async health() {
    return { status: 'up' as const, latencyMs: 0 };
  }
}

function createConfig(overrides: Record<string, unknown> = {}) {
  return redisDomain.parse({ enabled: true, ...overrides }, context);
}

function createService(fake = new FakeRedis(), overrides: Record<string, unknown> = {}) {
  const service = new CacheService(fake as unknown as RedisService, createConfig(overrides));
  return { service, fake };
}

describe('cacheService 读取', () => {
  it('命中时解码版本化值，并使用完整前缀键', async () => {
    const { service, fake } = createService();
    fake.store.set('nest-admin:cache:users:1', encodeCacheValue({ id: 1 }, 1024));

    await expect(service.get('users:1')).resolves.toEqual({ id: 1 });
    expect(fake.getCalls).toEqual(['nest-admin:cache:users:1']);
    expect(service.getMetrics()).toMatchObject({ hits: 1, misses: 0 });
  });

  it('jSON 原始类型与 null 不会被当成未命中', async () => {
    const { service, fake } = createService();
    fake.store.set('nest-admin:cache:null', encodeCacheValue(null, 1024));
    fake.store.set('nest-admin:cache:false', encodeCacheValue(false, 1024));
    fake.store.set('nest-admin:cache:zero', encodeCacheValue(0, 1024));
    fake.store.set('nest-admin:cache:empty', encodeCacheValue('', 1024));

    await expect(service.get('null')).resolves.toBeNull();
    await expect(service.get('false')).resolves.toBe(false);
    await expect(service.get('zero')).resolves.toBe(0);
    await expect(service.get('empty')).resolves.toBe('');
    expect(service.getMetrics()).toMatchObject({ hits: 4, misses: 0 });
  });

  it('未命中、旧格式和损坏值都按未命中降级', async () => {
    const { service, fake } = createService();
    fake.store.set('nest-admin:cache:legacy', '{"id":1}');
    fake.store.set('nest-admin:cache:broken', 'v1:{');

    await expect(service.get('missing')).resolves.toBeUndefined();
    await expect(service.get('legacy')).resolves.toBeUndefined();
    await expect(service.get('broken')).resolves.toBeUndefined();

    expect(service.getMetrics()).toMatchObject({ hits: 0, misses: 2, decodeErrors: 1 });
  });

  it('读取命令失败按未命中降级并计数', async () => {
    const { service, fake } = createService();
    vi.spyOn(fake, 'get').mockRejectedValue(new Error('connection lost'));

    await expect(service.get('key')).resolves.toBeUndefined();
    expect(service.getMetrics()).toMatchObject({ readErrors: 1, hits: 0, misses: 0 });
  });

  it('批量读取混合命中、未命中与旧格式', async () => {
    const { service, fake } = createService();
    fake.store.set('nest-admin:cache:a', encodeCacheValue('A', 1024));
    fake.store.set('nest-admin:cache:b', 'legacy');

    await expect(service.getMany(['a', 'b', 'c'])).resolves.toEqual(['A', undefined, undefined]);
    expect(service.getMetrics()).toMatchObject({ hits: 1, misses: 2 });
  });

  it('批量读取失败时整体按未命中降级', async () => {
    const { service, fake } = createService();
    vi.spyOn(fake, 'mget').mockRejectedValue(new Error('down'));

    await expect(service.getMany(['a', 'b'])).resolves.toEqual([undefined, undefined]);
    expect(service.getMetrics()).toMatchObject({ readErrors: 1 });
  });

  it('空键列表不访问 Redis', async () => {
    const { service, fake } = createService();
    await expect(service.getMany([])).resolves.toEqual([]);
    expect(fake.getCalls).toHaveLength(0);
  });
});

describe('cacheService 写入与删除', () => {
  it('写入版本化 JSON 与默认 TTL，并能读回', async () => {
    const { service, fake } = createService();
    await service.set('users:1', { id: 1, roles: ['reader'] });

    expect(fake.setCalls).toHaveLength(1);
    expect(fake.setCalls[0]).toMatchObject({
      key: 'nest-admin:cache:users:1',
      ttl: 60000,
    });
    expect(fake.setCalls[0].value.startsWith('v1:')).toBe(true);
    await expect(service.get('users:1')).resolves.toEqual({ id: 1, roles: ['reader'] });
    expect(service.getMetrics()).toMatchObject({ sets: 1, hits: 1 });
  });

  it('显式 TTL 覆盖默认值', async () => {
    const { service, fake } = createService();
    await service.set('key', false, 250);
    expect(fake.setCalls[0].ttl).toBe(250);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, 2147483648, '1000', null])(
    '非法 TTL %j 在访问 Redis 前被拒绝',
    async (ttl) => {
      const { service, fake } = createService();
      await expect(service.set('key', 'value', ttl as number)).rejects.toThrow(RangeError);
      expect(fake.setCalls).toHaveLength(0);
    },
  );

  it('拒绝空键、控制字符、undefined 和不可序列化值', async () => {
    const { service, fake } = createService();
    await expect(service.set('', 'value')).rejects.toThrow(TypeError);
    await expect(service.set('bad\u0000key', 'value')).rejects.toThrow('控制字符');
    await expect(service.set('key', undefined as never)).rejects.toThrow(TypeError);
    await expect(service.set('key', 1n as never)).rejects.toThrow(TypeError);
    expect(fake.setCalls).toHaveLength(0);
  });

  it('拒绝超过配置上限的值', async () => {
    const { service } = createService(new FakeRedis(), { 'max-value-bytes': 8 });
    await expect(service.set('key', 'value-too-large')).rejects.toThrow('不能超过 8 字节');
  });

  it('删除返回是否命中，并累计删除数量', async () => {
    const { service, fake } = createService();
    fake.store.set('nest-admin:cache:a', 'v1:1');
    fake.store.set('nest-admin:cache:b', 'v1:2');

    await expect(service.del('a')).resolves.toBe(true);
    await expect(service.del('missing')).resolves.toBe(false);

    await expect(service.delMany(['a', 'a', 'b', 'missing'])).resolves.toBe(1);
    expect(fake.delManyCalls[0]).toEqual([
      'nest-admin:cache:a',
      'nest-admin:cache:b',
      'nest-admin:cache:missing',
    ]);
    expect(service.getMetrics()).toMatchObject({ deletes: 2 });
  });

  it('删除失败抛出错误并计数', async () => {
    const { service, fake } = createService();
    vi.spyOn(fake, 'del').mockRejectedValue(new Error('down'));

    await expect(service.del('key')).rejects.toThrow('down');
    expect(service.getMetrics()).toMatchObject({ deleteErrors: 1 });
  });

  it('存在性与 TTL 查询遵循读取降级契约', async () => {
    const { service, fake } = createService();
    fake.store.set('nest-admin:cache:key', 'v1:"value"');

    await expect(service.has('key')).resolves.toBe(true);
    await expect(service.has('missing')).resolves.toBe(false);
    await expect(service.ttl('key')).resolves.toBe(1000);
    await expect(service.ttl('missing')).resolves.toBe(-2);

    vi.spyOn(fake, 'exists').mockRejectedValue(new Error('down'));
    await expect(service.has('key')).resolves.toBe(false);
    expect(service.getMetrics()).toMatchObject({ readErrors: 1 });

    vi.spyOn(fake, 'pttl').mockRejectedValue(new Error('down'));
    await expect(service.ttl('key')).rejects.toThrow('down');
    expect(service.getMetrics()).toMatchObject({ readErrors: 2 });
  });
});

describe('cacheService wrap', () => {
  it('未命中时执行 loader、写回并复用缓存', async () => {
    const { service, fake } = createService();
    const loader = vi.fn(async () => ({ id: 7 }));

    await expect(service.wrap('wrap', loader, 1000)).resolves.toEqual({ id: 7 });
    await expect(service.wrap('wrap', loader, 1000)).resolves.toEqual({ id: 7 });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(fake.setCalls).toHaveLength(1);
    expect(fake.setCalls[0].ttl).toBe(1000);
  });

  it('合并同键并发加载，只执行一次 loader', async () => {
    const { service } = createService();
    const loader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id: 7 };
    });

    const results = await Promise.all([
      service.wrap('wrap', loader, 1000),
      service.wrap('wrap', loader, 1000),
      service.wrap('wrap', loader, 1000),
    ]);

    expect(results).toEqual([{ id: 7 }, { id: 7 }, { id: 7 }]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(service.getMetrics()).toMatchObject({ coalesced: 2, sets: 1 });
  });

  it('loader 返回 undefined 时不写缓存，下次调用重新加载', async () => {
    const { service, fake } = createService();
    const loader = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('loaded') as unknown as () => Promise<string>;

    await expect(service.wrap('key', loader)).resolves.toBeUndefined();
    expect(fake.setCalls).toHaveLength(0);
    await expect(service.wrap('key', loader)).resolves.toBe('loaded');
    expect(fake.setCalls).toHaveLength(1);
  });

  it('loader 失败后清理 single-flight，后续调用可重试', async () => {
    const { service } = createService();
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('loader failed'))
      .mockResolvedValueOnce('loaded');

    await expect(service.wrap('key', loader)).rejects.toThrow('loader failed');
    await expect(service.wrap('key', loader)).resolves.toBe('loaded');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('写回失败会让 wrap 失败，避免调用方误以为缓存已生效', async () => {
    const { service, fake } = createService();
    vi.spyOn(fake, 'set').mockRejectedValue(new Error('write failed'));

    await expect(service.wrap('key', async () => 'value')).rejects.toThrow('write failed');
    expect(service.getMetrics()).toMatchObject({ writeErrors: 1 });
  });
});

describe('cacheService 配置与观测', () => {
  it('tTL 抖动只在配置范围内缩短 TTL，且不会低于 1 毫秒', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const { service, fake } = createService(new FakeRedis(), {
        ttl: 1000,
        'ttl-jitter': 100,
      });
      await service.set('key', 'value');
      expect(fake.setCalls[0].ttl).toBe(500);
    } finally {
      random.mockRestore();
    }
  });

  it('缓存关闭时仍校验参数，但不创建任何 Redis 交互', async () => {
    const fake = new FakeRedis();
    fake.enabled = false;
    const { service } = createService(fake);

    await service.set('key', 'value');
    await expect(service.get('key')).resolves.toBeUndefined();
    await expect(service.del('key')).resolves.toBe(false);
    await expect(service.delMany(['key'])).resolves.toBe(0);
    await expect(service.has('key')).resolves.toBe(false);
    await expect(service.ttl('key')).resolves.toBe(-2);

    const loader = vi.fn(async () => ({ id: 1 }));
    await expect(service.wrap('key', loader, 1000)).resolves.toEqual({ id: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fake.setCalls).toHaveLength(0);

    await expect(service.set('key', 'value', 0)).rejects.toThrow(RangeError);
  });

  it('暴露健康状态与可重置的进程内指标', async () => {
    const { service } = createService();
    await expect(service.health()).resolves.toEqual({ status: 'up', latencyMs: 0 });

    await service.set('key', 'value');
    await service.get('key');
    expect(service.getMetrics()).toMatchObject({ sets: 1, hits: 1 });

    service.resetMetrics();
    expect(service.getMetrics()).toMatchObject({ sets: 0, hits: 0, misses: 0 });
  });
});
