import { describe, expect, it, vi } from 'vitest';
import { CacheUnavailableError } from './cache.error.js';
import { RedisClient } from './redis.client.js';
import { RedisService } from './redis.service.js';

type RedisCommandMock = ReturnType<typeof vi.fn>;

interface FakeClient {
  status: string;
  ping: RedisCommandMock;
  get: RedisCommandMock;
  mget: RedisCommandMock;
  set: RedisCommandMock;
  del: RedisCommandMock;
  unlink: RedisCommandMock;
  exists: RedisCommandMock;
  pttl: RedisCommandMock;
}

function createClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    status: 'ready',
    ping: vi.fn().mockResolvedValue('PONG'),
    get: vi.fn().mockResolvedValue(null),
    mget: vi.fn().mockResolvedValue([]),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
    unlink: vi.fn().mockResolvedValue(0),
    exists: vi.fn().mockResolvedValue(0),
    pttl: vi.fn().mockResolvedValue(-2),
    ...overrides,
  };
}

function createService(options: {
  enabled?: boolean;
  ready?: boolean;
  client?: FakeClient | undefined;
} = {}): { service: RedisService; client: FakeClient | undefined } {
  const client = 'client' in options ? options.client : createClient();
  const connection = {
    enabled: options.enabled ?? true,
    isReady: options.ready ?? true,
    client,
  } as unknown as RedisClient;
  return { service: new RedisService(connection), client };
}

describe('redisService', () => {
  it('未启用时报告 disabled 且所有命令快速失败', async () => {
    const { service, client } = createService({ enabled: false, client: undefined });
    expect(service.enabled).toBe(false);
    expect(await service.health()).toEqual({ status: 'disabled', latencyMs: 0 });
    await expect(service.get('key')).rejects.toThrow('Redis 缓存未启用');
    expect(client).toBeUndefined();
  });

  it('连接未就绪时直接失败，不调用底层客户端', async () => {
    const client = createClient({ status: 'reconnecting' });
    const { service } = createService({ ready: false, client });
    await expect(service.get('key')).rejects.toThrow('Redis 缓存命令执行失败');
    expect(client.get).not.toHaveBeenCalled();
  });

  it('透传 GET/MGET/SET/DEL/UNLINK/EXISTS/PTTL 命令', async () => {
    const client = createClient({
      get: vi.fn().mockResolvedValue('value'),
      mget: vi.fn().mockResolvedValue(['a', null]),
      del: vi.fn().mockResolvedValue(1),
      unlink: vi.fn().mockResolvedValue(2),
      exists: vi.fn().mockResolvedValue(1),
      pttl: vi.fn().mockResolvedValue(5000),
    });
    const { service } = createService({ client });

    await expect(service.get('key')).resolves.toBe('value');
    await expect(service.mget(['a', 'b'])).resolves.toEqual(['a', null]);
    await service.set('key', 'v1:value', 1000);
    await expect(service.del('key')).resolves.toBe(true);
    await expect(service.delMany(['a', 'b'])).resolves.toBe(2);
    await expect(service.exists('key')).resolves.toBe(true);
    await expect(service.pttl('key')).resolves.toBe(5000);

    expect(client.set).toHaveBeenCalledWith('key', 'v1:value', 'PX', 1000);
    expect(client.unlink).toHaveBeenCalledWith('a', 'b');
  });

  it('空批量命令不访问 Redis', async () => {
    const { service, client } = createService();
    await expect(service.mget([])).resolves.toEqual([]);
    await expect(service.delMany([])).resolves.toBe(0);
    expect(client?.mget).not.toHaveBeenCalled();
    expect(client?.unlink).not.toHaveBeenCalled();
  });

  it('把命令异常转换为稳定错误并保留 cause', async () => {
    const cause = new Error('WRONGTYPE raw detail');
    const client = createClient({ get: vi.fn().mockRejectedValue(cause) });
    const { service } = createService({ client });

    const error = await service.get('key').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CacheUnavailableError);
    expect(error).toMatchObject({ code: 'CACHE_UNAVAILABLE', message: 'Redis 缓存命令执行失败' });
    expect((error as CacheUnavailableError).cause).toBe(cause);
  });

  it('健康检查区分 up/down 并报告耗时', async () => {
    const up = createService();
    const upHealth = await up.service.health();
    expect(upHealth.status).toBe('up');
    expect(upHealth.latencyMs).toBeGreaterThanOrEqual(0);

    const down = createService({
      client: createClient({ ping: vi.fn().mockRejectedValue(new Error('ECONNRESET')) }),
    });
    await expect(down.service.health()).resolves.toMatchObject({
      status: 'down',
      error: 'Redis 不可用',
    });
  });

  it('execute 为 pipeline/Lua 等高级命令提供受控逃生口', async () => {
    const { service, client } = createService();
    const operation = vi.fn().mockResolvedValue('result');
    await expect(service.execute(operation)).resolves.toBe('result');
    expect(operation).toHaveBeenCalledWith(client);
  });
});
