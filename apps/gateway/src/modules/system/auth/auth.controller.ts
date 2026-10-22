import type { AuthenticatedUser } from '@app/auth';
import type { FastifyRequest } from 'fastify';
import { AuthService, CurrentUser, Public } from '@app/auth';
import { Authenticated } from '@app/permission';
import { Body, Controller, Get, Header, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { SystemAuthService } from './auth.service.js';
import {
  AuthMenuDto,
  LoginDto,
  LoginResponseDto,
  ProfileResponseDto,
  RefreshTokenDto,
  TokenResponseDto,
} from './dto/auth.dto.js';

/**
 * 认证
 */
@Controller('auth')
export class SystemAuthController {
  constructor(
    @Inject(SystemAuthService) private readonly service: SystemAuthService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /** 账号密码登录并创建独立设备会话。 */
  @Post('login')
  @Public()
  login(@Body() body: LoginDto, @Req() request: FastifyRequest): Promise<LoginResponseDto> {
    return this.service.login(body, request.ip);
  }

  /** 轮换令牌，保持会话绝对期限；旧 Refresh Token 重放将撤销当前会话。 */
  @Post('refresh')
  @Public()
  refresh(@Body() body: RefreshTokenDto): Promise<TokenResponseDto> {
    return this.auth.refresh(body.refreshToken);
  }

  /** 撤销当前设备会话，使该会话 Access/Refresh Token 立即失效。 */
  @Post('logout')
  @ApiBearerAuth()
  logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.auth.logout(user.sessionId);
  }

  /** 查询本人脱敏资料和实时有效角色、操作权限。 */
  @Get('profile')
  @Authenticated()
  @ApiBearerAuth()
  profile(@CurrentUser() user: AuthenticatedUser): Promise<ProfileResponseDto> {
    return this.service.profile(user);
  }

  /** 查询本人已授权的可见目录/菜单树；操作权限见 profile.permissions。 */
  @Get('menus')
  @Authenticated()
  @ApiBearerAuth()
  @Header('Cache-Control', 'no-store')
  menus(@CurrentUser() user: AuthenticatedUser): Promise<AuthMenuDto[]> {
    return this.service.menus(user.userId);
  }
}
