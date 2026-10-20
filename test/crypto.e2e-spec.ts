import type { ApiDecryptConfig } from '@app/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { constants, createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt } from 'node:crypto';
import { createFastifyAdapter } from '@app/common';
import { apiDecryptConfig, AppConfigModule } from '@app/config';
import { CoreModule } from '@app/core';
import { ApiEncrypt, CryptoModule } from '@app/crypto';
import { BadRequestException, Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

@Controller('crypto-probe')
class CryptoProbeController {
  @ApiEncrypt()
  @Post('request')
  request(@Body() body: { message: string }) {
    return body;
  }

  @ApiEncrypt({ response: true })
  @Get('response')
  response() {
    return { message: 'response secret' };
  }

  @ApiEncrypt({ response: true })
  @Get('response-error')
  responseError(): never {
    throw new BadRequestException('invalid operation');
  }

  @Post('plain')
  plain(@Body() body: { message: string }) {
    return body;
  }
}

@Module({
  imports: [AppConfigModule.forRoot(), CryptoModule, CoreModule],
  controllers: [CryptoProbeController],
})
class ApiCryptoTestModule {}

function makeConfig(): ApiDecryptConfig {
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
  const aesPassword = '1234567890abcdef1234567890abcdef';
  const cipher = createCipheriv('aes-256-ecb', Buffer.from(aesPassword, 'utf8'), null);
  const encryptedBody = Buffer.concat([
    cipher.update(Buffer.from(plainBody, 'utf8')),
    cipher.final(),
  ]).toString('base64');
  const encryptedKey = publicEncrypt(
    { key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki', padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(Buffer.from(aesPassword, 'utf8').toString('base64'), 'utf8'),
  ).toString('base64');
  return { encryptedBody, encryptedKey };
}

function decryptResponse(encryptedBody: string, encryptedKey: string, privateKey: string): string {
  const encodedAesPassword = privateDecrypt(
    { key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8', padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(encryptedKey, 'base64'),
  ).toString('utf8');
  const aesPassword = Buffer.from(encodedAesPassword, 'base64').toString('utf8');
  const decipher = createDecipheriv('aes-256-ecb', Buffer.from(aesPassword, 'utf8'), null);
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBody, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

describe('API AES/RSA 加密 (e2e)', () => {
  let app: NestFastifyApplication;
  let config: ApiDecryptConfig;

  beforeAll(async () => {
    config = makeConfig();
    const module = await Test.createTestingModule({ imports: [ApiCryptoTestModule] })
      .overrideProvider(apiDecryptConfig.KEY)
      .useValue(config)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), { logger: false });
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('decrypts request bodies before Fastify parses JSON and enforces @ApiEncrypt()', async () => {
    const encrypted = encryptRequest('{"message":"request secret"}', config.publicKey!);
    const response = await app.inject({
      method: 'POST',
      url: '/api/crypto-probe/request',
      headers: { 'content-type': 'text/plain', 'encrypt-key': encrypted.encryptedKey },
      payload: encrypted.encryptedBody,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ code: 0, data: { message: 'request secret' }, message: '操作成功' });

    const missingHeader = await app.inject({
      method: 'POST',
      url: '/api/crypto-probe/request',
      payload: { message: 'plain text' },
    });
    expect(missingHeader.statusCode).toBe(403);
    expect(missingHeader.json().code).toBe(403);
  });

  it('encrypts the unified response when response: true is declared', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/crypto-probe/response' });
    const encryptedKey = response.headers['encrypt-key'];
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(encryptedKey).toBeTypeOf('string');
    expect(JSON.parse(decryptResponse(response.body, encryptedKey as string, config.privateKey!))).toEqual({
      code: 0,
      data: { message: 'response secret' },
      message: '操作成功',
    });

    const errorResponse = await app.inject({ method: 'GET', url: '/api/crypto-probe/response-error' });
    expect(errorResponse.statusCode).toBe(400);
    expect(JSON.parse(decryptResponse(
      errorResponse.body,
      errorResponse.headers['encrypt-key'] as string,
      config.privateKey!,
    ))).toMatchObject({ code: 400, data: null, message: 'invalid operation' });
  });

  it('leaves unannotated routes compatible with plain JSON requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/crypto-probe/plain',
      payload: { message: 'plain request' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.message).toBe('plain request');
  });

  it('rejects malformed encrypted requests with the standard error shape', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/crypto-probe/request',
      headers: { 'content-type': 'application/json', 'encrypt-key': 'invalid' },
      payload: 'invalid',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 400, data: null, message: '加密请求无效' });
  });
});
