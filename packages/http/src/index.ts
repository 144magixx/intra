import { randomUUID } from 'node:crypto';
import { lstat, open, link, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { IntraError, getPointer, type Service, type MaterializedRequest, type ResponseRules, type Artifact } from '../../contracts/src/index.js';
import { validateRequest } from '../../registry/src/index.js';

export interface HttpCredentials {
  cookieHeader(url: string): Promise<string>;
  acceptSetCookie(url: string, headers: string[]): Promise<void>;
}
export interface Exchange {
  status: number;
  json?: unknown;
  validJSON: boolean;
  bytes: number;
  format: 'json' | 'text' | 'binary';
  /** Private temporary body path; never expose as successful output before commit. */
  bodyPath?: string;
  elapsedMs: number;
  finalOrigin?: string;
}
export class HttpFailure extends IntraError {
  artifact?: Artifact;
  finalOrigin?: string;
  constructor(code: string, artifact?: Artifact, finalOrigin?: string) { super(code); this.artifact = artifact; this.finalOrigin = finalOrigin; }
}
const ownedBodies = new Set<string>();
const redirects = new Set([301, 302, 303, 307, 308]);

export async function checkOutput(target: string): Promise<void> {
  try { await lstat(path.resolve(target)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new IntraError('OUTPUT_ERROR');
  }
  throw new IntraError('OUTPUT_EXISTS');
}
async function removeOwned(target: string): Promise<void> {
  const resolved = path.resolve(target);
  if (!ownedBodies.has(resolved)) throw new IntraError('OUTPUT_ERROR');
  await unlink(resolved);
  ownedBodies.delete(resolved);
}
export async function discard(exchange: Exchange): Promise<void> {
  if (exchange.bodyPath) await removeOwned(exchange.bodyPath);
}
export async function persist(exchange: Exchange, target: string): Promise<Artifact> {
  if (!exchange.bodyPath || !ownedBodies.has(path.resolve(exchange.bodyPath))) throw new IntraError('OUTPUT_ERROR');
  try {
    // Hard linking commits atomically and never replaces a pre-existing destination.
    await link(exchange.bodyPath, path.resolve(target));
    await removeOwned(exchange.bodyPath);
    return { path: path.resolve(target), format: exchange.format, bytes: exchange.bytes, complete: true };
  } catch (error) {
    throw new HttpFailure((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_ERROR', {
      path: exchange.bodyPath, format: exchange.format, bytes: exchange.bytes, complete: true,
    });
  }
}
function isLoginRedirect(service: Service, current: URL, location: string): boolean {
  let url: URL;
  try { url = new URL(location, current); } catch { return false; }
  return (service.auth.authFailureRules ?? []).some(rule => rule.kind === 'loginRedirect'
    && rule.origin === url.origin && typeof rule.pathPrefix === 'string' && url.pathname.startsWith(rule.pathPrefix));
}

export async function executeHttp(options: {
  service: Service; request: MaterializedRequest; semantics: 'read' | 'write' | 'unknown';
  credentials: HttpCredentials; output?: string; timeoutMs?: number; maxBytes?: number;
}): Promise<Exchange> {
  const { service, semantics, credentials, output } = options;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new IntraError('INVALID_ARGUMENT');
  let request = structuredClone(options.request);
  let url = validateRequest(service, request);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let bodyPath: string | undefined;
  let bytes = 0;
  let sent = false;
  let phase: 'network' | 'output' = 'network';
  let bodyComplete = false;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    if (output) {
      await checkOutput(output);
      bodyPath = path.resolve(`${output}.intra-${randomUUID()}.partial`);
      phase = 'output';
      file = await open(bodyPath, 'wx', 0o600);
      ownedBodies.add(bodyPath);
    }
    phase = 'network';
    let response: Response | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      if (controller.signal.aborted) throw new IntraError('REQUEST_TIMEOUT');
      const headers = new Headers(request.headers);
      // Every hop asks the scoped jar again; never reuse the prior credential header.
      const cookie = await credentials.cookieHeader(url.href);
      if (cookie) headers.set('cookie', cookie);
      if (request.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
      sent = true;
      response = await fetch(url, {
        method: request.method, headers,
        body: request.rawBody !== undefined ? request.rawBody : request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'manual', signal: controller.signal,
      });
      await credentials.acceptSetCookie(url.href, response.headers.getSetCookie());
      if (!redirects.has(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new IntraError('RESPONSE_SCHEMA_MISMATCH');
      if (isLoginRedirect(service, url, location)) throw new IntraError('AUTH_EXPIRED');
      if (semantics !== 'read') throw new IntraError('REQUEST_OUTCOME_UNKNOWN');
      if (hop === 5) throw new IntraError('RESPONSE_SCHEMA_MISMATCH');
      const next = new URL(location, url);
      if (next.username || next.password || next.hash) throw new IntraError('CONTRACT_INVALID');
      if (next.origin !== url.origin) {
        // Only non-sensitive representation headers survive crossing an origin.
        request.headers = Object.fromEntries(Object.entries(request.headers ?? {})
          .filter(([name]) => /^(accept|accept-language|content-type)$/i.test(name)));
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === 'POST')) {
        request.method = request.method === 'HEAD' ? 'HEAD' : 'GET';
        delete request.body;
        delete request.rawBody;
        for (const key of Object.keys(request.headers ?? {})) if (/^content-/i.test(key)) delete request.headers![key];
      }
      // Validate the actual redirect target independently from the original request base URL.
      validateRequest({ ...service, baseUrl: next.origin }, { ...request, path: `${next.pathname}${next.search}`, query: undefined, url: undefined });
      url = next;
    }
    if (!response) throw new IntraError('NETWORK_UNREACHABLE');
    const memory: Buffer[] = [];
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        const remaining = maxBytes - bytes;
        const accepted = buffer.subarray(0, remaining);
        if (accepted.length) {
          if (file) {
            phase = 'output';
            // FileHandle.writeFile appends at the current handle offset, handling short writes.
            await file.writeFile(accepted);
            phase = 'network';
          } else memory.push(accepted);
          bytes += accepted.length;
        }
        if (buffer.length > remaining) {
          controller.abort();
          throw new IntraError('RESPONSE_TOO_LARGE');
        }
      }
    }
    bodyComplete = true;
    phase = 'output';
    if (file) { await file.sync(); await file.close(); file = undefined; }
    const data = bodyPath ? await readFile(bodyPath) : Buffer.concat(memory);
    let json: unknown;
    let validJSON = false;
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); validJSON = true; } catch { /* classified without reflecting response */ }
    const format = validJSON ? 'json' : response.headers.get('content-type')?.startsWith('text/') ? 'text' : 'binary';
    return { status: response.status, json, validJSON, bytes, bodyPath, format, elapsedMs: performance.now() - started, finalOrigin: url.origin };
  } catch (error) {
    if (file) { try { await file.close(); } catch { /* retain partial file */ } }
    let code = error instanceof IntraError ? error.code : phase === 'output' ? 'OUTPUT_ERROR'
      : controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_UNREACHABLE';
    if (sent && semantics !== 'read' && ['REQUEST_TIMEOUT', 'NETWORK_UNREACHABLE'].includes(code)) code = 'REQUEST_OUTCOME_UNKNOWN';
    if (bodyPath && ownedBodies.has(bodyPath)) {
      if (bytes === 0) { try { await removeOwned(bodyPath); bodyPath = undefined; } catch { /* report retained partial */ } }
    }
    if (bodyPath && !ownedBodies.has(bodyPath)) bodyPath = undefined;
    throw new HttpFailure(code, bodyPath ? { path: bodyPath, format: 'binary', bytes, complete: bodyComplete } : undefined, url.origin);
  } finally { clearTimeout(timer); }
}

