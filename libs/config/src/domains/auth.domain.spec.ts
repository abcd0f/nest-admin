import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigModule } from '../config.module.js';
import * as configLoader from '../core/config-loader.js';
import { resetCompiledConfig } from '../core/validate.js';
import { authConfig, authDomain } from './auth.domain.js';

const context = { environment: 'test' } as const;
const jwtSecret = randomBytes(32).toString('hex');

afterEach(() => {
  vi.restoreAllMocks();
  resetCompiledConfig();
});

describe('auth 配置域', () => {
  it('默认固定 HS256、15 分钟 Access Token 和 7 天绝对会话期限', () => {
    expect(authDomain.parse({ 'jwt-secret': jwtSecret }, context)).toEqual({
      jwtSecret,
      jwtAlgorithm: 'HS256',
      jwtIssuer: 'nest-admin',
      jwtAudience: 'nest-admin:gateway',
      accessTokenTtl: 900,
      refreshTokenTtl: 604800,
    });
  });

  it.each([undefined, null, '', ' '.repeat(32), 'short', 123, {}, true])('拒绝缺失、过短或非字符串密钥：%s', (secret) => {
    expect(() => authDomain.parse({ 'jwt-secret': secret }, context)).toThrow('auth.jwt-secret');
  });

  it('不 trim 密钥，错误信息不包含密钥原文', () => {
    const secret = ` ${jwtSecret} `;
    expect(authDomain.parse({ 'jwt-secret': secret }, context).jwtSecret).toBe(secret);
    expect(() => authDomain.parse({ 'jwt-secret': 'private-short-key' }, context))
      .toThrow(/^auth\.jwt-secret: (?!.*private-short-key)/);
  });

  it('支持 YAML 数字字符串及自定义签发方、接收方', () => {
    expect(authDomain.parse({
      'jwt-secret': jwtSecret,
      'jwt-issuer': 'custom-issuer',
      'jwt-audience': 'custom-audience',
      'access-token-ttl': '60',
      'refresh-token-ttl': '3600',
    }, context)).toMatchObject({
      jwtIssuer: 'custom-issuer',
      jwtAudience: 'custom-audience',
      accessTokenTtl: 60,
      refreshTokenTtl: 3600,
    });
  });

  it.each([
    ['jwt-algorithm', 'none'],
    ['jwt-algorithm', 'HS512'],
    ['jwt-issuer', ''],
    ['jwt-audience', '   '],
    ['access-token-ttl', 0],
    ['access-token-ttl', true],
    ['access-token-ttl', ''],
    ['access-token-ttl', 1.5],
    ['access-token-ttl', 2147483648],
    ['refresh-token-ttl', -1],
    ['refresh-token-ttl', '7d'],
    ['refresh-token-ttl', Infinity],
  ])('拒绝非法配置 %s=%s', (key, value) => {
    expect(() => authDomain.parse({ 'jwt-secret': jwtSecret, [key]: value }, context))
      .toThrow(`auth.${key}`);
  });

  it.each([899, 900])('要求 Refresh Token 期限大于 Access Token 期限：%s', (ttl) => {
    expect(() => authDomain.parse({ 'jwt-secret': jwtSecret, 'refresh-token-ttl': ttl }, context))
      .toThrow('auth.refresh-token-ttl');
  });

  it('通过现有启动入口拒绝缺失密钥，并向 Nest DI 注册解析后的配置', async () => {
    const values = { database: { url: 'postgresql://test:test@localhost/test' } };
    const source = vi.spyOn(configLoader, 'configSource').mockReturnValue({ ...context, values });
    expect(() => AppConfigModule.forRoot()).toThrow('auth.jwt-secret');

    source.mockReturnValue({ ...context, values: { ...values, auth: { 'jwt-secret': jwtSecret } } });
    const module = await Test.createTestingModule({ imports: [AppConfigModule.forRoot()] }).compile();
    try {
      expect(module.get(authConfig.KEY)).toMatchObject({ jwtSecret, accessTokenTtl: 900 });
    } finally {
      await module.close();
    }
  });
});
