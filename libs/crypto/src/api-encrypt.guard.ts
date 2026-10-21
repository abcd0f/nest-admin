import type { ApiDecryptConfig } from '@app/config';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { ApiEncryptOptions } from './api-encrypt.decorator.js';
import { apiDecryptConfig } from '@app/config';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';

import { Reflector } from '@nestjs/core';
import { supportsEncryptedRequest } from './api-crypto-policy.js';
import { API_ENCRYPT_POLICY, API_ENCRYPT_RESPONSE } from './api-encrypt.decorator.js';

@Injectable()
export class ApiEncryptGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(apiDecryptConfig.KEY) private readonly config: ApiDecryptConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.enabled) return true;

    const policy = this.reflector.getAllAndOverride<ApiEncryptOptions>(API_ENCRYPT_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) return true;

    const request = context.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | undefined>;
      [API_ENCRYPT_RESPONSE]?: boolean;
    }>();
    if (supportsEncryptedRequest(request.method)
      && !request.headers[this.config.headerFlag.toLowerCase()]) {
      throw new ForbiddenException('此接口要求使用 AES/RSA 加密请求');
    }

    if (policy.response) request[API_ENCRYPT_RESPONSE] = true;
    return true;
  }
}
