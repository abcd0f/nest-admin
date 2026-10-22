import { Module } from '@nestjs/common';
import { PermissionGuard } from './permission.guard.js';
import { PermissionService } from './permission.service.js';
import { PermissionSource } from './permission.source.js';
import { PrismaPermissionSource } from './prisma-permission.source.js';

@Module({
  providers: [
    PermissionService,
    PermissionGuard,
    { provide: PermissionSource, useClass: PrismaPermissionSource },
  ],
  exports: [PermissionService, PermissionGuard, PermissionSource],
})
export class PermissionModule {}
