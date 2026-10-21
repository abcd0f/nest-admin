import { HttpStatus } from '@nestjs/common';

/**
 * 平台通用业务码。
 *
 * 通用业务码直接采用 HTTP 状态码，便于与协议层状态保持一致。
 * 业务模块的专属错误码从 100001 起按模块分配代码段，不要往这里加。
 */
export const BUSINESS_CODE = {
  /** 成功 */
  SUCCESS: 0,
  /** 请求不合法 */
  BAD_REQUEST: HttpStatus.BAD_REQUEST,
  /** 未认证 */
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  /** 无访问权限 */
  FORBIDDEN: HttpStatus.FORBIDDEN,
  /** 资源不存在 */
  NOT_FOUND: HttpStatus.NOT_FOUND,
  /** 资源冲突 */
  CONFLICT: HttpStatus.CONFLICT,
  /** 参数校验失败 */
  VALIDATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  /** 请求过于频繁 */
  TOO_MANY_REQUESTS: HttpStatus.TOO_MANY_REQUESTS,
  /** 系统内部错误 */
  INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
  /** 服务不可用 */
  SERVICE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  /** 通用业务失败 */
  BUSINESS_FAILURE: 100000,
} as const;

export type BusinessCode = (typeof BUSINESS_CODE)[keyof typeof BUSINESS_CODE];

/** 成功响应缺省提示 */
export const DEFAULT_SUCCESS_MESSAGE = '操作成功';

/**
 * 业务码的默认提示语。
 *
 * 只放「可以安全暴露给客户端」的文案；5xx 一律使用固定提示，
 * 不把内部异常消息透传出去。
 */
export const DEFAULT_BUSINESS_MESSAGE: Readonly<Record<number, string>> = {
  [BUSINESS_CODE.BAD_REQUEST]: '请求不合法',
  [BUSINESS_CODE.UNAUTHORIZED]: '未认证',
  [BUSINESS_CODE.FORBIDDEN]: '无访问权限',
  [BUSINESS_CODE.NOT_FOUND]: '资源不存在',
  [BUSINESS_CODE.CONFLICT]: '资源冲突',
  [BUSINESS_CODE.VALIDATION_FAILED]: '请求参数校验失败',
  [BUSINESS_CODE.TOO_MANY_REQUESTS]: '请求过于频繁',
  [BUSINESS_CODE.INTERNAL_ERROR]: '系统内部错误',
  [BUSINESS_CODE.SERVICE_UNAVAILABLE]: '服务不可用',
  [BUSINESS_CODE.BUSINESS_FAILURE]: '业务处理失败',
};

/** 取状态码的默认提示语；未登记的码回落为通用文案。 */
export function resultCodeMessage(code: number): string {
  if (code === BUSINESS_CODE.SUCCESS) return DEFAULT_SUCCESS_MESSAGE;

  return DEFAULT_BUSINESS_MESSAGE[code] ?? '请求处理失败';
}

/**
 * 常见 HTTP 状态到平台业务码的固定映射。
 *
 * 未列出的状态码直接使用 HTTP 状态码。
 */
const HTTP_STATUS_BUSINESS_CODE: Readonly<Record<number, number>> = {
  [HttpStatus.BAD_REQUEST]: BUSINESS_CODE.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: BUSINESS_CODE.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: BUSINESS_CODE.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: BUSINESS_CODE.NOT_FOUND,
  [HttpStatus.CONFLICT]: BUSINESS_CODE.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: BUSINESS_CODE.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: BUSINESS_CODE.TOO_MANY_REQUESTS,
  [HttpStatus.INTERNAL_SERVER_ERROR]: BUSINESS_CODE.INTERNAL_ERROR,
  [HttpStatus.SERVICE_UNAVAILABLE]: BUSINESS_CODE.SERVICE_UNAVAILABLE,
};

/**
 * 把 HTTP 状态映射为业务码。
 *
 * @example
 * httpStatusToBusinessCode(404); // 404
 * httpStatusToBusinessCode(502); // 502
 */
export function httpStatusToBusinessCode(status: number): number {
  return HTTP_STATUS_BUSINESS_CODE[status] ?? status;
}

/** Prisma 已知请求错误对应的 HTTP 状态。未列出的 Prisma 错误按 500 处理。 */
export const PRISMA_ERROR_HTTP_STATUS: Readonly<Record<string, HttpStatus>> = {
  P2000: HttpStatus.UNPROCESSABLE_ENTITY,
  P2002: HttpStatus.CONFLICT,
  P2003: HttpStatus.CONFLICT,
  P2004: HttpStatus.BAD_REQUEST,
  P2005: HttpStatus.UNPROCESSABLE_ENTITY,
  P2006: HttpStatus.UNPROCESSABLE_ENTITY,
  P2007: HttpStatus.UNPROCESSABLE_ENTITY,
  P2011: HttpStatus.UNPROCESSABLE_ENTITY,
  P2012: HttpStatus.UNPROCESSABLE_ENTITY,
  P2013: HttpStatus.UNPROCESSABLE_ENTITY,
  P2014: HttpStatus.CONFLICT,
  P2015: HttpStatus.NOT_FOUND,
  P2016: HttpStatus.BAD_REQUEST,
  P2017: HttpStatus.CONFLICT,
  P2018: HttpStatus.NOT_FOUND,
  P2019: HttpStatus.UNPROCESSABLE_ENTITY,
  P2020: HttpStatus.UNPROCESSABLE_ENTITY,
  P2024: HttpStatus.SERVICE_UNAVAILABLE,
  P2025: HttpStatus.NOT_FOUND,
  P2034: HttpStatus.CONFLICT,
};

/** 将 Prisma 请求错误码映射为 HTTP 状态，未知错误安全回落到 500。 */
export function prismaCodeToHttpStatus(code: string): HttpStatus {
  return PRISMA_ERROR_HTTP_STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}
