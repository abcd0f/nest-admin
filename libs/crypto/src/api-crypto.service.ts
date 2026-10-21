import type { ApiDecryptConfig } from '@app/config';
import { constants, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { BASE64_PATTERN } from '@app/common/constants/regex.js';

export interface EncryptedResponse {
  body: string;
  encryptedKey: string;
}

function decodeBase64(value: string): Buffer {
  if (!BASE64_PATTERN.test(value)) {
    throw new Error('invalid base64');
  }
  return Buffer.from(value, 'base64');
}

function keyObject(value: string, kind: 'public' | 'private') {
  if (value.includes('-----BEGIN')) {
    return kind === 'private' ? createPrivateKey(value) : createPublicKey(value);
  }

  const der = decodeBase64(value);
  return kind === 'private'
    ? createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    : createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** Implements the AES-ECB/PKCS padding and RSA PKCS#1 v1.5 format used by Hutool. */
export class ApiCryptoService {
  private readonly privateKey;
  private readonly publicKey;

  constructor(private readonly config: ApiDecryptConfig) {
    if (config.enabled) {
      this.privateKey = keyObject(config.privateKey!, 'private');
      this.publicKey = keyObject(config.publicKey!, 'public');
    }
  }

  decryptRequest(encryptedKey: string, encryptedBody: Buffer): Buffer {
    if (!this.privateKey) throw new Error('API 解密未启用');

    const encodedAesKey = privateDecrypt(
      { key: this.privateKey, padding: constants.RSA_PKCS1_PADDING },
      decodeBase64(encryptedKey),
    ).toString('utf8');
    const aesKey = decodeBase64(encodedAesKey);
    const algorithm = this.aesAlgorithm(aesKey);
    const ciphertext = decodeBase64(encryptedBody.toString('utf8').trim());
    if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new Error('invalid AES ciphertext');

    const decipher = createDecipheriv(algorithm, aesKey, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  encryptResponse(plainBody: string): EncryptedResponse {
    if (!this.publicKey) throw new Error('API 响应加密未启用');

    const aesPassword = randomBytes(24).toString('base64url');
    const aesKey = Buffer.from(aesPassword, 'utf8');
    const encryptor = createCipheriv(this.aesAlgorithm(aesKey), aesKey, null);
    const encryptedBody = Buffer.concat([
      encryptor.update(Buffer.from(plainBody, 'utf8')),
      encryptor.final(),
    ]).toString('base64');
    const encryptedKey = publicEncrypt(
      { key: this.publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(aesKey.toString('base64'), 'utf8'),
    ).toString('base64');

    return { body: encryptedBody, encryptedKey };
  }

  async decryptStream(encryptedKey: string, payload: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Readable> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of payload) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error('body too large');
      chunks.push(Buffer.from(chunk));
    }
    return Readable.from([this.decryptRequest(encryptedKey, Buffer.concat(chunks))]);
  }

  private aesAlgorithm(aesKey: Buffer): string {
    if (![16, 24, 32].includes(aesKey.length)) throw new Error('invalid AES key length');
    return `aes-${aesKey.length * 8}-ecb`;
  }
}
