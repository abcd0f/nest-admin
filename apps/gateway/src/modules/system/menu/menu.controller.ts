import { Permission } from '@app/permission';
import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CreateMenuDto, MenuResponseDto, MenuTreeDto, UpdateMenuDto } from './dto/menu.dto.js';
import { MenuService } from './menu.service.js';

/** 系统菜单、按钮管理。 */
@Controller('system/menu')
@ApiBearerAuth()
export class MenuController {
  constructor(@Inject(MenuService) private readonly service: MenuService) {}

  /** 查询管理菜单树，包含隐藏/停用节点和按钮。 */
  @Get('list')
  @Permission('system:menu:list')
  findAll(): Promise<MenuTreeDto[]> {
    return this.service.findAll();
  }

  /** 查询菜单或按钮。 */
  @Get(':id')
  @Permission('system:menu:query')
  findOne(@Param('id') id: bigint): Promise<MenuResponseDto> {
    return this.service.findOne(id);
  }

  /** 创建目录、菜单或按钮，校验父链和权限码。 */
  @Post()
  @Permission('system:menu:add')
  create(@Body() body: CreateMenuDto): Promise<MenuResponseDto> {
    return this.service.create(body);
  }

  /** 更新路由展示字段、权限码、状态或父节点，禁止循环及不兼容类型变更。 */
  @Put(':id')
  @Permission('system:menu:edit')
  update(
    @Param('id') id: bigint,
    @Body() body: UpdateMenuDto,
  ): Promise<MenuResponseDto> {
    return this.service.update(id, body);
  }

  /** 物理删除无子节点、无角色引用的菜单；Menu 没有逻辑删除字段。 */
  @Delete(':id')
  @Permission('system:menu:delete')
  remove(@Param('id') id: bigint): Promise<void> {
    return this.service.remove(id);
  }
}
