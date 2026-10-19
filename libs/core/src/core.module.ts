import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AllExceptionsFilter } from './filters/index.js';

/**
 * core 基础设施模块。
 *
 * 全局增强器统一在这里通过 `APP_*` 令牌注册，业务应用只导入本模块一次，
 * 不在 `main.ts` 里重复挂载，保证依赖注入与独立测试能力。
 */
@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class CoreModule {}
