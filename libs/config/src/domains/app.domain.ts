import type { Environment } from '../core/index.js';
import { asInteger, asObject, asString, defineConfigDomain } from '../core/index.js';

export type NodeEnv = Environment;

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  apiPrefix: string;
  isProduction: boolean;
}

export const appDomain = defineConfigDomain<AppConfig>({
  namespace: 'app',
  parse(raw, context): AppConfig {
    const value = asObject(raw, 'app');
    return {
      nodeEnv: context.environment,
      port: asInteger(value.port, 'app.port', 3000, 1),
      apiPrefix: asString(value['api-prefix'], 'app.api-prefix', ''),
      isProduction: context.environment === 'production',
    };
  },
});

export const appConfig = appDomain.token;
