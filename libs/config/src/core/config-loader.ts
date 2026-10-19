import type { Environment, RawConfig, RawConfigSnapshot } from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ENVIRONMENTS } from './types.js';

const CONFIG_DIR = 'config';
const BASE_FILE = 'default.yaml';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    merged[key] =
      isPlainObject(merged[key]) && isPlainObject(value)
        ? deepMerge(merged[key] as Record<string, unknown>, value)
        : value;
  }
  return merged;
}

function readYamlFile(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;

  const parsed = parseYaml(readFileSync(file, 'utf8'));
  if (parsed === undefined || parsed === null) return {};
  if (!isPlainObject(parsed)) throw new Error(`配置文件 ${file} 的顶层必须是「键: 值」映射`);
  return parsed;
}

export function resolveEnvironment(): Environment {
  const name = process.env.NODE_ENV ?? 'development';
  if (!(ENVIRONMENTS as readonly string[]).includes(name)) {
    throw new Error(`NODE_ENV 必须是 ${ENVIRONMENTS.join(' / ')} 之一，当前为 "${name}"`);
  }
  return name as Environment;
}

export function loadConfigSource(): RawConfigSnapshot {
  const environment = resolveEnvironment();
  const dir = resolve(process.cwd(), CONFIG_DIR);
  const baseFile = resolve(dir, BASE_FILE);

  if (!existsSync(baseFile)) {
    throw new Error(`缺少配置基线层 ${baseFile}（当前工作目录：${process.cwd()}）`);
  }

  const layers = [
    baseFile,
    resolve(dir, `${environment}.yaml`),
    resolve(dir, `${environment}.local.yaml`),
  ];
  let values: Record<string, unknown> = {};

  for (const file of layers) {
    const layer = readYamlFile(file);
    if (layer !== undefined) values = deepMerge(values, layer);
  }

  return { environment, values: values as RawConfig };
}

let cached: RawConfigSnapshot | undefined;

export function configSource(): RawConfigSnapshot {
  cached ??= loadConfigSource();
  return cached;
}

export function resetConfigSource(): void {
  cached = undefined;
}
