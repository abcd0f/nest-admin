import type { ArgumentsHost } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUSINESS_CODE } from '../constants/index.js';
import { CoreModule } from '../core.module.js';
import { BusinessException } from '../exceptions/index.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

interface ReplyCall {
  body: Record<string, unknown>;
  status: number;
}

function createHost(response: Record<string, unknown> = {}): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', url: '/users?token=secret' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('全局异常过滤器', () => {
  let reply: ReturnType<typeof vi.fn>;
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    reply = vi.fn();
    const httpAdapterHost = { httpAdapter: { reply } } as unknown as HttpAdapterHost;
    filter = new AllExceptionsFilter(httpAdapterHost);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function catchError(exception: unknown, response: Record<string, unknown> = {}): ReplyCall {
    filter.catch(exception, createHost(response));
    expect(reply).toHaveBeenCalledTimes(1);

    const [, body, status] = reply.mock.calls[0] as [unknown, ReplyCall['body'], number];
    return { body, status };
  }

  it('业务异常保留业务码、HTTP 状态与字段错误', () => {
    const errors = [{ field: 'name', messages: ['name should not be empty'] }];
    const result = catchError(BusinessException.validation(errors));

    expect(result.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(result.body).toEqual({
      code: BUSINESS_CODE.VALIDATION_FAILED,
      data: null,
      message: '请求参数校验失败',
      errors,
    });
  });

  it('框架 HTTP 异常映射为平台业务码并保留原状态', () => {
    const result = catchError(new NotFoundException('用户不存在'));

    expect(result.status).toBe(HttpStatus.NOT_FOUND);
    expect(result.body).toEqual({
      code: BUSINESS_CODE.NOT_FOUND,
      data: null,
      message: '用户不存在',
    });
  });

  it('数组形式的框架提示合并为单行字符串', () => {
    const result = catchError(new BadRequestException(['name 不能为空', 'age 必须是数字']));

    expect(result.body.message).toBe('name 不能为空; age 必须是数字');
  });

  it('未映射的 HTTP 状态按 状态 * 100 生成业务码', () => {
    const result = catchError(new HttpException('网关超时', HttpStatus.GATEWAY_TIMEOUT));

    expect(result.status).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect(result.body.code).toBe(50400);
    expect(result.body.message).toBe('系统内部错误');
  });

  it('未知 Error 返回 500 且不泄露内部消息', () => {
    const result = catchError(new Error('数据库密码=secret'));

    expect(result.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(result.body).toEqual({
      code: BUSINESS_CODE.INTERNAL_ERROR,
      data: null,
      message: '系统内部错误',
    });
    expect(JSON.stringify(result.body)).not.toContain('secret');
  });

  it('非 Error 抛出值同样返回安全 500', () => {
    const result = catchError('boom');

    expect(result.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(result.body.code).toBe(BUSINESS_CODE.INTERNAL_ERROR);
  });

  it('显式构造的 HTTP 5xx 保留状态但不透传内部原因', () => {
    const result = catchError(new HttpException('数据库连接串泄露', HttpStatus.BAD_GATEWAY));

    expect(result.status).toBe(HttpStatus.BAD_GATEWAY);
    expect(result.body.code).toBe(50200);
    expect(result.body.message).toBe('系统内部错误');
  });

  it('响应头已发送时不再写回', () => {
    filter.catch(new Error('late'), createHost({ headersSent: true }));

    expect(reply).not.toHaveBeenCalled();
  });

  it('sent 标记同样阻止二次写回', () => {
    filter.catch(new Error('late'), createHost({ sent: true }));

    expect(reply).not.toHaveBeenCalled();
  });
});

@Controller('probe')
class ProbeController {
  @Get('business')
  business(): never {
    throw new BusinessException({
      code: 100101,
      message: '用户不存在',
      status: HttpStatus.NOT_FOUND,
    });
  }

  @Get('unknown')
  unknown(): never {
    throw new Error('数据库密码=secret');
  }
}

describe('core 模块全局过滤器装配', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule],
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('通过 APP_FILTER 生效：业务异常返回统一错误外壳', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/business' });

    expect(response.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(response.json()).toEqual({
      code: 100101,
      data: null,
      message: '用户不存在',
    });
  });

  it('通过 APP_FILTER 生效：未知错误返回安全 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/unknown' });

    expect(response.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.json()).toEqual({
      code: BUSINESS_CODE.INTERNAL_ERROR,
      data: null,
      message: '系统内部错误',
    });
    expect(response.body).not.toContain('secret');
  });
});
