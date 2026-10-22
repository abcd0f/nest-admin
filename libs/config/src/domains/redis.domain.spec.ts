import { describe, expect, it } from 'vitest';
import { redisDomain } from './redis.domain.js';

const context = { environment: 'test' } as const;

describe('缓存连接配置', () => {
  it('默认关闭，解析 YAML 数字字符串并保留密码空格', () => {
    expect(redisDomain.parse({}, context)).toMatchObject({ enabled: false, ttl: 60000, db: 0 });
    expect(redisDomain.parse({ enabled: 'true', port: '6379', password: ' secret ' }, context))
      .toMatchObject({ enabled: true, port: 6379, password: ' secret ' });
  });

  it.each(['*', 'app?', 'app[1]', '', '  '])('拒绝可能越界的命名空间 %s', (prefix) => {
    expect(() => redisDomain.parse({ 'key-prefix': prefix }, context)).toThrow('redis.key-prefix');
  });

  it.each([
    ['port', 65536],
['db', -1],
['connect-timeout', 0],
['command-timeout', true],
    ['commands-queue-max-length', 1.5],
['retry-delay', 30001],
['password', 123456],
  ])('校验 %s 并包含配置路径', (key, value) => {
    expect(() => redisDomain.parse({ [key]: value }, context)).toThrow(`redis.${key}`);
  });
});