export interface Classification {
  kind: 'success' | 'authExpired' | 'ambiguous' | 'businessError' | 'schemaMismatch';
  summary: { count?: number; total?: number; identity?: string };
  businessCode?: string | number;
}
export function classify(exchange: Exchange, rules: ResponseRules | undefined, service: Service, probe = false): Classification {
  const result = (kind: Classification['kind']): Classification => ({ kind, summary: {} });
  for (const rule of service.auth.authFailureRules ?? []) {
    if ((rule.kind === 'businessCode' || (probe && rule.kind === 'probeFailure')) && rule.pointer !== undefined
      && exchange.validJSON && Object.hasOwn(rule, 'equals') && Object.is(getPointer(exchange.json, rule.pointer), rule.equals)) return result('authExpired');
  }
  if (exchange.status === 401 || exchange.status === 403) return result('ambiguous');
  // A raw call has no business-success contract; never present transport success as business success.
  if (!rules) return result(exchange.status >= 200 && exchange.status < 300 ? 'success' : 'businessError');
  if (!exchange.validJSON && (rules.success.code || rules.itemsPointer || rules.totalPointer || rules.identityPointer)) return result('schemaMismatch');
  if (!rules.success.httpStatuses.includes(exchange.status)) return result('businessError');
  const classified = result('success');
  if (rules.success.code) {
    const code = getPointer(exchange.json, rules.success.code.pointer);
    if (code === undefined) return result('schemaMismatch');
    if (!Object.is(code, rules.success.code.equals)) return result('businessError');
    // Only the contract's expected value can be exposed, not an arbitrary returned secret.
    if (typeof code === 'string' || typeof code === 'number') classified.businessCode = code;
  }
  if (rules.itemsPointer !== undefined) {
    const items = getPointer(exchange.json, rules.itemsPointer);
    if (!Array.isArray(items)) return result('schemaMismatch');
    classified.summary.count = items.length;
  }
  if (rules.totalPointer !== undefined) {
    const total = getPointer(exchange.json, rules.totalPointer);
    if (!Number.isSafeInteger(total) || (total as number) < 0) return result('schemaMismatch');
    classified.summary.total = total as number;
  }
  if (rules.identityPointer !== undefined) {
    const identity = getPointer(exchange.json, rules.identityPointer);
    if (typeof identity !== 'string' || !identity.trim() || identity.length > 256 || /[\r\n\0]/.test(identity)) return result('schemaMismatch');
    classified.summary.identity = identity;
  }
  return classified;
}
