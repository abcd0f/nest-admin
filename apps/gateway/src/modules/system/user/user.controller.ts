import type { AuthenticatedUser } from '@app/auth';
import { CurrentUser } from '@app/auth';
import { Permission } from '@app/permission';
import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import {
  AssignUserRolesDto,
  CreateUserDto,
  UpdateUserDto,
  UserPageDto,
  UserQueryDto,
  UserResponseDto,
} from './dto/user.dto.js';
import { UserService } from './user.service.js';

/** 系统用户管理。 */
@Controller('system/user')
@ApiBearerAuth()
export class UserController {
  constructor(@Inject(UserService) private readonly service: UserService) {}

  /** 分页查询未删除用户，不返回密码或内部登录信息。 */
  @Get('list')
  @Permission('system:user:list')
  findAll(
    @Query() query: UserQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserPageDto> {
    return this.service.findAll(query, actor);
  }

  /** 查询用户资料和已关联角色。 */
  @Get(':id')
  @Permission('system:user:query')
  findOne(
    @Param('id') id: bigint,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return this.service.findOne(id, actor);
  }

  /** 创建用户；分配角色使用独立的 assignRoles 权限。 */
  @Post()
  @Permission('system:user:add')
  create(
    @Body() body: CreateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return this.service.create(body, actor);
  }

  /** 更新基本资料、密码、部门或状态，不能停用本人。 */
  @Put(':id')
  @Permission('system:user:edit')
  update(
    @Param('id') id: bigint,
    @Body() body: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return this.service.update(id, body, actor);
  }

  /** 事务内完整替换角色，保护最后一位有效管理员。路径对齐 Java `PUT /system/user/authRole`。 */
  @Put('authRole/:id')
  @Permission('system:user:assignRoles')
  assignRoles(
    @Param('id') id: bigint,
    @Body() body: AssignUserRolesDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return this.service.assignRoles(id, body, actor);
  }

  /** 逻辑删除并移除角色关联，不能删除本人或仍任部门负责人的用户。 */
  @Delete(':id')
  @Permission('system:user:delete')
  remove(@Param('id') id: bigint, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    return this.service.remove(id, actor);
  }
}
