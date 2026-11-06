import type { CredentialStore } from './types.js';

/** Test-only secret store. Production CLI construction must use MacKeychainStore. */
export class MemorySecretStore implements CredentialStore {
  #values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.#values.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.#values.set(key, value); }
  async delete(key: string): Promise<void> { this.#values.delete(key); }
  toJSON(): object { return { type: 'MemorySecretStore', testOnly: true }; }
}
