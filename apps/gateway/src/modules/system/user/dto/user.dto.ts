import { PageQueryDto } from '@app/common';
import { PartialType } from '@nestjs/swagger';
import { IsEmail, IsInt, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';

/**
 * 创建用户必填参数
 */
export class CreateUserDto {
  /**
   * 用户名称
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  userName!: string;

  /**
   * 密码
   * @example <PASSWORD>
   */
  @IsString()
  @Length(6, 128)
  password!: string;

  /**
   * 用户昵称
   */
  @IsString()
  nickName?: string;

  /**
   * 邮箱
   * @example <EMAIL>
   */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  /**
   * 手机号
   */
  phoneNumber?: string;

  /**
   * 性别
   */
  @IsString()
  sex?: string;

  /**
   * 备注
   */
  @IsString()
  remark?: string;
}

/**
 * 修改用户参数
 */
export class UpdateUserDto extends PartialType(CreateUserDto) {
  /** 修改用户id */
  @IsInt()
  @Min(1)
  userId!: number;
}

/** 查询用户参数 */
export class QueryUserDto extends PageQueryDto {}
