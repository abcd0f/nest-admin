import { asBoolean, asInteger, asObject, asString, defineConfigDomain } from '../core/index.js';

const DEFAULT_SCHEMA = 'public';

export interface DatabasePoolConfig {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

export interface DatabaseConfig {
  url: string;
  schema: string;
  pool: DatabasePoolConfig;
  logQueries: boolean;
}

function resolveSchema(url: string): string {
  try {
    return new URL(url).searchParams.get('schema') ?? DEFAULT_SCHEMA;
  } catch {
    return DEFAULT_SCHEMA;
  }
}

export const databaseDomain = defineConfigDomain<DatabaseConfig>({
  namespace: 'database',
  parse(raw): DatabaseConfig {
    const value = asObject(raw, 'database');
    const pool = asObject(value.pool, 'database.pool');
    const url = asString(value.url, 'database.url');

    return {
      url,
      schema: resolveSchema(url),
      pool: {
        max: asInteger(pool.max, 'database.pool.max', 10, 1),
        idleTimeoutMillis: asInteger(pool['idle-timeout'], 'database.pool.idle-timeout', 10_000, 0),
        connectionTimeoutMillis: asInteger(
          pool['connect-timeout'],
          'database.pool.connect-timeout',
          5_000,
          0,
        ),
      },
      logQueries: asBoolean(value['log-queries'], 'database.log-queries', false),
    };
  },
});

export const databaseConfig = databaseDomain.token;
