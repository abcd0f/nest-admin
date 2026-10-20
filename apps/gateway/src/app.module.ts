import { CacheModule } from '@app/cache';
import { AppConfigModule } from '@app/config';
import { CoreModule } from '@app/core';
import { CryptoModule } from '@app/crypto';
import { DatabaseModule } from '@app/database';
import { LoggerModule } from '@app/logger';
import { SwaggerModule } from '@app/swagger';
import { Module } from '@nestjs/common';

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
    SwaggerModule,
    SystemModule,
    DatabaseModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
