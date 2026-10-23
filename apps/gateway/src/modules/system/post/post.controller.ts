import type { AuthenticatedUser } from '@app/auth';
import { CurrentUser } from '@app/auth';
import { Permission } from '@app/permission';
import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import {
  CreatePostDto,
  PostOptionDto,
  PostOptionQueryDto,
  PostPageDto,
  PostQueryDto,
  PostResponseDto,
  UpdatePostDto,
} from './dto/post.dto.js';
import { PostService } from './post.service.js';

/** 系统岗位管理。 */
@Controller('system/post')
@ApiBearerAuth()
export class PostController {
  constructor(@Inject(PostService) private readonly service: PostService) {}

  /** 分页查询未删除岗位，受数据范围约束。 */
  @Get('list')
  @Permission('system:post:list')
  findAll(
    @Query() query: PostQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PostPageDto> {
    return this.service.findAll(query, actor);
  }

  /** 岗位下拉：只返回启用岗位，可按部门过滤。对齐 Java `/system/post/optionselect`。 */
  @Get('optionselect')
  @Permission('system:post:query')
  options(
    @Query() query: PostOptionQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PostOptionDto[]> {
    return this.service.options(query.deptId, actor);
  }

  /** 查询岗位详情。 */
  @Get(':id')
  @Permission('system:post:query')
  findOne(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PostResponseDto> {
    return this.service.findOne(id, actor);
  }

  /** 创建岗位；部门必须在当前数据范围内。 */
  @Post()
  @Permission('system:post:add')
  create(
    @Body() body: CreatePostDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PostResponseDto> {
    return this.service.create(body, actor);
  }

  /** 更新岗位；已分配用户的岗位不能停用。 */
  @Put(':id')
  @Permission('system:post:edit')
  update(
    @Param('id') id: string,
    @Body() body: UpdatePostDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PostResponseDto> {
    return this.service.update(id, body, actor);
  }

  /** 逻辑删除岗位；已分配用户的岗位不能删除。 */
  @Delete(':id')
  @Permission('system:post:delete')
  remove(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    return this.service.remove(id, actor);
  }
}
