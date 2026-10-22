import { describe, expect, it } from 'vitest';
import { asInteger } from '../core/parsers.js';
import { appDomain } from './app.domain.js';
import { databaseDomain } from './database.domain.js';
import { loggerDomain } from './logger.domain.js';
import { redisDomain } from './redis.domain.js';
import { throttlerDomain } from './throttler.domain.js';

const context = { environment: 'test' } as const;
const fields = [
  { path: 'redis.ttl', fallback: 60000, parse: (ttl: unknown) => redisDomain.parse({ ttl }, context).ttl },
  { path: 'throttler.ttl', fallback: 60000, parse: (ttl: unknown) => throttlerDomain.parse({ ttl }, context).ttl },
  {
    path: 'logger.file.size-mb',
    fallback: 20,
    parse: (size: unknown) => loggerDomain.parse({ file: { 'size-mb': size } }, context).file.sizeMb,
  },
];

describe.each(fields)('配置整数兼容性：$path', ({ path, fallback, parse }) => {
  it.each([null, undefined])('缺省输入 %s 使用原默认值', (value) => {
    expect(parse(value)).toBe(fallback);
  });

  it.each([1, '1', ' 12 '])('接受数值或数字字符串 %s', (value) => {
    expect(parse(value)).toBe(Number(value));
  });

  it.each([true, false, [1], {}, '', ' ', 'invalid', -1, 0, 1.5, Number.NaN, Infinity])(
    '拒绝非法输入 %s 并保留配置路径',
    (value) => {
      expect(() => parse(value)).toThrow(path);
    },
  );
});

describe('配置整数域规则', () => {
  it('保留各域的默认值和可选封禁时间', () => {
    expect(redisDomain.parse({}, context)).toMatchObject({ ttl: 60000, port: 6379, db: 0, retryDelay: 1000 });
    expect(throttlerDomain.parse({}, context)).toEqual({ enabled: true, ttl: 60000, limit: 100, blockDuration: undefined });
    expect(loggerDomain.parse({}, context).file).toMatchObject({ sizeMb: 20, maxFiles: 15 });
  });

  it('redis TTL 保留定时器上限，端口和重试间隔保留各自上限', () => {
    expect(redisDomain.parse({ ttl: '2147483647', port: '65535', 'retry-delay': 30000 }, context))
      .toMatchObject({ ttl: 2147483647, port: 65535, retryDelay: 30000 });
    expect(() => redisDomain.parse({ ttl: 2147483648 }, context)).toThrow('redis.ttl: 必须小于等于 2147483647');
    expect(() => redisDomain.parse({ port: 65536 }, context)).toThrow('redis.port: 必须小于等于 65535');
    expect(() => redisDomain.parse({ 'retry-delay': 30001 }, context)).toThrow('redis.retry-delay: 必须小于等于 30000');
  });

  it('非负字段接受 0，但空白字符串不能代替 0', () => {
    expect(redisDomain.parse({ db: '0' }, context)).toMatchObject({ db: 0 });
    expect(throttlerDomain.parse({ 'block-duration': '0' }, context).blockDuration).toBe(0);
    expect(() => redisDomain.parse({ db: ' ' }, context)).toThrow('redis.db: 必须是整数');
    expect(() => throttlerDomain.parse({ 'block-duration': '' }, context)).toThrow('throttler.block-duration: 必须是整数');
    expect(() => throttlerDomain.parse({ 'block-duration': -1 }, context)).toThrow('throttler.block-duration: 必须是非负整数');
  });

  it('保留 logger 与 throttler 的既有错误文案', () => {
    expect(() => loggerDomain.parse({ file: { 'max-files': true } }, context))
      .toThrow('logger.file.max-files: 必须是正整数');
    expect(() => loggerDomain.parse({ file: { 'max-files': ' ' } }, context))
      .toThrow('logger.file.max-files: 必须是大于等于 1 的整数');
    expect(() => throttlerDomain.parse({ ttl: ' ' }, context)).toThrow('throttler.ttl: 必须是整数');
  });

  it('不将 Redis 上限扩展到 logger 或 throttler', () => {
    const value = Number.MAX_SAFE_INTEGER + 1;
    expect(() => redisDomain.parse({ ttl: value }, context)).toThrow('redis.ttl');
    expect(throttlerDomain.parse({ ttl: value }, context).ttl).toBe(value);
    expect(loggerDomain.parse({ file: { 'max-files': value } }, context).file.maxFiles).toBe(value);
  });

  it('app/database 和原 asInteger 保留既有宽松转换', () => {
    expect(asInteger(true, 'example', undefined, 1)).toBe(1);
    expect(asInteger('', 'example', undefined, 0)).toBe(0);
    expect(appDomain.parse({ port: [1] }, context).port).toBe(1);
    expect(databaseDomain.parse({ url: 'postgresql://localhost/test', pool: { max: true, 'idle-timeout': '' } }, context).pool)
      .toMatchObject({ max: 1, idleTimeoutMillis: 0 });
  });
});
