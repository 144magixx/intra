import type { Service, Cookie, SnapshotResult } from '../../contracts/src/index.js';
export type CredentialService = Service;
export type SnapshotCookie = Cookie;
export type { SnapshotResult };

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PairProfile {
  alias: string;
  profileId: string;
  storeId: string;
  extensionId: string;
  /** Expected account only, not evidence of an authenticated session. */
  accountId?: string;
}

export interface Profile extends PairProfile {
  schemaVersion: 1;
  pairedAt: string;
}

export interface CredentialMetadata {
  readonly profileId: string;
  readonly storeId: string;
  readonly serviceId: string;
  readonly origin: string;
  readonly accountId?: string;
  readonly accountVerified: boolean;
  readonly cookieNames: readonly string[];
  readonly source: 'browser' | 'http';
  readonly observedAt: string;
  readonly expiresAt: string | null;
}

export interface CredentialSession {
  readonly credentialRef: string;
  readonly metadata: CredentialMetadata;
  /** Fingerprint of contents, independent of snapshot IDs/timestamps. */
  readonly generation: string;
  cookieHeader(url: string): Promise<string>;
  acceptSetCookie(url: string, headers: string[]): Promise<void>;
}

export interface RefreshLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}
