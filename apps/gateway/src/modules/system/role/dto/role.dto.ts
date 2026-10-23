import {
  BIGINT_ID_PATTERN,
  CONTAINS_NON_WHITESPACE_PATTERN,
  IDENTIFIER_WITHOUT_WILDCARD_PATTERN,
  PageMetaDto,
  PageQueryDto,
} from '@app/common';
import { DateFormat } from '@app/core';
import { PartialType } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { DeptTreeDto } from '../../dept/dto/dept.dto.js';
import { MenuTreeDto } from '../../menu/dto/menu.dto.js';

export class CreateRoleDto {
  /** 角色名称。 */
  @IsString()
  @Matches(CONTAINS_NON_WHITESPACE_PATTERN)
  @MaxLength(64)
  roleName!: string;

  /** 角色标识，未删除角色内精确查重，不允许空白和通配符。 */
  @IsString()
  @Matches(IDENTIFIER_WITHOUT_WILDCARD_PATTERN)
  @MaxLength(64)
  roleKey!: string;

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

  /**
   * 菜单树选择项是否关联显示，缺省 true。
   *
   * 只影响角色菜单回显（`GET /system/role/menuTree/:id`）：为 true 时剔除父节点，
   * 让前端把部分勾选的父节点渲染成半选。不参与权限计算。
   */
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  menuCheckStrictly?: boolean;

  /** 部门树选择项是否关联显示，缺省 true；只影响角色部门回显，不参与数据权限计算。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  deptCheckStrictly?: boolean;

  /** 备注；null 清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string | null;
}

export class UpdateRoleDto extends PartialType(CreateRoleDto, { skipNullProperties: false }) {}

export class RoleQueryDto extends PageQueryDto {
  /** 角色名称包含匹配。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(64)
  roleName?: string;

  /** 角色标识精确匹配。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(64)
  roleKey?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1'])
  status?: string;
}

export class AssignRoleMenusDto {
  /** 完整替换菜单集合；不会隐式补入父节点，空数组清空。 */
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @Matches(BIGINT_ID_PATTERN, { each: true })
  @MaxLength(19, { each: true })
  @Type(() => String)
  menuIds!: string[];
}

export class RoleDataScopeDto {
  /** 1 全部、2 自定义、3 本部门、4 本部门及以下、5 本人、6 部门及以下或本人。 */
  @IsIn(['1', '2', '3', '4', '5', '6'])
  dataScope!: string;

  /** 仅 dataScope=2 使用且必须非空；其他范围须省略或传空数组。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @Matches(BIGINT_ID_PATTERN, { each: true })
  @MaxLength(19, { each: true })
  @Type(() => String)
  deptIds?: string[];
}

@Exclude()
export class RoleResponseDto {
  @Expose()
  @Type(() => String)
  roleId!: string;

  @Expose()
  roleName!: string;

  @Expose()
  roleKey!: string;

  @Expose()
  orderNum!: number;

  @Expose()
  status!: string;

  @Expose()
  dataScope!: string;

  @Expose()
  menuCheckStrictly!: boolean;

  @Expose()
  deptCheckStrictly!: boolean;

  @Expose()
  @Type(() => String)
  menuIds!: string[];

  @Expose()
  @Type(() => String)
  deptIds!: string[];

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
export class RolePageDto {
  @Expose()
  @Type(() => RoleResponseDto)
  items!: RoleResponseDto[];

  @Expose()
  @Type(() => PageMetaDto)
  meta!: PageMetaDto;
}

/** 角色菜单回显：已选 ID + 完整菜单树。 */
@Exclude()
export class RoleMenuTreeDto {
  /** 角色已关联的菜单 ID；menuCheckStrictly 为 true 时只含末级节点，父节点由前端推导为半选。 */
  @Expose()
  @Type(() => String)
  checkedKeys!: string[];

  @Expose()
  @Type(() => MenuTreeDto)
  menus!: MenuTreeDto[];
}

/** 角色部门回显：已选 ID + 完整部门树。 */
@Exclude()
export class RoleDeptTreeDto {
  /** 角色已关联的部门 ID；deptCheckStrictly 为 true 时只含末级节点。 */
  @Expose()
  @Type(() => String)
  checkedKeys!: string[];

  @Expose()
  @Type(() => DeptTreeDto)
  depts!: DeptTreeDto[];
}
