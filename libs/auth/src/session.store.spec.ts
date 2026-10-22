import type { AuthSession } from './session.store.js';
import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from './session.store.js';

function session(extra: Partial<AuthSession> = {}): AuthSession {
  return {
    userId: '1',
    refreshHash: '0'.repeat(64),
    expiresAt: Date.now() + 60_000,
    roles: ['operator'],
    permissions: ['system:user:list'],
    ...extra,
  };
}

function fixture() {
  const evalScript = vi.fn().mockResolvedValue(1);
  const multi = {
    sAdd: vi.fn().mockReturnThis(),
    pExpire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  const client = {
    eval: evalScript,
    sMembers: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(2),
    multi: vi.fn(() => multi),
  };
  const redis = {
    get: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    setIfAbsent: vi.fn().mockResolvedValue(true),
    key: (key: string) => `test:data:${key}`,
    execute: vi.fn((operation: (value: unknown) => unknown) => operation(client)),
    del: vi.fn().mockResolvedValue(2),
  };
  return { redis, client, multi, evalScript, store: new SessionStore(redis as never) };
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

  it('创建会话时把 sid 写入用户索引并同步 TTL，供权限变更批量踢人', async () => {
    const { store, multi, redis } = fixture();
    const sid = randomUUID();
    await store.create(sid, session());
    expect(redis.setIfAbsent).toHaveBeenCalledExactlyOnceWith(
      `auth:session:${sid}`,
      expect.stringContaining('"roles":["operator"]'),
      expect.any(Number),
    );
    expect(multi.sAdd).toHaveBeenCalledExactlyOnceWith('test:data:auth:user:1', sid);
    expect(multi.pExpire).toHaveBeenCalledExactlyOnceWith(
      'test:data:auth:user:1',
      expect.any(Number),
    );
    expect(multi.exec).toHaveBeenCalledOnce();
  });

  it('索引写入失败时抛出，不留无法撤销的会话', async () => {
    const { store, multi } = fixture();
    multi.exec.mockRejectedValueOnce(new Error('private redis detail'));
    await expect(store.create(randomUUID(), session())).rejects.toThrow(ServiceUnavailableException);
  });

  it('缺失/过期会话返回 401，损坏内容或缺失快照返回 503', async () => {
    const { store, redis } = fixture();
    const sid = randomUUID();
    await expect(store.get(sid)).rejects.toThrow(UnauthorizedException);
    redis.get.mockResolvedValueOnce('not-json');
    await expect(store.get(sid)).rejects.toThrow(ServiceUnavailableException);
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        userId: '1',
        refreshHash: '0'.repeat(64),
        expiresAt: Date.now() - 1,
        roles: [],
        permissions: [],
      }),
    );
    await expect(store.get(sid)).rejects.toThrow(UnauthorizedException);
    // 旧格式会话（没有 roles/permissions）不能被当成空权限放行。
    redis.get.mockResolvedValueOnce(
      JSON.stringify({ userId: '1', refreshHash: '0'.repeat(64), expiresAt: Date.now() + 60_000 }),
    );
    await expect(store.get(sid)).rejects.toThrow(ServiceUnavailableException);
  });

  it('按用户撤销会话，同时清理会话、重放集合与索引', async () => {
    const { store, client } = fixture();
    client.sMembers.mockResolvedValueOnce(['a', 'b']);
    expect(await store.revokeUser('1')).toBe(2);
    expect(client.sMembers).toHaveBeenCalledExactlyOnceWith('test:data:auth:user:1');
    expect(client.unlink).toHaveBeenCalledExactlyOnceWith([
      'test:data:auth:session:a',
      'test:data:auth:used:a',
      'test:data:auth:session:b',
      'test:data:auth:used:b',
      'test:data:auth:user:1',
    ]);
  });

  it('没有会话索引时不执行删除，非法用户 ID 不访问 Redis', async () => {
    const { store, client } = fixture();
    expect(await store.revokeUser('1')).toBe(0);
    expect(client.unlink).not.toHaveBeenCalled();
    for (const id of ['', '0', '01', ' 1']) {
      await expect(store.revokeUser(id)).rejects.toThrow(UnauthorizedException);
    }
    expect(client.sMembers).toHaveBeenCalledTimes(1);
  });

  it('redis 故障映射为 503，不回显底层错误', async () => {
    const { store, redis } = fixture();
    redis.get.mockRejectedValueOnce(new Error('private redis connection detail'));
    await expect(store.get(randomUUID())).rejects.toThrow('认证服务不可用');
    redis.del.mockRejectedValueOnce(new Error('offline'));
    await expect(store.revoke(randomUUID())).rejects.toThrow(ServiceUnavailableException);
  });
});
