import { DateFormat } from '@app/core/decorators/index.js';
import { Expose, Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/pagination.js';

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
   * @example 1
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = DEFAULT_PAGE;

  /**
   * 页大小，缺省 20，上限 200；超出上限返回 422
   *
   * 与 `paginate()` 共用 common 中的分页常量；DTO 负责严格校验，
   * `paginate()` 负责内部调用的缺省与截断。
   * @example 20
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number = DEFAULT_PAGE_SIZE;

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
