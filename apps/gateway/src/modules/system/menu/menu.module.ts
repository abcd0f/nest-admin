import { Module } from '@nestjs/common';
import { MenuController } from './menu.controller.js';
import { MenuService } from './menu.service.js';

@Module({ controllers: [MenuController], providers: [MenuService] })
export class MenuModule {}
