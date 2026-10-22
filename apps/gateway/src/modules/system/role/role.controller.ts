import type { AuthenticatedUser } from '@app/auth';
import { CurrentUser } from '@app/auth';
import { Permission } from '@app/permission';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import {
  AssignRoleMenusDto,
  CreateRoleDto,
  RoleDataScopeDto,
  RolePageDto,
  RoleQueryDto,
  RoleResponseDto,
  UpdateRoleDto,
} from './dto/role.dto.js';
import { RoleService } from './role.service.js';

/** 系统角色管理。 */
@Controller('system/roles')
@ApiBearerAuth()
export class RoleController {
  constructor(@Inject(RoleService) private readonly service: RoleService) {}

  /** 分页查询未删除角色。 */
  @Get()
  @Permission('system:role:list')
  findAll(@Query() query: RoleQueryDto): Promise<RolePageDto> {
    return this.service.findAll(query);
  }

  /** 查询角色及菜单、部门关联。 */
  @Get(':id')
  @Permission('system:role:query')
  findOne(@Param('id') id: string): Promise<RoleResponseDto> {
    return this.service.findOne(id);
  }

  /** 创建角色，初始数据范围为本人，初始无菜单权限。 */
  @Post()
  @Permission('system:role:add')
  create(
    @Body() body: CreateRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return this.service.create(body, actor);
  }

  /** 更新角色基本资料或状态。 */
  @Patch(':id')
  @Permission('system:role:edit')
  update(
    @Param('id') id: string,
    @Body() body: UpdateRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return this.service.update(id, body, actor);
  }

  /** 事务内完整替换菜单关联，保护最后一位有效管理员。 */
  @Patch(':id/menus')
  @Permission('system:role:assignMenus')
  assignMenus(
    @Param('id') id: string,
    @Body() body: AssignRoleMenusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return this.service.assignMenus(id, body, actor);
  }

  /** 同一事务更新数据范围和自定义部门集合；查询过滤在阶段 6 接入。 */
  @Patch(':id/data-scope')
  @Permission('system:role:dataScope')
  dataScope(
    @Param('id') id: string,
    @Body() body: RoleDataScopeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return this.service.dataScope(id, body, actor);
  }

  /** 逻辑删除无用户引用的角色，同时清理菜单和部门关联。 */
  @Delete(':id')
  @Permission('system:role:delete')
  remove(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    return this.service.remove(id, actor);
  }
}
