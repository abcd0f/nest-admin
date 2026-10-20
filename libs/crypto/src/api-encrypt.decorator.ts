import { SetMetadata } from '@nestjs/common';

export const API_ENCRYPT_POLICY = Symbol('API_ENCRYPT_POLICY');
export const API_ENCRYPT_RESPONSE = Symbol('API_ENCRYPT_RESPONSE');

export interface ApiEncryptOptions {
  /** Encrypt the successful response body as well as requiring encrypted write requests. */
  response?: boolean;
}

/** Require encrypted POST/PUT request bodies; response encryption is opt-in. */
export function ApiEncrypt(options: ApiEncryptOptions = {}): MethodDecorator {
  return SetMetadata(API_ENCRYPT_POLICY, { response: options.response ?? false });
}
