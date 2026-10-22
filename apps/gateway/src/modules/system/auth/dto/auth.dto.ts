import { REFRESH_TOKEN_PATTERN } from '@app/auth';
import { ApiProperty } from '@nestjs/swagger';
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

export class AuthMenuDto {
  /** 菜单 ID，十进制字符串。 */
  menuId!: string;
  /** 父节点 ID，根节点为 "0"。 */
  parentId!: string;
  /** 菜单名称。 */
  menuName!: string;
  /** 路由节点类型，M 目录、C 菜单；不包含按钮。 */
  menuType!: 'M' | 'C';
  /** 显示顺序，相同时按菜单 ID 升序。 */
  orderNum!: number;
  /** 路由地址。 */
  path!: string | null;
  /** 前端组件路径。 */
  component!: string | null;
  /** 路由参数，保留数据库原值。 */
  query!: string | null;
  /** 是否外链：0 是、1 否。 */
  isFrame!: string;
  /** 是否缓存：0 缓存、1 不缓存。 */
  isCache!: string;
  /** 是否隐藏；本接口仅返回 0（显示）的节点。 */
  visible!: string;
  /** 菜单图标。 */
  icon!: string | null;
  /** 当前用户可见的已授权子节点。 */
  @ApiProperty({ type: () => AuthMenuDto, isArray: true })
  children!: AuthMenuDto[];
}
