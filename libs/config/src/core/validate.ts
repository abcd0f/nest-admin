import type { ConfigObject } from '@nestjs/config';

import type { AnyConfigDomain, RawConfigSnapshot } from './types.js';

export interface CompiledConfig {
  readonly snapshot: RawConfigSnapshot;
  readonly values: ReadonlyMap<string, ConfigObject>;
}

let compiled: CompiledConfig | undefined;

export function compileConfig(domains: readonly AnyConfigDomain[], snapshot: RawConfigSnapshot): CompiledConfig {
  if (compiled?.snapshot === snapshot) return compiled;

  const values = new Map<string, ConfigObject>();
  const errors: string[] = [];

  for (const domain of domains) {
    try {
      const context = { environment: snapshot.environment };
      const value = domain.parse(snapshot.values[domain.namespace], context);
      domain.validate?.(value, context);
      values.set(domain.namespace, value);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    compiled = undefined;
    throw new Error(`配置校验失败：\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  }

  compiled = { snapshot, values };
  return compiled;
}

export function getCompiledConfig<TConfig extends ConfigObject>(namespace: string): TConfig {
  const value = compiled?.values.get(namespace);
  if (value === undefined) {
    throw new Error(`配置域 ${namespace} 尚未编译，请先导入并初始化 AppConfigModule`);
  }
  return value as TConfig;
}

export function resetCompiledConfig(): void {
  compiled = undefined;
}
