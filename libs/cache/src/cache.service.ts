import type { RedisConfig } from '@app/config';
import type { CacheMetrics } from './cache.types.js';
import type { RedisHealth } from './redis.service.js';
import { redisConfig } from '@app/config';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { decodeCacheValue, encodeCacheValue, isCacheEnvelope } from './cache-codec.js';
import { buildCacheKey } from './cache-key.js';
import { CacheMetricsCollector } from './cache-metrics.js';
import { assertCacheTtl } from './cache-ttl.js';
import { RedisService } from './redis.service.js';

/**
 * 业务缓存门面。
 *
 * 语义边界（与 README 保持一致）：
 * - 读取失败按未命中降级，保证缓存故障不阻断业务读路径；
 * - 写入/删除失败抛出 CacheUnavailableError，避免调用方误以为数据已生效；
 * - 值统一使用版本化 JSON 编码，TTL 统一为毫秒，默认不允许永久缓存；
 * - wrap 在进程内合并同一键的并发加载，跨实例惊群由 TTL 抖动缓解。
 *
 * 本服务不承担会话、授权、限流或唯一数据源职责；这些场景需要独立的
 * Redis 数据模型和一致性策略，不应复用缓存键空间。
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly metrics = new CacheMetricsCollector();
  /** 进程内 single-flight：同一键的并发加载只执行一次 loader。 */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private lastWarningAt = -Infinity;

  constructor(
    private readonly redis: RedisService,
    @Inject(redisConfig.KEY) private readonly config: RedisConfig,
  ) {}

  get enabled(): boolean {
    return this.redis.enabled;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const fullKey = buildCacheKey(this.config.keyPrefix, key);
    if (!this.redis.enabled) return undefined;
    return this.read<T>(fullKey);
  }

  async getMany<T>(keys: readonly string[]): Promise<(T | undefined)[]> {
    const fullKeys = keys.map((key) => buildCacheKey(this.config.keyPrefix, key));
    if (fullKeys.length === 0) return [];
    if (!this.redis.enabled) return fullKeys.map(() => undefined);

    let rawValues: (string | null)[];
    try {
      rawValues = await this.redis.mget(fullKeys);
    } catch {
      this.metrics.increment('readErrors');
      this.warn('Redis 缓存批量读取失败，按未命中处理');
      return fullKeys.map(() => undefined);
    }
    return rawValues.map((raw) => this.decode<T>(raw));
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const fullKey = buildCacheKey(this.config.keyPrefix, key);
    const effectiveTtl = this.resolveTtl(ttl);
    const encoded = encodeCacheValue(value, this.config.maxValueBytes);
    if (!this.redis.enabled) return;
    await this.write(fullKey, encoded, effectiveTtl);
  }

  /** 返回是否真的删除了键；缓存未启用时恒为 false。 */
  async del(key: string): Promise<boolean> {
    const fullKey = buildCacheKey(this.config.keyPrefix, key);
    if (!this.redis.enabled) return false;

    try {
      const deleted = await this.redis.del(fullKey);
      if (deleted) this.metrics.increment('deletes');
      return deleted;
    } catch (error) {
      this.metrics.increment('deleteErrors');
      throw error;
    }
  }

  /** 批量删除并返回实际删除数量；内部使用 UNLINK，避免大键阻塞 Redis。 */
  async delMany(keys: readonly string[]): Promise<number> {
    const fullKeys = [...new Set(keys.map((key) => buildCacheKey(this.config.keyPrefix, key)))];
    if (fullKeys.length === 0) return 0;
    if (!this.redis.enabled) return 0;

    try {
      const deleted = await this.redis.delMany(fullKeys);
      this.metrics.increment('deletes', deleted);
      return deleted;
    } catch (error) {
      this.metrics.increment('deleteErrors');
      throw error;
    }
  }

  /** 存在性检查；读取失败按 false 降级，避免把缓存故障当成业务不存在。 */
  async has(key: string): Promise<boolean> {
    const fullKey = buildCacheKey(this.config.keyPrefix, key);
    if (!this.redis.enabled) return false;

    try {
      return await this.redis.exists(fullKey);
    } catch {
      this.metrics.increment('readErrors');
      this.warn('Redis 缓存存在性检查失败，按不存在处理');
      return false;
    }
  }

  /** 剩余 TTL（毫秒）：-2 键不存在，-1 无过期时间；命令失败会抛出。 */
  async ttl(key: string): Promise<number> {
    const fullKey = buildCacheKey(this.config.keyPrefix, key);
    if (!this.redis.enabled) return -2;

    try {
      return await this.redis.pttl(fullKey);
    } catch (error) {
      this.metrics.increment('readErrors');
      throw error;
    }
  }

  /**
   * 读取或加载并写回缓存。
   *
   * - 命中直接返回；
   * - 未命中时同一进程内同键并发调用只执行一次 loader；
   * - loader 返回 undefined 时不写缓存；返回 null 表示合法的负缓存；
   * - 写回失败会让 wrap 失败，调用方应感知缓存未生效。
   */
  wrap<T>(key: string, loader: () => Promise<T>, ttl?: number): Promise<T> {
    const fullKey = buildCacheKey(this.config.keyPrefix, key);
    const effectiveTtl = this.resolveTtl(ttl);
    if (!this.redis.enabled) return loader();

    const existing = this.inflight.get(fullKey);
    if (existing) {
      this.metrics.increment('coalesced');
      return existing as Promise<T>;
    }

    const pending = this.load(fullKey, loader, effectiveTtl);
    this.inflight.set(fullKey, pending);
    void pending
      .finally(() => {
        if (this.inflight.get(fullKey) === pending) this.inflight.delete(fullKey);
      })
      .catch(() => {
        // loader 的异常由返回的 pending 传播，这里只负责清理，避免未处理的 rejection。
      });
    return pending;
  }

  health(): Promise<RedisHealth> {
    return this.redis.health();
  }

  getMetrics(): Readonly<CacheMetrics> {
    return this.metrics.snapshot();
  }

  resetMetrics(): void {
    this.metrics.reset();
  }

  private async load<T>(
    fullKey: string,
    loader: () => Promise<T>,
    ttl: number,
  ): Promise<T> {
    const cached = await this.read<T>(fullKey);
    if (cached !== undefined) return cached;

    const value = await loader();
    if (value === undefined) return value;

    const encoded = encodeCacheValue(value, this.config.maxValueBytes);
    await this.write(fullKey, encoded, ttl);
    return value;
  }

  private async read<T>(fullKey: string): Promise<T | undefined> {
    try {
      return this.decode<T>(await this.redis.get(fullKey));
    } catch {
      this.metrics.increment('readErrors');
      this.warn('Redis 缓存读取失败，按未命中处理');
      return undefined;
    }
  }

  private decode<T>(raw: string | null): T | undefined {
    if (raw === null || !isCacheEnvelope(raw)) {
      this.metrics.increment('misses');
      return undefined;
    }

    try {
      const value = decodeCacheValue<T>(raw);
      this.metrics.increment('hits');
      return value;
    } catch {
      this.metrics.increment('decodeErrors');
      this.warn('缓存值解码失败，按未命中处理');
      return undefined;
    }
  }

  private async write(fullKey: string, encoded: string, ttl: number): Promise<void> {
    try {
      await this.redis.set(fullKey, encoded, ttl);
      this.metrics.increment('sets');
    } catch (error) {
      this.metrics.increment('writeErrors');
      throw error;
    }
  }

  private resolveTtl(ttl?: number): number {
    // 只有 undefined 表示使用默认值；null 等非法值必须显式拒绝，不能被 ?? 静默吞掉。
    const base = ttl === undefined ? this.config.ttl : ttl;
    assertCacheTtl(base);

    if (this.config.ttlJitter <= 0) return base;
    const maxJitter = Math.floor((base * this.config.ttlJitter) / 100);
    if (maxJitter < 1) return base;
    return Math.max(1, base - Math.floor(Math.random() * (maxJitter + 1)));
  }

  private warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarningAt < 30_000) return;
    this.lastWarningAt = now;
    this.logger.warn(`${message}（同类日志每 30 秒最多一次）`);
  }
}
