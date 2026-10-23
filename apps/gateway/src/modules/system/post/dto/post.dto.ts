import { PageMetaDto, PageQueryDto } from '@app/common';
import { DateFormat } from '@app/core';
import { PartialType } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreatePostDto {
  /** 所属部门；岗位按部门划分，同名岗位可存在于不同部门。省略时落在当前用户所属部门。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[1-9]\d{0,18}$/)
  @MaxLength(19)
  @Type(() => String)
  deptId?: string;

  /** 岗位编码，未删除岗位内全局唯一。 */
  @IsString()
  @Matches(/^\S+$/)
  @MaxLength(64)
  postCode!: string;

  /** 岗位名称，同一部门内唯一。 */
  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  postName!: string;

  /** 显示顺序，缺省 0。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  orderNum?: number;

  /** 状态：0 启用、1 停用，缺省 0。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1'])
  status?: string;

  /** 备注；null 清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string | null;
}

export class UpdatePostDto extends PartialType(CreatePostDto, { skipNullProperties: false }) {}

export class PostQueryDto extends PageQueryDto {
  /** 岗位编码包含匹配。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(64)
  postCode?: string;

  /** 岗位名称包含匹配。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(64)
  postName?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1'])
  status?: string;

  /** 所属部门精确匹配，不扩展下级；范围过滤另行生效。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[1-9]\d{0,18}$/)
  @MaxLength(19)
  @Type(() => String)
  deptId?: string;
}

/** 岗位下拉选择：只回传渲染选项需要的字段。 */
export class PostOptionQueryDto {
  /** 只返回该部门下的启用岗位。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[1-9]\d{0,18}$/)
  @MaxLength(19)
  @Type(() => String)
  deptId?: string;
}

@Exclude()
export class PostResponseDto {
  @Expose()
  @Type(() => String)
  postId!: string;

  @Expose()
  @Type(() => String)
  deptId!: string | null;

  @Expose()
  postCode!: string;

  @Expose()
  postName!: string;

  @Expose()
  orderNum!: number;

  @Expose()
  status!: string;

  @Expose()
  remark!: string | null;

  @Expose()
  @DateFormat()
  createTime!: Date;

  @Expose()
  @DateFormat()
  updateTime!: Date | null;
}

@Exclude()
export class PostOptionDto {
  @Expose()
  @Type(() => String)
  postId!: string;

  @Expose()
  postCode!: string;

  @Expose()
  postName!: string;
}

@Exclude()
export class PostPageDto {
  @Expose()
  @Type(() => PostResponseDto)
  items!: PostResponseDto[];

  @Expose()
  @Type(() => PageMetaDto)
  meta!: PageMetaDto;
}
