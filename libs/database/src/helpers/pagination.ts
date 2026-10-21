import type { PageQueryDto, PageResponseDto } from '@app/common';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@app/common/constants/pagination.js';

export { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@app/common/constants/pagination.js';

/** 分页入参由 PageQueryDto 完成 HTTP 字符串转换和校验 */
export type PageQuery = Pick<PageQueryDto, 'page' | 'pageSize' | 'orderByColumn' | 'isAsc'>;

interface FindManyDelegate<T> {
  findMany: (...args: any[]) => Promise<T[]>;
  count: (...args: any[]) => Promise<number>;
}

export interface PaginationParams<
  Where = unknown,
  OrderBy = unknown,
  Select = unknown,
  Omit = unknown,
> extends PageQuery {
  where?: Where;
  orderBy?: OrderBy;
  select?: Select;
  omit?: Omit;
}

function buildOrderBy(orderBy?: unknown): unknown {
  if (!orderBy) return { createTime: 'desc' };

  if (typeof orderBy === 'object' && ('orderByColumn' in orderBy || 'isAsc' in orderBy)) {
    const { orderByColumn = 'createTime', isAsc = 'desc' } = orderBy as Pick<
      PageQuery,
      'orderByColumn' | 'isAsc'
    >;
    return { [orderByColumn]: isAsc };
  }

  return orderBy;
}

/**
 * 归一化分页参数。
 *
 * 规则（对 page / pageSize 一致）：
 * - 非法值（非数字、NaN、<= 0、Infinity）→ 回落到默认值
 * - 合法值 → pageSize 封顶 MAX_PAGE_SIZE
 *
 * 不做封顶的话，一个 `pageSize=999999` 的请求就能把数据库拖垮。
 */
export function normalizePage(query: PageQuery = {}): {
  skip: number;
  take: number;
  page: number;
  pageSize: number;
} {
  const rawPage = Math.trunc(Number(query.page));
  const rawPageSize = Math.trunc(Number(query.pageSize));

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : DEFAULT_PAGE;
  const pageSize =
    Number.isFinite(rawPageSize) && rawPageSize > 0
      ? Math.min(MAX_PAGE_SIZE, rawPageSize)
      : DEFAULT_PAGE_SIZE;

  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

/**
 * 分页查询：返回当前页数据及分页元数据，总数使用相同的 where 条件查询。
 * 自动将 orderByColumn / isAsc 转为 Prisma 排序条件，默认按 createTime 降序。
 * 显式传入的 orderBy 优先，支持原生 Prisma 排序条件。
 *
 * @example
 * return paginate(this.prisma.user, { ...query, where });
 */
export async function paginate<
  T,
  Where = unknown,
  OrderBy = unknown,
  Select = unknown,
  Omit = unknown,
>(
  delegate: FindManyDelegate<T>,
  params: PaginationParams<Where, OrderBy, Select, Omit> = {},
): Promise<PageResponseDto<T>> {
  const { where, orderBy, select, omit, orderByColumn, isAsc } = params;
  if (select && omit) {
    throw new Error('Cannot use both "select" and "omit" at the same time');
  }

  const { skip, take, page, pageSize } = normalizePage(params);
  const findManyArgs: Record<string, unknown> = {
    where,
    skip,
    take,
    orderBy: buildOrderBy(orderBy ?? { orderByColumn, isAsc }),
  };
  if (select) findManyArgs.select = select;
  else if (omit) findManyArgs.omit = omit;

  const [items, total] = await Promise.all([
    delegate.findMany(findManyArgs),
    delegate.count({ where }),
  ]);

  return {
    items,
    meta: { page, pageSize, total, totalPage: Math.ceil(total / pageSize) },
  };
}
