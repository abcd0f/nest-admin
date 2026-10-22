import { CacheTtlError } from './cache.error.js';

/** Redis PX / 定时器可接受的 TTL 上界。 */
export const CACHE_TTL_MAX = 2147483647;
export const CACHE_TTL_MESSAGE = '缓存 TTL 必须是 1 到 2147483647 的整数毫秒，省略时使用默认值';

export function isValidCacheTtl(ttl: number): boolean {
  return Number.isInteger(ttl) && ttl > 0 && ttl <= CACHE_TTL_MAX;
}

export function assertCacheTtl(ttl: number): void {
  if (!isValidCacheTtl(ttl)) throw new CacheTtlError(CACHE_TTL_MESSAGE);
}
