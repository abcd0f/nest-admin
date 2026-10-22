import type { AuthenticatedUser } from '@app/auth';
import { CurrentUser } from '@app/auth';
import { Permission } from '@app/permission';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CreateMenuDto, MenuResponseDto, MenuTreeDto, UpdateMenuDto } from './dto/menu.dto.js';
import { MenuService } from './menu.service.js';

/** 系统菜单、按钮管理。 */
@Controller('system/menus')
@ApiBearerAuth()
export class MenuController {
  constructor(@Inject(MenuService) private readonly service: MenuService) {}

  /** 查询管理菜单树，包含隐藏/停用节点和按钮。 */
  @Get()
  @Permission('system:menu:list')
  findAll(): Promise<MenuTreeDto[]> {
    return this.service.findAll();
  }

  /** 查询菜单或按钮。 */
  @Get(':id')
  @Permission('system:menu:query')
  findOne(@Param('id') id: string): Promise<MenuResponseDto> {
    return this.service.findOne(id);
  }

  /** 创建目录、菜单或按钮，校验父链和权限码。 */
  @Post()
  @Permission('system:menu:add')
  create(
    @Body() body: CreateMenuDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MenuResponseDto> {
    return this.service.create(body, actor);
  }

  /** 更新路由展示字段、权限码、状态或父节点，禁止循环及不兼容类型变更。 */
  @Patch(':id')
  @Permission('system:menu:edit')
  update(
    @Param('id') id: string,
    @Body() body: UpdateMenuDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MenuResponseDto> {
    return this.service.update(id, body, actor);
  }

  /** 物理删除无子节点、无角色引用的菜单；Menu 没有逻辑删除字段。 */
  @Delete(':id')
  @Permission('system:menu:delete')
  remove(@Param('id') id: string): Promise<void> {
    return this.service.remove(id);
  }
}
