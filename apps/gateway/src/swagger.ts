import type { ConfigKeyPaths } from '../../../packages/config/src/index.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: NestFastifyApplication) {
  const configService = app.get(ConfigService<ConfigKeyPaths, true>);
  const appConfig = configService.get('app', { infer: true });

  if (!appConfig.swagger.enable) return;

  const config = new DocumentBuilder()
    .setTitle(`${appConfig.name} API`)
    .setDescription(`${appConfig.name} API documentation`)
    .setVersion(appConfig.swagger.version)
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(appConfig.swagger.path, app, document);
}
