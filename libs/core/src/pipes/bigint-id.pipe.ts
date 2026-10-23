import type { ArgumentMetadata, PipeTransform, Type } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { BusinessException } from '../exceptions/business.exception.js';
import { isBigIntId } from '../validators/bigint-id.js';

/**
 * `design:paramtypes` 把 `bigint` 发射成 `BigInt` 构造函数，
 * 它没有 `new` 签名，与 Nest 的 `Type<T>` 不兼容，只能断言后比较。
 */
const BIGINT_METATYPE = BigInt as unknown as Type<unknown>;

/**
 * 全局 BigInt 主键管道。
 *
 * 在 `CoreModule` 里以 `APP_PIPE` 注册，对所有路由生效，但只接管
 * **声明为 `bigint` 的控制器参数**（`metadata.metatype` 为 `BigInt`）：
 *
 * ```ts
 * @Get(':id')
 * findOne(@Param('id') id: bigint) { ... }   // id 已是 bigint，无需再转换
 * ```
 *
 * 之所以按类型而不是按参数名（`id` / `xxxId`）判断，是因为参数名约定
 * 覆盖不了 `:target` 这类不叫 `id` 的主键路由，而类型由编译器保证。
 * 其余参数（`string`、`number`、DTO 对象）原样透传，交给 DTO 校验管道，
 * 本管道不做任何隐式类型转换。
 *
 * 数组主键（如 `?ids=1,2`）的 `metatype` 是 `Array`，不归本管道处理，
 * 请在 DTO 上用字段级校验。
 *
 * 刻意不声明构造参数：本管道以 `APP_PIPE` + `useClass` 全局注册，
 * 一旦有构造参数，Nest 会把它当依赖去容器里解析（`string` 会变成 `String` 令牌）并启动失败。
 * 失败时统一返回一条提示，不构造字段错误，也不再按参数名或实体定制文案。
 */
@Injectable()
export class BigIntIdPipe implements PipeTransform<unknown, unknown> {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.metatype !== BIGINT_METATYPE) return value;
    // 已经转换过的值保持幂等，避免重复校验。
    if (typeof value === 'bigint') return value;
    if (!isBigIntId(value)) {
      throw BusinessException.validation('ID 无效');
    }
    return BigInt(value);
  }
}
