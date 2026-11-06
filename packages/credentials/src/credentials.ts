import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { IntraError, assertJson, cloneJson, isRecord, validate } from '../../contracts/src/index.js';
import { atomicMetadata, credentialsDirectory, privateDirectory, readPrivateText } from './private-files.js';
import { snapshotSession, serviceURL } from './cookie-session.js';
import { withFileLock } from './refresh-lock.js';
import type { CredentialService, CredentialSession, CredentialStore, PairProfile, Profile, RefreshLockOptions, SnapshotResult } from './types.js';

interface SecretRecord {
  schemaVersion: 1;
  profileId: string;
  storeId: string;
  serviceId: string;
  origin: string;
  requestedURL: string;
  /** Only snapshots requested without a name filter are complete for this URL. */
  allCookieNames?: true;
  accountId?: string;
  snapshot: SnapshotResult;
}
interface ActiveRecord { schemaVersion: 1; key: string; accountId?: string }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
}
function pairing(value: unknown): PairProfile {
  assertJson(value, 'INVALID_ARGUMENT');
  if (!isRecord(value) || Object.keys(value).some(key => !['alias', 'profileId', 'storeId', 'extensionId', 'accountId'].includes(key)) ||
      typeof value.alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value.alias) ||
      !identifier(value.profileId) || !identifier(value.storeId) || typeof value.extensionId !== 'string' || !/^[a-p]{32}$/.test(value.extensionId) ||
      (value.accountId !== undefined && !identifier(value.accountId))) throw new IntraError('INVALID_ARGUMENT');
  return cloneJson(value) as unknown as PairProfile;
}

