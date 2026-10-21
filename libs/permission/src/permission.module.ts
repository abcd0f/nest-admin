import { Module } from '@nestjs/common';
import { PermissionService } from './permission.service.js';

@Module({
  providers: [PermissionService],
  exports: [PermissionService],
})
export class PermissionModule {}
