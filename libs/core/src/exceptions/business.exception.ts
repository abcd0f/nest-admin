import type { FieldError } from '../interfaces/index.js';

import { BUSINESS_CODE, DEFAULT_BUSINESS_MESSAGE } from '@app/common/constants/index.js';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 只读的业务错误定义。
 *
 * 业务模块在各自的错误常量里声明，例如：
 *
 * ```ts
 * export const USER_NOT_FOUND = {
 *   code: 100101,
 *   message: '用户不存在',
 *   status: HttpStatus.NOT_FOUND,
 * } as const satisfies BusinessErrorDefinition;
 * ```
 */
export interface BusinessErrorDefinition {
  /** 非零业务码，业务模块从 100001 起分配 */
  readonly code: number;
  /** 面向用户的默认提示 */
  readonly message: string;
  /** 该错误默认对应的 HTTP 状态 */
  readonly status: HttpStatus;
}

export interface BusinessExceptionOptions {
  /** 覆盖定义里的默认提示（例如带上具体参数） */
  message?: string;
  /** 字段级校验错误，仅校验类失败使用 */
  errors?: FieldError[];
  /** 原始原因，只用于服务端排查，不对外输出 */
  cause?: unknown;
}

/**
 * 可预期的业务失败。
 *
 * 继承 `HttpException` 以复用 Nest 的异常通道，但业务码、字段错误和
 * 对外提示由本类显式携带；全局过滤器不会解析消息字符串来猜错误类型。
 *
 * @example
 * ```ts
 * throw new BusinessException(USER_NOT_FOUND, { cause: error });
 * throw new BusinessException(ORDER_LOCKED, { message: `订单 ${id} 已锁定` });
 * ```
 */
export class BusinessException extends HttpException {
  /** 稳定业务码，客户端据此判断失败原因 */
  readonly code: number;

  /** 字段级校验错误，非校验类失败为 undefined */
  readonly errors?: FieldError[];

  constructor(definition: BusinessErrorDefinition, options: BusinessExceptionOptions = {}) {
    if (definition.code === BUSINESS_CODE.SUCCESS) {
      throw new Error('业务异常的业务码不能为 0');
    }

    const message = options.message ?? definition.message;

    super(message, definition.status, { cause: options.cause });

    this.name = 'BusinessException';
    this.code = definition.code;
    this.errors = options.errors;
  }

  /**
   * 构造参数校验失败异常（HTTP 422）。
   *
   * 供全局校验管道在把 class-validator 的错误树拍平成 `FieldError[]` 后调用，
   * 避免过滤器重新理解 class-validator 的树结构。
   */
  static validation(errors: FieldError[], message?: string): BusinessException {
    return new BusinessException(
      {
        code: BUSINESS_CODE.VALIDATION_FAILED,
        message: message ?? DEFAULT_BUSINESS_MESSAGE[BUSINESS_CODE.VALIDATION_FAILED],
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      },
      { errors },
    );
  }
}
