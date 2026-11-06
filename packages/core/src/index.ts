import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { IntraError, safeError, type Service, type Operation, type MaterializedRequest, type ToolResult, type SnapshotParams, type CookieSnapshot } from '../../contracts/src/index.js';
import { Registry, materialize, validateRequest } from '../../registry/src/index.js';
import { type Credentials, type CredentialSession } from '../../credentials/src/index.js';
import { executeHttp, classify, persist, discard, HttpFailure, type Exchange, type Classification } from '../../http/src/index.js';

export interface Bridge {
  listProfiles(): Promise<Array<{ profileId: string; storeIds: string[]; extensionId: string; confirmed: boolean }>>;
  getConnection(profileId: string): Promise<{ profileId: string; storeIds: string[]; extensionId: string; confirmed: boolean }>;
  snapshot(params: SnapshotParams): Promise<CookieSnapshot>;
}
export interface CallOptions {
  profile: string; output?: string; timeoutMs?: number; maxBytes?: number;
}
export function success(data: unknown, requestId = randomUUID()): ToolResult {
  return { schemaVersion: 1, requestId, ok: true, data, meta: {} };
}
export function failure(error: unknown, requestId = randomUUID()): ToolResult {
  const safe = safeError(error);
  return { schemaVersion: 1, requestId, ok: false, meta: {}, error: {
    code: safe.code, message: safe.message, retryable: safe.retryable,
    ...(safe.action ? { action: safe.action } : {}),
  } };
}

export type DirectRequest = Omit<MaterializedRequest, 'path' | 'url'>;

