import { describe, expect, it } from 'vitest';

import { apiDecryptDomain } from './api-decrypt.domain.js';

describe('apiDecryptDomain', () => {
  it('defaults to disabled and uses the RuoYi request header name', () => {
    expect(apiDecryptDomain.parse(undefined, { environment: 'test' })).toEqual({
      enabled: false,
      headerFlag: 'encrypt-key',
      privateKey: undefined,
      publicKey: undefined,
    });
  });

  it('requires both RSA keys when enabled', () => {
    expect(() => apiDecryptDomain.parse({ enabled: true }, { environment: 'test' }))
      .toThrow('api-decrypt.private-key');
    expect(() => apiDecryptDomain.parse({ enabled: true, 'private-key': 'private' }, { environment: 'test' }))
      .toThrow('api-decrypt.public-key');
  });
});
