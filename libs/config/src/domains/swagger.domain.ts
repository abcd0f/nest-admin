import { asBoolean, asObject, asString, defineConfigDomain } from '../core/index.js';

export interface SwaggerConfig {
  enabled: boolean;
  path: string;
  title: string;
  description: string;
  version: string;
}

export const swaggerDomain = defineConfigDomain<SwaggerConfig>({
  namespace: 'swagger',
  parse(raw, context): SwaggerConfig {
    const value = asObject(raw, 'swagger');
    return {
      enabled: asBoolean(value.enabled, 'swagger.enabled', context.environment !== 'production'),
      path: asString(value.path, 'swagger.path', 'docs'),
      title: asString(value.title, 'swagger.title', 'Nest Admin API'),
      description: asString(value.description, 'swagger.description', 'Nest Admin 接口文档'),
      version: asString(value.version, 'swagger.version', '1.0.0'),
    };
  },
});

export const swaggerConfig = swaggerDomain.token;
