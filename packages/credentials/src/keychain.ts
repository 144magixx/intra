import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IntraError, isRecord, projectRoot } from '../../contracts/src/index.js';
import { isFsError, privateDirectory } from './private-files.js';
import { withFileLock } from './refresh-lock.js';
import type { CredentialStore } from './types.js';

export interface NativeProcessOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}
export interface NativeProcessResult { stdout: string; stderr?: string; exitCode: number }
export type NativeRunner = (executable: string, args: readonly string[], stdin: string, options: NativeProcessOptions) => Promise<NativeProcessResult>;

/** All streams are captured in-process. Errors never retain stdin/stdout/stderr. */
export const runNativeHelper: NativeRunner = async (executable, args, stdin, options) => new Promise((resolve, reject) => {
  let child;
  try { child = spawn(executable, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...options.env } }); }
  catch { reject(new IntraError('KEYCHAIN_UNAVAILABLE')); return; }
  const output: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  const fail = (): void => {
    if (failed) return;
    failed = true;
    child.kill('SIGKILL');
    reject(new IntraError('KEYCHAIN_UNAVAILABLE'));
  };
  const timer = setTimeout(fail, options.timeoutMs);
  timer.unref();
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.maxOutputBytes) fail();
    else output.push(chunk);
  });
  // Drain stderr, never relay it. Native/compiler diagnostics can contain sensitive data.
  child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxOutputBytes) fail(); });
  child.stdin.on('error', fail);
  child.on('error', fail);
  child.on('close', code => {
    clearTimeout(timer);
    if (!failed) resolve({ stdout: Buffer.concat(output).toString('utf8'), exitCode: code ?? -1 });
  });
  child.stdin.end(stdin, 'utf8');
});

function processOptions(timeoutMs: number): NativeProcessOptions {
  return { env: { PATH: '/usr/bin:/bin', HOME: homedir(), TMPDIR: tmpdir() }, timeoutMs, maxOutputBytes: 2 * 1024 * 1024 };
}

export interface KeychainHelperBuildOptions { home?: string; runner?: NativeRunner }
/** Explicit build only; compilation never executes the helper or touches Keychain. */
export async function buildKeychainHelper(options: KeychainHelperBuildOptions = {}): Promise<string> {
  if (process.platform !== 'darwin') throw new IntraError('KEYCHAIN_UNAVAILABLE', 'macOS Keychain requires macOS.');
  const home = options.home ?? join(homedir(), '.intra');
  const directory = join(home, 'credentials', 'native');
  await privateDirectory(home);
  await privateDirectory(join(home, 'credentials'));
  await privateDirectory(directory);
  let source = fileURLToPath(new URL('../native/keychain.m', import.meta.url));
  let content: Buffer;
  try { content = await readFile(source); }
  catch (error) {
    if (!isFsError(error, 'ENOENT')) throw new IntraError('KEYCHAIN_UNAVAILABLE');
    source = join(projectRoot, 'packages', 'credentials', 'native', 'keychain.m');
    try { content = await readFile(source); } catch { throw new IntraError('KEYCHAIN_UNAVAILABLE'); }
  }
  const digest = createHash('sha256').update('objc-arc-foundation-security-v1').update(content).update(process.arch).digest('hex').slice(0, 24);
  const binary = join(directory, `keychain-${digest}`);
  const runner = options.runner ?? runNativeHelper;
  return withFileLock(join(directory, 'locks'), digest, async () => {
    try {
      const stat = await lstat(binary);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || !(stat.mode & 0o100) || (process.getuid && stat.uid !== process.getuid())) throw new IntraError('KEYCHAIN_UNAVAILABLE');
      return binary;
    } catch (error) { if (!isFsError(error, 'ENOENT')) throw new IntraError('KEYCHAIN_UNAVAILABLE'); }
    const temporary = join(directory, `.build-${randomUUID()}`);
    try {
      const result = await runner('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security', '-O2', source, '-o', temporary], '', processOptions(120000));
      if (result.exitCode !== 0) throw new IntraError('KEYCHAIN_UNAVAILABLE');
      await chmod(temporary, 0o700);
      await rename(temporary, binary);
      return binary;
    } catch { throw new IntraError('KEYCHAIN_UNAVAILABLE', 'The native Keychain helper could not be built.'); }
    finally { await unlink(temporary).catch(() => undefined); }
  }, { timeoutMs: 30000 });
}

export interface MacKeychainOptions { helperPath?: string; home?: string; runner?: NativeRunner }
export class MacKeychainStore implements CredentialStore {
  #options: MacKeychainOptions;
  #helper: Promise<string> | undefined;
  constructor(options: MacKeychainOptions = {}) { this.#options = { ...options }; }

  async #request(op: 'get' | 'set' | 'delete', key: string, value?: string): Promise<string | null> {
    if (typeof key !== 'string' || !key || key.length > 1024 || /[\x00-\x1f\x7f]/.test(key) || (value !== undefined && typeof value !== 'string')) throw new IntraError('INVALID_ARGUMENT');
    if (process.platform !== 'darwin' && !this.#options.runner) throw new IntraError('KEYCHAIN_UNAVAILABLE', 'macOS Keychain requires macOS.');
    const stdin = JSON.stringify({ op, key, ...(value === undefined ? {} : { value }) });
    if (Buffer.byteLength(stdin) > 1024 * 1024) throw new IntraError('KEYCHAIN_UNAVAILABLE', 'The credential record exceeds the native helper limit.');
    try {
      const helper = this.#options.helperPath ?? await (this.#helper ??= buildKeychainHelper(this.#options));
      const result = await (this.#options.runner ?? runNativeHelper)(helper, [], stdin, processOptions(30000));
      if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) throw new Error();
      const response: unknown = JSON.parse(result.stdout);
      if (!isRecord(response) || response.ok !== true || Object.keys(response).some(field => !['ok', 'value'].includes(field))) throw new Error();
      if (op === 'get') {
        if (response.value !== null && typeof response.value !== 'string') throw new Error();
        return response.value;
      }
      if (response.value !== undefined) throw new Error();
      return null;
    } catch { throw new IntraError('KEYCHAIN_UNAVAILABLE', 'The macOS Keychain is unavailable.'); }
  }
  async get(key: string): Promise<string | null> { return this.#request('get', key); }
  async set(key: string, value: string): Promise<void> { await this.#request('set', key, value); }
  async delete(key: string): Promise<void> { await this.#request('delete', key); }
  toJSON(): object { return { type: 'MacKeychainStore' }; }
}
