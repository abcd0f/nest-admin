import { defineConfig } from 'prisma/config';
import { loadConfigSource } from './libs/config/src/core/config-loader.js';

// Prisma CLI（migrate / db push / studio）不走 Nest 的 DI，这里直接读同一份
// config/*.yaml，避免连接串出现第二处来源。
const source = loadConfigSource();
const database = source.values.database as { url?: unknown } | undefined;
const url = database?.url;

if (typeof url !== 'string' || url.length === 0) {
  throw new Error('database.url 未配置：请检查 config/default.yaml 与 config/<env>.local.yaml');
}

export default defineConfig({
  schema: 'prisma/',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Prisma CLI 用这个连接串；运行时用的是驱动适配器里的连接串（同一个来源）
    url,
  },
});
