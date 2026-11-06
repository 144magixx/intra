import { EventEmitter } from 'node:events';
import { homedir, endianness } from 'node:os';
import { resolve, join } from 'node:path';
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { domainMatch, pathMatch } from 'tough-cookie';
import { validate, IntraError } from '../../../packages/contracts/src/index.js';

export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_PENDING = 32;
export const EXTENSION_ID = /^[a-p]{32}$/;
export const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}(?![\s\S])/;
/** The extension enforces selected scopes and Chrome grants; the host validates URLs. */
export function isAllowedCookieURL(url: URL): boolean {
  const hostname = url.hostname;
  const ip = isIP(hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname);
  const dns = hostname.length <= 253 && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  return ['https:', 'http:'].includes(url.protocol)
    && !url.username && !url.password && !url.href.includes('#') && (ip !== 0 || dns);
}
export interface SnapshotParams { profileId: string; storeId: string; url: string; cookieNames?: string[]; deadlineMs: number }
export interface BridgeCookie { name: string; value: string; domain: string; path: string; hostOnly: boolean; secure: boolean; httpOnly: boolean; sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified'; session: boolean; expirationDate?: number; storeId: string; partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean } }
export interface Snapshot { profileId: string; storeId: string; snapshotId: string; observedAt: string; cookies: BridgeCookie[] }
export interface Hello { profileId: string; extensionVersion: string; protocolVersions: number[]; storeIds: string[] }
export interface BridgeProfile { profileId: string; storeIds: string[]; extensionId: string; extensionVersion: string; protocolVersion: 1; connectionId: string; socketPath: string; confirmed: true }
export interface Message { schemaVersion: 1; requestId: string; type: 'request' | 'response' | 'event'; method?: string; params?: unknown; ok?: boolean; result?: unknown; error?: { code: string; message: string; retryable: boolean } }

export function fail(code: string, message: string): IntraError { return new IntraError(code, message); }
export function checked<T>(kind: 'ipc' | 'snapshot' | 'snapshotParams' | 'hello', value: unknown): T { validate(kind, value); return value as T; }
const BRIDGE_ERRORS = new Set(['FORBIDDEN', 'PROFILE_NOT_PAIRED', 'PROFILE_AMBIGUOUS', 'BRIDGE_UNAVAILABLE', 'COOKIE_NOT_FOUND', 'CONTRACT_INVALID', 'PROTOCOL_MISMATCH', 'REQUEST_TIMEOUT', 'RESPONSE_TOO_LARGE', 'PARTITIONED_COOKIE_UNSUPPORTED']);
export function safeErrorCode(code: unknown): string { return typeof code === 'string' && BRIDGE_ERRORS.has(code) ? code : 'BRIDGE_UNAVAILABLE'; }
export function errorMessage(requestId: string, error: unknown): Message {
  const code = safeErrorCode(error instanceof IntraError ? error.code : undefined);
  return { schemaVersion: 1, requestId, type: 'response', ok: false, error: { code, message: `Browser bridge request failed (${code})`, retryable: false } };
}
export function response(requestId: string, result: unknown): Message { return { schemaVersion: 1, requestId, type: 'response', ok: true, result }; }
export function request(requestId: string, method: string, params: unknown): Message { return { schemaVersion: 1, requestId, type: 'request', method, params }; }
export function validateExtensionOrigin(argv: string[], expectedId: string): string {
  if (!EXTENSION_ID.test(expectedId) || argv.length !== 1 || argv[0] !== `chrome-extension://${expectedId}/`) throw fail('FORBIDDEN', 'Native host requires the configured Chrome extension origin argument');
  return expectedId;
}
export function validateSnapshotParams(value: unknown, profile?: Pick<BridgeProfile, 'profileId' | 'storeIds'>): SnapshotParams {
  const params = checked<SnapshotParams>('snapshotParams', value);
  let url: URL;
  try { url = new URL(params.url); } catch { throw fail('INVALID_ARGUMENT', 'Invalid snapshot URL'); }
  if (!isAllowedCookieURL(url)) throw fail('FORBIDDEN', 'Snapshot requires a valid HTTP or HTTPS URL without userinfo or fragment');
  if (params.cookieNames !== undefined && (!Array.isArray(params.cookieNames) || !params.cookieNames.length || params.cookieNames.length > 16
    || new Set(params.cookieNames).size !== params.cookieNames.length || params.cookieNames.some(name => typeof name !== 'string' || !COOKIE_NAME.test(name)))) {
    throw fail('CONTRACT_INVALID', 'Snapshot cookie names must be unique nonempty tokens');
  }
  if (profile && (params.profileId !== profile.profileId || !profile.storeIds.includes(params.storeId))) throw fail('PROFILE_NOT_PAIRED', 'Snapshot profile or store is not paired');
  return params;
}
export function validateSnapshot(value: unknown, params: SnapshotParams): Snapshot {
  const snapshot = checked<Snapshot>('snapshot', value);
  if (snapshot.profileId !== params.profileId || snapshot.storeId !== params.storeId || !Number.isFinite(Date.parse(snapshot.observedAt))) throw fail('CONTRACT_INVALID', 'Snapshot does not match requested profile and store');
  const url = new URL(params.url);
  const keys = new Set<string>();
  for (const cookie of snapshot.cookies) {
    if (cookie.partitionKey !== undefined) throw fail('PARTITIONED_COOKIE_UNSUPPORTED', 'Partitioned cookies are not supported');
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    const key = JSON.stringify([cookie.name, domain, cookie.path]);
    if (cookie.storeId !== params.storeId || (params.cookieNames !== undefined && !params.cookieNames.includes(cookie.name)) || /[\x00-\x20\x7f;=]/.test(cookie.name) || /[\x00-\x1f\x7f;]/.test(cookie.value) || !domain || (cookie.hostOnly ? url.hostname.toLowerCase() !== domain : !domainMatch(url.hostname, domain)) || !cookie.path.startsWith('/') || !pathMatch(url.pathname, cookie.path) || (cookie.secure && url.protocol !== 'https:') || (cookie.expirationDate !== undefined && (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= Date.now() / 1000)) || keys.has(key)) throw fail('CONTRACT_INVALID', 'Snapshot cookie does not match requested URL, names or store');
    keys.add(key);
  }
  return snapshot;
}
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (!body.length || body.length > MAX_FRAME_BYTES) throw fail('RESPONSE_TOO_LARGE', 'Native message exceeds 256 KiB');
  const prefix = Buffer.allocUnsafe(4);
  if (endianness() === 'LE') prefix.writeUInt32LE(body.length); else prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerSize = 0;
  private body: Buffer | undefined;
  private bodySize = 0;
  private failed = false;
  constructor(private readonly onMessage: (value: unknown) => void, private readonly onError: (error: unknown) => void) {}
  push(chunk: Buffer): void {
    if (this.failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.headerSize, chunk.length - offset);
          chunk.copy(this.header, this.headerSize, offset, offset + count);
          offset += count; this.headerSize += count;
          if (this.headerSize < 4) continue;
          const length = endianness() === 'LE' ? this.header.readUInt32LE() : this.header.readUInt32BE();
          if (length < 1 || length > MAX_FRAME_BYTES) throw fail('CONTRACT_INVALID', 'Invalid native message length');
          this.body = Buffer.allocUnsafe(length); this.bodySize = 0;
        }
        const count = Math.min(this.body.length - this.bodySize, chunk.length - offset);
        chunk.copy(this.body, this.bodySize, offset, offset + count);
        offset += count; this.bodySize += count;
        if (this.bodySize === this.body.length) {
          const body = this.body;
          this.body = undefined; this.headerSize = 0; this.bodySize = 0;
          this.onMessage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
          if (this.failed) return;
        }
      }
    } catch (error) { this.failed = true; this.onError(error); }
  }
  end(): void { if (!this.failed && (this.headerSize || this.body)) { this.failed = true; this.onError(fail('CONTRACT_INVALID', 'Truncated native message')); } }
}
export class FramedPeer extends EventEmitter {
  private ended = false;
  private decoder: FrameDecoder;
  constructor(readonly input: Readable, readonly output: Writable) {
    super();
    this.decoder = new FrameDecoder(value => this.emit('message', value), error => this.close(error));
    input.on('data', this.onData); input.on('end', this.onEnd); input.on('close', this.onClose); input.on('error', this.onError);
    if (output !== input as unknown) output.on('error', this.onError);
  }
  private onData = (chunk: Buffer) => this.decoder.push(chunk);
  private onEnd = () => { this.decoder.end(); this.close(); };
  private onClose = () => this.close();
  private onError = () => this.close(fail('BRIDGE_UNAVAILABLE', 'Bridge transport disconnected'));
  send(value: unknown): void {
    if (this.ended || this.output.destroyed || this.output.writableLength > MAX_FRAME_BYTES * 2) throw fail('BRIDGE_UNAVAILABLE', 'Bridge transport unavailable');
    this.output.write(encodeFrame(value));
  }
  close(error?: unknown): void { if (this.ended) return; this.ended = true; this.input.off('data', this.onData); this.emit('closed', error); }
}
export function bridgeHome(home?: string): string { return resolve(home ?? process.env.INTRA_HOME ?? join(homedir(), '.intra')); }
export function runtimeDirectory(home?: string): string { return join(bridgeHome(home), 'run'); }
export async function assertPrivate(path: string, kind: 'directory' | 'file' | 'socket'): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : kind === 'socket' ? !stat.isSocket() : !stat.isFile()) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw fail('FORBIDDEN', 'Bridge runtime path must be private and owned by the current user');
}
export async function prepareRuntime(home?: string): Promise<string> {
  const base = bridgeHome(home);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await assertPrivate(base, 'directory');
  const run = join(await realpath(base), 'run');
  await mkdir(run, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await assertPrivate(run, 'directory');
  return run;
}
export async function socketAlive(path: string, timeoutMs = 150): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    const finish = (alive: boolean) => { clearTimeout(timer); socket.destroy(); resolve(alive); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
export async function discoverProfiles(home?: string, extensionId?: string, deadlineAt = Date.now() + 2000): Promise<BridgeProfile[]> {
  const base = bridgeHome(home);
  try { await assertPrivate(base, 'directory'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const run = join(await realpath(base), 'run');
  try { await assertPrivate(run, 'directory'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const entries = await readdir(run);
  if (entries.length > 512) throw fail('BRIDGE_UNAVAILABLE', 'Too many bridge runtime entries');
  const profiles: BridgeProfile[] = [];
  for (const name of entries) {
    if (Date.now() >= deadlineAt) throw fail('REQUEST_TIMEOUT', 'Bridge discovery deadline exceeded');
    if (!/^b-[0-9a-f]{12}\.json$/.test(name)) continue;
    const path = join(run, name);
    try {
      await assertPrivate(path, 'file');
      if ((await lstat(path)).size > 16_384) continue;
      const value = JSON.parse(await readFile(path, 'utf8')) as BridgeProfile;
      if (!value || !PROFILE_ID.test(value.profileId) || !PROFILE_ID.test(value.connectionId) || !EXTENSION_ID.test(value.extensionId) || value.protocolVersion !== 1 || value.confirmed !== true || typeof value.extensionVersion !== 'string' || !Array.isArray(value.storeIds) || !value.storeIds.length || value.storeIds.length > 16 || value.storeIds.some(id => typeof id !== 'string' || !id) || value.socketPath !== join(run, name.replace(/\.json$/, '.sock')) || (extensionId !== undefined && value.extensionId !== extensionId)) continue;
      await assertPrivate(value.socketPath, 'socket');
      if (await socketAlive(value.socketPath, Math.max(1, Math.min(150, deadlineAt - Date.now())))) profiles.push(value);
    } catch (error) { if (error instanceof IntraError) throw error; }
  }
  return profiles;
}
