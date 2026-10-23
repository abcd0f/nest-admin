import type { AuthenticatedUser } from '@app/auth';
import { CurrentUser } from '@app/auth';
import { Permission } from '@app/permission';
import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import {
  AssignRoleMenusDto,
  CreateRoleDto,
  RoleDataScopeDto,
  RoleDeptTreeDto,
  RoleMenuTreeDto,
  RolePageDto,
  RoleQueryDto,
  RoleResponseDto,
  UpdateRoleDto,
} from './dto/role.dto.js';
import { RoleService } from './role.service.js';

/** 系统角色管理。 */
@Controller('system/role')
@ApiBearerAuth()
export class RoleController {
  constructor(@Inject(RoleService) private readonly service: RoleService) {}

  /** 分页查询未删除角色。 */
  @Get('list')
  @Permission('system:role:list')
  findAll(@Query() query: RoleQueryDto): Promise<RolePageDto> {
    return this.service.findAll(query);
  }

  /** 查询角色及菜单、部门关联。 */
  @Get(':id')
  @Permission('system:role:query')
  findOne(@Param('id') id: bigint): Promise<RoleResponseDto> {
    return this.service.findOne(id);
  }

  /**
   * 角色菜单回显：已选 ID 按 menuCheckStrictly 裁剪父节点，另返回完整菜单树。
   *
   * Java 对应 `GET /system/menu/roleMenuTreeselect/{roleId}`，挂在菜单控制器下。
   * 这里留在角色控制器：菜单模块已被角色模块依赖，反向注入会形成循环。
   */
  @Get('menuTree/:id')
  @Permission('system:role:query')
  menuTree(@Param('id') id: bigint): Promise<RoleMenuTreeDto> {
    return this.service.menuTreeSelect(id);
  }

  /** 角色部门回显：已选 ID 按 deptCheckStrictly 裁剪父节点，另返回完整部门树。对齐 Java `/system/role/deptTree/{roleId}`。 */
  @Get('deptTree/:id')
  @Permission('system:role:query')
  deptTree(
    @Param('id') id: bigint,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<RoleDeptTreeDto> {
    return this.service.deptTreeSelect(id, actor);
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
  @Put(':id')
  @Permission('system:role:edit')
  update(
    @Param('id') id: bigint,
    @Body() body: UpdateRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return this.service.update(id, body, actor);
  }

  /** 事务内完整替换菜单关联。Java 没有独立端点，菜单随角色更新一起提交；这里拆分以便单独授权。 */
  @Put('menus/:id')
  @Permission('system:role:assignMenus')
  assignMenus(
    @Param('id') id: bigint,
    @Body() body: AssignRoleMenusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return this.service.assignMenus(id, body, actor);
  }

  /** 同一事务更新数据范围和自定义部门集合。路径对齐 Java `/system/role/dataScope`。 */
  @Put('dataScope/:id')
  @Permission('system:role:dataScope')
  dataScope(
    @Param('id') id: bigint,
    @Body() body: RoleDataScopeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return this.service.dataScope(id, body, actor);
  }

  /** 逻辑删除无用户引用的角色，同时清理菜单和部门关联。 */
  @Delete(':id')
  @Permission('system:role:delete')
  remove(@Param('id') id: bigint, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    return this.service.remove(id, actor);
  }
}
