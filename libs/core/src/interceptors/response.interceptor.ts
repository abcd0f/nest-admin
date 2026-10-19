import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { ApiSuccessResponse } from '../interfaces/index.js';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { map } from 'rxjs';
import { BUSINESS_CODE, resultCodeMessage } from '../constants/index.js';
import { SKIP_RESPONSE_WRAP } from '../decorators/raw-response.decorator.js';

/**
 * 统一包装成功响应。
 *
 * 业务接口默认返回统一响应体；文件下载、流式响应等特殊接口可通过
 * `@RawResponse()` 跳过包装。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T | null> | T
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T | null> | T> {
    const skipWrap = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_WRAP, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipWrap) {
      return next.handle();
    }

    const code = BUSINESS_CODE.SUCCESS;

    return next.handle().pipe(
      map((data) => ({
        code,
        data: data ?? null,
        message: resultCodeMessage(code),
      })),
    );
  }
}
