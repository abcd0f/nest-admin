import { BUSINESS_CODE, httpStatusToBusinessCode, prismaCodeToHttpStatus } from '@app/common/constants/index.js';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { BusinessException } from './business.exception.js';

describe('业务异常', () => {
  it('保留错误定义里的业务码、HTTP 状态与默认提示', () => {
    const exception = new BusinessException({
      code: 100101,
      message: '用户不存在',
      status: HttpStatus.NOT_FOUND,
    });

    expect(exception.code).toBe(100101);
    expect(exception.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(exception.message).toBe('用户不存在');
    expect(exception.errors).toBeUndefined();
  });

  it('允许覆盖对外提示并保留原因链', () => {
    const cause = new Error('数据库连接超时');
    const exception = new BusinessException(
      { code: 100102, message: '订单已锁定', status: HttpStatus.CONFLICT },
      { message: '订单 A-1 已锁定', cause },
    );

    expect(exception.message).toBe('订单 A-1 已锁定');
    expect(exception.cause).toBe(cause);
  });

  it('校验失败工厂返回标准 HTTP 422 与字段错误', () => {
    const errors = [{ field: 'items.0.name', messages: ['name should not be empty'] }];
    const exception = BusinessException.validation(errors);

    expect(exception.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(exception.code).toBe(BUSINESS_CODE.VALIDATION_FAILED);
    expect(exception.errors).toEqual(errors);
  });

  it('拒绝把成功码 0 当作错误码', () => {
    expect(() => new BusinessException({
      code: BUSINESS_CODE.SUCCESS,
      message: '不该出现',
      status: HttpStatus.BAD_REQUEST,
    })).toThrow('业务异常的业务码不能为 0');
  });

  it('通用业务码与 HTTP 状态码一致，并为 Prisma 错误提供标准状态映射', () => {
    expect(httpStatusToBusinessCode(HttpStatus.NOT_FOUND)).toBe(HttpStatus.NOT_FOUND);
    expect(prismaCodeToHttpStatus('P2002')).toBe(HttpStatus.CONFLICT);
    expect(prismaCodeToHttpStatus('P2025')).toBe(HttpStatus.NOT_FOUND);
    expect(prismaCodeToHttpStatus('P2024')).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(prismaCodeToHttpStatus('P2999')).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});
