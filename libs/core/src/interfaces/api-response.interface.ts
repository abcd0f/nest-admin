/**
 * 单个字段的校验错误。
 *
 * `field` 是稳定的路径表达式（如 `items.0.name`），不包含 DTO target 或原始输入。
 */
export interface FieldError {
  readonly field: string;
  readonly messages: string[];
}

/**
 * 成功响应外壳。
 *
 * `code` 恒为 0；`data` 无返回值时为 null。
 */
export interface ApiSuccessResponse<T = unknown> {
  readonly code: number;
  readonly data: T;
  readonly message: string;
}

/**
 * 失败响应外壳。
 *
 * `errors` 只在字段校验失败时出现，其余错误不带该字段。
 */
export interface ApiErrorResponse {
  readonly code: number;
  readonly data: null;
  readonly message: string;
  readonly errors?: FieldError[];
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;
