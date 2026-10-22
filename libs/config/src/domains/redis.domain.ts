import { REDIS_CONNECTION_NAME_PATTERN, REDIS_KEY_PREFIX_PATTERN } from '@app/common/constants/regex.js';
import {
  asBoolean,
  asObject,
  asOptionalString,
  asStrictInteger,
  defineConfigDomain,
} from '../core/index.js';

export interface RedisConfig {
  enabled: boolean;
  ttl: number;
  ttlJitter: number;
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  keyPrefix: string;
  connectionName: string;
  connectTimeout: number;
  commandTimeout: number;
  maxRetriesPerRequest: number;
  retryDelay: number;
  retryMaxDelay: number;
  keepAlive: number;
  family: 0 | 4 | 6;
  maxValueBytes: number;
  tlsEnabled: boolean;
  tlsRejectUnauthorized: boolean;
}

// 限制为 Node 定时器可表示的范围，拒绝 Number(true)、Number('') 等隐式转换。
function redisInteger(
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max = 2147483647,
): number {
  return asStrictInteger(value, path, fallback, min, max);
}

function redisFamily(value: unknown): 0 | 4 | 6 {
  const family = redisInteger(value, 'redis.family', 0, 0, 6);
  if (family !== 0 && family !== 4 && family !== 6) {
    throw new Error('redis.family: 只能是 0（自动）、4（IPv4）或 6（IPv6）');
  }
  return family;
}

export const redisDomain = defineConfigDomain<RedisConfig>({
  namespace: 'redis',
  parse(raw): RedisConfig {
    const value = asObject(raw, 'redis');
    const host = value.host ?? '127.0.0.1';
    const keyPrefix = value['key-prefix'] ?? 'nest-admin:cache';
    const connectionName = value['connection-name'] ?? 'nest-admin-cache';
    if (typeof host !== 'string' || host.trim().length === 0)
      throw new Error('redis.host: 必须是非空字符串');
    if (typeof keyPrefix !== 'string' || !REDIS_KEY_PREFIX_PATTERN.test(keyPrefix)) {
      throw new Error('redis.key-prefix: 必须由字母、数字、下划线、短横线及冒号分隔的非空段组成');
    }
    if (
      typeof connectionName !== 'string' ||
      connectionName.length > 128 ||
      !REDIS_CONNECTION_NAME_PATTERN.test(connectionName)
    ) {
      throw new Error('redis.connection-name: 必须是不超过 128 个字符的字母、数字、下划线、短横线或点');
    }
    if (value.password != null && typeof value.password !== 'string') {
      throw new Error('redis.password: 必须是字符串');
    }

    const config: RedisConfig = {
      enabled: asBoolean(value.enabled, 'redis.enabled', false),
      ttl: redisInteger(value.ttl, 'redis.ttl', 60000, 1),
      ttlJitter: redisInteger(value['ttl-jitter'], 'redis.ttl-jitter', 0, 0, 100),
      host: host.trim(),
      port: redisInteger(value.port, 'redis.port', 6379, 1, 65535),
      username: asOptionalString(value.username, 'redis.username'),
      password: value.password || undefined,
      db: redisInteger(value.db, 'redis.db', 0, 0),
      keyPrefix,
      connectionName,
      connectTimeout: redisInteger(value['connect-timeout'], 'redis.connect-timeout', 2000, 1),
      commandTimeout: redisInteger(value['command-timeout'], 'redis.command-timeout', 1000, 1),
      maxRetriesPerRequest: redisInteger(
        value['max-retries-per-request'],
        'redis.max-retries-per-request',
        0,
        0,
      ),
      retryDelay: redisInteger(value['retry-delay'], 'redis.retry-delay', 1000, 1, 30000),
      retryMaxDelay: redisInteger(value['retry-max-delay'], 'redis.retry-max-delay', 30000, 1, 60000),
      keepAlive: redisInteger(value['keep-alive'], 'redis.keep-alive', 30000, 0),
      family: redisFamily(value.family),
      maxValueBytes: redisInteger(
        value['max-value-bytes'],
        'redis.max-value-bytes',
        1048576,
        1,
        16777216,
      ),
      tlsEnabled: asBoolean(value['tls-enabled'], 'redis.tls-enabled', false),
      tlsRejectUnauthorized: asBoolean(
        value['tls-reject-unauthorized'],
        'redis.tls-reject-unauthorized',
        true,
      ),
    };

    if (config.retryMaxDelay < config.retryDelay) {
      throw new Error('redis.retry-max-delay: 必须大于等于 redis.retry-delay');
    }
    return config;
  },
});

export const redisConfig = redisDomain.token;
