import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { assertKey, assertTtl, deleteByPrefix } from './cache.utils.js';
import { RedisClient } from './redis.client.js';

const INCREMENT = `
local value = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) == -1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return {value, redis.call('PTTL', KEYS[1])}
`;
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;
const EXTEND = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`;

export interface RedisLock {
  /** 锁的租约过期后，release/extend 返回 false，不操作其他持有者的锁。 */
  release: () => Promise<boolean>;
  extend: (ttl: number) => Promise<boolean>;
}

export class RedisLockBusyError extends Error {
  constructor() {
    super('Redis 锁已被占用');
    this.name = 'RedisLockBusyError';
  }
}

export class RedisLockLostError extends Error {
  constructor() {
    super('Redis 锁租约已失效');
    this.name = 'RedisLockLostError';
  }
}

/** 严格 Redis 操作：故障抛出，适合验证码、会话、幂等和分布式协调。 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(RedisClient) private readonly redis: RedisClient) {}

  /** 原生 Hash/Set/ZSet/List、Lua、MULTI 均复用这一客户端；key 必须通过 key() 构造。 */
  get client(): RedisClient['ready'] {
    return this.redis.ready;
  }

  /** 原生高级操作也可经过统一时限；不自动重试，也不取消已发送的服务端命令。 */
  execute<T>(operation: (client: RedisClient['ready']) => Promise<T>): Promise<T> {
    return this.redis.run(() => operation(this.client));
  }

  key(key: string): string {
    assertKey(key);
    return `${this.redis.config.keyPrefix}:data:${key}`;
  }

  get(key: string): Promise<string | null> {
    return this.execute(client => client.get(this.key(key)));
  }

  async set(key: string, value: string, ttl = this.redis.config.ttl): Promise<void> {
    assertTtl(ttl);
    await this.execute(client => client.set(
      this.key(key),
      value,
      ttl === 0 ? undefined : { expiration: { type: 'PX', value: ttl } },
    ));
  }

  /** SET NX PX 原子占位，适合幂等标记；失败不会覆盖值或重置 TTL。 */
  async setIfAbsent(key: string, value: string, ttl: number): Promise<boolean> {
    assertTtl(ttl, false);
    return (
      (await this.execute(client => client.set(this.key(key), value, {
        condition: 'NX',
        expiration: { type: 'PX', value: ttl },
      }))) === 'OK'
    );
  }

  /** GETDEL 原子取走一次性令牌/验证码，避免并发重复消费。 */
  consume(key: string): Promise<string | null> {
    return this.execute(client => client.getDel(this.key(key)));
  }

  async del(...keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    return this.execute(client => client.unlink(keys.map((key) => this.key(key))));
  }

  ttl(key: string): Promise<number> {
    return this.execute(client => client.pTTL(this.key(key)));
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    assertTtl(ttl, false);
    return (await this.execute(client => client.pExpire(this.key(key), ttl))) === 1;
  }

  deleteByPrefix(prefix: string): Promise<number> {
    return this.execute(client => deleteByPrefix(client, this.key(prefix)));
  }

  /** 原子计数并在首次写入时设置窗口，后续递增不延长 TTL，适合登录失败计数/固定窗口限流。 */
  async increment(key: string, ttl: number, amount = 1): Promise<{ value: number; ttl: number }> {
    assertTtl(ttl, false);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new TypeError('amount 必须是正安全整数');
    const result = (await this.execute(client => client.eval(INCREMENT, {
      keys: [this.key(key)],
      arguments: [String(amount), String(ttl)],
    }))) as [number, number];
    return { value: result[0], ttl: result[1] };
  }

  async acquireLock(key: string, ttl: number): Promise<RedisLock | undefined> {
    assertKey(key);
    assertTtl(ttl, false);
    const lockKey = `${this.redis.config.keyPrefix}:lock:${key}`;
    const token = randomUUID();
    const result = await this.execute(client => client.set(lockKey, token, {
      condition: 'NX',
      expiration: { type: 'PX', value: ttl },
    }));
    if (result !== 'OK') return undefined;
    return {
      release: async () =>
        (await this.execute(client => client.eval(RELEASE, { keys: [lockKey], arguments: [token] }))) === 1,
      extend: async (leaseTtl) => {
        assertTtl(leaseTtl, false);
        return (
          (await this.execute(client => client.eval(EXTEND, {
            keys: [lockKey],
            arguments: [token, String(leaseTtl)],
          }))) === 1
        );
      },
    };
  }

  /** 不等待竞争、不自动续租；任务应在 ttl 内结束，长任务可显式 lease.extend()。 */
  async withLock<T>(key: string, ttl: number, task: (lease: RedisLock) => Promise<T>): Promise<T> {
    const lease = await this.acquireLock(key, ttl);
    if (!lease) throw new RedisLockBusyError();
    try {
      const value = await task(lease);
      if (!(await lease.release())) throw new RedisLockLostError();
      return value;
    } catch (error) {
      try {
        await lease.release();
      } catch {
        this.logger.warn('释放 Redis 锁失败，将由租约 TTL 回收');
      }
      throw error;
    }
  }

  health() {
    return this.redis.health();
  }
}
