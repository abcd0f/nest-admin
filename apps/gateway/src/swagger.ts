import type { ConfigKeyPaths } from '../../../packages/config/src/index.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: NestFastifyApplication) {
  const configService = app.get(ConfigService<ConfigKeyPaths, true>);
  const appConfig = configService.get('app', { infer: true });
  const swaggerConfig = configService.get('swagger', { infer: true });

  if (!swaggerConfig.enable) return;

  const config = new DocumentBuilder()
    .setTitle(`${appConfig.name} API`)
    .setDescription(`${appConfig.name} API documentation`)
    .setVersion(swaggerConfig.version)
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(swaggerConfig.path, app, document);
}
