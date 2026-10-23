import type { ArgumentMetadata, Type } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BusinessException } from '../exceptions/business.exception.js';
import { isBigIntId, MAX_BIGINT_ID } from '../validators/bigint-id.js';
import { BigIntIdPipe } from './bigint-id.pipe.js';

/** 与 `design:paramtypes` 保持一致：`bigint` 参数在运行时是 `BigInt` 构造函数。 */
const BIGINT_METATYPE = BigInt as unknown as Type<unknown>;

function paramMeta(data = 'id'): ArgumentMetadata {
  return { type: 'param', data, metatype: BIGINT_METATYPE };
}

function catchError(pipe: BigIntIdPipe, value: unknown, metadata: ArgumentMetadata): BusinessException {
  try {
    pipe.transform(value, metadata);
  } catch (error) {
    return error as BusinessException;
  }
  throw new Error('期望抛出 BusinessException，实际通过了校验');
}

describe('全局 BigInt 主键管道', () => {
  const pipe = new BigIntIdPipe();

  it('把合法十进制字符串转成 bigint，且不经过 Number', () => {
    expect(pipe.transform('1', paramMeta())).toBe(1n);
    // 2^53 + 1：走 Number 会丢精度，转成 bigint 必须保持精确。
    expect(pipe.transform('9007199254740993', paramMeta())).toBe(9007199254740993n);
    expect(pipe.transform(String(MAX_BIGINT_ID), paramMeta())).toBe(MAX_BIGINT_ID);
  });

  it('已是 bigint 的值保持幂等', () => {
    expect(pipe.transform(5n, paramMeta())).toBe(5n);
  });

  it('非 bigint 参数原样透传，交给 DTO 校验管道', () => {
    expect(pipe.transform('abc', { type: 'param', data: 'key', metatype: String })).toBe('abc');
    expect(pipe.transform(undefined, { type: 'query', metatype: Object })).toBeUndefined();
    expect(pipe.transform({ id: '1' }, { type: 'body', metatype: Object })).toEqual({ id: '1' });
  });

  it.each([
    ['空串', ''],
    ['零', '0'],
    ['前导零', '007'],
    ['前导空白', ' 1'],
    ['尾随空白', '1 '],
    ['负数', '-1'],
    ['正号', '+1'],
    ['小数', '1.0'],
    ['科学计数法', '1e3'],
    ['非数字', 'abc'],
    ['int64 上界 +1', '9223372036854775808'],
    ['19 位溢出值', '9999999999999999999'],
  ])('拒绝%s并返回 422 字段错误', (_label, value) => {
    const error = catchError(pipe, value, paramMeta());
    expect(error).toBeInstanceOf(BusinessException);
    expect(error.getStatus()).toBe(422);
    expect(error.errors).toEqual([{ field: 'id', messages: ['ID 无效'] }]);
  });

  it('字段名取自参数名', () => {
    expect(catchError(pipe, 'x', paramMeta('roleId')).errors).toEqual([
      { field: 'roleId', messages: ['ID 无效'] },
    ]);
  });

  it('判定函数与管道保持同一套规则', () => {
    for (const value of ['1', '9223372036854775807', '9007199254740993']) {
      expect(isBigIntId(value)).toBe(true);
    }
    for (const value of ['0', '01', '9223372036854775808', '', 1, 1n, null, undefined]) {
      expect(isBigIntId(value)).toBe(false);
    }
  });
});
