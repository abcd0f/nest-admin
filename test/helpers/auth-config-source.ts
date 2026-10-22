import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';

// 仅供调用 AppConfigModule.forRoot() 的测试使用，不创建本地配置文件或运行时默认密钥。
vi.mock('../../libs/config/src/core/config-loader.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../libs/config/src/core/config-loader.js')>();
  const jwtSecret = randomBytes(32).toString('hex');
  return {
    ...original,
    configSource: () => {
      const source = original.configSource();
      return {
        ...source,
        values: { ...source.values, auth: { ...source.values.auth as object, 'jwt-secret': jwtSecret } },
      };
    },
  };
});
