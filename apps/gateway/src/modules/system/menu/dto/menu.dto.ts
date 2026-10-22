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

export class CreateMenuDto {
  /** 父菜单 ID，缺省 "0"。M/C 仅可挂在 M 下；F 必须挂在 C 下。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,18})$/)
  @MaxLength(19)
  @Type(() => String)
  parentId?: string;

  /** 菜单名称。 */
  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  menuName!: string;

  /** M 目录、C 菜单、F 按钮。 */
  @IsIn(['M', 'C', 'F'])
  menuType!: string;

  /** 显示顺序，缺省 0。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  orderNum?: number;

  /** 路由地址；null 清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  path?: string | null;

  /** 前端组件路径；null 清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  component?: string | null;

  /** 路由参数；null 清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  query?: string | null;

  /** 是否外链：0 是、1 否，缺省 1。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1'])
  isFrame?: string;

  /** 是否缓存：0 是、1 否，缺省 0。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1'])
  isCache?: string;

  /** 是否隐藏：0 显示、1 隐藏，缺省 0。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1'])
  visible?: string;

  /** 状态：0 启用、1 停用，缺省 0。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1'])
  status?: string;

  /** 精确操作权限码。F 必填，M 必须为空；不支持通配符。null 清空。 */
  @IsOptional()
  @IsString()
  @Matches(/^[^\s*]+$/)
  @MaxLength(100)
  perms?: string | null;

  /** 图标；null 清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string | null;

  /** 备注；null 清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string | null;
}

export class UpdateMenuDto extends PartialType(CreateMenuDto, { skipNullProperties: false }) {}

@Exclude()
export class MenuResponseDto {
  @Expose()
  @Type(() => String)
  menuId!: string;

  @Expose()
  @Type(() => String)
  parentId!: string;

  @Expose()
  menuName!: string;

  @Expose()
  menuType!: string;

  @Expose()
  orderNum!: number;

  @Expose()
  path!: string | null;

  @Expose()
  component!: string | null;

  @Expose()
  query!: string | null;

  @Expose()
  isFrame!: string;

  @Expose()
  isCache!: string;

  @Expose()
  visible!: string;

  @Expose()
  status!: string;

  @Expose()
  perms!: string | null;

  @Expose()
  icon!: string | null;

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
export class MenuTreeDto extends MenuResponseDto {
  @ApiProperty({ type: () => MenuTreeDto, isArray: true })
  @Expose()
  @Type(() => MenuTreeDto)
  children!: MenuTreeDto[];
}
