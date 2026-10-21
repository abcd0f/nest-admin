import type { ApiDecryptConfig } from '@app/config';
import type { OnApplicationBootstrap } from '@nestjs/common';

import { apiDecryptConfig } from '@app/config';
import { Inject, Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ApiCryptoService } from './api-crypto.service.js';
import { installApiCryptoHooks } from './fastify-api-crypto.js';

@Injectable()
export class ApiCryptoHooksInstaller implements OnApplicationBootstrap {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly crypto: ApiCryptoService,
    @Inject(apiDecryptConfig.KEY) private readonly config: ApiDecryptConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) return;

    const adapter = this.httpAdapterHost.httpAdapter;
    if (adapter.getType() !== 'fastify') {
      throw new Error('API AES/RSA 加密要求使用 Fastify HTTP adapter');
    }

    installApiCryptoHooks(adapter.getInstance(), this.config, this.crypto);
  }
}
