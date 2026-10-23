import type { AuthenticatedUser } from '@app/auth';
import { CurrentUser } from '@app/auth';
import { Permission } from '@app/permission';
import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { DeptService } from './dept.service.js';
import { CreateDeptDto, DeptResponseDto, DeptTreeDto, UpdateDeptDto } from './dto/dept.dto.js';

/** 系统部门管理。 */
@Controller('system/dept')
@ApiBearerAuth()
export class DeptController {
  constructor(@Inject(DeptService) private readonly service: DeptService) {}

  /** 查询未删除的部门树，包含停用节点。 */
  @Get('list')
  @Permission('system:dept:list')
  findAll(@CurrentUser() actor: AuthenticatedUser): Promise<DeptTreeDto[]> {
    return this.service.findAll(actor);
  }

  /** 查询部门资料及包含自身的祖先路径。 */
  @Get(':id')
  @Permission('system:dept:query')
  findOne(
    @Param('id') id: bigint,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DeptResponseDto> {
    return this.service.findOne(id, actor);
  }

  /** 创建部门，服务端计算 ancestors 并校验负责人。 */
  @Post()
  @Permission('system:dept:add')
  create(
    @Body() body: CreateDeptDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DeptResponseDto> {
    return this.service.create(body, actor);
  }

  /** 更新部门，移动时在同一事务重算所有未删除后代路径。 */
  @Put(':id')
  @Permission('system:dept:edit')
  update(
    @Param('id') id: bigint,
    @Body() body: UpdateDeptDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DeptResponseDto> {
    return this.service.update(id, body, actor);
  }

  /** 逻辑删除部门，拒绝子部门、用户或角色数据范围引用。 */
  @Delete(':id')
  @Permission('system:dept:delete')
  remove(@Param('id') id: bigint, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    return this.service.remove(id, actor);
  }
}
