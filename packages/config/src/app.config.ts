import { ConfigType, registerAs } from '@nestjs/config';
import { env, envBoolean, envNumber } from '../../../packages/utils/src/index.js';

export const appRegToken = 'app';

export const AppConfig = registerAs(appRegToken, () => ({
  name: env('APP_NAME'),
  port: envNumber('APP_PORT', 3000),
  prefix: env('API_PREFIX', '/api'),
  resmode: env('APP_RES_MODE'),
  logger: {
    level: env('LOGGER_LEVEL'),
    dir: env('LOGGER_DIR'),
    showConsole: envBoolean('LOGGER_CONSOLE'),
  },
  swagger: {
    enable: envBoolean('SWAGGER_ENABLE', true),
    path: env('SWAGGER_PATH', 'api'),
    version: env('SWAGGER_VERSION', '1.0'),
  },
}));

export type IAppConfig = ConfigType<typeof AppConfig>;
