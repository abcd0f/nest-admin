import { DateFormat } from '@app/core';
import { ApiProperty, PartialType } from '@nestjs/swagger';
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

export class CreateDeptDto {
  /** 父部门 ID，缺省 "0"。ancestors 由服务端维护。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,18})$/)
  @MaxLength(19)
  @Type(() => String)
  parentId?: string;

  /** 部门名称。 */
  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  deptName!: string;

  /** 显示顺序，缺省 0。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  orderNum?: number;

  /** 负责人用户 ID；null 清空。 */
  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d{0,18}$/)
  @MaxLength(19)
  @Type(() => String)
  leaderId?: string | null;

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

export class UpdateDeptDto extends PartialType(CreateDeptDto, { skipNullProperties: false }) {}

@Exclude()
export class DeptResponseDto {
  @Expose()
  @Type(() => String)
  deptId!: string;

  @Expose()
  @Type(() => String)
  parentId!: string;

  @Expose()
  ancestors!: string;

  @Expose()
  deptName!: string;

  @Expose()
  orderNum!: number;

  @Expose()
  @Type(() => String)
  leaderId!: string | null;

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
export class DeptTreeDto extends DeptResponseDto {
  @ApiProperty({ type: () => DeptTreeDto, isArray: true })
  @Expose()
  @Type(() => DeptTreeDto)
  children!: DeptTreeDto[];
}
