import type { ApiDecryptConfig } from '@app/config';
import { constants, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt } from 'node:crypto';

/** 独立测试客户端，不调用服务端的报文编解码实现。 */
export function createCryptoConfig(): ApiDecryptConfig {
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

export function encryptRequest(plainBody: string, publicKey: string) {
  const aesKey = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
  const cipher = createCipheriv('aes-256-ecb', aesKey, null);
  const encryptedBody = Buffer.concat([cipher.update(plainBody, 'utf8'), cipher.final()]).toString('base64');
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  const encryptedKey = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey.toString('base64'), 'utf8'),
  ).toString('base64');
  return { encryptedBody, encryptedKey };
}

export function decryptResponse(encryptedBody: string, encryptedKey: string, privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const encodedAesKey = privateDecrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(encryptedKey, 'base64'),
  ).toString('utf8');
  const decipher = createDecipheriv('aes-256-ecb', Buffer.from(encodedAesKey, 'base64'), null);
  return Buffer.concat([decipher.update(Buffer.from(encryptedBody, 'base64')), decipher.final()]).toString('utf8');
}
