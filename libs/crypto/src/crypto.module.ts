import type { ApiDecryptConfig } from '@app/config';
import { apiDecryptConfig } from '@app/config';
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { ApiCryptoHooksInstaller } from './api-crypto-hooks-installer.js';
import { ApiCryptoService } from './api-crypto.service.js';
import { ApiEncryptGuard } from './api-encrypt.guard.js';
import { PasswordHashService } from './password-hash.service.js';

@Global()
@Module({
  providers: [
    {
      provide: ApiCryptoService,
      inject: [apiDecryptConfig.KEY],
      useFactory: (config: ApiDecryptConfig) => new ApiCryptoService(config),
    },
    { provide: APP_GUARD, useClass: ApiEncryptGuard },
    ApiCryptoHooksInstaller,
    PasswordHashService,
  ],
  exports: [ApiCryptoService, PasswordHashService],
})
export class CryptoModule {}
