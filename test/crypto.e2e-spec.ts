import type { ApiDecryptConfig } from '@app/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createFastifyAdapter } from '@app/common';
import { apiDecryptConfig, AppConfigModule } from '@app/config';
import { CoreModule } from '@app/core';
import { ApiEncrypt, CryptoModule } from '@app/crypto';
import { All, BadRequestException, Body, Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCryptoConfig, decryptResponse, encryptRequest } from './helpers/api-crypto-client.js';

@Controller('crypto-probe')
class CryptoProbeController {
  @ApiEncrypt()
  @All('request')
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

  @All('plain')
  plain(@Body() body: { message: string }) {
    return body;
  }
}

@Module({
  imports: [AppConfigModule.forRoot(), CryptoModule, CoreModule],
  controllers: [CryptoProbeController],
})
class ApiCryptoTestModule {}

describe('API AES/RSA 加密 (e2e)', () => {
  let app: NestFastifyApplication;
  let config: ApiDecryptConfig;

  beforeAll(async () => {
    config = createCryptoConfig();
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

  it.each(['POST', 'PUT'] as const)('decrypts %s before JSON parsing and enforces @ApiEncrypt()', async (method) => {
    const encrypted = encryptRequest('{"message":"request secret"}', config.publicKey!);
    const response = await app.inject({
      method,
      url: '/api/crypto-probe/request',
      headers: { 'content-type': 'text/plain', 'encrypt-key': encrypted.encryptedKey },
      payload: encrypted.encryptedBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ code: 0, data: { message: 'request secret' }, message: '操作成功' });

    const missingHeader = await app.inject({
      method,
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
    expect(errorResponse.headers['content-type']).toContain('text/plain');
    expect(JSON.parse(decryptResponse(
      errorResponse.body,
      errorResponse.headers['encrypt-key'] as string,
      config.privateKey!,
    ))).toMatchObject({ code: 400, data: null, message: 'invalid operation' });
  });

  it.each(['POST', 'PUT'] as const)('leaves unannotated %s routes compatible with plain JSON and encrypted requests', async (method) => {
    const response = await app.inject({
      method,
      url: '/api/crypto-probe/plain',
      payload: { message: 'plain request' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.message).toBe('plain request');

    const encrypted = encryptRequest('{"message":"encrypted request"}', config.publicKey!);
    const encryptedResponse = await app.inject({
      method,
      url: '/api/crypto-probe/plain',
      headers: { 'content-type': 'text/plain', 'encrypt-key': encrypted.encryptedKey },
      payload: encrypted.encryptedBody,
    });
    expect(encryptedResponse.statusCode).toBe(200);
    expect(encryptedResponse.json().data.message).toBe('encrypted request');
  });

  it.each(['GET', 'DELETE', 'PATCH'] as const)('%s neither requires an encryption header nor decrypts the payload', async (method) => {
    const plainResponse = await app.inject({ method, url: '/api/crypto-probe/request' });
    expect(plainResponse.statusCode).toBe(200);

    const response = await app.inject({
      method,
      url: '/api/crypto-probe/request',
      headers: { 'content-type': 'text/plain', 'encrypt-key': 'invalid' },
      payload: 'unchanged payload',
    });
    expect(response.statusCode).toBe(200);
    // Fastify 不解析 GET 请求体，其他方法的明文保持原样。
    expect(response.json().data).toBe(method === 'GET' ? null : 'unchanged payload');
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
