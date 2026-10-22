import type { RedisConfig } from '@app/config';
import type { RedisOptions } from 'ioredis';

/** 连接创建时必须注入的状态，避免把 RedisClient 实例耦合进纯函数。 */
export interface RedisRetryState {
  /** 首次连接成功前返回 false（启动快速失败）；运行期断开后返回 true。 */
  readonly shouldRetry: () => boolean;
}

/**
 * 运行期重连延迟：指数退避 + 20% 抖动，避免集群同时重连造成惊群。
 *
 * 首次连接不经过此分支；`retryStrategy` 返回 null 让启动失败快速暴露。
 */
export function redisRetryDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelay, baseDelay * 2 ** Math.max(0, attempt - 1));
  const jittered = exponential * (0.8 + random() * 0.2);
  return Math.max(1, Math.min(maxDelay, Math.round(jittered)));
}

/**
 * 把应用配置映射为 ioredis 选项。
 *
 * 显式关闭离线队列与自动重发：Redis 不可用时让业务命令立即失败，
 * 由 CacheService 决定读取降级、写入抛错，避免请求在连接恢复前无限堆积。
 */
export function createRedisOptions(config: RedisConfig, state: RedisRetryState): RedisOptions {
  const options: RedisOptions = {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    db: config.db,
    connectTimeout: config.connectTimeout,
    commandTimeout: config.commandTimeout,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    keepAlive: config.keepAlive,
    family: config.family,
    connectionName: config.connectionName,
    lazyConnect: true,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    enableAutoPipelining: false,
    retryStrategy: (attempt) =>
      state.shouldRetry() ? redisRetryDelay(attempt, config.retryDelay, config.retryMaxDelay) : null,
  };

  if (config.tlsEnabled) {
    options.tls = { rejectUnauthorized: config.tlsRejectUnauthorized };
  }
  return options;
}
