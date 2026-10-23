/**
 * BigInt 主键的十进制字面量校验。
 *
 * 与 Nest 无关的纯函数，`BigIntIdPipe` 与认证/权限模块共用同一套规则，
 * 保证"什么算合法主键"只有一处定义。格式部分复用
 * `@app/common` 的 {@link BIGINT_ID_PATTERN}，避免正则写两份。
 */
import { BIGINT_ID_PATTERN } from '@app/common/constants/regex.js';

/** int64 上界，Prisma `BigInt` 主键的合法上限。 */
export const MAX_BIGINT_ID = 9223372036854775807n;

/**
 * 判断一个值是否为可安全落库的 BigInt 主键字符串。
 *
 * 只接受规范十进制字符串：`'007'`、`' 1'`、`'-1'`、`'1.0'` 一律不合法，
 * 避免同一主键出现多种字面量。全程用 `BigInt` 比较，不经过 `Number`，
 * 否则 19 位数值会被浮点精度截断。
 *
 * 用途不限于路由主键：JWT 的 `sub`、会话里的 `userId`、DTO 里的关联 ID
 * 都是同一套取值范围。
 */
export function isBigIntId(value: unknown): value is string {
  return typeof value === 'string' && BIGINT_ID_PATTERN.test(value) && BigInt(value) <= MAX_BIGINT_ID;
}
