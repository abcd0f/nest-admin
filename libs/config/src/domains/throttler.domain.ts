import { asBoolean, asObject, asStrictInteger, defineConfigDomain } from '../core/index.js';

export interface ThrottlerConfig {
  enabled: boolean;
  ttl: number;
  limit: number;
  blockDuration?: number;
}

export const throttlerDomain = defineConfigDomain<ThrottlerConfig>({
  namespace: 'throttler',
  parse(raw): ThrottlerConfig {
    const value = asObject(raw, 'throttler');
    return {
      enabled: asBoolean(value.enabled, 'throttler.enabled', true),
      ttl: asStrictInteger(value.ttl, 'throttler.ttl', 60000, 1),
      limit: asStrictInteger(value.limit, 'throttler.limit', 100, 1),
      // 保持可选，让官方守卫使用接口最终生效的 ttl 作为缺省封禁时长。
      blockDuration: value['block-duration'] == null
        ? undefined
        : asStrictInteger(value['block-duration'], 'throttler.block-duration', undefined, 0),
    };
  },
});

export const throttlerConfig = throttlerDomain.token;
