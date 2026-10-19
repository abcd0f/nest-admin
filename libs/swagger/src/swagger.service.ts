import type { SwaggerConfig } from '@app/config';
import type { INestApplication } from '@nestjs/common';
import { swaggerConfig } from '@app/config';
import { Inject, Injectable } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

@Injectable()
export class SwaggerService {
  constructor(@Inject(swaggerConfig.KEY) private readonly config: SwaggerConfig) {}

  setup(app: INestApplication): void {
    if (!this.config.enabled) return;

    const documentConfig = new DocumentBuilder()
      .setTitle(this.config.title)
      .setDescription(this.config.description)
      .setVersion(this.config.version)
      .build();

    SwaggerModule.setup(
      this.config.path,
      app,
      () => SwaggerModule.createDocument(app, documentConfig),
      { useGlobalPrefix: true },
    );
  }
}
