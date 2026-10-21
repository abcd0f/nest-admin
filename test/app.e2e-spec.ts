import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createFastifyAdapter } from '@app/common';
import { HTTP_LOG_TEST_SECRETS_PATTERN } from '@app/common/constants/regex.js';
import { loggerConfig, redisConfig } from '@app/config';
import { AllExceptionsFilter, RawResponse } from '@app/core';
import { LoggerService, PinoLogger } from '@app/logger';
import { BadRequestException, ConsoleLogger, Controller, Get, Inject, Logger, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../apps/gateway/src/app.module.js';
import { loggerDomain } from '../libs/config/src/domains/logger.domain.js';
import { redisDomain } from '../libs/config/src/domains/redis.domain.js';
import { readLogRecords } from './helpers/read-log-records.js';

@Controller('log-probe')
@RawResponse()
class LogProbeController {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

  @Post('ok')
  async ok(@Req() request: { id: string }) {
    await setImmediate();
    this.logger.info({ password: 'business-secret' }, 'probe-business');
    new Logger('ProbeService').log('probe-nest');
    return { id: request.id };
  }

  @Get('bad')
  bad(): never {
    throw new BadRequestException('参数错误');
  }

  @Get('failure')
  failure(): never {
    throw new Error('probe-failure');
  }

  @Get('prisma-conflict')
  prismaConflict(): never {
    throw Object.assign(new Error('database detail'), { code: 'P2002' });
  }

  @Get('prisma-missing')
  prismaMissing(): never {
    throw Object.assign(new Error('database detail'), { code: 'P2025' });
  }
}

interface HttpLogRecord {
  level: number;
  msg: string;
  context?: string;
  responseTime?: number;
  req?: { id: string; url: string };
  res?: { statusCode: number };
  err?: { stack: string };
}

describe('Gateway Fastify 日志链路 (e2e)', () => {
  let app: NestFastifyApplication;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nest-logger-http-'));
    // Vitest 的转换链不保证生成构造参数元数据，仅在测试中补充已有生产类型。
    Reflect.defineMetadata('design:paramtypes', [HttpAdapterHost], AllExceptionsFilter);
    const config = loggerDomain.parse({ console: { enabled: false }, file: { directory } }, { environment: 'test' });
    const module = await Test.createTestingModule({ imports: [AppModule], controllers: [LogProbeController] })
      .overrideProvider(redisConfig.KEY)
      .useValue(redisDomain.parse({ enabled: false }, { environment: 'test' }))
      .overrideProvider(loggerConfig.KEY)
      .useValue(config)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), { logger: false });
    app.useLogger(app.get(LoggerService));
    app.setGlobalPrefix(app.get(ConfigService).getOrThrow<string>('app.apiPrefix'));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    Logger.overrideLogger(new ConsoleLogger());
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function records(prefix = 'gateway'): Promise<HttpLogRecord[]> {
    return readLogRecords<HttpLogRecord>(directory, prefix);
  }

  it('实际根模块按 Fastify 启动，根接口使用配置的全局 API 前缀', async () => {
    const response = await app.inject({ method: 'GET', url: '/api' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('欢迎使用 Nest.js 构建的 API 接口服务！');
  });

  it('不带全局 API 前缀的根接口返回 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });

  it('并发请求跨 await 的业务日志与访问日志使用实际 Fastify ID，且不泄露凭据', async () => {
    const responses = await Promise.all(Array.from({ length: 3 }, () => app.inject({
      method: 'POST',
      url: '/api/log-probe/ok?token=query-secret',
      headers: { authorization: 'Bearer header-secret', cookie: 'session=cookie-secret', 'x-request-id': 'untrusted-id' },
      payload: { password: 'body-secret' },
    })));
    const ids = responses.map(response => {
      expect(response.statusCode).toBe(201);
      return response.json<{ id: string }>().id;
    });
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain('untrusted-id');

    await vi.waitFor(async () => {
      const logs = await records();
      for (const id of ids) {
        const matching = logs.filter(log => log.req?.id === id);
        expect(matching.filter(log => log.msg === 'probe-business')).toHaveLength(1);
        expect(matching.filter(log => log.msg === 'probe-nest' && log.context === 'ProbeService')).toHaveLength(1);
        const access = matching.filter(log => log.res?.statusCode === 201);
        expect(access).toHaveLength(1);
        expect(access[0]).toMatchObject({ level: 30, req: { url: '/api/log-probe/ok' } });
        expect(access[0].responseTime).toBeTypeOf('number');
      }
      const content = JSON.stringify(logs);
      expect(content).not.toMatch(HTTP_LOG_TEST_SECRETS_PATTERN);
    });
  });

  it('4xx 为 warn 且不进入错误文件，5xx 和原始堆栈进入 error 文件', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/log-probe/bad' });
    const failure = await app.inject({ method: 'GET', url: '/api/log-probe/failure' });
    expect(bad.statusCode).toBe(400);
    expect(failure.statusCode).toBe(500);
    expect(failure.body).not.toContain('probe-failure');
    await vi.waitFor(async () => {
      const main = await records();
      expect(main.filter(log => log.res?.statusCode === 400)).toMatchObject([{ level: 40 }]);
      expect(main.filter(log => log.res?.statusCode === 500)).toMatchObject([{ level: 50 }]);
      const errors = await records('error');
      expect(errors.some(log => log.req?.url === '/api/log-probe/bad')).toBe(false);
      expect(errors.some(log => log.err?.stack.includes('probe-failure'))).toBe(true);
      expect(errors.some(log => log.res?.statusCode === 500)).toBe(true);
    });
  });

  it('框架 404 同样只产生一条请求完成日志', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/missing-route' })).statusCode).toBe(404);
    await vi.waitFor(async () => {
      const access = (await records()).filter(log => log.req?.url === '/api/missing-route' && log.res);
      expect(access).toHaveLength(1);
      expect(access[0].level).toBe(40);
    });
  });

  it('Prisma 唯一约束和记录不存在分别映射为 HTTP 409 和 404', async () => {
    const conflict = await app.inject({ method: 'GET', url: '/api/log-probe/prisma-conflict' });
    const missing = await app.inject({ method: 'GET', url: '/api/log-probe/prisma-missing' });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 409, data: null, message: '资源冲突' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 404, data: null, message: '资源不存在' });
    expect(conflict.body).not.toContain('database detail');
    expect(missing.body).not.toContain('database detail');
  });
});
