import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LoggerService } from '@app/logger';
import { ConfigService } from '@nestjs/config';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });
  const logger = app.get(LoggerService);
  app.useLogger(logger);
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);

  await app.listen(port, '0.0.0.0');

  logger.log(`Application listening on ${await app.getUrl()}`, 'Bootstrap');
}
await bootstrap();
