import type { ConfigFactory, ConfigFactoryKeyHost, ConfigObject } from '@nestjs/config';

export const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export type RawConfig = Readonly<Record<string, unknown>>;

export interface RawConfigSnapshot {
  readonly environment: Environment;
  readonly values: RawConfig;
}

export interface ConfigContext {
  readonly environment: Environment;
}

export interface ConfigDomain<TConfig extends ConfigObject = ConfigObject> {
  readonly namespace: string;
  readonly token: ConfigFactory<TConfig> & ConfigFactoryKeyHost<TConfig>;
  readonly parse: (raw: unknown, context: ConfigContext) => TConfig;
  readonly validate?: (value: TConfig, context: ConfigContext) => void;
}

export type AnyConfigDomain = ConfigDomain<any>;
