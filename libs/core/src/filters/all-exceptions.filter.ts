import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { ApiErrorResponse, FieldError } from '../interfaces/index.js';
import {
  BUSINESS_CODE,
  DEFAULT_BUSINESS_MESSAGE,
  httpStatusToBusinessCode,
  PRISMA_ERROR_CODE_PATTERN,
  prismaCodeToHttpStatus,
} from '@app/common/constants/index.js';

import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { BusinessException } from '../exceptions/index.js';

/** 只读取写响应所需的字段，避免绑定具体平台类型 */
interface RawHttpResponse {
  headersSent?: boolean;
  sent?: boolean;
}

interface RawHttpRequest {
  method?: string;
  url?: string;
}

interface ResolvedError {
  status: number;
  body: ApiErrorResponse;
  /** 需要记录到服务端日志的原始异常 */
  cause?: unknown;
}

/**
 * 全局异常过滤器。
 *
 * 处理顺序：
 * 1. `BusinessException`：保留业务码、HTTP 状态与受控的字段错误；
 * 2. 其他 `HttpException`：保留 HTTP 状态，映射为平台业务码，只提取公开提示；
 * 3. 未知错误或非 Error 抛出值：统一 500，对外固定安全提示。
 *
 * 响应通过 `HttpAdapterHost` 写回，不依赖 Express 或 Fastify 的专用 API；
 * 响应头已发送时不再尝试写 JSON，避免二次发送导致连接异常。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const context = host.switchToHttp();
    const request = context.getRequest<RawHttpRequest>();
    const response = context.getResponse<RawHttpResponse>();

    if (response.headersSent === true || response.sent === true) {
      this.logger.warn(`响应已发送，跳过异常写回：${this.describeRequest(request)}`);
      return;
    }

    const resolved = this.resolve(exception);

    if (resolved.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${this.describeRequest(request)} -> ${resolved.status}/${resolved.body.code} ${resolved.body.message}`,
        this.describeCause(resolved.cause),
      );
    }

    httpAdapter.reply(response, resolved.body, resolved.status);
  }

  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof BusinessException) {
      return {
        status: exception.getStatus(),
        body: this.errorBody(exception.code, exception.message, exception.errors),
      };
    }

    if (exception instanceof HttpException) {
      return this.resolveHttpException(exception);
    }

    const prismaCode = this.prismaCodeOf(exception);
    if (prismaCode !== undefined) {
      const status = prismaCodeToHttpStatus(prismaCode);
      const code = httpStatusToBusinessCode(status);

      return {
        status,
        body: this.errorBody(code, this.defaultMessageOf(code)),
        cause: exception,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: this.errorBody(
        BUSINESS_CODE.INTERNAL_ERROR,
        DEFAULT_BUSINESS_MESSAGE[BUSINESS_CODE.INTERNAL_ERROR],
      ),
      cause: exception,
    };
  }

  private prismaCodeOf(exception: unknown): string | undefined {
    if (exception === null || typeof exception !== 'object') return undefined;

    const code = (exception as { code?: unknown }).code;
    return typeof code === 'string' && PRISMA_ERROR_CODE_PATTERN.test(code) ? code : undefined;
  }

  private resolveHttpException(exception: HttpException): ResolvedError {
    const status = exception.getStatus();
    const code = httpStatusToBusinessCode(status);

    // 5xx 可能是内部细节泄露，对外一律使用固定提示，原始异常只进日志。
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return {
        status,
        body: this.errorBody(code, this.defaultMessageOf(code)),
        cause: exception,
      };
    }

    const message = this.publicMessageOf(exception) ?? this.defaultMessageOf(code);

    return {
      status,
      body: this.errorBody(code, message),
    };
  }

  /**
   * 只提取可公开的提示，不透传框架异常里的任意响应对象。
   *
   * Nest 的 `BadRequestException` 等会把 message 存成字符串数组，
   * 这里拼成单行字符串，保证 `message` 始终是字符串。
   */
  private publicMessageOf(exception: HttpException): string | undefined {
    const response = exception.getResponse();

    if (typeof response === 'string') {
      return response.length > 0 ? response : undefined;
    }

    if (response === null || typeof response !== 'object') {
      return undefined;
    }

    const message = (response as { message?: unknown }).message;

    if (typeof message === 'string') {
      return message.length > 0 ? message : undefined;
    }

    if (Array.isArray(message)) {
      const messages = message.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      );

      if (messages.length > 0) {
        return messages.join('; ');
      }
    }

    return undefined;
  }

  private defaultMessageOf(code: number): string {
    return DEFAULT_BUSINESS_MESSAGE[code]
      ?? DEFAULT_BUSINESS_MESSAGE[BUSINESS_CODE.INTERNAL_ERROR];
  }

  private errorBody(code: number, message: string, errors?: FieldError[]): ApiErrorResponse {
    if (errors !== undefined && errors.length > 0) {
      return { code, data: null, message, errors };
    }

    return { code, data: null, message };
  }

  /** 只记录方法与路径，不记录查询串、请求体或认证信息 */
  private describeRequest(request: RawHttpRequest): string {
    const url = request.url ?? '';
    const queryIndex = url.indexOf('?');

    return `${request.method ?? '-'} ${queryIndex === -1 ? url : url.slice(0, queryIndex)}`;
  }

  private describeCause(cause: unknown): string {
    if (cause instanceof Error) {
      return cause.stack ?? `${cause.name}: ${cause.message}`;
    }

    return `非 Error 抛出值（${typeof cause}）`;
  }
}
