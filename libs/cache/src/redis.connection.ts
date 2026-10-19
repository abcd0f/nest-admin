import type { RedisConfig } from '@app/config';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { redisConfig } from '@app/config';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

/** 仅由缓存模块持有的单连接；Store 不创建连接，也不负责关闭。 */
@Injectable()
export class RedisConnection implements OnModuleInit, OnModuleDestroy {
  readonly client?: Redis;
  private readonly logger = new Logger(RedisConnection.name);
  private connected = false;
  private closing?: Promise<void>;
  private warned = false;

  constructor(@Inject(redisConfig.KEY) config: RedisConfig) {
    if (!config.enabled) return;
    this.client = new Redis({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      db: config.db,
      connectTimeout: config.connectTimeout,
      commandTimeout: config.commandTimeout,
      maxRetriesPerRequest: config.maxRetriesPerRequest,
      tls: config.tlsEnabled ? {} : undefined,
      lazyConnect: true,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      // 初次失败直接结束启动；运行期保留有上限的重连间隔，不排队业务请求。
      retryStrategy: (attempt) =>
        this.connected && !this.closing ? Math.min(config.retryDelay * attempt, 30000) : null,
    });
    this.client.on('ready', this.onReady);
    this.client.on('error', this.onUnavailable);
    this.client.on('close', this.onUnavailable);
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.connect();
    } catch {
      await this.onModuleDestroy();
      throw new Error('Redis 连接失败，请检查地址、凭据、TLS 与网络配置');
    }
  }

  onModuleDestroy(): Promise<void> {
    this.closing ??= this.close();
    return this.closing;
  }

  private async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      if (client.status === 'ready') await client.quit();
    } catch {
      this.logger.warn('Redis 正常关闭失败，强制断开连接');
    } finally {
      client.disconnect();
      client.off('ready', this.onReady);
      client.off('error', this.onUnavailable);
      client.off('close', this.onUnavailable);
    }
  }

  private readonly onReady = (): void => {
    this.connected = true;
    this.warned = false;
    this.logger.log('Redis 缓存连接就绪');
  };

  private readonly onUnavailable = (): void => {
    if (this.closing || this.warned) return;
    this.warned = true;
    // 不记录客户端异常对象，它可能包含认证命令或服务端返回的敏感内容。
    this.logger.warn('Redis 缓存连接不可用');
  };
}
