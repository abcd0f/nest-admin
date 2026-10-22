import { REFRESH_TOKEN_PATTERN } from '@app/auth';
import { IsNotEmpty, IsString, Length, Matches, MaxLength } from 'class-validator';

export class LoginDto {
  /** 用户账号，按原值精确匹配。 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  userName!: string;

  /** 登录密码，不执行 trim 或隐式类型转换。 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

export class RefreshTokenDto {
  /** 会话 ID 与 256 位随机值组成的 Refresh Token。 */
  @IsString()
  @Length(80, 80)
  @Matches(REFRESH_TOKEN_PATTERN)
  refreshToken!: string;
}

export class AuthUserDto {
  /** 用户 ID，十进制字符串。 */
  userId!: string;
  /** 用户账号。 */
  userName!: string;
  /** 用户昵称。 */
  nickName!: string;
  /** 当前部门 ID，无部门时为 null。 */
  deptId!: string | null;
}

export class TokenResponseDto {
  /** 短期访问 JWT。 */
  accessToken!: string;
  /** 每次刷新后必须替换的 Refresh Token。 */
  refreshToken!: string;
  /** Authorization 请求头方案。 */
  tokenType!: 'Bearer';
  /** Access Token 剩余有效期，单位秒。 */
  expiresIn!: number;
}

export class LoginResponseDto extends TokenResponseDto {
  /** 脱敏用户资料。 */
  user!: AuthUserDto;
}

export class ProfileResponseDto extends AuthUserDto {
  /** 当前有效角色标识。 */
  roles!: string[];
  /** 当前有效操作权限码。 */
  permissions!: string[];
}
