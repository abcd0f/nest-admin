import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import config from '../../../packages/config/src/index.js';
import { PrismaModule } from '../../../packages/database/src/index.js';
import { AppController } from './app.controller.js';

import { AppService } from './app.service.js';

const environment = process.env.NODE_ENV ?? 'development';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      expandVariables: true,
      envFilePath: ['.env.local', `.env.${environment}`, '.env'],
      load: [...Object.values(config)],
    }),
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
