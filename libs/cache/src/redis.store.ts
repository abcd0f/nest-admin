import KeyvRedis from '@keyv/redis';
import { Keyv } from 'keyv';
import { deleteByPrefix } from './cache.utils.js';
import { RedisClient } from './redis.client.js';

/** 关闭 KeyvRedis 的懒连接和断连权限，连接生命周期统一交给 Nest。 */
export class SharedRedisStore extends KeyvRedis<string> {
  constructor(private readonly owner: RedisClient) {
    if (!owner.client) throw new Error('Redis 未启用');
    super(owner.client, {
      namespace: `${owner.config.keyPrefix}:cache`,
      keyPrefixSeparator: ':',
      throwOnConnectError: true,
      throwOnErrors: true,
    });
  }

  override async getClient(): Promise<RedisClient['ready']> {
    return this.owner.ready;
  }

  override async disconnect(): Promise<void> {
    // 借用的连接不可被 cache-manager.disconnect() 关闭。
  }

  override async clear(): Promise<void> {
    // 上游 clear 会吞掉异常；这里保持写操作失败可见，且仅清理缓存命名空间。
    await deleteByPrefix(this.owner.ready, `${this.namespace}:`);
  }
}

export function createRedisKeyv(owner: RedisClient): Keyv {
  const namespace = `${owner.config.keyPrefix}:cache`;
  const store = owner.client
    ? new SharedRedisStore(owner)
    : {
        get: async () => undefined,
        set: async () => true,
        delete: async () => false,
        clear: async () => {},
      };
  const keyv = new Keyv({ store, namespace, useKeyPrefix: false, throwOnErrors: true });
  // 错误由调用方处理；避免 EventEmitter 的 error 成为未捕获异常。
  keyv.on('error', () => {});
  return keyv;
}
