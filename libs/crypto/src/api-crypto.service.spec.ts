import { readFileSync } from 'node:fs';
import { FIELD_CIPHERTEXT_PREFIX_PATTERN } from '@app/common/constants/regex.js';
import { instanceToPlain, plainToInstance } from 'class-transformer';

import { describe, expect, it } from 'vitest';
import { createCryptoConfig, decryptResponse, encryptRequest } from '../../../test/helpers/api-crypto-client.js';
import { ApiCryptoService } from './api-crypto.service.js';
import { DecryptField, EncryptField } from './field-crypto.decorator.js';

class FieldCryptoDto {
  @EncryptField()
  @DecryptField()
  secret!: string;

  visible!: string;
}

describe('apiCryptoService', () => {
  it('解密独立固定的 AES-128/RSA 协议向量，不使用共享客户端编码函数', () => {
    const vector = JSON.parse(readFileSync(new URL('../../../test/fixtures/api-crypto-request.json', import.meta.url), 'utf8'));
    const service = new ApiCryptoService({
      enabled: true,
      headerFlag: 'encrypt-key',
      privateKey: vector.privateKey,
      publicKey: vector.publicKey,
    });
    expect(service.decryptRequest(vector.encryptedKey, Buffer.from(vector.encryptedBody, 'utf8')).toString('utf8'))
      .toBe(vector.plaintext);
  });

  it('encrypts and decrypts only decorated fields during DTO conversion', () => {
    const dto = plainToInstance(FieldCryptoDto, { secret: 'private value', visible: 'unchanged' });
    const encrypted = instanceToPlain(dto);
    expect(encrypted.secret).toMatch(FIELD_CIPHERTEXT_PREFIX_PATTERN);
    expect(encrypted.visible).toBe('unchanged');
    expect(plainToInstance(FieldCryptoDto, encrypted).secret).toBe('private value');
  });

  it.each(['shared', 'separate'])('decrypts requests and encrypts responses with %s RSA key pairs', (keyMode) => {
    const requestConfig = createCryptoConfig();
    const responseConfig = keyMode === 'shared' ? requestConfig : createCryptoConfig();
    const config = { ...requestConfig, publicKey: responseConfig.publicKey };
    const service = new ApiCryptoService(config);
    const request = encryptRequest('{"message":"hello"}', requestConfig.publicKey!);
    expect(service.decryptRequest(request.encryptedKey, Buffer.from(request.encryptedBody, 'utf8')).toString('utf8'))
      .toBe('{"message":"hello"}');

    const response = service.encryptResponse('{"code":0,"data":{"message":"hello"},"message":"操作成功"}');
    expect(decryptResponse(response.body, response.encryptedKey, responseConfig.privateKey!))
      .toBe('{"code":0,"data":{"message":"hello"},"message":"操作成功"}');
  });

  it('rejects malformed RSA headers and invalid AES payloads', () => {
    const service = new ApiCryptoService(createCryptoConfig());
    expect(() => service.decryptRequest('invalid', Buffer.from('invalid'))).toThrow();
  });
});
