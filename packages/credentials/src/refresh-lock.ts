import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { IntraError } from '../../contracts/src/index.js';
import { isFsError, privateDirectory } from './private-files.js';
import type { RefreshLockOptions } from './types.js';

/** Cross-process, bounded lock. Deliberately never steals a possibly live lock. */
export async function withFileLock<T>(directory: string, scope: string, callback: () => Promise<T>, options: RefreshLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollMs = options.pollMs ?? 25;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) {
    throw new IntraError('INVALID_ARGUMENT');
  }
  await privateDirectory(directory);
  const lock = join(directory, `${createHash('sha256').update(scope).digest('hex')}.lock`);
  const deadline = performance.now() + timeoutMs;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (!isFsError(error, 'EEXIST')) throw new IntraError('INTERNAL_ERROR', 'The credentials lock is unavailable.');
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new IntraError('REFRESH_LOCK_TIMEOUT', 'The credentials refresh lock timed out.', { retryable: true });
      await delay(Math.min(pollMs, remaining));
    }
  }
  const acquired = await lstat(lock);
  const ownerPath = join(lock, 'owner.json');
  try {
    await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token: randomUUID() }), { mode: 0o600, flag: 'wx' });
    return await callback();
  } finally {
    // An externally replaced lock must never be removed by its previous owner.
    const current = await lstat(lock).catch(() => undefined);
    if (current?.ino === acquired.ino && current.dev === acquired.dev && !current.isSymbolicLink()) {
      await unlink(ownerPath).catch(() => undefined);
      await rmdir(lock).catch(() => undefined);
    }
  }
}
