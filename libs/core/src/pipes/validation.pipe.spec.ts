import { Type } from 'class-transformer';
import { IsString, ValidateNested } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { LoginDto } from '../../../../apps/gateway/src/modules/system/auth/dto/auth.dto.js';
import { PageQueryDto } from '../../../common/src/dto/base.dto.js';
import { BusinessException } from '../exceptions/business.exception.js';
import { DtoValidationPipe } from './validation.pipe.js';

class EntryDto {
  @IsString({ message: 'private input $value' })
  name!: string;
}

class NestedDto {
  @ValidateNested({ each: true })
  @Type(() => EntryDto)
  items!: EntryDto[];
}

describe('全局 DTO 校验', () => {
  const pipe = new DtoValidationPipe();

  it('保留显式分页数字转换，拒绝登录字段的隐式类型转换及未知字段', async () => {
    expect(
      await pipe.transform(
        { page: '2', pageSize: '20' },
        { type: 'query', metatype: PageQueryDto },
      ),
    ).toMatchObject({ page: 2, pageSize: 20 });
    for (const value of [
      { userName: 'alice', password: 123 },
      { userName: 'alice', password: 'secret', roleId: '1' },
    ]) {
      await expect(pipe.transform(value, { type: 'body', metatype: LoginDto })).rejects.toThrow(
        BusinessException,
      );
    }
    const result = (await pipe.transform(
      { userName: 'alice', password: '  secret  ' },
      { type: 'body', metatype: LoginDto },
    )) as LoginDto;
    expect(result.password).toBe('  secret  ');
  });

  it('扁平化嵌套字段路径，不包含 target/value 或插值后的敏感字段', async () => {
    const error = (await pipe
      .transform({ items: [{ name: 42 }] }, { type: 'body', metatype: NestedDto })
      .catch((value) => value)) as BusinessException;
    expect(error).toBeInstanceOf(BusinessException);
    expect(error.getStatus()).toBe(422);
    expect(error.errors).toEqual([{ field: 'items.0.name', messages: ['字段校验失败'] }]);
    expect(JSON.stringify(error.errors)).not.toContain('42');
  });
});
