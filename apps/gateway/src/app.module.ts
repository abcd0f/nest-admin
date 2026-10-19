import { AppConfigModule } from '@app/config';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

@Module({
  imports: [
    // 配置是所有模块的前置依赖，放第一位。
    // 内部负责：按 NODE_ENV 加载 .env、启动时校验环境变量、注册各配置域。
    AppConfigModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
