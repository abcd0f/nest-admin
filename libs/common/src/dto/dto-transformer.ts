import type { PageResponseDto } from './base.dto.js';

import { ClassConstructor, plainToInstance } from 'class-transformer';
import { PageMetaDto } from './base.dto.js';

const SERIALIZE_OPTIONS = { excludeExtraneousValues: true, enableImplicitConversion: true };

export function toDto<T>(cls: ClassConstructor<T>, plain: object | null | undefined): T | null {
  if (plain === null || plain === undefined) return null;
  return plainToInstance(cls, plain, SERIALIZE_OPTIONS);
}

export function toDtoList<T>(
  cls: ClassConstructor<T>,
  plainList: object[] | null | undefined,
): T[] {
  if (!plainList || !Array.isArray(plainList)) return [];
  return plainList.map((item) => plainToInstance(cls, item, SERIALIZE_OPTIONS));
}

export function toPageDto<T>(cls: ClassConstructor<T>, data: PageResponseDto<object>) {
  return {
    items: toDtoList(cls, data.items),
    meta: plainToInstance(PageMetaDto, data.meta, SERIALIZE_OPTIONS),
  };
}

/**
 * 把「可选数值」的原始输入归一化成 `number | undefined`。
 *
 * 存在意义只有一个：**把「空值」和「值为 0」区分开**。
 *
 * 直接写 `@Type(() => Number)` 是不行的——class-transformer 对 `Number` 的处理是
 * `Number(value)`，而 `Number('') === 0`、`Number('  ') === 0`。后果是
 * `?status=`（前端清空筛选后提交的空串）会被静默转成 `0`，也就是「筛选停用用户」，
 * 看起来像筛选失效，实际是条件被凭空造了出来。
 *
 * 所以调用点的写法是 `@Type(() => String)` + 本函数：
 * 前者**压掉**隐式的 `Number` 转换（`enableImplicitConversion: true` 会按
 * `design:type` 把属性转成数字），让 `@Transform` 拿到的是原始字符串，
 * 才能分辨 `''` 与 `'0'`。
 *
 * 非法输入（如 `'abc'`）**刻意返回 `NaN` 而不是 `undefined`**：返回 `undefined`
 * 会被 `@IsOptional()` 放行，筛选条件被静默丢弃；返回 `NaN` 则会落到后续的
 * `@IsEnum` / `@IsIn` 上，得到一个 422 + 字段级提示。
 *
 * @example
 * // DTO 上：
 * @IsOptional()
 * @Type(() => String)
 * @Transform(({ value }) => toOptionalNumber(value))
 * @IsEnum(UserStatus)
 * status?: UserStatus;
 */
export function toOptionalNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }

  return Number(raw);
}
