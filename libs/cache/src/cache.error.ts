/**
 * 缓存错误的稳定分类。
 *
 * 业务层只依赖这些错误类型判断失败原因，不解析错误消息；
 * 消息仅用于日志和排查，避免把 Redis/序列化内部细节暴露给调用方。
 */
export type CacheErrorCode =
  | 'CACHE_KEY_INVALID'
  | 'CACHE_TTL_INVALID'
  | 'CACHE_VALUE_INVALID'
  | 'CACHE_UNAVAILABLE';

/** 缓存键不合法（空值、控制字符或超长）。继承 TypeError 便于区分编程错误。 */
export class CacheKeyError extends TypeError {
  readonly code = 'CACHE_KEY_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CacheKeyError';
  }
}

/** TTL 不合法。继承 RangeError，保持既有调用方的异常类型契约。 */
export class CacheTtlError extends RangeError {
  readonly code = 'CACHE_TTL_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CacheTtlError';
  }
}

/** 缓存值不是受支持的 JSON 类型，或超过大小限制。 */
export class CacheValueError extends TypeError {
  readonly code = 'CACHE_VALUE_INVALID' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CacheValueError';
  }
}

/** Redis 未启用或命令执行失败。消息固定，避免泄露连接串、凭据或服务端内容。 */
export class CacheUnavailableError extends Error {
  readonly code = 'CACHE_UNAVAILABLE' as const;

  constructor(message = 'Redis 缓存命令执行失败', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CacheUnavailableError';
  }
}
