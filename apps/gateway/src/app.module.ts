import { AppConfigModule } from '@app/config';
import { CoreModule } from '@app/core';
import { LoggerModule } from '@app/logger';
import { SwaggerModule } from '@app/swagger';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';

@Module({
  imports: [
    // 配置是所有模块的前置依赖，放第一位。
    // 内部负责：按 NODE_ENV 加载 .env、启动时校验环境变量、注册各配置域。
    AppConfigModule.forRoot(),
    LoggerModule,
    // core 负责全局异常过滤等 HTTP 基础设施，只在这里导入一次。
    CoreModule,
    SwaggerModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
