import type { CacheValue } from './cache.types.js';
import { CacheValueError } from './cache.error.js';

/**
 * 值编码版本。
 *
 * 前缀使缓存格式可以平滑演进：升级期间旧版本写入的值不会被新代码误读，
 * 而是按未命中处理，等待 TTL 自然淘汰。不要在没有迁移方案时修改该前缀。
 */
const CODEC_PREFIX = 'v1:';
const MAX_DEPTH = 32;

export function isCacheEnvelope(raw: string): boolean {
  return raw.startsWith(CODEC_PREFIX);
}

export function encodeCacheValue(value: unknown, maxBytes: number): string {
  if (value === undefined) throw new CacheValueError('缓存值不能是 undefined');
  assertJsonValue(value, 0, new WeakSet<object>());

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new CacheValueError('缓存值必须是可 JSON 序列化的数据', { cause });
  }

  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new CacheValueError(`缓存值序列化后不能超过 ${maxBytes} 字节`);
  }
  return `${CODEC_PREFIX}${json}`;
}

export function decodeCacheValue<T>(raw: string): T {
  if (!isCacheEnvelope(raw)) {
    throw new CacheValueError('缓存值编码版本不受支持');
  }

  try {
    return JSON.parse(raw.slice(CODEC_PREFIX.length)) as T;
  } catch (cause) {
    throw new CacheValueError('缓存值解码失败', { cause });
  }
}

function assertJsonValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): asserts value is CacheValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;

  if (typeof value === 'number') {
    // JSON.stringify 会把 NaN/Infinity 静默改成 null，必须在写入前拒绝。
    if (!Number.isFinite(value)) throw new CacheValueError('缓存值中的数字必须是有限数');
    return;
  }

  if (typeof value !== 'object') {
    throw new CacheValueError('缓存值只能包含字符串、数字、布尔值、null、数组和普通对象');
  }

  if (depth >= MAX_DEPTH) {
    throw new CacheValueError(`缓存值嵌套层级不能超过 ${MAX_DEPTH} 层`);
  }
  if (seen.has(value)) {
    throw new CacheValueError('缓存值不能包含循环引用');
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonValue(item, depth + 1, seen);
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CacheValueError('缓存值只能包含普通对象，不能包含类实例');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CacheValueError('缓存值不能包含 Symbol 键');
    }
    for (const item of Object.values(value)) {
      if (item === undefined) {
        throw new CacheValueError('缓存值对象不能包含 undefined 字段');
      }
      assertJsonValue(item, depth + 1, seen);
    }
  } finally {
    seen.delete(value);
  }
}
