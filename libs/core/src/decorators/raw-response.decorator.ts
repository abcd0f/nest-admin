import { SetMetadata } from '@nestjs/common';

/** 元数据键：标记「跳过统一响应包装」 */
export const SKIP_RESPONSE_WRAP = Symbol('SKIP_RESPONSE_WRAP');

/**
 * 跳过统一响应包装。
 *
 * 用于少数必须返回原始体的接口：文件下载、流式响应、第三方回调要求的固定格式等。
 * 可标注在方法或 controller 类上（标在类上时对该类全部接口生效）。
 *
 * @example
 * ```ts
 * @RawResponse()
 * @Get('export')
 * export() {
 *   return this.service.buildCsv();
 * }
 * ```
 */
export function RawResponse() {
  return SetMetadata(SKIP_RESPONSE_WRAP, true);
}
