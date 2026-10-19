import { DateFormat } from '@app/core/decorators/index.js';
import { Expose, Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * 排序顺序
 */
export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

/**
 * 分页查询参数
 */
export class PageQueryDto {
  /**
   * 页码
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /**
   * 页大小，缺省 20，上限 200；超出上限返回 422
   *
   * 取值必须与 `@app/database` 的 `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE` 保持一致：
   * DTO 负责「校验层」的严格约束（越界返回 422），`paginate()` 负责「兜底层」
   * 的缺省与截断，两者数字一旦漂移就会出现「文档写 200、代码封顶 100」。
   * 不在这里引常量是刻意为之——`common` 是比 `database` 更底层的库，不应反向依赖。
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 20;

  /**
   * 排序字段
   */
  @IsOptional()
  @IsString()
  orderByColumn?: string;

  /**
   * 排序顺序
   */
  @IsOptional()
  @IsEnum(SortOrder)
  @Transform(({ value }) => value?.toLowerCase())
  isAsc?: SortOrder;
}

/**
 * 分页元数据
 */
export class PageMetaDto {
  /**
   * 页码
   */
  @Expose()
  @IsInt()
  page!: number;

  /**
   * 页大小
   */
  @Expose()
  pageSize!: number;

  /**
   * 总数
   */
  @Expose()
  total!: number;

  /**
   * 总页数
   */
  @Expose()
  totalPage!: number;
}

/**
 * 分页响应数据
 */
export class PageResponseDto<T> {
  /**
   * 数据项
   */
  @Expose()
  items!: T[];

  /**
   * 分页元数据
   */
  @Expose()
  meta!: PageMetaDto;
}

/**
 * 基础实体
 */
export class BaseEntityDto {
  /**
   * 创建时间
   */
  @Expose()
  @DateFormat()
  createTime?: Date;

  /**
   * 更新人
   */
  @Expose()
  updateBy?: string;

  /**
   * 更新时间
   */
  @Expose()
  @DateFormat()
  updateTime?: Date;

  /**
   * 备注
   */
  @Expose()
  remark?: string;
}
