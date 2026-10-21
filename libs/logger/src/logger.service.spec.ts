import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigModule, loggerConfig } from '@app/config';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { readLogRecords } from '../../../test/helpers/read-log-records.js';
import { loggerDomain } from '../../config/src/domains/logger.domain.js';
import { LoggerModule } from './logger.module.js';
import { LoggerService } from './logger.service.js';

describe('nest 日志桥接与生命周期', () => {
  it('原有 Nest Logger 自动写入两个文件，app.close 前的最后一条错误落盘', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nest-logger-bridge-'));
    const config = loggerDomain.parse({ console: { enabled: false }, file: { directory } }, { environment: 'test' });
    const module = await Test.createTestingModule({ imports: [AppConfigModule.forRoot(), LoggerModule] })
      .overrideProvider(loggerConfig.KEY)
      .useValue(config)
      .compile();
    const app = module.createNestApplication(new FastifyAdapter(), { logger: false });

    try {
      app.useLogger(app.get(LoggerService));
      await app.init();
      const logger = new Logger('LegacyService');
      logger.log('bridge-info');
      logger.error(new Error('bridge-tail-error'));
      await app.close();

      const main = JSON.stringify(await readLogRecords(directory));
      const error = JSON.stringify(await readLogRecords(directory, 'error'));
      expect(main).toContain('bridge-info');
      expect(main).toContain('bridge-tail-error');
      expect(error).toContain('bridge-tail-error');
      expect(error).toContain('LegacyService');
      expect(error).not.toContain('bridge-info');
    } finally {
      Logger.overrideLogger(new ConsoleLogger());
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
