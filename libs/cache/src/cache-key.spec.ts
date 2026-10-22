import { describe, expect, it } from 'vitest';
import { assertCacheKey, buildCacheKey, CACHE_KEY_MAX_BYTES } from './cache-key.js';
import { assertCacheTtl, CACHE_TTL_MAX, isValidCacheTtl } from './cache-ttl.js';
import { CacheKeyError } from './cache.error.js';

describe('cache key', () => {
  it('前缀只拼接一次，业务键保持可读的命名空间结构', () => {
    expect(buildCacheKey('nest-admin:cache', 'users:v1:42')).toBe('nest-admin:cache:users:v1:42');
    expect(buildCacheKey('tenant:a', 'users:1')).toBe('tenant:a:users:1');
  });

  it.each(['', ' ', '\t', null, undefined, 42])('拒绝空键或非字符串键 %j', (key) => {
    expect(() => assertCacheKey(key as unknown as string)).toThrow(CacheKeyError);
  });

  it('拒绝控制字符', () => {
    expect(() => assertCacheKey('users\u0000:1')).toThrow('控制字符');
    expect(() => assertCacheKey('users\n:1')).toThrow('控制字符');
    expect(() => assertCacheKey('users\u007F:1')).toThrow('控制字符');
  });

  it('限制业务键和完整键的 UTF-8 字节数', () => {
    expect(() => assertCacheKey('a'.repeat(CACHE_KEY_MAX_BYTES + 1))).toThrow('不能超过');
    expect(() => assertCacheKey('中'.repeat(171))).toThrow('不能超过');
    expect(() =>
      buildCacheKey('p'.repeat(CACHE_KEY_MAX_BYTES - 5), '123456'),
    ).toThrow('完整缓存键长度');
  });

  it('错误带有稳定分类码', () => {
    try {
      assertCacheKey('');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ code: 'CACHE_KEY_INVALID' });
    }
  });
});

describe('cache ttl', () => {
  it.each([1, 2, 60000, CACHE_TTL_MAX])('接受合法 TTL %s', (ttl) => {
    expect(isValidCacheTtl(ttl)).toBe(true);
    expect(() => assertCacheTtl(ttl)).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, CACHE_TTL_MAX + 1, null, '1000'])(
    '拒绝非法 TTL %j',
    (ttl) => {
      expect(isValidCacheTtl(ttl as unknown as number)).toBe(false);
      expect(() => assertCacheTtl(ttl as unknown as number)).toThrow(RangeError);
    },
  );

  it('错误带有稳定分类码', () => {
    try {
      assertCacheTtl(0);
    } catch (error) {
      expect(error).toMatchObject({ code: 'CACHE_TTL_INVALID' });
    }
  });
});
