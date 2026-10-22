import type { RedisConfig } from '@app/config';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { redisConfig } from '@app/config';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { createRedisOptions } from './redis.options.js';

/**
 * Redis 连接的唯一所有者。
 *
 * 职责边界：
 * - 创建/关闭 ioredis 客户端，管理启动失败、运行期重连和优雅退出。
 * - 不执行缓存命令，也不做序列化；命令门面见 RedisService，缓存语义见 CacheService。
 * - 关闭时移除自有监听器，避免热重载或测试中累积监听器。
 */
@Injectable()
export class RedisClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisClient.name);
  private readonly redis?: Redis;
  private readonly config: RedisConfig;
  /** 首次连接成功后置为 true；运行期断线仍允许继续重连。 */
  private hasConnected = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private lastWarningAt = -Infinity;

  constructor(@Inject(redisConfig.KEY) config: RedisConfig) {
    this.config = config;
    if (!config.enabled) return;

    this.redis = new Redis(
      createRedisOptions(config, { shouldRetry: () => this.hasConnected && !this.closing }),
    );
    this.redis.on('ready', this.onReady);
    this.redis.on('error', this.onError);
    this.redis.on('close', this.onClose);
    this.redis.on('reconnecting', this.onReconnecting);
    this.redis.on('end', this.onEnd);
  }

  /** 原始客户端只用于健康检查、测试和极少数高级命令；业务代码应使用 CacheService。 */
  get client(): Redis | undefined {
    return this.redis;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get isReady(): boolean {
    return this.redis?.status === 'ready';
  }

  async onModuleInit(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.connect();
    } catch {
      await this.onModuleDestroy();
      // 不携带原始 error：连接串、ACL 用户名等敏感信息可能出现在 ioredis 错误对象中。
      throw new Error('Redis 连接失败，请检查地址、凭据、TLS 与网络配置');
    }
  }

  onModuleDestroy(): Promise<void> {
    this.closePromise ??= this.close();
    return this.closePromise;
  }

  private async close(): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    this.closing = true;

    try {
      // quit 会等待已发出的命令完成；重连中或已断开时直接强制关闭。
      if (redis.status === 'ready' || redis.status === 'connect') await redis.quit();
    } catch {
      this.logger.warn('Redis 正常关闭失败，强制断开连接');
    } finally {
      redis.disconnect();
      redis.off('ready', this.onReady);
      redis.off('error', this.onError);
      redis.off('close', this.onClose);
      redis.off('reconnecting', this.onReconnecting);
      redis.off('end', this.onEnd);
    }
  }

  private readonly onReady = (): void => {
    this.hasConnected = true;
    this.lastWarningAt = -Infinity;
    this.logger.log(`Redis 缓存连接就绪（db=${this.config.db}）`);
  };

  private readonly onError = (): void => {
    this.warnOnce('Redis 缓存连接异常');
  };

  private readonly onClose = (): void => {
    if (this.closing) return;
    this.warnOnce('Redis 缓存连接已断开，等待重连');
  };

  private readonly onReconnecting = (): void => {
    if (this.closing) return;
    this.warnOnce('Redis 缓存连接中断，正在重连');
  };

  private readonly onEnd = (): void => {
    if (this.closing) return;
    this.warnOnce('Redis 缓存连接已结束');
  };

  private warnOnce(message: string): void {
    const now = Date.now();
    if (now - this.lastWarningAt < 30_000) return;
    this.lastWarningAt = now;
    // 不记录客户端异常对象，它可能包含认证命令或服务端返回的敏感内容。
    this.logger.warn(message);
  }
}
