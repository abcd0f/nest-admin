import fs from 'node:fs';
import path from 'node:path';
import { LoggerService } from '@nestjs/common';
import pino from 'pino';
import { isDev } from '../../utils/src/globalenv.util.js';

export interface PinoLoggerOptions {
  enableConsole?: boolean;
  logDir?: string;
  level?: pino.Level;
  maxFiles?: number;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getLogFileName(level: string): string {
  const date = new Date().toISOString().split('T')[0];
  return `${level}-${date}.log`;
}

function cleanOldLogs(logDir: string, maxFiles: number): void {
  if (!fs.existsSync(logDir) || maxFiles <= 0) return;

  const files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.log'))
    .map(f => ({
      name: f,
      path: path.join(logDir, f),
      mtime: fs.statSync(path.join(logDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  files.slice(maxFiles).forEach(file => {
    try {
      fs.unlinkSync(file.path);
    } catch {}
  });
}

function createFileDestination(logDir: string, level: string) {
  ensureDir(logDir);
  return pino.destination({
    dest: path.join(logDir, getLogFileName(level)),
    sync: false,
  });
}

function createPinoLogger(options: PinoLoggerOptions = {}): pino.Logger {
  const {
    enableConsole,
    logDir = path.resolve(process.cwd(), 'logs'),
    level = isDev ? 'debug' : 'info',
    maxFiles = 30,
  } = options;

  const showConsole = enableConsole !== false;

  cleanOldLogs(logDir, maxFiles);

  const appFileDestination = createFileDestination(logDir, 'app');
  const errorFileDestination = createFileDestination(logDir, 'error');

  const baseOptions: pino.LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label.toUpperCase() }),
    },
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  };

  const streams: pino.StreamEntry[] = [
    { level: 'info' as pino.Level, stream: appFileDestination },
    { level: 'error' as pino.Level, stream: errorFileDestination },
  ];

  if (showConsole) {
    if (isDev) {
      streams.unshift({
        level: level as pino.Level,
        stream: pino.transport({
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }),
      });
    } else {
      streams.unshift({ level: 'info' as pino.Level, stream: process.stdout });
    }
  }

  return pino(baseOptions, pino.multistream(streams));
}

export class PinoLogger implements LoggerService {
  private readonly logger: pino.Logger;

  constructor(options?: PinoLoggerOptions) {
    this.logger = createPinoLogger(options);
  }

  log(message: string, context?: string): void {
    this.logger.info({ context }, message);
  }

  error(message: string, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, message);
  }

  warn(message: string, context?: string): void {
    this.logger.warn({ context }, message);
  }

  debug(message: string, context?: string): void {
    this.logger.debug({ context }, message);
  }

  verbose(message: string, context?: string): void {
    this.logger.trace({ context }, message);
  }
}
