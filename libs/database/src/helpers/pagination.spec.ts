import { describe, expect, it, vi } from 'vitest';
import { paginate } from './pagination.js';

describe('paginate', () => {
  it('返回当前页及筛选后的分页元数据，count 不受分页或字段选择影响', async () => {
    const items = [{ userId: 21 }];
    const delegate = {
      findMany: vi.fn().mockResolvedValue(items),
      count: vi.fn().mockResolvedValue(21),
    };
    const where = { status: '0' };
    const select = { userId: true };
    const orderBy = { userId: 'asc' };

    const result = await paginate(delegate, {
      page: 3,
      pageSize: 10,
      where,
      select,
      orderBy,
      orderByColumn: 'createTime',
    });

    expect(result).toEqual({
      items,
      meta: { page: 3, pageSize: 10, total: 21, totalPage: 3 },
    });
    expect(delegate.findMany).toHaveBeenCalledExactlyOnceWith({
      where,
      select,
      orderBy,
      skip: 20,
      take: 10,
    });
    expect(delegate.count).toHaveBeenCalledExactlyOnceWith({ where });
  });

  it.each([
    { query: {}, total: 0, page: 1, pageSize: 20, totalPage: 0 },
    { query: { page: NaN, pageSize: -1 }, total: 40, page: 1, pageSize: 20, totalPage: 2 },
    { query: { page: 2, pageSize: 999999 }, total: 401, page: 2, pageSize: 200, totalPage: 3 },
    { query: { pageSize: 201 }, total: 201, page: 1, pageSize: 200, totalPage: 2 },
    { query: { page: 5, pageSize: 10 }, total: 21, page: 5, pageSize: 10, totalPage: 3 },
  ])('按有效分页参数返回元数据：$query，total=$total', async ({ query, total, page, pageSize, totalPage }) => {
    const delegate = {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(total),
    };

    expect(await paginate(delegate, query)).toEqual({
      items: [],
      meta: { page, pageSize, total, totalPage },
    });
    expect(delegate.findMany).toHaveBeenCalledExactlyOnceWith({
      where: undefined,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createTime: 'desc' },
    });
    expect(delegate.count).toHaveBeenCalledExactlyOnceWith({ where: undefined });
  });

  it('保留 omit 和排序字段转换', async () => {
    const delegate = {
      findMany: vi.fn().mockResolvedValue([{ userId: 1 }]),
      count: vi.fn().mockResolvedValue(1),
    };

    await paginate(delegate, { omit: { password: true }, orderByColumn: 'userId' });

    expect(delegate.findMany).toHaveBeenCalledExactlyOnceWith({
      where: undefined,
      skip: 0,
      take: 20,
      orderBy: { userId: 'desc' },
      omit: { password: true },
    });
  });

  it('同时传入 select 和 omit 时不执行查询', async () => {
    const delegate = { findMany: vi.fn(), count: vi.fn() };

    await expect(paginate(delegate, { select: { userId: true }, omit: { password: true } }))
      .rejects
      .toThrow('Cannot use both "select" and "omit" at the same time');
    expect(delegate.findMany).not.toHaveBeenCalled();
    expect(delegate.count).not.toHaveBeenCalled();
  });
});
