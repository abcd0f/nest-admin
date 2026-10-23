import { Global, Module } from '@nestjs/common';
import { SystemAuthModule } from './auth/auth.module.js';
import { DeptModule } from './dept/dept.module.js';
import { MenuModule } from './menu/menu.module.js';
import { PostModule } from './post/post.module.js';
import { RoleModule } from './role/role.module.js';
import { UserModule } from './user/user.module.js';

@Global()
@Module({
  imports: [SystemAuthModule, UserModule, RoleModule, MenuModule, DeptModule, PostModule],
})
export class SystemModule {}
