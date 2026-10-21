import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readLogRecords<T>(directory: string, prefix = 'gateway'): Promise<T[]> {
  const names = (await readdir(directory)).filter(file => file.startsWith(`${prefix}.`));
  const contents = await Promise.all(names.map(file => readFile(join(directory, file), 'utf8')));
  return contents.flatMap(content => content.split('\n').filter(Boolean).map(line => JSON.parse(line) as T));
}
