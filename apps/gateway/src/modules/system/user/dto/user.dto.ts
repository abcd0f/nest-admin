import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class CreateUserDto {
  /**
   * 用户名
   * @example admin
   */
  @IsString()
  @Length(3, 64)
  @Matches(/^[\w-]+$/)
  username!: string;

  /**
   * 密码
   * @example <PASSWORD>
   */
  @IsString()
  @Length(6, 128)
  password!: string;

  /**
   * 邮箱
   * @example <EMAIL>
   */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  /**
   * 昵称
   * @example 昵称
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickName?: string;
}
