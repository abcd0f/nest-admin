import { apiDecryptConfig, apiDecryptDomain } from './api-decrypt.domain.js';
import { appConfig, appDomain } from './app.domain.js';
import { databaseConfig, databaseDomain } from './database.domain.js';
import { loggerConfig, loggerDomain } from './logger.domain.js';
import { redisConfig, redisDomain } from './redis.domain.js';
import { swaggerConfig, swaggerDomain } from './swagger.domain.js';
import { throttlerConfig, throttlerDomain } from './throttler.domain.js';

/**
 * 域注册表 —— 新增配置域时唯一需要改动的清单。
 *
 * 启动校验的顺序、registerAs 的注册顺序都从这里派生，
 * 不存在「加了校验忘了注册」这类漏改（旧版就是漏改 load[] 才会编译通过、启动才崩）。
 *
 * 新增一个域：
 *   1. 新建 `domains/<name>.domain.ts`，用 defineConfigDomain 实现 parse/validate
 *   2. 在下方 imports 加一行、DOMAINS 数组加一项、文件末尾补类型导出
 */
export const DOMAINS = [
  appDomain,
  apiDecryptDomain,
  loggerDomain,
  swaggerDomain,
  throttlerDomain,
  databaseDomain,
  redisDomain,
] as const;

export { apiDecryptConfig, appConfig, databaseConfig, loggerConfig, redisConfig, swaggerConfig, throttlerConfig };

export type { ApiDecryptConfig } from './api-decrypt.domain.js';
export type { AppConfig, NodeEnv } from './app.domain.js';
export type { DatabaseConfig, DatabasePoolConfig } from './database.domain.js';
export type { LoggerConfig } from './logger.domain.js';
export type { RedisConfig } from './redis.domain.js';
export type { SwaggerConfig } from './swagger.domain.js';
export type { ThrottlerConfig } from './throttler.domain.js';
