import type { OnApplicationShutdown } from '@nestjs/common';
import type { TransportMultiOptions } from 'pino';
import { once } from 'node:events';
import { transport } from 'pino';

// thread-stream 当前声明遗漏 ref()，运行时由 Pino 的 transport 提供。
type ManagedTransport = ReturnType<typeof transport> & { ref: () => void };

/** 输出流的唯一所有者；业务和 HTTP 层均不负责文件句柄与 worker。 */
export class LoggerTransport implements OnApplicationShutdown {
  private closing?: Promise<void>;

  private constructor(readonly stream: ManagedTransport) {}

  static async create(options: TransportMultiOptions): Promise<LoggerTransport> {
    const stream = transport(options) as ManagedTransport;
    await once(stream, 'ready');
    return new LoggerTransport(stream);
  }

  onApplicationShutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = once(this.stream, 'close').then(() => undefined);
    // Pino 就绪后会 unref worker；关闭期间必须保持它存活直到尾部记录落盘。
    this.stream.ref();
    this.stream.end();
    return this.closing;
  }
}
