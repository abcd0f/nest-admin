import { AuthModule } from '@app/auth';
import { Module } from '@nestjs/common';
import { DeptModule } from '../dept/dept.module.js';
import { MenuModule } from '../menu/menu.module.js';
import { RoleController } from './role.controller.js';
import { RoleService } from './role.service.js';

@Module({
  // 角色回显要返回完整菜单树/部门树，复用各自 service 的树构建逻辑。
  imports: [AuthModule, MenuModule, DeptModule],
  controllers: [RoleController],
  providers: [RoleService],
})
export class RoleModule {}
