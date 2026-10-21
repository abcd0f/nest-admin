import type { LoggerConfig } from '@app/config';
import type { TransportMultiOptions } from 'pino';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DIRECTORY_ERROR_PATTERN, LOG_DATE_PATTERN, LOGGER_TEST_SECRETS_PATTERN } from '@app/common/constants/regex.js';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLogRecords } from '../../../test/helpers/read-log-records.js';
import { loggerDomain } from '../../config/src/domains/logger.domain.js';
import { createHttpOptions, createTransportOptions } from './logger.options.js';
import { LoggerTransport } from './logger.transport.js';

interface LogRecord {
  level: number;
  msg: string;
  err?: { message: string; stack: string; cause?: { message: string } };
}

describe('真实 Pino 输出与文件轮转', () => {
  let directory: string;
  let config: LoggerConfig;
  let output: LoggerTransport | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nest-logger-transport-'));
    config = loggerDomain.parse({
      level: 'debug',
console: { enabled: false },
file: { directory, 'max-files': 100 },
    }, { environment: 'test' });
  });

  afterEach(async () => {
    await output?.onApplicationShutdown();
    output = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  async function files(prefix: string): Promise<string[]> {
    return (await readdir(directory)).filter(file => file.startsWith(`${prefix}.`));
  }

  async function records(prefix: string): Promise<LogRecord[]> {
    return readLogRecords<LogRecord>(directory, prefix);
  }

  function rollingOptions(overrides: Record<string, unknown>): TransportMultiOptions {
    const options = createTransportOptions(config);
    for (const target of options.targets) Object.assign(target.options!, overrides);
    return options;
  }

  it('按级别复制分流、保留错误原因链、脱敏并排空尾部日志', async () => {
    output = await LoggerTransport.create(createTransportOptions(config));
    const logger = pino(createHttpOptions(config), output.stream);
    logger.debug('debug-record');
    logger.info({ password: 'root-secret', account: { token: 'nested-secret' } }, 'info-record');
    logger.warn('warn-record');
    logger.error({ err: new Error('database unavailable', { cause: new Error('connection refused') }) }, 'error-record');
    logger.fatal('fatal-tail-record');
    await output.onApplicationShutdown();

    const main = await records('gateway');
    const errors = await records('error');
    expect(main.map(record => record.level)).toEqual([20, 30, 40, 50, 60]);
    expect(errors.map(record => record.level)).toEqual([50, 60]);
    expect(errors[0].err?.stack).toContain('database unavailable');
    expect(errors[0].err?.cause?.message).toBe('connection refused');
    expect(JSON.stringify(main)).not.toMatch(LOGGER_TEST_SECRETS_PATTERN);
    expect(JSON.stringify(main)).toContain('[REDACTED]');
    expect((await readFile(join(directory, (await files('gateway'))[0]), 'utf8'))).not.toContain('\u001B[');
  });

  it('全局级别过滤在所有文件目标生效', async () => {
    config.level = 'fatal';
    output = await LoggerTransport.create(createTransportOptions(config));
    const logger = pino(createHttpOptions(config), output.stream);
    logger.info('filtered-info');
    logger.error('filtered-error');
    logger.fatal('kept-fatal');
    await output.onApplicationShutdown();
    expect((await records('gateway')).map(record => record.msg)).toEqual(['kept-fatal']);
    expect((await records('error')).map(record => record.msg)).toEqual(['kept-fatal']);
  });

  it('主文件与 error 文件分别按大小轮转，记录不丢失', async () => {
    output = await LoggerTransport.create(rollingOptions({ size: '1k' }));
    const logger = pino(createHttpOptions(config), output.stream);
    for (let i = 0; i < 4; i++) {
      logger.info({ padding: 'x'.repeat(1500) }, `info-${i}`);
      logger.error({ padding: 'x'.repeat(1500) }, `error-${i}`);
      await vi.waitFor(async () => {
        expect((await files('gateway')).length).toBeGreaterThan(i + 1);
        expect((await files('error')).length).toBeGreaterThan(i + 1);
      });
    }
    await output.onApplicationShutdown();
    expect((await records('gateway')).map(record => record.msg).sort()).toEqual([
      'error-0',
'error-1',
'error-2',
'error-3',
'info-0',
'info-1',
'info-2',
'info-3',
    ]);
    expect((await records('error')).map(record => record.msg).sort()).toEqual(['error-0', 'error-1', 'error-2', 'error-3']);
  });

  it('跨时间边界后，两类日志各自进入新文件', async () => {
    output = await LoggerTransport.create(rollingOptions({ frequency: 300 }));
    const logger = pino(createHttpOptions(config), output.stream);
    logger.error('before-boundary');
    await vi.waitFor(async () => {
      expect((await files('gateway')).length).toBeGreaterThan(1);
      expect((await files('error')).length).toBeGreaterThan(1);
    });
    logger.error('after-boundary');
    await output.onApplicationShutdown();
    for (const prefix of ['gateway', 'error']) {
      const contents = await Promise.all((await files(prefix)).map(file => readFile(join(directory, file), 'utf8')));
      expect(contents.filter(content => content.includes('before-boundary'))).toHaveLength(1);
      expect(contents.filter(content => content.includes('after-boundary'))).toHaveLength(1);
      expect(contents.some(content => content.includes('before-boundary') && content.includes('after-boundary'))).toBe(false);
    }
  });

  it.each([1, 2])('各自最多保留 %s 份，清理跨重启历史且保留其他前缀', async (maxFiles) => {
    for (const prefix of ['gateway', 'error']) {
      for (let i = 1; i <= 4; i++) {
        await writeFile(join(directory, `${prefix}.2000-01-01.${i}.log`), 'old-process\n');
      }
    }
    await writeFile(join(directory, 'unrelated.2000-01-01.1.log'), 'keep');
    config.file.maxFiles = maxFiles;
    output = await LoggerTransport.create(rollingOptions({ frequency: 300 }));
    pino(createHttpOptions(config), output.stream).error('new-process');
    await vi.waitFor(async () => {
      expect(await files('gateway')).toHaveLength(maxFiles);
      expect(await files('error')).toHaveLength(maxFiles);
      expect((await readdir(directory)).some(file => file.startsWith('gateway.2000') || file.startsWith('error.2000'))).toBe(false);
    }, { timeout: 3000 });
    await output.onApplicationShutdown();
    expect(await readFile(join(directory, 'unrelated.2000-01-01.1.log'), 'utf8')).toBe('keep');
  });

  it('文件目录不可用时，初始化明确失败', async () => {
    await writeFile(join(directory, 'blocked'), 'file');
    config.file.directory = join(directory, 'blocked', 'logs');
    await expect(LoggerTransport.create(createTransportOptions(config))).rejects.toThrow(DIRECTORY_ERROR_PATTERN);
  });

  it.each([true, false])('控制台 pretty=%s 实际输出正确格式', async (pretty) => {
    config.console = { enabled: true, pretty };
    config.file.enabled = false;
    const source = `
      import pino, { transport } from 'pino';
      import { once } from 'node:events';
      const stream = transport(${JSON.stringify(createTransportOptions(config))});
      await once(stream, 'ready');
      stream.ref();
      pino(stream).info('console-probe');
      const closed = once(stream, 'close');
      stream.end();
      await closed;
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source]);
    expect(stdout).toContain('console-probe');
    if (pretty) {
      expect(stdout).toContain('\u001B[');
      expect(stdout).toMatch(LOG_DATE_PATTERN);
      expect(stdout).toContain('INFO');
    } else {
      expect(JSON.parse(stdout).level).toBe(30);
      expect(stdout).not.toContain('\u001B[');
    }
  });
});
