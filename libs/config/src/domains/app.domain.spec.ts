import { describe, expect, it } from 'vitest';
import { appDomain } from './app.domain.js';

describe('appDomain', () => {
  it('未配置全局 API 前缀时默认为 api', () => {
    expect(appDomain.parse({}, { environment: 'test' })).toHaveProperty('apiPrefix', 'api');
  });

  it('解析 YAML 中的自定义全局 API 前缀', () => {
    expect(appDomain.parse({ 'api-prefix': 'admin/v1' }, { environment: 'test' }))
      .toHaveProperty('apiPrefix', 'admin/v1');
  });

  it('拒绝对象类型的全局 API 前缀', () => {
    expect(() => appDomain.parse({ 'api-prefix': {} }, { environment: 'test' }))
      .toThrow('app.api-prefix');
  });
});
