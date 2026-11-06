import { createHash, randomUUID } from 'node:crypto';
import { Cookie, CookieJar, canonicalDomain, domainMatch, pathMatch } from 'tough-cookie';
import { IntraError, validate, cloneJson } from '../../contracts/src/index.js';
import type { CredentialMetadata, CredentialService, CredentialSession, Profile, SnapshotResult } from './types.js';

const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 6265 §4.1.1: cookie-value = *cookie-octet / ( DQUOTE *cookie-octet DQUOTE )
const validCookieValue = /^(?:[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*|"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*")$/;

export function serviceURL(service: CredentialService, input: string): URL {
  validate('service', service);
  let url: URL;
  try { url = new URL(input); } catch { throw new IntraError('INVALID_ARGUMENT'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || !service.allowedOrigins.includes(url.origin)) {
    throw new IntraError('INVALID_ARGUMENT', 'The credential target URL is not allowed by this service.');
  }
  if (url.protocol === 'http:' && !service.protocolExceptions?.some(exception => exception.origin === url.origin && exception.reason.trim())) {
    throw new IntraError('INVALID_ARGUMENT', 'HTTP credentials require an explicit origin exception.');
  }
  if (service.auth.cookieNames?.some(name => !cookieNamePattern.test(name))) throw new IntraError('CONTRACT_INVALID');
  return url;
}

function newJar(): CookieJar {
  return new CookieJar(undefined, { rejectPublicSuffixes: true, looseMode: false, prefixSecurity: 'strict', allowSecureOnLocal: false });
}

async function fingerprint(jar: CookieJar, scope: string): Promise<string> {
  const serialized = await jar.serialize();
  const cookies = serialized.cookies.map(cookie => ({
    key: cookie.key, value: cookie.value, domain: cookie.domain, path: cookie.path,
    hostOnly: cookie.hostOnly, secure: cookie.secure, httpOnly: cookie.httpOnly,
    expires: cookie.expires, maxAge: cookie.maxAge, sameSite: cookie.sameSite,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash('sha256').update(JSON.stringify({ scope, cookies })).digest('hex');
}

/** A session owns its jar. No process-wide credentialRef lookup is provided. */
class ScopedSession implements CredentialSession {
  readonly credentialRef = `credential:${randomUUID()}`;
  #jar: CookieJar;
  #metadata: CredentialMetadata;
  #generation: string;
  #service: CredentialService;
  #scope: string;
  #pathname: string;
  #updates: Promise<void> = Promise.resolve();

  constructor(jar: CookieJar, service: CredentialService, metadata: CredentialMetadata, generation: string, scope: string, pathname: string) {
    this.#jar = jar;
    this.#service = cloneJson(service);
    this.#metadata = Object.freeze({ ...metadata, cookieNames: Object.freeze([...metadata.cookieNames]) });
    this.#generation = generation;
    this.#scope = scope;
    this.#pathname = pathname;
  }
  get metadata(): CredentialMetadata { return this.#metadata; }
  get generation(): string { return this.#generation; }

  #url(input: string): URL {
    const url = serviceURL(this.#service, input);
    if (url.origin !== this.#metadata.origin) throw new IntraError('INVALID_ARGUMENT', 'Resolve credentials again for a different origin.');
    if (this.#service.auth.cookieNames === undefined && url.pathname !== this.#pathname) throw new IntraError('COOKIE_NOT_FOUND');
    return url;
  }

  async cookieHeader(input: string): Promise<string> {
    const url = this.#url(input);
    await this.#updates;
    try {
      const cookies = await this.#jar.getCookies(url);
      // The explicit secure check is defense in depth, including localhost.
      return cookies.filter(cookie => (this.#service.auth.cookieNames === undefined || this.#service.auth.cookieNames.includes(cookie.key)) && (!cookie.secure || url.protocol === 'https:'))
        .map(cookie => cookie.cookieString()).join('; ');
    } catch { throw new IntraError('CONTRACT_INVALID', 'The credential cookies could not be matched.'); }
  }

  async acceptSetCookie(input: string, headers: string[]): Promise<void> {
    const url = this.#url(input);
    if (!Array.isArray(headers) || headers.length > 1024 || headers.some(header => typeof header !== 'string' || header.length > 16384 || /[\r\n\0]/.test(header))) {
      throw new IntraError('CONTRACT_INVALID', 'The response contains invalid cookies.');
    }
    const pending = this.#updates.then(async () => {
      // Build a complete replacement before publishing: a late invalid cookie cannot partially mutate the session.
      const candidate = await this.#jar.clone();
      for (const header of headers) {
        const parsed = Cookie.parse(header, { loose: false });
        if (!parsed || !cookieNamePattern.test(parsed.key) || !validCookieValue.test(parsed.value)) throw new IntraError('CONTRACT_INVALID', 'The response contains invalid cookies.');
        if (this.#service.auth.cookieNames !== undefined && !this.#service.auth.cookieNames.includes(parsed.key)) continue;
        if (parsed.extensions?.some(extension => /^partitioned(?:\s*=|\s*$)/i.test(extension))) throw new IntraError('PARTITIONED_COOKIE_UNSUPPORTED');
        if (parsed.secure && url.protocol !== 'https:') throw new IntraError('CONTRACT_INVALID', 'Secure cookies require HTTPS.');
        try { await candidate.setCookie(parsed, url, { ignoreError: false, http: true }); }
        catch { throw new IntraError('CONTRACT_INVALID', 'The response contains invalid cookies.'); }
      }
      const applicable = await candidate.getCookies(url);
      const generation = await fingerprint(candidate, this.#scope);
      this.#jar = candidate;
      this.#generation = generation;
      this.#metadata = Object.freeze({ ...this.#metadata, source: 'http' as const,
        cookieNames: Object.freeze([...new Set(applicable.map(cookie => cookie.key))].sort()) });
    });
    this.#updates = pending.catch(() => undefined);
    return pending;
  }

  toJSON(): object { return { credentialRef: this.credentialRef, metadata: this.#metadata, generation: this.#generation }; }
}

export async function snapshotSession(profile: Profile, service: CredentialService, rawSnapshot: SnapshotResult, requestedURL: string, accountId?: string): Promise<CredentialSession> {
  const snapshot = cloneJson(validate('snapshot', rawSnapshot));
  const url = serviceURL(service, requestedURL);
  if (snapshot.profileId !== profile.profileId || snapshot.storeId !== profile.storeId || snapshot.cookies.some(cookie => cookie.storeId !== profile.storeId)) {
    throw new IntraError('ACCOUNT_MISMATCH');
  }
  if (!Number.isFinite(Date.parse(snapshot.observedAt)) || !/^\d{4}-\d{2}-\d{2}T/.test(snapshot.observedAt) || snapshot.cookies.length > 4096) {
    throw new IntraError('CONTRACT_INVALID');
  }
  const jar = newJar();
  const unique = new Set<string>();
  for (const item of snapshot.cookies) {
    if (item.partitionKey !== undefined) throw new IntraError('PARTITIONED_COOKIE_UNSUPPORTED');
    if ((service.auth.cookieNames !== undefined && !service.auth.cookieNames.includes(item.name)) || !cookieNamePattern.test(item.name) || !validCookieValue.test(item.value) || item.value.length > 16384) {
      throw new IntraError('CONTRACT_INVALID', 'The snapshot contains invalid cookies.');
    }
    if (!item.path.startsWith('/') || /[\x00-\x20\x7f;]/.test(item.path) || !pathMatch(url.pathname, item.path)) throw new IntraError('CONTRACT_INVALID', 'The snapshot cookie path does not match the requested URL.');
    const domain = canonicalDomain(item.domain);
    const hostname = canonicalDomain(url.hostname);
    if (!domain || !hostname || /[\s/\\:@?#]/.test(item.domain) || (item.hostOnly ? item.domain.startsWith('.') || domain !== hostname : !domainMatch(hostname, domain))) {
      throw new IntraError('CONTRACT_INVALID', 'The snapshot cookie domain does not match the requested URL.');
    }
    if ((item.session && item.expirationDate !== undefined) || (!item.session && item.expirationDate === undefined) || (item.expirationDate !== undefined && (!Number.isFinite(item.expirationDate) || Math.abs(item.expirationDate * 1000) > 8.64e15))) {
      throw new IntraError('CONTRACT_INVALID', 'The snapshot contains invalid cookie expiry metadata.');
    }
    if (item.secure && url.protocol !== 'https:') throw new IntraError('CONTRACT_INVALID', 'Secure snapshot cookies require HTTPS.');
    const identity = JSON.stringify([item.name, domain, item.path]);
    if (unique.has(identity)) throw new IntraError('CONTRACT_INVALID', 'The snapshot contains duplicate cookies.');
    unique.add(identity);
    const cookie = new Cookie({
      key: item.name, value: item.value, domain: item.hostOnly ? undefined : domain, path: item.path, hostOnly: item.hostOnly,
      secure: item.secure, httpOnly: item.httpOnly,
      sameSite: item.sameSite === 'no_restriction' ? 'none' : item.sameSite === 'unspecified' ? undefined : item.sameSite,
      expires: item.expirationDate === undefined ? 'Infinity' : new Date(item.expirationDate * 1000),
    });
    try { await jar.setCookie(cookie, url, { ignoreError: false, http: true }); }
    catch { throw new IntraError('CONTRACT_INVALID', 'The snapshot contains invalid cookies.'); }
  }
  const applicable = await jar.getCookies(url);
  if (applicable.length === 0 || service.auth.cookieNames?.some(name => !applicable.some(cookie => cookie.key === name))) throw new IntraError('COOKIE_NOT_FOUND');
  const expiry = applicable.map(cookie => cookie.expiryTime()).filter((time): time is number => time !== undefined && Number.isFinite(time));
  const metadata: CredentialMetadata = {
    profileId: profile.profileId, storeId: profile.storeId, serviceId: service.id, origin: url.origin,
    ...(accountId === undefined ? {} : { accountId }), accountVerified: accountId !== undefined,
    cookieNames: [...new Set(applicable.map(cookie => cookie.key))].sort(),
    source: 'browser', observedAt: snapshot.observedAt,
    expiresAt: expiry.length === 0 ? null : new Date(Math.min(...expiry)).toISOString(),
  };
  const scope = JSON.stringify([profile.profileId, profile.storeId, service.id, url.origin, accountId ?? null]);
  return new ScopedSession(jar, service, metadata, await fingerprint(jar, scope), scope, url.pathname);
}
