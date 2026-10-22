import { asBoolean, asObject, asOptionalString, asStrictInteger, asString, defineConfigDomain } from '../core/index.js';

export interface RedisConfig {
  enabled: boolean;
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  keyPrefix: string;
  ttl: number;
  connectTimeout: number;
  commandTimeout: number;
  retryDelay: number;
  commandsQueueMaxLength: number;
  tls: boolean;
}

export const redisDomain = defineConfigDomain<RedisConfig>({
  namespace: 'redis',
  parse(raw): RedisConfig {
    const value = asObject(raw, 'redis');
    const integer = (key: string, fallback: number, min = 1, max = 2147483647) =>
      asStrictInteger(value[key], `redis.${key}`, fallback, min, max);
    const keyPrefix = asString(value['key-prefix'] ?? 'nest-admin', 'redis.key-prefix');
    if (!/^[\w:-]+$/.test(keyPrefix)) {
      throw new Error('redis.key-prefix: 只能包含字母、数字、下划线、冒号和连字符');
    }
    // 密码不 trim，空格可能是合法凭据的一部分。
    const password = value.password;
    if (password != null && typeof password !== 'string') {
      throw new Error('redis.password: 必须是字符串');
    }
    return {
      enabled: asBoolean(value.enabled, 'redis.enabled', false),
      host: asString(value.host, 'redis.host', '127.0.0.1'),
      port: integer('port', 6379, 1, 65535),
      username: asOptionalString(value.username, 'redis.username'),
      password: password ?? undefined,
      db: integer('db', 0, 0),
      keyPrefix,
      ttl: integer('ttl', 60000),
      connectTimeout: integer('connect-timeout', 5000),
      commandTimeout: integer('command-timeout', 2000),
      retryDelay: integer('retry-delay', 1000, 1, 30000),
      commandsQueueMaxLength: integer('commands-queue-max-length', 1000),
      tls: asBoolean(value.tls, 'redis.tls', false),
    };
  },
});

export const redisConfig = redisDomain.token;