export class Credentials {
  #store: CredentialStore;
  #home: string;
  #directory: string;
  constructor(options: { store: CredentialStore; home: string }) {
    this.#store = options.store;
    this.#home = resolve(options.home);
    this.#directory = credentialsDirectory(options.home);
  }
  async #initialize(): Promise<void> {
    await privateDirectory(this.#home);
    await privateDirectory(this.#directory);
  }
  async #profiles(): Promise<Profile[]> {
    const text = await readPrivateText(join(this.#directory, 'profiles.json'));
    if (text === null) return [];
    try {
      const data: unknown = JSON.parse(text);
      if (!isRecord(data) || data.schemaVersion !== 1 || !Array.isArray(data.profiles) || Object.keys(data).some(key => !['schemaVersion', 'profiles'].includes(key))) throw new Error();
      const profiles = data.profiles.map((item: unknown) => {
        if (!isRecord(item) || item.schemaVersion !== 1 || typeof item.pairedAt !== 'string' || !Number.isFinite(Date.parse(item.pairedAt))) throw new Error();
        const { schemaVersion: _version, pairedAt, ...input } = item;
        return { ...pairing(input), schemaVersion: 1 as const, pairedAt };
      });
      if (new Set(profiles.map(item => item.alias)).size !== profiles.length || new Set(profiles.map(item => item.profileId)).size !== profiles.length) throw new Error();
      return profiles;
    } catch { throw new IntraError('INTERNAL_ERROR', 'The profile metadata is invalid.'); }
  }

  /** The caller must obtain user confirmation through the verified browser bridge separately. */
  async pair(input: PairProfile): Promise<Profile> {
    const selected = pairing(input);
    await this.#initialize();
    return withFileLock(join(this.#directory, 'locks'), 'profiles', async () => {
      const profiles = await this.#profiles();
      if (profiles.some(profile => profile.alias === selected.alias || profile.profileId === selected.profileId)) throw new IntraError('PROFILE_AMBIGUOUS');
      const profile: Profile = { ...selected, schemaVersion: 1, pairedAt: new Date().toISOString() };
      await atomicMetadata(join(this.#directory, 'profiles.json'), { schemaVersion: 1, profiles: [...profiles, profile] });
      return Object.freeze(profile);
    });
  }

  /** Local pairing metadata only; never reads the credential store. */
  async profiles(): Promise<Array<Pick<Profile, 'alias' | 'profileId' | 'storeId' | 'pairedAt'>>> {
    await this.#initialize();
    return (await this.#profiles()).map(({ alias, profileId, storeId, pairedAt }) => ({ alias, profileId, storeId, pairedAt }));
  }

  async profile(alias: string): Promise<Profile> {
    if (typeof alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(alias)) throw new IntraError('INVALID_ARGUMENT');
    await this.#initialize();
    const selected = (await this.#profiles()).find(profile => profile.alias === alias);
    if (!selected) throw new IntraError('PROFILE_NOT_PAIRED');
    return Object.freeze(selected);
  }

  #scope(profile: Profile, service: CredentialService, origin: string): string {
    return hash([profile.profileId, profile.storeId, service.id, origin]);
  }
  async #get(key: string): Promise<string | null> {
    try { return await this.#store.get(key); }
    catch { throw new IntraError('KEYCHAIN_UNAVAILABLE', 'The credential store is unavailable.'); }
  }
  async #active(scope: string): Promise<ActiveRecord | null> {
    const text = await this.#get(`intra:v1:active:${scope}`);
    if (text === null) return null;
    try {
      const data: unknown = JSON.parse(text);
      if (!isRecord(data) || data.schemaVersion !== 1 || typeof data.key !== 'string' || !/^intra:v1:snapshot:[a-f0-9]{64}:[a-f0-9-]{36}$/.test(data.key) ||
          (data.accountId !== undefined && !identifier(data.accountId)) || Object.keys(data).some(key => !['schemaVersion', 'key', 'accountId'].includes(key))) throw new Error();
      return data as unknown as ActiveRecord;
    } catch { throw new IntraError('CONTRACT_INVALID', 'The stored credential record is invalid.'); }
  }

  /** Transient, explicitly account-unverified session for Core's identity probe. */
  async previewSnapshot(alias: string, service: CredentialService, snapshot: SnapshotResult, requestedURL = service.baseUrl): Promise<CredentialSession> {
    const profile = await this.profile(alias);
    return snapshotSession(profile, service, snapshot, requestedURL);
  }

  /** accountId must come from Core's successful identity probe, never from cookie contents. */
  async saveSnapshot(alias: string, service: CredentialService, rawSnapshot: SnapshotResult, accountId?: string, requestedURL = service.baseUrl): Promise<CredentialSession> {
    const profile = await this.profile(alias);
    if (accountId !== undefined && !identifier(accountId)) throw new IntraError('INVALID_ARGUMENT');
    if (profile.accountId !== undefined && profile.accountId !== accountId) throw new IntraError('ACCOUNT_MISMATCH');
    const snapshot = cloneJson(validate('snapshot', rawSnapshot));
    const selectedService = cloneJson(validate('service', service));
    const url = serviceURL(selectedService, requestedURL);
    const session = await snapshotSession(profile, selectedService, snapshot, url.href, accountId);
    const scope = this.#scope(profile, selectedService, url.origin);
    return withFileLock(join(this.#directory, 'locks'), `snapshot:${scope}`, async () => {
      const active = await this.#active(scope);
      if (active?.accountId !== undefined && active.accountId !== accountId) throw new IntraError('ACCOUNT_MISMATCH');
      // Account-scoped immutable snapshot plus one atomic publication pointer.
      const key = `intra:v1:snapshot:${hash([scope, accountId ?? null])}:${randomUUID()}`;
      const record: SecretRecord = {
        schemaVersion: 1, profileId: profile.profileId, storeId: profile.storeId,
        serviceId: selectedService.id, origin: url.origin, requestedURL: url.href,
        ...(selectedService.auth.cookieNames === undefined ? { allCookieNames: true as const } : {}),
        ...(accountId === undefined ? {} : { accountId }), snapshot,
      };
      const next: ActiveRecord = { schemaVersion: 1, key, ...(accountId === undefined ? {} : { accountId }) };
      try {
        await this.#store.set(key, JSON.stringify(record));
        await this.#store.set(`intra:v1:active:${scope}`, JSON.stringify(next));
      } catch {
        // A lost helper reply can follow a successful pointer write. Retain the immutable
        // record so a possibly published pointer always refers to a complete snapshot.
        throw new IntraError('KEYCHAIN_UNAVAILABLE', 'The credential snapshot could not be saved.');
      }
      // Old immutable records remain available to concurrent readers that already read the pointer.
      // They contain secrets only in the chosen CredentialStore, never in metadata files.
      return session;
    });
  }

  async resolve(alias: string, service: CredentialService, requestedURL: string): Promise<CredentialSession> {
    const profile = await this.profile(alias);
    const url = serviceURL(service, requestedURL);
    const active = await this.#active(this.#scope(profile, service, url.origin));
    if (active === null) throw new IntraError('COOKIE_NOT_FOUND');
    const text = await this.#get(active.key);
    if (text === null) throw new IntraError('COOKIE_NOT_FOUND');
    let record: SecretRecord;
    try {
      const data: unknown = JSON.parse(text);
      assertJson(data);
      if (!isRecord(data) || data.schemaVersion !== 1 || data.profileId !== profile.profileId || data.storeId !== profile.storeId || data.serviceId !== service.id || data.origin !== url.origin || typeof data.requestedURL !== 'string' || data.accountId !== active.accountId ||
          (data.allCookieNames !== undefined && data.allCookieNames !== true) ||
          Object.keys(data).some(key => !['schemaVersion', 'profileId', 'storeId', 'serviceId', 'origin', 'requestedURL', 'allCookieNames', 'accountId', 'snapshot'].includes(key))) throw new Error();
      if (profile.accountId !== undefined && profile.accountId !== data.accountId) throw new IntraError('ACCOUNT_MISMATCH');
      record = data as unknown as SecretRecord;
    } catch (error) {
      if (error instanceof IntraError && error.code === 'ACCOUNT_MISMATCH') throw error;
      throw new IntraError('CONTRACT_INVALID', 'The stored credential record is invalid.');
    }
    const snapshotURL = serviceURL(service, record.requestedURL);
    if (snapshotURL.origin !== url.origin) throw new IntraError('CONTRACT_INVALID');
    // getAll({ url }) cannot observe cookies specific to any other pathname.
    // Legacy and named-only snapshots never establish URL-mode completeness.
    if (service.auth.cookieNames === undefined && (record.allCookieNames !== true || snapshotURL.pathname !== url.pathname)) {
      throw new IntraError('COOKIE_NOT_FOUND');
    }
    const session = await snapshotSession(profile, service, record.snapshot, record.requestedURL, record.accountId);
    const header = await session.cookieHeader(url.href);
    const names = new Set(header.split('; ').map(cookie => cookie.slice(0, cookie.indexOf('='))));
    if (!header || service.auth.cookieNames?.some(name => !names.has(name))) throw new IntraError('COOKIE_NOT_FOUND');
    return session;
  }

  /** Re-resolve inside callback; another process may already have refreshed while waiting. */
  async withRefreshLock<T>(alias: string, service: CredentialService, callback: () => Promise<T>, options: RefreshLockOptions = {}): Promise<T> {
    const profile = await this.profile(alias);
    validate('service', service);
    return withFileLock(join(this.#directory, 'locks'), `refresh:${hash([profile.profileId, profile.storeId, profile.accountId ?? null, service.id])}`, callback, options);
  }
}
