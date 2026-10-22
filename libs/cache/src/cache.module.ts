import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';
import { createCache } from 'cache-manager';
import { CacheService } from './cache.service.js';
import { RedisClient } from './redis.client.js';
import { RedisService } from './redis.service.js';
import { createRedisKeyv } from './redis.store.js';

@Global()
@Module({
  providers: [
    RedisClient,
    {
      provide: CACHE_MANAGER,
      inject: [RedisClient],
      useFactory: (owner: RedisClient) => createCache({
        stores: [createRedisKeyv(owner)],
        ttl: owner.config.ttl,
        nonBlocking: false,
      }),
    },
    CacheService,
    RedisService,
  ],
  exports: [CACHE_MANAGER, CacheService, RedisService, RedisClient],
})
export class CacheModule {}
