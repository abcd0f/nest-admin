import type { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { isValidCacheTtl } from './cache-ttl.js';

export type CacheValue =
  string | number | boolean | null | CacheValue[] | { [key: string]: CacheValue };

/** 可选的读取缓存，不承担会话、授权、限流或唯一数据存储职责。 */
@Injectable()
export class CacheService {
  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async get<T>(key: string): Promise<T | undefined> {
    this.validateKey(key);
    return this.cache.get<T>(key);
  }

  async set<T extends CacheValue>(key: string, value: T, ttl?: number): Promise<void> {
    this.validateKey(key);
    this.validateTtl(ttl);
    if (value === undefined) throw new TypeError('缓存值不能是 undefined');
    await this.cache.set(key, value, ttl);
  }

  async del(key: string): Promise<void> {
    this.validateKey(key);
    await this.cache.del(key);
  }

  async wrap<T extends CacheValue>(
    key: string,
    loader: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    this.validateKey(key);
    this.validateTtl(ttl);
    return this.cache.wrap(key, loader, ttl);
  }

  private validateKey(key: string): void {
    if (typeof key !== 'string' || key.trim().length === 0) throw new TypeError('缓存键不能为空');
  }

  private validateTtl(ttl: number | undefined): void {
    if (ttl !== undefined && !isValidCacheTtl(ttl)) {
      throw new RangeError('缓存 TTL 必须是 1 到 2147483647 的整数毫秒，省略时使用默认值');
    }
  }
}
