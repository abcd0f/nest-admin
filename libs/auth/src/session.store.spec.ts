import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from './session.store.js';

function fixture() {
  const evalScript = vi.fn().mockResolvedValue(1);
  const redis = {
    get: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    setIfAbsent: vi.fn().mockResolvedValue(true),
    key: (key: string) => `test:data:${key}`,
    execute: vi.fn((operation: (client: unknown) => unknown) => operation({ eval: evalScript })),
    del: vi.fn().mockResolvedValue(2),
  };
  return { redis, evalScript, store: new SessionStore(redis as never) };
}

describe('会话存储边界', () => {
  it('轮换在一次 Lua 调用中完成，key 经现有 Redis 命名空间处理', async () => {
    const { store, evalScript } = fixture();
    const sid = randomUUID();
    await store.rotate(sid, 'old-hash', 'new-hash');
    expect(evalScript).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      keys: [`test:data:auth:session:${sid}`, `test:data:auth:used:${sid}`],
      arguments: ['old-hash', 'new-hash'],
    });
    evalScript.mockResolvedValueOnce(0);
    await expect(store.rotate(sid, 'old-hash', 'new-hash')).rejects.toThrow(UnauthorizedException);
  });

  it('缺失/过期会话返回 401，损坏内容返回 503', async () => {
    const { store, redis } = fixture();
    const sid = randomUUID();
    await expect(store.get(sid)).rejects.toThrow(UnauthorizedException);
    redis.get.mockResolvedValueOnce('not-json');
    await expect(store.get(sid)).rejects.toThrow(ServiceUnavailableException);
    redis.get.mockResolvedValueOnce(
      JSON.stringify({ userId: '1', refreshHash: '0'.repeat(64), expiresAt: Date.now() - 1 }),
    );
    await expect(store.get(sid)).rejects.toThrow(UnauthorizedException);
  });

  it('redis 故障映射为 503，不回显底层错误', async () => {
    const { store, redis } = fixture();
    redis.get.mockRejectedValueOnce(new Error('private redis connection detail'));
    await expect(store.get(randomUUID())).rejects.toThrow('认证服务不可用');
    redis.del.mockRejectedValueOnce(new Error('offline'));
    await expect(store.revoke(randomUUID())).rejects.toThrow(ServiceUnavailableException);
  });
});
