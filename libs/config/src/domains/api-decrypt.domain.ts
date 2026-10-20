import { asBoolean, asObject, asOptionalString, asString, defineConfigDomain } from '../core/index.js';

export interface ApiDecryptConfig {
  enabled: boolean;
  headerFlag: string;
  privateKey?: string;
  publicKey?: string;
}

export const apiDecryptDomain = defineConfigDomain<ApiDecryptConfig>({
  namespace: 'api-decrypt',
  parse(raw): ApiDecryptConfig {
    const value = asObject(raw, 'api-decrypt');
    const enabled = asBoolean(value.enabled, 'api-decrypt.enabled', false);
    const privateKey = asOptionalString(value['private-key'], 'api-decrypt.private-key');
    const publicKey = asOptionalString(value['public-key'], 'api-decrypt.public-key');

    if (enabled && !privateKey) {
      throw new Error('api-decrypt.private-key: 启用 API 解密时必须配置 RSA 私钥');
    }
    if (enabled && !publicKey) {
      throw new Error('api-decrypt.public-key: 启用响应加密时必须配置 RSA 公钥');
    }

    return {
      enabled,
      headerFlag: asString(value['header-flag'], 'api-decrypt.header-flag', 'encrypt-key'),
      privateKey,
      publicKey,
    };
  },
});

export const apiDecryptConfig = apiDecryptDomain.token;
