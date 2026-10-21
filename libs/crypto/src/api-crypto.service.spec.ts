import type { ApiDecryptConfig } from '@app/config';
import { constants, createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt } from 'node:crypto';
import { instanceToPlain, plainToInstance } from 'class-transformer';

import { describe, expect, it } from 'vitest';
import { ApiCryptoService } from './api-crypto.service.js';
import { DecryptField, EncryptField } from './field-crypto.decorator.js';

class FieldCryptoDto {
  @EncryptField()
  @DecryptField()
  secret!: string;

  visible!: string;
}

function createConfig(): ApiDecryptConfig {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    enabled: true,
    headerFlag: 'encrypt-key',
    privateKey: keys.privateKey.toString('base64'),
    publicKey: keys.publicKey.toString('base64'),
  };
}

function encryptRequest(plainBody: string, publicKey: string) {
  const aesPassword = '0123456789abcdef0123456789abcdef';
  const aesKey = Buffer.from(aesPassword, 'utf8');
  const cipher = createCipheriv('aes-256-ecb', aesKey, null);
  const encryptedBody = Buffer.concat([
    cipher.update(Buffer.from(plainBody, 'utf8')),
    cipher.final(),
  ]).toString('base64');
  const encryptedKey = publicEncrypt(
    { key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki', padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(Buffer.from(aesPassword, 'utf8').toString('base64'), 'utf8'),
  ).toString('base64');
  return { encryptedBody: Buffer.from(encryptedBody, 'utf8'), encryptedKey };
}

describe('apiCryptoService', () => {
  it('encrypts and decrypts only decorated fields during DTO conversion', () => {
    const dto = plainToInstance(FieldCryptoDto, { secret: 'private value', visible: 'unchanged' });
    const encrypted = instanceToPlain(dto);
    expect(encrypted.secret).toMatch(/^enc:v1:/);
    expect(encrypted.visible).toBe('unchanged');
    expect(plainToInstance(FieldCryptoDto, encrypted).secret).toBe('private value');
  });

  it.each(['shared', 'separate'])('decrypts requests and encrypts responses with %s RSA key pairs', (keyMode) => {
    const requestConfig = createConfig();
    const responseConfig = keyMode === 'shared' ? requestConfig : createConfig();
    const config = { ...requestConfig, publicKey: responseConfig.publicKey };
    const service = new ApiCryptoService(config);
    const request = encryptRequest('{"message":"hello"}', requestConfig.publicKey!);
    expect(service.decryptRequest(request.encryptedKey, request.encryptedBody).toString('utf8'))
      .toBe('{"message":"hello"}');

    const response = service.encryptResponse('{"code":0,"data":{"message":"hello"},"message":"操作成功"}');
    const encodedAesPassword = privateDecrypt(
      { key: Buffer.from(responseConfig.privateKey!, 'base64'), format: 'der', type: 'pkcs8', padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(response.encryptedKey, 'base64'),
    ).toString('utf8');
    const aesPassword = Buffer.from(encodedAesPassword, 'base64').toString('utf8');
    const responseDecipher = createDecipheriv('aes-256-ecb', Buffer.from(aesPassword, 'utf8'), null);
    expect(Buffer.concat([responseDecipher.update(Buffer.from(response.body, 'base64')), responseDecipher.final()]).toString('utf8'))
      .toBe('{"code":0,"data":{"message":"hello"},"message":"操作成功"}');
  });

  it('rejects malformed RSA headers and invalid AES payloads', () => {
    const service = new ApiCryptoService(createConfig());
    expect(() => service.decryptRequest('invalid', Buffer.from('invalid'))).toThrow();
  });
});
