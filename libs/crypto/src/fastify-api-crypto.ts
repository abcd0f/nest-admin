import type { ApiDecryptConfig } from '@app/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { Readable } from 'node:stream';
import { supportsEncryptedRequest } from './api-crypto-policy.js';
import { ApiCryptoService } from './api-crypto.service.js';
import { API_ENCRYPT_RESPONSE } from './api-encrypt.decorator.js';

type FastifyInstance = ReturnType<ReturnType<NestFastifyApplication['getHttpAdapter']>['getInstance']>;

const EMPTY_BODY = Readable.from([]);

/** Install before the server starts so Fastify receives decrypted JSON before parsing it. */
export function installApiCryptoHooks(
  fastify: FastifyInstance,
  config: ApiDecryptConfig,
  crypto: ApiCryptoService,
): void {
  if (!config.enabled) return;

  fastify.addHook('preParsing', async (request, reply, payload) => {
    const encryptedKey = request.headers[config.headerFlag.toLowerCase()];
    if (!supportsEncryptedRequest(request.method) || typeof encryptedKey !== 'string' || !encryptedKey) {
      return payload;
    }

    try {
      const maxBytes = request.routeOptions.bodyLimit ?? fastify.initialConfig.bodyLimit ?? 1048576;
      const clearPayload = await crypto.decryptStream(encryptedKey, payload, maxBytes);
      request.headers['content-type'] = 'application/json';
      (clearPayload as Readable & { receivedEncodedLength: number }).receivedEncodedLength = Number(
        request.headers['content-length'] ?? 0,
      );
      return clearPayload;
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'body too large';
      reply
        .code(tooLarge ? 413 : 400)
        .type('application/json; charset=utf-8')
        .send({
          code: tooLarge ? 413 : 400,
          data: null,
          message: tooLarge ? '请求体过大' : '加密请求无效',
        });
      return EMPTY_BODY;
    }
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    if (!(request as typeof request & { [API_ENCRYPT_RESPONSE]?: boolean })[API_ENCRYPT_RESPONSE]) {
      return payload;
    }
    if (reply.statusCode === 204 || reply.statusCode === 304) return payload;

    const plainBody = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
    if (typeof plainBody !== 'string') return payload;

    const encrypted = crypto.encryptResponse(plainBody);
    reply.header(config.headerFlag, encrypted.encryptedKey);
    const currentExposeHeader = reply.getHeader('access-control-expose-headers');
    const exposedHeaders = Array.isArray(currentExposeHeader)
      ? currentExposeHeader.flatMap((header) => String(header).split(','))
      : String(currentExposeHeader ?? '').split(',');
    exposedHeaders.push(config.headerFlag);
    reply.header(
      'access-control-expose-headers',
      [...new Set(exposedHeaders.map((header) => header.trim()).filter(Boolean))].join(', '),
    );
    reply.type('text/plain; charset=utf-8');
    return encrypted.body;
  });
}
