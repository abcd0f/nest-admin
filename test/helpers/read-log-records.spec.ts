import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLogRecords } from './read-log-records.js';

describe('测试日志读取', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nest-read-logs-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('读取多个轮转文件、空文件和尾部换行，并隔离前缀', async () => {
    await Promise.all([
      writeFile(join(directory, 'gateway.1.log'), '{"msg":"one"}\r\n'),
      writeFile(join(directory, 'gateway.2.log'), '{"msg":"two"}\n\n'),
      writeFile(join(directory, 'gateway.3.log'), ''),
      writeFile(join(directory, 'error.1.log'), '{"msg":"error"}\n'),
    ]);
    const records = await readLogRecords<{ msg: string }>(directory);
    expect(records.map(record => record.msg).sort()).toEqual(['one', 'two']);
    expect(await readLogRecords(directory, 'error')).toEqual([{ msg: 'error' }]);
  });

  it('不吞掉日志损坏或目录读取错误', async () => {
    await writeFile(join(directory, 'gateway.1.log'), 'invalid json');
    await expect(readLogRecords(directory)).rejects.toThrow(SyntaxError);
    await expect(readLogRecords(join(directory, 'missing'))).rejects.toThrow();
  });
});
