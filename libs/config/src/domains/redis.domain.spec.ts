import { describe, expect, it } from 'vitest';
import { redisDomain } from './redis.domain.js';

const context = { environment: 'test' } as const;

describe('redisDomain', () => {
  it('关闭时提供完整、可预测的默认连接配置', () => {
    expect(redisDomain.parse({}, context)).toEqual({
      enabled: false,
      ttl: 60000,
      ttlJitter: 0,
      host: '127.0.0.1',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
      keyPrefix: 'nest-admin:cache',
      connectionName: 'nest-admin-cache',
      connectTimeout: 2000,
      commandTimeout: 1000,
      maxRetriesPerRequest: 0,
      retryDelay: 1000,
      retryMaxDelay: 30000,
      keepAlive: 30000,
      family: 0,
      maxValueBytes: 1048576,
      tlsEnabled: false,
      tlsRejectUnauthorized: true,
    });
  });

  it('解析 YAML/环境变量风格的字符串布尔值与整数', () => {
    expect(
      redisDomain.parse(
        {
          enabled: 'true',
          ttl: '5000',
          'ttl-jitter': '10',
          port: '6380',
          db: '2',
          'connect-timeout': '500',
          'command-timeout': '250',
          'max-retries-per-request': '1',
          'retry-delay': '500',
          'retry-max-delay': '5000',
          'keep-alive': '0',
          family: '4',
          'max-value-bytes': '2048',
          'tls-enabled': 'true',
          'tls-reject-unauthorized': 'false',
        },
        context,
      ),
    ).toMatchObject({
      enabled: true,
      ttl: 5000,
      ttlJitter: 10,
      port: 6380,
      db: 2,
      connectTimeout: 500,
      commandTimeout: 250,
      maxRetriesPerRequest: 1,
      retryDelay: 500,
      retryMaxDelay: 5000,
      keepAlive: 0,
      family: 4,
      maxValueBytes: 2048,
      tlsEnabled: true,
      tlsRejectUnauthorized: false,
    });
  });

  it.each([0, -1, 1.5, 2147483648, true, ''])('拒绝非法 redis.ttl：%s', (ttl) => {
    expect(() => redisDomain.parse({ ttl }, context)).toThrow('redis.ttl');
  });

  it.each([-1, 101, 1.5, true, ''])('拒绝非法 redis.ttl-jitter：%s', (jitter) => {
    expect(() => redisDomain.parse({ 'ttl-jitter': jitter }, context)).toThrow('redis.ttl-jitter');
  });

  it.each([1, 100])('接受 TTL 抖动边界 %s', (jitter) => {
    expect(redisDomain.parse({ 'ttl-jitter': jitter }, context).ttlJitter).toBe(jitter);
  });

  it.each([0, 4, 6])('接受地址族 %s', (family) => {
    expect(redisDomain.parse({ family }, context).family).toBe(family);
  });

  it.each([1, 2, 3, 5, 7, 1.5, true])('拒绝非法地址族 %s', (family) => {
    expect(() => redisDomain.parse({ family }, context)).toThrow('redis.family');
  });

  it('拒绝非法的键前缀与连接名', () => {
    expect(() => redisDomain.parse({ 'key-prefix': '' }, context)).toThrow('redis.key-prefix');
    expect(() => redisDomain.parse({ 'key-prefix': 'nest::cache' }, context)).toThrow('redis.key-prefix');
    expect(() => redisDomain.parse({ 'key-prefix': 'nest admin' }, context)).toThrow('redis.key-prefix');
    expect(() => redisDomain.parse({ 'connection-name': 'cache client' }, context)).toThrow(
      'redis.connection-name',
    );
    expect(() => redisDomain.parse({ 'connection-name': 'a'.repeat(129) }, context)).toThrow(
      'redis.connection-name',
    );
  });

  it('拒绝越界的超时、重试、keep-alive 与值大小', () => {
    expect(() => redisDomain.parse({ 'connect-timeout': 0 }, context)).toThrow('redis.connect-timeout');
    expect(() => redisDomain.parse({ 'command-timeout': 0 }, context)).toThrow('redis.command-timeout');
    expect(() => redisDomain.parse({ 'retry-delay': 30001 }, context)).toThrow('redis.retry-delay');
    expect(() => redisDomain.parse({ 'retry-max-delay': 0 }, context)).toThrow('redis.retry-max-delay');
    expect(() => redisDomain.parse({ 'retry-max-delay': 60001 }, context)).toThrow('redis.retry-max-delay');
    expect(() => redisDomain.parse({ 'keep-alive': -1 }, context)).toThrow('redis.keep-alive');
    expect(() => redisDomain.parse({ 'max-value-bytes': 0 }, context)).toThrow('redis.max-value-bytes');
    expect(() => redisDomain.parse({ 'max-value-bytes': 16777217 }, context)).toThrow(
      'redis.max-value-bytes',
    );
  });

  it('最大重连间隔不得小于退避基数', () => {
    expect(() =>
      redisDomain.parse({ 'retry-delay': 5000, 'retry-max-delay': 1000 }, context),
    ).toThrow('redis.retry-max-delay: 必须大于等于 redis.retry-delay');
  });

  it('保留可选凭据的空值语义', () => {
    expect(redisDomain.parse({ username: '', password: '' }, context)).toMatchObject({
      username: undefined,
      password: undefined,
    });
    expect(redisDomain.parse({ username: 'cache-user', password: 'secret' }, context)).toMatchObject({
      username: 'cache-user',
      password: 'secret',
    });
  });
});
