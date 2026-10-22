import { CacheKeyError } from './cache.error.js';

/** 完整 Redis 键的最大字节数。超过该长度的键难以排查，也容易造成内存浪费。 */
export const CACHE_KEY_MAX_BYTES = 512;

// Redis 协议允许任意二进制键，但缓存键会进入日志、监控和慢查询，控制字符没有可读性。
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1F || codePoint === 0x7F) return true;
  }
  return false;
}

/** 只校验业务键部分；键前缀由配置域在启动时校验。 */
export function assertCacheKey(key: string): void {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new CacheKeyError('缓存键不能为空');
  }
  if (hasControlCharacter(key)) {
    throw new CacheKeyError('缓存键不能包含控制字符');
  }
  if (Buffer.byteLength(key, 'utf8') > CACHE_KEY_MAX_BYTES) {
    throw new CacheKeyError(`缓存键长度不能超过 ${CACHE_KEY_MAX_BYTES} 字节`);
  }
}

/**
 * 生成最终 Redis 键。
 *
 * 前缀只在此处拼接一次，业务层始终使用短键；调用方无法通过传入完整键绕过命名空间。
 */
export function buildCacheKey(prefix: string, key: string): string {
  assertCacheKey(key);
  const fullKey = `${prefix}:${key}`;
  if (Buffer.byteLength(fullKey, 'utf8') > CACHE_KEY_MAX_BYTES) {
    throw new CacheKeyError(`完整缓存键长度不能超过 ${CACHE_KEY_MAX_BYTES} 字节`);
  }
  return fullKey;
}
