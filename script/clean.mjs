import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const rootDir = process.cwd();

/**
 * 递归查找并删除目标目录或文件
 * @param {string} currentDir - 当前遍历的目录路径
 * @param {string[]} targets - 要删除的目录或文件名称
 */
async function cleanTargetsRecursively(currentDir, targets) {
  const items = await fs.readdir(currentDir);

  for (const item of items) {
    try {
      const itemPath = join(currentDir, item);

      // 匹配到目标目录或文件时直接删除
      if (targets.includes(item)) {
        await fs.rm(itemPath, {
          force: true,
          recursive: true,
        });

        console.log(`Deleted: ${itemPath}`);
        continue;
      }

      const stat = await fs.lstat(itemPath);

      if (stat.isDirectory()) {
        await cleanTargetsRecursively(itemPath, targets);
      }
    } catch {
      // 忽略无法访问或删除的文件
    }
  }
}

async function startCleanup() {
  // 要删除的目录及文件名称
  const targets = ['node_modules', 'dist', 'dist.zip'];

  const deleteLockFile = process.argv.includes('--del-lock');

  const cleanupTargets = deleteLockFile ? [...targets, 'pnpm-lock.yaml'] : targets;

  console.log(`Starting cleanup of targets: ${cleanupTargets.join(', ')} from root: ${rootDir}`);

  try {
    await cleanTargetsRecursively(rootDir, cleanupTargets);
    console.log('Cleanup process completed.');
  } catch (error) {
    console.error(`Unexpected error during cleanup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await startCleanup();
