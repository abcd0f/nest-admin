import type { OnModuleDestroy } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { assertKey, assertTtl, deleteByPrefix } from './cache.utils.js';
import { RedisClient } from './redis.client.js';

/** JSON 缓存：读故障视为未命中；显式写入、删除故障抛出，避免虚假成功。 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly pending = new Map<string, Promise<unknown>>();
  private metrics = { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0 };

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Inject(RedisClient) private readonly redis: RedisClient,
  ) {
    this.cache.on('get', this.onRead);
    this.cache.on('mget', this.onRead);
  }

  private readonly onRead = (event: { error?: unknown }) => {
    if (event.error) {
      this.metrics.errors++;
      this.logger.warn('Redis 缓存读取失败，按未命中处理');
    }
  };

  onModuleDestroy(): void {
    this.cache.off('get', this.onRead);
    this.cache.off('mget', this.onRead);
  }

  async get<T>(key: string): Promise<T | undefined> {
    assertKey(key);
    const value = this.redis.config.enabled
      ? await this.read(() => this.cache.get<T>(key), undefined)
      : undefined;
    if (value === undefined) this.metrics.misses++;
    else this.metrics.hits++;
    return value;
  }

  async set<T>(key: string, value: T, ttl = this.redis.config.ttl): Promise<void> {
    assertKey(key);
    assertTtl(ttl);
    if (value === undefined) throw new TypeError('undefined 表示缓存未命中，不能作为缓存值');
    if (!this.redis.config.enabled) return;
    await this.write(() => this.cache.set(key, value, ttl));
    this.metrics.sets++;
  }

  async getMany<T>(keys: string[]): Promise<Array<T | undefined>> {
    keys.forEach(assertKey);
    if (!keys.length) return [];
    const values = this.redis.config.enabled
      ? await this.read(() => this.cache.mget<T>(keys), keys.map(() => undefined))
      : keys.map(() => undefined);
    for (const value of values) {
      if (value === undefined) this.metrics.misses++;
      else this.metrics.hits++;
    }
    return values;
  }

  async setMany<T>(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
    for (const entry of entries) {
      assertKey(entry.key);
      assertTtl(entry.ttl ?? this.redis.config.ttl);
      if (entry.value === undefined) throw new TypeError('undefined 不能作为缓存值');
    }
    if (!this.redis.config.enabled || !entries.length) return;
    await this.write(() => this.cache.mset(entries));
    this.metrics.sets += entries.length;
  }

  async del(key: string): Promise<void> {
    await this.delMany([key]);
  }

  async delMany(keys: string[]): Promise<void> {
    keys.forEach(assertKey);
    if (!this.redis.config.enabled || !keys.length) return;
    await this.write(() => this.redis.ready.unlink(keys.map((key) => this.storageKey(key))));
    this.metrics.deletes += keys.length;
  }

  /** 同一进程内相同 key 合并回源；null 可用于缓存不存在的记录。 */
  wrap<T>(key: string, loader: () => Promise<T>, ttl = this.redis.config.ttl): Promise<T> {
    assertKey(key);
    assertTtl(ttl);
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const loading = (async () => {
      const cached = await this.get<T>(key);
      if (cached !== undefined) return cached;
      const value = await loader();
      if (value !== undefined) {
        try {
          await this.set(key, value, ttl);
        } catch {
          this.logger.warn('缓存回填失败，返回已加载的业务结果');
        }
      }
      return value;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, loading);
    return loading;
  }

  /** 返回 Redis 剩余毫秒数：-2 不存在，-1 永不过期。 */
  async ttl(key: string): Promise<number> {
    assertKey(key);
    if (!this.redis.config.enabled) return -2;
    return this.redis.run(() => this.redis.ready.pTTL(this.storageKey(key)));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    assertKey(prefix);
    if (!this.redis.config.enabled) return 0;
    return this.write(() => deleteByPrefix(this.redis.ready, this.storageKey(prefix)));
  }

  async clear(): Promise<void> {
    if (this.redis.config.enabled) await this.write(() => this.cache.clear());
  }

  health() {
    return this.redis.health();
  }

  getMetrics() {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics = { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0 };
  }

  private storageKey(key: string): string {
    return `${this.redis.config.keyPrefix}:cache:${key}`;
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.redis.run(operation);
    } catch (cause) {
      this.metrics.errors++;
      throw new Error('Redis 缓存命令执行失败', { cause });
    }
  }

  private async read<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await this.redis.run(operation);
    } catch (error) {
      this.onRead({ error });
      return fallback;
    }
  }
}
