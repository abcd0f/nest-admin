import { AuthModule } from '@app/auth';
import { PermissionModule } from '@app/permission';
import { Module } from '@nestjs/common';
import { SystemAuthController } from './auth.controller.js';
import { SystemAuthService } from './auth.service.js';

@Module({
  imports: [AuthModule, PermissionModule],
  controllers: [SystemAuthController],
  providers: [SystemAuthService],
})
export class SystemAuthModule {}
