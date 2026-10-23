import type { ThrottlerConfig } from '@app/config';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

import { BUSINESS_CODE, DEFAULT_BUSINESS_MESSAGE } from '@app/common/constants/index.js';
import { throttlerConfig } from '@app/config';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AllExceptionsFilter } from './filters/index.js';
import { ResponseInterceptor } from './interceptors/index.js';
import { BigIntIdPipe, DtoValidationPipe } from './pipes/index.js';

/**
 * core 基础设施模块。
 *
 * 全局增强器统一在这里通过 `APP_*` 令牌注册，业务应用只导入本模块一次，
 * 不在 `main.ts` 里重复挂载，保证依赖注入与独立测试能力。
 * 依赖 AppConfigModule.forRoot() 提前初始化全局配置。
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [throttlerConfig.KEY],
      useFactory: (config: ThrottlerConfig): ThrottlerModuleOptions => ({
        throttlers: [{ ttl: config.ttl, limit: config.limit, blockDuration: config.blockDuration }],
        skipIf: () => !config.enabled,
        errorMessage: DEFAULT_BUSINESS_MESSAGE[BUSINESS_CODE.TOO_MANY_REQUESTS],
      }),
    }),
  ],
  providers: [
    // 先转换路由主键再校验 DTO：声明为 bigint 的参数在进入 handler 前已是 bigint，
    // 未声明的参数本管道直接透传，互不干扰。
    { provide: APP_PIPE, useClass: BigIntIdPipe },
    { provide: APP_PIPE, useClass: DtoValidationPipe },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
  ],
})
export class CoreModule {}
