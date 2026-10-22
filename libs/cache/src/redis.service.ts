import type { Redis } from 'ioredis';
import { Injectable } from '@nestjs/common';
import { CacheUnavailableError } from './cache.error.js';
import { RedisClient } from './redis.client.js';

export type RedisHealthStatus = 'up' | 'down' | 'disabled';

export interface RedisHealth {
  status: RedisHealthStatus;
  latencyMs: number;
  /** 仅包含稳定、无敏感信息的摘要。 */
  error?: string;
}

/**
 * Redis 命令门面。
 *
 * 所有命令都在这里统一做三件事：
 * 1. 未启用/未就绪时快速失败，不触碰连接；
 * 2. 把 ioredis 异常转换为稳定的 CacheUnavailableError，屏蔽连接串和凭据；
 * 3. 为上层提供无 Redis 类型泄漏的窄接口。
 *
 * 这里不做序列化、TTL 策略和降级决策，那些属于 CacheService。
 */
@Injectable()
export class RedisService {
  constructor(private readonly connection: RedisClient) {}

  get enabled(): boolean {
    return this.connection.enabled;
  }

  get isReady(): boolean {
    return this.connection.isReady;
  }

  async ping(): Promise<boolean> {
    const pong = await this.run((redis) => redis.ping());
    return pong === 'PONG';
  }

  async health(): Promise<RedisHealth> {
    if (!this.connection.enabled) return { status: 'disabled', latencyMs: 0 };

    const startedAt = Date.now();
    try {
      await this.ping();
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: 'Redis 不可用',
      };
    }
  }

  async get(key: string): Promise<string | null> {
    return this.run((redis) => redis.get(key));
  }

  async mget(keys: readonly string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    return this.run((redis) => redis.mget(...keys));
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.run((redis) => redis.set(key, value, 'PX', ttlMs));
  }

  async del(key: string): Promise<boolean> {
    return (await this.run((redis) => redis.del(key))) > 0;
  }

  async delMany(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    // UNLINK 在后台线程释放内存，避免大键删除阻塞 Redis 主线程。
    return this.run((redis) => redis.unlink(...keys));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.run((redis) => redis.exists(key))) > 0;
  }

  async pttl(key: string): Promise<number> {
    return this.run((redis) => redis.pttl(key));
  }

  /**
   * 受控逃生口：需要 pipeline、Lua 或模块命令时使用。
   * 调用方仍需通过 CacheService 或本类完成参数校验，不得把用户输入直接拼进命令。
   */
  execute<T>(operation: (redis: Redis) => Promise<T>): Promise<T> {
    return this.run(operation);
  }

  private async run<T>(operation: (redis: Redis) => Promise<T>): Promise<T> {
    if (!this.connection.enabled) {
      throw new CacheUnavailableError('Redis 缓存未启用');
    }

    const redis = this.connection.client;
    if (!redis || redis.status !== 'ready') {
      throw new CacheUnavailableError();
    }

    try {
      return await operation(redis);
    } catch (cause) {
      // 保留 cause 供进程内日志/调试，但不把其消息拼进对外错误。
      throw new CacheUnavailableError('Redis 缓存命令执行失败', { cause });
    }
  }
}
