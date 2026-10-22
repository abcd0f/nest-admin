import { Module } from '@nestjs/common';
import { PermissionGuard } from './permission.guard.js';
import { PermissionService } from './permission.service.js';
import { DenyPermissionSource, PermissionSource } from './permission.source.js';

@Module({
  providers: [
    PermissionService,
    PermissionGuard,
    { provide: PermissionSource, useClass: DenyPermissionSource },
  ],
  exports: [PermissionService, PermissionGuard, PermissionSource],
})
export class PermissionModule {}
