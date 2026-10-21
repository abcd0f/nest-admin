import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { FIELD_ENCRYPTION_KEY } from '@app/common/constants/index.js';
import { Transform } from 'class-transformer';

const CIPHERTEXT_PREFIX = 'enc:v1:';

function deriveKey(key: string): Buffer {
  if (!key) throw new Error('字段加密密钥不能为空');
  return createHash('sha256').update(key, 'utf8').digest();
}

function encrypt(value: unknown, key: string): unknown {
  if (value === null || value === undefined || typeof value !== 'string' || value === '') return value;
  if (value.startsWith(CIPHERTEXT_PREFIX)) return value;

  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${CIPHERTEXT_PREFIX}${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(value: unknown, key: string): unknown {
  if (value === null || value === undefined || typeof value !== 'string' || value === '') return value;
  if (!value.startsWith(CIPHERTEXT_PREFIX)) return value;

  const [nonceText, tagText, ciphertextText, ...extra] = value.slice(CIPHERTEXT_PREFIX.length).split(':');
  if (!nonceText || !tagText || ciphertextText === undefined || extra.length > 0) {
    throw new Error('字段密文格式无效');
  }

  try {
    const nonce = Buffer.from(nonceText, 'base64');
    const tag = Buffer.from(tagText, 'base64');
    const ciphertext = Buffer.from(ciphertextText, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(key), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('字段解密失败：密钥错误或密文已损坏');
  }
}

/** Encrypt a string field when converting a DTO instance to a plain object. */
export function EncryptField(): PropertyDecorator {
  return Transform(({ value }) => encrypt(value, FIELD_ENCRYPTION_KEY), { toPlainOnly: true });
}

/** Decrypt a string field when converting a plain object to a DTO instance. */
export function DecryptField(): PropertyDecorator {
  return Transform(({ value }) => decrypt(value, FIELD_ENCRYPTION_KEY), { toClassOnly: true });
}
