import { REDIS_KEY_PREFIX_PATTERN } from '@app/core/constants/regex.js';
import {
  asBoolean,
  asInteger,
  asObject,
  asOptionalString,
  defineConfigDomain,
} from '../core/index.js';

export interface RedisConfig {
  enabled: boolean;
  ttl: number;
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  keyPrefix: string;
  connectTimeout: number;
  commandTimeout: number;
  maxRetriesPerRequest: number;
  retryDelay: number;
  tlsEnabled: boolean;
}

// 限制为 Node 定时器可表示的范围，拒绝 Number(true)、Number('') 等隐式转换。
function redisInteger(
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max = 2147483647,
): number {
  if (
    (value != null && typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && value.trim().length === 0)
  ) {
    throw new Error(`${path}: 必须是整数`);
  }
  const result = asInteger(value, path, fallback, min);
  if (!Number.isSafeInteger(result) || result > max)
    throw new Error(`${path}: 必须小于等于 ${max}`);
  return result;
}

export const redisDomain = defineConfigDomain<RedisConfig>({
  namespace: 'redis',
  parse(raw): RedisConfig {
    const value = asObject(raw, 'redis');
    const host = value.host ?? '127.0.0.1';
    const keyPrefix = value['key-prefix'] ?? 'nest-admin:cache';
    if (typeof host !== 'string' || host.trim().length === 0)
      throw new Error('redis.host: 必须是非空字符串');
    if (typeof keyPrefix !== 'string' || !REDIS_KEY_PREFIX_PATTERN.test(keyPrefix)) {
      throw new Error('redis.key-prefix: 必须由字母、数字、下划线、短横线及冒号分隔的非空段组成');
    }
    if (value.password != null && typeof value.password !== 'string') {
      throw new Error('redis.password: 必须是字符串');
    }
    return {
      enabled: asBoolean(value.enabled, 'redis.enabled', false),
      ttl: redisInteger(value.ttl, 'redis.ttl', 60000, 1),
      host: host.trim(),
      port: redisInteger(value.port, 'redis.port', 6379, 1, 65535),
      username: asOptionalString(value.username, 'redis.username'),
      password: value.password || undefined,
      db: redisInteger(value.db, 'redis.db', 0, 0),
      keyPrefix,
      connectTimeout: redisInteger(value['connect-timeout'], 'redis.connect-timeout', 2000, 1),
      commandTimeout: redisInteger(value['command-timeout'], 'redis.command-timeout', 1000, 1),
      maxRetriesPerRequest: redisInteger(
        value['max-retries-per-request'],
        'redis.max-retries-per-request',
        0,
        0,
      ),
      retryDelay: redisInteger(value['retry-delay'], 'redis.retry-delay', 1000, 1, 30000),
      tlsEnabled: asBoolean(value['tls-enabled'], 'redis.tls-enabled', false),
    };
  },
});

export const redisConfig = redisDomain.token;
