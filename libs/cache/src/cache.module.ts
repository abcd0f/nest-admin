import type { RedisConfig } from '@app/config';
import { redisConfig } from '@app/config';
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { Keyv } from 'keyv';
import { CacheService } from './cache.service.js';
import { RedisConnection } from './redis.connection.js';
import { RedisStore } from './redis.store.js';

@Module({
  imports: [
    NestCacheModule.registerAsync({
      extraProviders: [RedisConnection],
      inject: [RedisConnection, redisConfig.KEY],
      useFactory: (connection: RedisConnection, redis: RedisConfig) => ({
        ttl: redis.ttl,
        nonBlocking: false,
        stores: [
          new Keyv({
            store: new RedisStore(connection, redis.ttl),
            namespace: redis.keyPrefix,
            ttl: redis.ttl,
            // 保留写入/删除异常；cache-manager 的读取异常按标准行为转为未命中。
            throwOnErrors: true,
            emitErrors: false,
            stats: true,
          }),
        ],
      }),
    }),
  ],
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
