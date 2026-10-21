import type { KeyvStoreAdapter, StoredData } from 'keyv';
import type { RedisConnection } from './redis.connection.js';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { isValidCacheTtl } from './cache-ttl.js';

/** Keyv 公开存储契约：值由 Keyv 编码，键前缀也只由 Keyv 添加一次。 */
export class RedisStore extends EventEmitter implements KeyvStoreAdapter {
  readonly opts = {};
  namespace?: string;
  private readonly logger = new Logger(RedisStore.name);
  private lastWarningAt = -Infinity;

  constructor(
    private readonly connection: RedisConnection,
    private readonly defaultTtl: number,
  ) {
    super();
  }

  async get<T>(key: string): Promise<StoredData<T> | undefined> {
    const client = this.connection.client;
    if (!client) return undefined;
    const value = await this.execute(() => client.get(key));
    // Keyv 的存储契约以泛型表示编码前的类型；此处返回的字符串随后由 Keyv 解码。
    return value === null ? undefined : (value as StoredData<T>);
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<boolean> {
    if (typeof value !== 'string') throw new TypeError('Redis Store 仅接受 Keyv 序列化后的字符串');
    if (!isValidCacheTtl(ttl))
      throw new RangeError('缓存 TTL 必须是正整数毫秒');
    const client = this.connection.client;
    if (!client) return true;
    await this.execute(() => client.set(key, value, 'PX', ttl));
    return true;
  }

  async delete(key: string): Promise<boolean> {
    const client = this.connection.client;
    if (!client) return false;
    return (await this.execute(() => client.del(key))) > 0;
  }

  async clear(): Promise<void> {
    throw new Error('不支持批量清空，请使用 del 按业务键失效缓存');
  }

  private async execute<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch {
      if (Date.now() - this.lastWarningAt >= 30000) {
        this.lastWarningAt = Date.now();
        this.logger.warn('Redis 缓存命令失败（同类日志每 30 秒最多一次）');
      }
      throw new Error('Redis 缓存命令执行失败');
    }
  }
}
