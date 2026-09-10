import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

const environment = process.env.NODE_ENV ?? 'development';
const rootDirectory = dirname(fileURLToPath(import.meta.url));

for (const fileName of ['.env.local', `.env.${environment}`, '.env']) {
  const filePath = join(rootDirectory, fileName);
  if (existsSync(filePath)) loadEnv({ path: filePath, quiet: true });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing ${name} environment variable`);
  return value;
}

const host = requiredEnv('DB_HOST');
const port = requiredEnv('DB_PORT');
const database = requiredEnv('DB_DATABASE');
const username = requiredEnv('DB_USERNAME');
const password = requiredEnv('DB_PASSWORD');

const datasourceUrl = [
  `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}`,
  `@${host}:${port}/${encodeURIComponent(database)}`,
].join('');

export default defineConfig({
  schema: 'packages/database/prisma/schema.prisma',
  migrations: {
    path: 'packages/database/prisma/migrations',
  },
  datasource: {
    url: datasourceUrl,
  },
});
