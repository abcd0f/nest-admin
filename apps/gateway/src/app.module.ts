import { AuthGuard, AuthModule } from '@app/auth';
import { CacheModule } from '@app/cache';
import { AppConfigModule } from '@app/config';
import { CoreModule } from '@app/core';
import { CryptoModule } from '@app/crypto';
import { DatabaseModule } from '@app/database';
import { LoggerModule } from '@app/logger';
import { PermissionGuard, PermissionModule } from '@app/permission';
import { SwaggerModule } from '@app/swagger';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AppController } from './app.controller.js';
import { SystemModule } from './modules/system/system.module.js';

@Module({
  imports: [
    // 配置是所有模块的前置依赖，放第一位。
    // 内部负责：按 NODE_ENV 加载分层 YAML、启动校验、注册各配置域。
    AppConfigModule.forRoot(),
    LoggerModule,
    CacheModule,
    CryptoModule,
    // core 负责全局异常过滤等 HTTP 基础设施，只在这里导入一次。
    CoreModule,
    AuthModule,
    PermissionModule,
    SwaggerModule,
    SystemModule,
    DatabaseModule,
  ],
  controllers: [AppController],
  // 同一主模块按声明顺序注册，先完成认证，再执行权限/角色校验。
  providers: [
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard },
  ],
})
export class AppModule {}