/** Build a transport context from an explicit URL; no API discovery or business inference. */
export function directServiceForURL(input: string): { service: Service; url: URL } {
  let url: URL;
  try {
    if (typeof input !== 'string' || !/^https?:\/\//i.test(input) || /[\\\x00-\x20\x7f]/.test(input)) throw new Error();
    url = new URL(input);
  } catch { throw new IntraError('INVALID_ARGUMENT'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || input.includes('#') || !url.hostname
    || url.hostname.startsWith('.') || url.hostname.includes('..') || url.hostname.endsWith('.')) throw new IntraError('INVALID_ARGUMENT');
  const service: Service = {
    schemaVersion: 1,
    id: `direct-${createHash('sha256').update(url.origin).digest('hex').slice(0, 32)}`,
    baseUrl: url.origin,
    allowedOrigins: [url.origin],
    auth: {},
    ...(url.protocol === 'http:' ? { protocolExceptions: [{ origin: url.origin, reason: 'Explicit user-supplied raw HTTP URL; Secure cookies remain prohibited.' }] } : {}),
  };
  return { service, url };
}

export class Core {
  constructor(readonly dependencies: { registry: Registry; credentials: Credentials; bridge: Bridge; home: string }) {}

  async requestURL(input: string, request: DirectRequest, options: CallOptions): Promise<ToolResult> {
    try {
      const { service, url } = directServiceForURL(input);
      const materialized: MaterializedRequest = { ...request, path: `${url.pathname}${url.search}` };
      validateRequest(service, materialized);
      return await this.execute(service, materialized, undefined, options);
    } catch (error) { return failure(error); }
  }

  async pairProfile(alias: string, profileId: string, storeId?: string): Promise<ToolResult> {
    const connection = await this.dependencies.bridge.getConnection(profileId);
    if (!connection.confirmed) throw new IntraError('PROFILE_NOT_PAIRED');
    if (!storeId && connection.storeIds.length !== 1) throw new IntraError('PROFILE_AMBIGUOUS');
    const chosenStore = storeId ?? connection.storeIds[0];
    if (!chosenStore || !connection.storeIds.includes(chosenStore)) throw new IntraError('PROFILE_NOT_PAIRED');
    const profile = await this.dependencies.credentials.pair({ alias, profileId, storeId: chosenStore, extensionId: connection.extensionId });
    return success({ profile, status: 'paired', accountStatus: 'unverified' });
  }

  private async probe(service: Service, session: CredentialSession, timeoutMs?: number): Promise<Classification> {
    if (!service.auth.identityProbeOperation) return { kind: 'ambiguous', summary: {} };
    const operation = await this.dependencies.registry.getOperation(service.auth.identityProbeOperation);
    if (operation.service !== service.id || operation.status !== 'verified' || operation.semantics !== 'read' || !operation.response.identityPointer) throw new IntraError('CONTRACT_INVALID');
    const request = materialize(service, operation, {});
    try {
      const exchange = await executeHttp({ service, request, semantics: 'read', credentials: session, timeoutMs, maxBytes: 1024 * 1024 });
      const result = classify(exchange, operation.response, service, true);
      if (result.kind === 'success' && session.metadata.accountId && session.metadata.accountId !== result.summary.identity) throw new IntraError('ACCOUNT_MISMATCH');
      return result;
    } catch (error) {
      if (error instanceof IntraError && error.code === 'AUTH_EXPIRED') return { kind: 'authExpired', summary: {} };
      if (error instanceof IntraError && error.code === 'COOKIE_NOT_FOUND') return { kind: 'ambiguous', summary: {} };
      throw error;
    }
  }

  private async sync(profileAlias: string, service: Service, requestedURL?: string, timeoutMs?: number): Promise<CredentialSession> {
    const { credentials, registry, bridge } = this.dependencies;
    const profile = await credentials.profile(profileAlias);
    const connection = await bridge.getConnection(profile.profileId);
    if (!connection.confirmed || connection.extensionId !== profile.extensionId || !connection.storeIds.includes(profile.storeId)) throw new IntraError('PROFILE_NOT_PAIRED');
    let probeURL: string | undefined;
    if (service.auth.identityProbeOperation) {
      const operation = await registry.getOperation(service.auth.identityProbeOperation);
      if (operation.service !== service.id || operation.status !== 'verified' || operation.semantics !== 'read' || !operation.response.identityPointer) throw new IntraError('CONTRACT_INVALID');
      probeURL = validateRequest(service, materialize(service, operation, {})).href;
    }
    const url = requestedURL ?? probeURL ?? service.baseUrl + '/';
    const readSnapshot = (targetURL: string) => bridge.snapshot({ profileId: profile.profileId, storeId: profile.storeId, url: targetURL,
      ...(service.auth.cookieNames === undefined ? {} : { cookieNames: service.auth.cookieNames }),
      deadlineMs: Math.min(timeoutMs ?? 30_000, 30_000) });
    const snapshot = await readSnapshot(url);
    let preview = await credentials.previewSnapshot(profileAlias, service, snapshot, url);
    let accountId: string | undefined;
    if (probeURL) {
      if (service.auth.cookieNames === undefined && new URL(probeURL).pathname !== new URL(url).pathname) {
        preview = await credentials.previewSnapshot(profileAlias, service, await readSnapshot(probeURL), probeURL);
      }
      const identity = await this.probe(service, preview, timeoutMs);
      if (identity.kind !== 'success' || !identity.summary.identity) throw new IntraError(identity.kind === 'authExpired' ? 'LOGIN_REQUIRED' : 'AUTH_STATE_UNDETERMINED');
      accountId = identity.summary.identity;
    }
    return credentials.saveSnapshot(profileAlias, service, snapshot, accountId, url);
  }

  async authSync(serviceId: string, profile: string): Promise<ToolResult> {
    const service = await this.dependencies.registry.getService(serviceId);
    const session = await this.dependencies.credentials.withRefreshLock(profile, service, () => this.sync(profile, service));
    return success({ profileId: session.metadata.profileId, cookieNames: session.metadata.cookieNames,
      accountVerified: session.metadata.accountVerified, status: 'last-observed', source: 'browser' });
  }
  async authCheck(serviceId: string, profile: string): Promise<ToolResult> {
    const service = await this.dependencies.registry.getService(serviceId);
    if (!service.auth.identityProbeOperation) return success({ status: 'UNKNOWN', reason: 'No identity probe is configured' });
    const operation = await this.dependencies.registry.getOperation(service.auth.identityProbeOperation);
    const request = materialize(service, operation, {});
    const session = await this.dependencies.credentials.resolve(profile, service, validateRequest(service, request).href);
    const result = await this.probe(service, session);
    if (result.kind !== 'success') throw new IntraError(result.kind === 'authExpired' ? 'LOGIN_REQUIRED' : 'AUTH_STATE_UNDETERMINED');
    return success({ status: 'authenticated', identity: result.summary.identity, profileId: session.metadata.profileId });
  }
  async call(operationId: string, args: unknown, options: CallOptions): Promise<ToolResult> {
    try {
      const { service, operation, request } = await this.dependencies.registry.resolve(operationId, args);
      return await this.execute(service, request, operation, options);
    } catch (error) { return failure(error); }
  }
  async request(serviceId: string, request: MaterializedRequest, options: CallOptions): Promise<ToolResult> {
    try {
      const service = await this.dependencies.registry.getService(serviceId);
      validateRequest(service, request);
      return await this.execute(service, request, undefined, options);
    } catch (error) { return failure(error); }
  }

  private async execute(service: Service, request: MaterializedRequest, operation: Operation | undefined, options: CallOptions): Promise<ToolResult> {
    const started = performance.now();
    const requestId = randomUUID();
    const timings = { credential: 0, http: 0, output: 0, total: 0 };
    const meta: ToolResult['meta'] = { serviceId: service.id, ...(operation ? { operationId: operation.id } : {}), authRefreshed: false, timingMs: timings };
    const semantics = operation?.semantics ?? 'unknown';
    let exchange: Exchange | undefined;
    const { credentials, home } = this.dependencies;
    let target = options.output;
    try {
      if (!target) {
        const directory = path.join(home, 'outputs');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        target = path.join(directory, `${requestId}.json`);
      }
      const url = validateRequest(service, request).href;
      let credentialStarted = performance.now();
      let session: CredentialSession;
      let refreshed = false;
      try { session = await credentials.resolve(options.profile, service, url); }
      catch (error) {
        if (!(error instanceof IntraError) || error.code !== 'COOKIE_NOT_FOUND') throw error;
        session = await credentials.withRefreshLock(options.profile, service, async () => {
          try { return await credentials.resolve(options.profile, service, url); }
          catch (inner) { if (!(inner instanceof IntraError) || inner.code !== 'COOKIE_NOT_FOUND') throw inner; }
          return this.sync(options.profile, service, url, options.timeoutMs);
        });
        refreshed = true;
        meta.authRefreshed = true;
      }
      timings.credential += performance.now() - credentialStarted;
      meta.profileId = session.metadata.profileId;
      for (let attempt = 0; attempt < 2; attempt++) {
        // HTTP may update the session jar; compare refreshes with the cache generation
        // from before the attempt, not a Set-Cookie mutation on an error response.
        const requestGeneration = session.generation;
        const sessionKey = (targetURL: string) => {
          const target = new URL(targetURL);
          return service.auth.cookieNames === undefined ? JSON.stringify([target.origin, target.pathname]) : target.origin;
        };
        const sessions = new Map<string, CredentialSession>([[sessionKey(url), session]]);
        const forURL = async (targetURL: string): Promise<CredentialSession> => {
          const key = sessionKey(targetURL);
          let selected = sessions.get(key);
          if (!selected) {
            selected = await credentials.resolve(options.profile, service, targetURL);
            if (session.metadata.accountId && selected.metadata.accountId !== session.metadata.accountId) throw new IntraError('ACCOUNT_MISMATCH');
            sessions.set(key, selected);
          }
          return selected;
        };
        const provider = {
          async cookieHeader(targetURL: string) { return (await forURL(targetURL)).cookieHeader(targetURL); },
          async acceptSetCookie(targetURL: string, headers: string[]) { return (await forURL(targetURL)).acceptSetCookie(targetURL, headers); },
        };
        let classification: Classification;
        let authOrigin = service.baseUrl;
        const httpStarted = performance.now();
        try {
          exchange = await executeHttp({ service, request, semantics, credentials: provider, output: target,
            timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
          timings.http += performance.now() - httpStarted;
          meta.httpStatus = exchange.status;
          authOrigin = exchange.finalOrigin ?? service.baseUrl;
          classification = classify(exchange, operation?.response, service);
        } catch (error) {
          timings.http += performance.now() - httpStarted;
          if (!(error instanceof IntraError) || error.code !== 'AUTH_EXPIRED') throw error;
          authOrigin = error instanceof HttpFailure ? error.finalOrigin ?? service.baseUrl : service.baseUrl;
          classification = { kind: 'authExpired', summary: {} };
        }
        if (authOrigin !== service.baseUrl && (classification.kind === 'ambiguous' || classification.kind === 'authExpired')) {
          // A's identity probe cannot establish B's account state after a redirect.
          throw new IntraError('AUTH_STATE_UNDETERMINED');
        }
        if (classification.kind === 'ambiguous') {
          // Do not recurse if the failing operation is itself the identity probe.
          if (!operation || operation.id !== service.auth.identityProbeOperation) {
            const probe = await this.probe(service, session, options.timeoutMs);
            if (probe.kind === 'success') throw new IntraError('FORBIDDEN');
            if (probe.kind === 'authExpired') classification = probe;
          }
          if (classification.kind === 'ambiguous') throw new IntraError('AUTH_STATE_UNDETERMINED');
        }
        if (classification.kind === 'authExpired') {
          if (semantics !== 'read' || refreshed || attempt !== 0) throw new IntraError('LOGIN_REQUIRED');
          credentialStarted = performance.now();
          const previousGeneration = requestGeneration;
          const next = await credentials.withRefreshLock(options.profile, service, async () => {
            const latest = await credentials.resolve(options.profile, service, url);
            if (latest.generation !== previousGeneration) return latest;
            return this.sync(options.profile, service, url, options.timeoutMs);
          });
          timings.credential += performance.now() - credentialStarted;
          if (next.generation === previousGeneration) throw new IntraError('LOGIN_REQUIRED');
          session = next;
          refreshed = true;
          meta.authRefreshed = true;
          if (exchange) { await discard(exchange); exchange = undefined; }
          continue;
        }
        if (classification.kind === 'schemaMismatch') throw new IntraError('RESPONSE_SCHEMA_MISMATCH');
        if (classification.kind === 'businessError') throw new IntraError('BUSINESS_ERROR');
        if (classification.summary.identity && session.metadata.accountId && classification.summary.identity !== session.metadata.accountId) throw new IntraError('ACCOUNT_MISMATCH');
        const outputStarted = performance.now();
        const artifact = await persist(exchange!, target);
        exchange = undefined;
        timings.output += performance.now() - outputStarted;
        if (classification.businessCode !== undefined) meta.businessCode = classification.businessCode;
        timings.total = performance.now() - started;
        return { schemaVersion: 1, requestId, ok: true, meta, artifact,
          data: operation ? classification.summary : { status: 'received', businessSuccess: 'unknown' } };
      }
      throw new IntraError('LOGIN_REQUIRED');
    } catch (error) {
      const result = failure(error, requestId);
      result.meta = meta;
      if (error instanceof HttpFailure && error.artifact) result.artifact = error.artifact;
      if (exchange && target) {
        try { result.artifact = await persist(exchange, target); }
        catch (outputError) { if (outputError instanceof HttpFailure && outputError.artifact) result.artifact = outputError.artifact; }
      }
      timings.total = performance.now() - started;
      return result;
    }
  }
}
