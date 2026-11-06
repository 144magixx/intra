import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { IntraError } from '../../contracts/src/index.js';

export function isFsError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function privateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Unsafe directory');
    }
    await chmod(directory, 0o700);
  } catch { throw new IntraError('INTERNAL_ERROR', 'The private credentials directory is unavailable.'); }
}

export function credentialsDirectory(home: string): string {
  if (typeof home !== 'string' || !home || resolve(home) === '/') throw new IntraError('INVALID_ARGUMENT');
  return join(resolve(home), 'credentials');
}

export async function readPrivateText(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 1024 * 1024) {
      throw new Error('Unsafe metadata file');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (isFsError(error, 'ENOENT')) return null;
    throw new IntraError('INTERNAL_ERROR', 'The credentials metadata could not be read.');
  } finally { await handle?.close(); }
}

/** Public metadata only. Never pass credential values to this function. */
export async function atomicMetadata(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.metadata-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch { throw new IntraError('INTERNAL_ERROR', 'The credentials metadata could not be saved.'); }
  finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}
