import type { DynamicModule } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { configSource, resetConfigSource } from './core/config-loader.js';
import { compileConfig, resetCompiledConfig } from './core/validate.js';
import { DOMAINS } from './domains/index.js';

@Global()
@Module({})
export class AppConfigModule {
  static forRoot(): DynamicModule {
    const snapshot = configSource();

    try {
      compileConfig(DOMAINS, snapshot);
    } catch (error) {
      resetConfigSource();
      resetCompiledConfig();
      throw error;
    }

    return {
      module: AppConfigModule,
      global: true,
      imports: [
        NestConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: DOMAINS.map((domain) => domain.token),
        }),
      ],
      exports: [NestConfigModule],
    };
  }
}
