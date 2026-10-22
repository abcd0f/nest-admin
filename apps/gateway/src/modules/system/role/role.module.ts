import { Module } from '@nestjs/common';
import { RoleController } from './role.controller.js';
import { RoleService } from './role.service.js';

@Module({ controllers: [RoleController], providers: [RoleService] })
export class RoleModule {}
