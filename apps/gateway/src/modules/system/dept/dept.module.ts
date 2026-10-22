import { Module } from '@nestjs/common';
import { DeptController } from './dept.controller.js';
import { DeptService } from './dept.service.js';

@Module({ controllers: [DeptController], providers: [DeptService], exports: [DeptService] })
export class DeptModule {}
