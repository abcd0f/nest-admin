import type { RedisClientType } from 'redis';

export function assertKey(key: string): void {
  if (typeof key !== 'string' || key.trim().length === 0) throw new TypeError('Redis key 必须是非空字符串');
}

export function assertTtl(ttl: number, allowZero = true): void {
  if (!Number.isSafeInteger(ttl) || ttl < (allowZero ? 0 : 1) || ttl > 2147483647) {
    throw new TypeError(`TTL 必须是 ${allowZero ? 0 : 1} 到 2147483647 之间的整数（毫秒）`);
  }
}

/** prefix 按字面量处理；逐批 SCAN + UNLINK，不阻塞 Redis，也不积攒删除任务。 */
export async function deleteByPrefix(client: Pick<RedisClientType, 'scan' | 'unlink'>, prefix: string): Promise<number> {
  assertKey(prefix);
  const match = `${prefix.replace(/[\\*?[\]]/g, '\\$&')}*`;
  let cursor = '0';
  let deleted = 0;
  do {
    const result = await client.scan(cursor, { MATCH: match, COUNT: 200 });
    cursor = result.cursor;
    if (result.keys.length > 0) deleted += await client.unlink(result.keys);
  } while (cursor !== '0');
  return deleted;
}
