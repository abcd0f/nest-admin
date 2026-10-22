import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service.js';
import { RedisClient } from './redis.client.js';
import { RedisService } from './redis.service.js';

/**
 * Redis 缓存模块。
 *
 * 设计要点：
 * - 只依赖 ioredis，不引入 Keyv / cache-manager / @nestjs/cache-manager；
 * - 标 @Global 与 DatabaseModule 一致：缓存属于全局基础设施，业务模块无需逐个导入；
 * - RedisClient 负责连接生命周期，RedisService 负责命令与健康检查，
 *   CacheService 负责业务缓存语义，三层可分别替换和测试。
 *
 * 前提：AppModule 中 AppConfigModule.forRoot() 必须先于本模块初始化，
 * 以便注入的 redisConfig.KEY 已完成解析与校验。
 */
@Global()
@Module({
  providers: [RedisClient, RedisService, CacheService],
  exports: [RedisClient, RedisService, CacheService],
})
export class CacheModule {}
