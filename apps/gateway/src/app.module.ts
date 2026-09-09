import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import config from '../../../packages/config/src/index.js';
import { AppController } from './app.controller.js';

import { AppService } from './app.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      expandVariables: true,
      envFilePath: ['.env.local', `.env.${process.env.NODE_ENV}`, '.env'],
      load: [...Object.values(config)],
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
