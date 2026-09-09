import { ConfigType, registerAs } from '@nestjs/config';
import { env, envBoolean } from '../../../packages/utils/src/index.js';

export const swaggerRegToken = 'swagger';

export const SwaggerConfig = registerAs(swaggerRegToken, () => ({
  enable: envBoolean('SWAGGER_ENABLE', true),
  path: env('SWAGGER_PATH', 'api'),
  version: env('SWAGGER_VERSION', '1.0'),
}));

export type ISwaggerConfig = ConfigType<typeof SwaggerConfig>;
