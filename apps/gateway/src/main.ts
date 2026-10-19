import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createFastifyAdapter } from '@app/common';
import { LoggerService } from '@app/logger';
import { SwaggerService } from '@app/swagger';
import { ConfigService } from '@nestjs/config';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter(), {
    bufferLogs: true,
  });
  const logger = app.get(LoggerService);
  app.useLogger(logger);
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);
  app.setGlobalPrefix(configService.getOrThrow<string>('app.apiPrefix'));
  app.get(SwaggerService).setup(app);

  await app.listen(port, '0.0.0.0');

  logger.log(`Application listening on ${await app.getUrl()}`);
}
await bootstrap();
