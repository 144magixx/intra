import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { IntraError } from '../../../packages/contracts/src/index.js';
import { FramedPeer, MAX_PENDING, checked, discoverProfiles, fail, request, safeErrorCode, validateSnapshot, validateSnapshotParams } from './protocol.js';
import type { BridgeProfile, Snapshot, SnapshotParams, Message } from './protocol.js';
export type { BridgeProfile, Snapshot, SnapshotParams } from './protocol.js';

export interface BrowserBridgeOptions { home?: string; extensionId?: string; timeoutMs?: number }
export class BrowserBridge {
  private active = 0;
  constructor(private readonly options: BrowserBridgeOptions = {}) {}
  async listProfiles(deadlineAt = Date.now() + 2000): Promise<BridgeProfile[]> {
    const profiles = await discoverProfiles(this.options.home, this.options.extensionId, deadlineAt);
    const ids = new Set<string>();
    for (const profile of profiles) {
      if (ids.has(profile.profileId)) throw fail('PROFILE_AMBIGUOUS', 'Multiple live extensions have the same profile ID; re-pair the copied profile');
      ids.add(profile.profileId);
    }
    return profiles;
  }
  async getConnection(profileId: string, deadlineAt?: number): Promise<BridgeProfile> {
    const profile = (await this.listProfiles(deadlineAt)).find(profile => profile.profileId === profileId);
    if (!profile) throw fail('PROFILE_NOT_PAIRED', 'Open the extension and confirm this browser profile');
    return profile;
  }
  async snapshot(input: SnapshotParams): Promise<Snapshot> {
    const params = validateSnapshotParams(input);
    if (this.active >= MAX_PENDING) throw fail('BRIDGE_UNAVAILABLE', 'Too many pending bridge requests');
    this.active++;
    const deadlineAt = Date.now() + Math.min(params.deadlineMs, this.options.timeoutMs ?? 30_000);
    try {
      const profile = await this.getConnection(params.profileId, deadlineAt);
      validateSnapshotParams(params, profile);
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw fail('REQUEST_TIMEOUT', 'Browser snapshot deadline exceeded');
      return await new Promise<Snapshot>((resolve, reject) => {
        const socket = createConnection(profile.socketPath);
        const peer = new FramedPeer(socket, socket);
        const requestId = randomUUID();
        let settled = false;
        const done = (error?: unknown, result?: Snapshot) => {
          if (settled) return;
          settled = true; clearTimeout(timer); socket.destroy(); peer.close();
          if (error) reject(error); else resolve(result!);
        };
        const timer = setTimeout(() => done(fail('REQUEST_TIMEOUT', 'Browser snapshot deadline exceeded')), remainingMs);
        peer.on('closed', () => done(fail('BRIDGE_UNAVAILABLE', 'Browser bridge disconnected')));
        peer.on('message', value => {
          try {
            const message = checked<Message>('ipc', value);
            if (message.type !== 'response' || message.requestId !== requestId) throw fail('CONTRACT_INVALID', 'Unexpected bridge response');
            if (!message.ok) throw new IntraError(safeErrorCode(message.error!.code), 'Browser snapshot request failed');
            done(undefined, validateSnapshot(message.result, params));
          } catch (error) { done(error); }
        });
        socket.once('connect', () => {
          try { peer.send(request(requestId, 'cookies.snapshot', params)); } catch (error) { done(error); }
        });
      });
    } finally { this.active--; }
  }
}
