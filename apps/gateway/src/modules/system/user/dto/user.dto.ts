import { PageMetaDto, PageQueryDto } from '@app/common';
import { DateFormat } from '@app/core';
import { PartialType } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateUserDto {
  /** 账号，未删除用户内精确查重。 */
  @IsString()
  @Matches(/^\S(?:.*\S)?$/)
  @MaxLength(64)
  userName!: string;

  /** 用户昵称。 */
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  nickName!: string;

  /** 初始密码，仅保存 Argon2id 哈希，不执行 trim。 */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  /** 所属部门；null 表示不分配部门。 */
  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d{0,18}$/)
  @MaxLength(19)
  @Type(() => String)
  deptId?: string | null;

  /** 邮箱；null 清空。 */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  /** 手机号；null 清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string | null;

  /** 性别：0 男、1 女、2 未知，缺省 2。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1', '2'])
  sex?: string;

  /** 状态：0 启用、1 停用，缺省 0。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1'])
  status?: string;

  /** 岗位集合；省略表示不改动，空数组清空，重复 ID 去重。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @Matches(/^[1-9]\d{0,18}$/, { each: true })
  @MaxLength(19, { each: true })
  @Type(() => String)
  postIds?: string[];

  /** 备注；null 清空。 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string | null;
}

export class UpdateUserDto extends PartialType(CreateUserDto, { skipNullProperties: false }) {}

export class UserQueryDto extends PageQueryDto {
  /** 账号包含匹配。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(64)
  userName?: string;

  /** 状态筛选。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['0', '1'])
  status?: string;

  /** 所属部门精确匹配，不扩展下级。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[1-9]\d{0,18}$/)
  @MaxLength(19)
  @Type(() => String)
  deptId?: string;
}

export class AssignUserRolesDto {
  /** 完整替换角色集合；空数组清空，重复 ID 去重。 */
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @Matches(/^[1-9]\d{0,18}$/, { each: true })
  @MaxLength(19, { each: true })
  @Type(() => String)
  roleIds!: string[];
}

@Exclude()
export class UserResponseDto {
  @Expose()
  @Type(() => String)
  userId!: string;

  @Expose()
  userName!: string;

  @Expose()
  nickName!: string;

  @Expose()
  @Type(() => String)
  deptId!: string | null;

  @Expose()
  email!: string | null;

  @Expose()
  phoneNumber!: string | null;

  @Expose()
  sex!: string;

  @Expose()
  status!: string;

  /** 已关联角色 ID，包含停用但未移除的关联。 */
  @Expose()
  @Type(() => String)
  roleIds!: string[];

  /** 已关联岗位 ID。 */
  @Expose()
  @Type(() => String)
  postIds!: string[];

  @Expose()
  remark!: string | null;

  /** 创建时间。 */
  @Expose()
  @DateFormat()
  createTime!: Date;

  @Expose()
  @DateFormat()
  updateTime!: Date | null;
}

@Exclude()
export class UserPageDto {
  @Expose()
  @Type(() => UserResponseDto)
  items!: UserResponseDto[];

  @Expose()
  @Type(() => PageMetaDto)
  meta!: PageMetaDto;
}
