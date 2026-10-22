import { describe, expect, it } from 'vitest';
import { decodeCacheValue, encodeCacheValue, isCacheEnvelope } from './cache-codec.js';
import { CacheValueError } from './cache.error.js';

const MAX_BYTES = 1024;

describe('cache codec', () => {
  it.each([
    'text',
    '',
    0,
    42,
    -1.5,
    false,
    true,
    null,
    ['a', 1, false, null],
    { id: 42, roles: ['reader'], nested: { enabled: true } },
    { '中文键': '中文值' },
  ])('编码后可无损还原 %j', (value) => {
    const encoded = encodeCacheValue(value, MAX_BYTES);
    expect(isCacheEnvelope(encoded)).toBe(true);
    expect(encoded.startsWith('v1:')).toBe(true);
    expect(decodeCacheValue(encoded)).toEqual(value);
  });

  it('使用版本前缀隔离旧格式，旧条目按未命中处理', () => {
    expect(isCacheEnvelope('{"id":42}')).toBe(false);
    expect(() => decodeCacheValue('{"id":42}')).toThrow(CacheValueError);
    expect(() => decodeCacheValue('v2:{"id":42}')).toThrow('缓存值编码版本不受支持');
  });

  it('拒绝无法稳定还原的 JSON 值', () => {
    expect(() => encodeCacheValue(undefined, MAX_BYTES)).toThrow('缓存值不能是 undefined');
    expect(() => encodeCacheValue(Number.NaN, MAX_BYTES)).toThrow('有限数');
    expect(() => encodeCacheValue(Number.POSITIVE_INFINITY, MAX_BYTES)).toThrow('有限数');
    expect(() => encodeCacheValue(1n, MAX_BYTES)).toThrow('缓存值只能包含');
    expect(() => encodeCacheValue(() => 'value', MAX_BYTES)).toThrow('缓存值只能包含');
    expect(() => encodeCacheValue(Symbol('value'), MAX_BYTES)).toThrow('缓存值只能包含');
    expect(() => encodeCacheValue({ missing: undefined }, MAX_BYTES)).toThrow('undefined 字段');
    expect(() => encodeCacheValue([undefined], MAX_BYTES)).toThrow('缓存值只能包含');
  });

  it('拒绝 Date、Map 等类实例，避免解码后类型失真', () => {
    expect(() => encodeCacheValue(new Date(), MAX_BYTES)).toThrow('普通对象');
    expect(() => encodeCacheValue(new Map([['a', 1]]), MAX_BYTES)).toThrow('普通对象');
    class Model {
      value = 1;
    }
    expect(() => encodeCacheValue(new Model(), MAX_BYTES)).toThrow('普通对象');
  });

  it('拒绝 Symbol 键、循环引用和超深嵌套', () => {
    expect(() => encodeCacheValue({ [Symbol('key')]: 1 }, MAX_BYTES)).toThrow('Symbol 键');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => encodeCacheValue(circular, MAX_BYTES)).toThrow('循环引用');

    let deep: unknown = 'leaf';
    for (let index = 0; index < 40; index++) deep = [deep];
    expect(() => encodeCacheValue(deep, MAX_BYTES)).toThrow('嵌套层级');
  });

  it('按 UTF-8 字节数限制序列化结果', () => {
    expect(() => encodeCacheValue('abcdef', 5)).toThrow('不能超过 5 字节');
    expect(() => encodeCacheValue('中文', 5)).toThrow('不能超过 5 字节');
    expect(encodeCacheValue('中文', 8)).toContain('中文');
  });

  it('损坏的版本化内容抛出解码错误', () => {
    expect(() => decodeCacheValue('v1:{')).toThrow('缓存值解码失败');
    expect(() => decodeCacheValue('v1:')).toThrow('缓存值解码失败');
  });
});
