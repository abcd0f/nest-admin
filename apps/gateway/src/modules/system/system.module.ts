import { Global, Module } from '@nestjs/common';
import { SystemAuthModule } from './auth/auth.module.js';
import { DeptModule } from './dept/dept.module.js';
import { ExampleModule } from './example/example.module.js';
import { MenuModule } from './menu/menu.module.js';
import { RoleModule } from './role/role.module.js';
import { UserModule } from './user/user.module.js';

@Global()
@Module({
  imports: [ExampleModule, SystemAuthModule, UserModule, RoleModule, MenuModule, DeptModule],
})
export class SystemModule {}
