import type { RedisConfig } from '@app/config';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { redisConfig } from '@app/config';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createClient } from 'redis';

type RedisClientType = ReturnType<typeof createClient>;

/** 唯一的连接所有者。其他服务和适配器只借用 client，不连接、不关闭。 */
@Injectable()
export class RedisClient implements OnModuleInit, OnApplicationShutdown {
  readonly client: RedisClientType | undefined;
  private readonly logger = new Logger(RedisClient.name);
  private connected = false;
  private closing = false;

  constructor(@Inject(redisConfig.KEY) readonly config: RedisConfig) {
    if (!config.enabled) return;
    this.client = createClient({
      username: config.username,
      password: config.password,
      database: config.db,
      name: `${config.keyPrefix}:${process.pid}`,
      disableOfflineQueue: true,
      commandsQueueMaxLength: config.commandsQueueMaxLength,
      commandOptions: { timeout: config.commandTimeout },
      socket: {
        host: config.host,
        port: config.port,
        ...(config.tls ? { tls: true as const } : { tls: false as const }),
        connectTimeout: config.connectTimeout,
        reconnectStrategy: (retries) => {
          // 首次连接失败立即终止启动；运行期在同一客户端上重建 socket。
          if (!this.connected || this.closing) return false;
          return Math.min(config.retryDelay * 2 ** Math.min(retries, 5), 30000) + Math.floor(Math.random() * 100);
        },
      },
    });
    this.client.on('error', this.onError);
    this.client.on('ready', this.onReady);
    this.client.on('reconnecting', this.onReconnecting);
  }

  private readonly onError = () => this.logger.error('Redis 连接或命令失败，请检查服务状态与凭据');
  private readonly onReady = () => {
    this.connected = true;
    this.logger.log('Redis 已就绪');
  };

  private readonly onReconnecting = () => this.logger.warn('Redis 正在重连，离线命令将立即失败');

  get ready(): RedisClientType {
    if (this.closing || !this.client?.isReady) throw new Error('Redis 未就绪或已关闭');
    return this.client;
  }

  async onModuleInit(): Promise<void> {
    if (!this.client || this.connected) return;
    // socket 超时不包含所有握手场景，因此对整个启动连接设置上限。
    const timer = setTimeout(() => {
      if (this.client?.isOpen) this.client.destroy();
    }, this.config.connectTimeout);
    try {
      await this.client.connect();
    } catch {
      if (this.client.isOpen) this.client.destroy();
      throw new Error('Redis 连接失败，请检查 redis 配置与服务状态');
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    if (!this.config.enabled) return { status: 'disabled' } as const;
    const start = performance.now();
    try {
      await this.run(() => this.ready.ping());
      return { status: 'up', latencyMs: Math.round(performance.now() - start) } as const;
    } catch {
      return { status: 'down' } as const;
    }
  }

  /** 上游 timeout 仅覆盖发送前排队；这里限制整个调用，超时不代表服务端取消执行。 */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Redis 命令执行超时')), this.config.commandTimeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    if (!this.client) return;
    // close() 在等待响应时可能一直挂起，且提前把 isOpen 置为 false，无法再 destroy。
    // 此钩子在 HTTP 服务停止后执行；明确终止仍未完成的 Redis 命令，保证退出可完成。
    if (this.client.isOpen) this.client.destroy();
    this.client.off('error', this.onError);
    this.client.off('ready', this.onReady);
    this.client.off('reconnecting', this.onReconnecting);
  }
}
