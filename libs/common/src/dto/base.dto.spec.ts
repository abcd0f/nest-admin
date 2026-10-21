import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { PageQueryDto } from './base.dto.js';

describe('分页查询 DTO', () => {
  it('缺省使用第 1 页、每页 20 条', () => {
    const query = plainToInstance(PageQueryDto, {});
    expect(query).toMatchObject({ page: 1, pageSize: 20 });
    expect(validateSync(query)).toEqual([]);
  });

  it.each([1, 200])('将 HTTP 字符串转换为合法页大小 %s', (pageSize) => {
    const query = plainToInstance(PageQueryDto, { page: '2', pageSize: String(pageSize) });
    expect(query).toMatchObject({ page: 2, pageSize });
    expect(validateSync(query)).toEqual([]);
  });

  it.each([0, 201, 1.5, 'invalid'])('拒绝非法页大小 %s', (pageSize) => {
    const errors = validateSync(plainToInstance(PageQueryDto, { pageSize }));
    expect(errors.map(error => error.property)).toEqual(['pageSize']);
  });
});
