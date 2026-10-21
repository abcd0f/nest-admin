import { asBoolean, asEnum, asObject, asPositiveInteger, defineConfigDomain } from '../core/index.js';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const ROLL_FREQUENCIES = ['hourly', 'daily', 'weekly'] as const;

export interface LoggerConfig {
  level: (typeof LOG_LEVELS)[number];
  console: { enabled: boolean; pretty: boolean };
  file: {
    enabled: boolean;
    directory: string;
    sizeMb: number;
    frequency: (typeof ROLL_FREQUENCIES)[number];
    maxFiles: number;
  };
}

export const loggerDomain = defineConfigDomain<LoggerConfig>({
  namespace: 'logger',
  parse(raw, context): LoggerConfig {
    const value = asObject(raw, 'logger');
    const console = asObject(value.console, 'logger.console');
    const file = asObject(value.file, 'logger.file');
    const directory = file.directory ?? 'logs/gateway';
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      throw new Error('logger.file.directory: 必须是非空字符串');
    }

    const config: LoggerConfig = {
      level: asEnum(value.level, 'logger.level', LOG_LEVELS, 'info'),
      console: {
        enabled: asBoolean(console.enabled, 'logger.console.enabled', true),
        pretty: asBoolean(console.pretty, 'logger.console.pretty', context.environment !== 'production'),
      },
      file: {
        enabled: asBoolean(file.enabled, 'logger.file.enabled', true),
        directory: directory.trim(),
        sizeMb: asPositiveInteger(file['size-mb'], 'logger.file.size-mb', 20),
        frequency: asEnum(file.frequency, 'logger.file.frequency', ROLL_FREQUENCIES, 'daily'),
        maxFiles: asPositiveInteger(file['max-files'], 'logger.file.max-files', 15),
      },
    };

    if (!config.console.enabled && !config.file.enabled) {
      throw new Error('logger: 控制台与文件输出至少启用一个');
    }
    return config;
  },
});

export const loggerConfig = loggerDomain.token;
