import type { LoggerConfig } from '@app/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TransportMultiOptions, TransportTargetOptions } from 'pino';
import type { Options } from 'pino-http';
import { resolve } from 'node:path';
import { stdSerializers, stdTimeFunctions } from 'pino';

const REDACT_FIELDS = ['password', 'token', 'accessToken', 'refreshToken', 'authorization', 'cookie'];

/** 日志生成策略与输出策略分开，HTTP 与业务日志共用同一根实例。 */
export function createHttpOptions(config: LoggerConfig): Options {
  return {
    level: config.level,
    timestamp: stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_FIELDS.flatMap(field => [field, `*.${field}`]),
      censor: '[REDACTED]',
    },
    wrapSerializers: false,
    serializers: {
      err: stdSerializers.errWithCause,
      req: (req: IncomingMessage & { originalUrl?: string }) => ({
        id: req.id,
        method: req.method,
        // Fastify/Nest 中间件匹配路由时会暂时重写 url，originalUrl 保留完整路径。
        url: (req.originalUrl ?? req.url)?.split('?', 1)[0],
      }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: () => 'HTTP request completed',
    customErrorMessage: () => 'HTTP request failed',
  };
}

/** 所有目标只接收可序列化选项，由 Pino 在同一个 worker 内创建。 */
export function createTransportOptions(config: LoggerConfig): TransportMultiOptions {
  const targets: TransportTargetOptions[] = [];

  if (config.console.enabled) {
    targets.push({
      target: config.console.pretty ? 'pino-pretty' : 'pino/file',
      level: config.level,
      options: config.console.pretty
        ? { destination: 1, colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
        : { destination: 1 },
    });
  }

  if (config.file.enabled) {
    for (const name of ['gateway', 'error'] as const) {
      targets.push({
        target: 'pino-roll',
        level: name === 'error' ? 'error' : config.level,
        options: {
          file: resolve(config.file.directory, `${name}.log`),
          mkdir: true,
          size: `${config.file.sizeMb}m`,
          frequency: config.file.frequency,
          dateFormat: config.file.frequency === 'hourly' ? 'yyyy-MM-dd-HH' : 'yyyy-MM-dd',
          // pino-roll 4.0.0 在跨进程历史清理模式下，count 包含活动文件。
          limit: { count: config.file.maxFiles, removeOtherLogFiles: true },
        },
      });
    }
  }

  return { targets, dedupe: false };
}
