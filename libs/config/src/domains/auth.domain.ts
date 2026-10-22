import { asEnum, asObject, asStrictInteger, asString, defineConfigDomain } from '../core/index.js';

export interface AuthConfig {
  jwtSecret: string;
  jwtAlgorithm: 'HS256';
  jwtIssuer: string;
  jwtAudience: string;
  /** Access Token 有效期，单位秒。 */
  accessTokenTtl: number;
  /** 会话绝对有效期，单位秒；刷新不延长。 */
  refreshTokenTtl: number;
}

export const authDomain = defineConfigDomain<AuthConfig>({
  namespace: 'auth',
  parse(raw): AuthConfig {
    const value = asObject(raw, 'auth');
    const jwtSecret = value['jwt-secret'];
    // 不 trim 密钥、不生成回退值；错误信息不得包含密钥原文。
    if (typeof jwtSecret !== 'string' || jwtSecret.trim().length === 0
      || Buffer.byteLength(jwtSecret, 'utf8') < 32) {
      throw new Error('auth.jwt-secret: 必须配置至少 32 字节的随机密钥，请通过环境 local.yaml 或密钥挂载提供');
    }

    const accessTokenTtl = asStrictInteger(value['access-token-ttl'], 'auth.access-token-ttl', 900, 1, 2147483647);
    const refreshTokenTtl = asStrictInteger(value['refresh-token-ttl'], 'auth.refresh-token-ttl', 604800, 1, 2147483647);
    if (refreshTokenTtl <= accessTokenTtl) {
      throw new Error('auth.refresh-token-ttl: 必须大于 auth.access-token-ttl');
    }

    return {
      jwtSecret,
      jwtAlgorithm: asEnum(value['jwt-algorithm'], 'auth.jwt-algorithm', ['HS256'] as const, 'HS256'),
      jwtIssuer: asString(value['jwt-issuer'] ?? 'nest-admin', 'auth.jwt-issuer'),
      jwtAudience: asString(value['jwt-audience'] ?? 'nest-admin:gateway', 'auth.jwt-audience'),
      accessTokenTtl,
      refreshTokenTtl,
    };
  },
});

export const authConfig = authDomain.token;
