import type { ConfigObject } from '@nestjs/config';
import type { ConfigContext, ConfigDomain } from './types.js';

import { registerAs } from '@nestjs/config';
import { getCompiledConfig } from './validate.js';

export interface ConfigDomainDefinition<TConfig extends ConfigObject> {
  readonly namespace: string;
  readonly parse: (raw: unknown, context: ConfigContext) => TConfig;
  readonly validate?: (value: TConfig, context: ConfigContext) => void;
}

export function defineConfigDomain<TConfig extends ConfigObject>(
  definition: ConfigDomainDefinition<TConfig>,
): ConfigDomain<TConfig> {
  const token = registerAs(definition.namespace, () => getCompiledConfig<TConfig>(definition.namespace));
  return { ...definition, token };
}
