import { asBoolean, asInteger, asObject, defineConfigDomain } from '../core/index.js';

export interface ThrottlerConfig {
  enabled: boolean;
  ttl: number;
  limit: number;
  blockDuration?: number;
}

function integer(value: unknown, path: string, fallback: number | undefined, min: number): number {
  if (
    (value != null && typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim().length === 0)
  ) {
    throw new Error(`${path}: 必须是整数`);
  }
  return asInteger(value, path, fallback, min);
}

export const throttlerDomain = defineConfigDomain<ThrottlerConfig>({
  namespace: 'throttler',
  parse(raw): ThrottlerConfig {
    const value = asObject(raw, 'throttler');
    return {
      enabled: asBoolean(value.enabled, 'throttler.enabled', true),
      ttl: integer(value.ttl, 'throttler.ttl', 60000, 1),
      limit: integer(value.limit, 'throttler.limit', 100, 1),
      // 保持可选，让官方守卫使用接口最终生效的 ttl 作为缺省封禁时长。
      blockDuration: value['block-duration'] == null
        ? undefined
        : integer(value['block-duration'], 'throttler.block-duration', undefined, 0),
    };
  },
});

export const throttlerConfig = throttlerDomain.token;
