import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IntraError } from '../../../packages/contracts/src/index.js';
import { FramedPeer, MAX_PENDING, PROFILE_ID, checked, discoverProfiles, errorMessage, fail, prepareRuntime, request, response, validateExtensionOrigin, validateSnapshot, validateSnapshotParams } from './protocol.js';
import type { BridgeProfile, Hello, Message, SnapshotParams } from './protocol.js';

export interface NativeHostOptions { home?: string; expectedExtensionId: string; argv: string[]; input: Readable; output: Writable; helloTimeoutMs?: number }
interface Pending { peer: FramedPeer; originalId: string; params: SnapshotParams; timer: ReturnType<typeof setTimeout> }
export class NativeHost {
  readonly extensionId: string;
  private native: FramedPeer;
  private server?: Server;
  private profile?: BridgeProfile;
  private descriptor?: { path: string; dev: number; ino: number };
  private pending = new Map<string, Pending>();
  private clients = new Map<FramedPeer, { socket: Socket; ids: Set<string> }>();
  private helloStarted = false;
  private stopped = false;
  private helloTimer: ReturnType<typeof setTimeout>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  constructor(private readonly options: NativeHostOptions) {
    this.extensionId = validateExtensionOrigin(options.argv, options.expectedExtensionId);
    this.native = new FramedPeer(options.input, options.output);
    this.native.on('message', value => this.onNative(value));
    this.native.on('closed', () => { void this.stop(); });
    this.helloTimer = setTimeout(() => { void this.stop(); }, options.helloTimeoutMs ?? 10_000);
  }
  private onNative(value: unknown): void {
    if (this.stopped) return;
    let message: Message;
    try { message = checked<Message>('ipc', value); } catch { void this.stop(); return; }
    if (message.type === 'request') {
      if (message.method !== 'bridge.hello' || this.helloStarted) { this.sendNative(errorMessage(message.requestId, fail('FORBIDDEN', 'Only one bridge hello is accepted'))); return; }
      this.helloStarted = true;
      this.starting = this.hello(message).catch(error => { this.sendNative(errorMessage(message.requestId, error)); void this.stop(); });
      return;
    }
    if (message.type !== 'response') { void this.stop(); return; }
    const pending = this.pending.get(message.requestId);
    if (!pending) return; // Timed-out and unrelated responses cannot satisfy another request.
    try {
      if (!message.ok) throw new IntraError(message.error!.code, 'Extension rejected snapshot');
      this.complete(message.requestId, response(pending.originalId, validateSnapshot(message.result, pending.params)));
    } catch (error) { this.complete(message.requestId, errorMessage(pending.originalId, error)); }
  }
  private sendNative(message: Message): void { try { this.native.send(message); } catch { void this.stop(); } }
  private async hello(message: Message): Promise<void> {
    const hello = checked<Hello>('hello', message.params);
    if (!PROFILE_ID.test(hello.profileId) || !hello.storeIds.length || hello.storeIds.length > 16 || hello.storeIds.some(id => !id) || new Set(hello.storeIds).size !== hello.storeIds.length) throw fail('CONTRACT_INVALID', 'Invalid profile or cookie stores');
    if (!hello.protocolVersions.includes(1)) throw fail('PROTOCOL_MISMATCH', 'Unsupported bridge protocol');
    const run = await prepareRuntime(this.options.home);
    if (this.stopped) return;
    const connectionId = randomUUID();
    const stem = `b-${connectionId.replaceAll('-', '').slice(0, 12)}`;
    const socketPath = join(run, `${stem}.sock`);
    if (Buffer.byteLength(socketPath) > 103) throw fail('BRIDGE_UNAVAILABLE', 'INTRA_HOME is too long for a Unix socket; configure a shorter private home');
    const profile: BridgeProfile = { profileId: hello.profileId, storeIds: hello.storeIds, extensionId: this.extensionId, extensionVersion: hello.extensionVersion, protocolVersion: 1, connectionId, socketPath, confirmed: true };
    const server = createServer(socket => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    server.on('error', () => { void this.stop(); });
    await chmod(socketPath, 0o600);
    if (this.stopped) return;
    this.profile = profile;
    const path = join(run, `${stem}.json`);
    await writeFile(path, JSON.stringify(profile), { flag: 'wx', mode: 0o600 });
    const stat = await lstat(path);
    this.descriptor = { path, dev: stat.dev, ino: stat.ino };
    if ((await discoverProfiles(this.options.home)).filter(item => item.profileId === profile.profileId).length > 1) throw fail('PROFILE_AMBIGUOUS', 'Duplicate live browser profile; re-pair copied profile');
    if (this.stopped) return;
    clearTimeout(this.helloTimer);
    this.sendNative(response(message.requestId, { protocolVersion: 1 }));
  }
  private accept(socket: Socket): void {
    if (this.stopped || !this.profile || this.clients.size >= 16) { socket.destroy(); return; }
    socket.setTimeout(31_000, () => socket.destroy());
    const peer = new FramedPeer(socket, socket);
    this.clients.set(peer, { socket, ids: new Set() });
    peer.on('closed', () => {
      this.clients.delete(peer); socket.destroy();
      for (const [id, pending] of this.pending) if (pending.peer === peer) { clearTimeout(pending.timer); this.pending.delete(id); }
    });
    peer.on('message', value => {
      let message: Message;
      try { message = checked<Message>('ipc', value); } catch { socket.destroy(); return; }
      try {
        if (message.type !== 'request' || message.method !== 'cookies.snapshot') throw fail('FORBIDDEN', 'Only cookie snapshots are exposed to local clients');
        const params = validateSnapshotParams(message.params, this.profile);
        const client = this.clients.get(peer)!;
        if (client.ids.has(message.requestId)) { socket.destroy(); return; }
        if (this.pending.size >= MAX_PENDING) throw fail('BRIDGE_UNAVAILABLE', 'Too many pending bridge requests');
        client.ids.add(message.requestId);
        const id = randomUUID();
        const timer = setTimeout(() => this.complete(id, errorMessage(message.requestId, fail('REQUEST_TIMEOUT', 'Snapshot deadline exceeded'))), params.deadlineMs);
        this.pending.set(id, { peer, originalId: message.requestId, params, timer });
        void this.forward(id);
      } catch (error) { try { peer.send(errorMessage(message.requestId, error)); } catch { socket.destroy(); } }
    });
  }
  private async forward(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    try {
      if ((await discoverProfiles(this.options.home)).filter(item => item.profileId === pending.params.profileId).length !== 1) throw fail('PROFILE_AMBIGUOUS', 'Profile connection is ambiguous');
      if (this.pending.has(id) && !this.stopped) this.native.send(request(id, 'cookies.snapshot', pending.params));
    } catch (error) { this.complete(id, errorMessage(pending.originalId, error)); }
  }
  private complete(id: string, result: Message): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(id);
    this.clients.get(pending.peer)?.ids.delete(pending.originalId);
    try { pending.peer.send(result); } catch { this.clients.get(pending.peer)?.socket.destroy(); }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true; clearTimeout(this.helloTimer);
    this.stopping = (async () => {
      await this.starting;
      for (const [id, pending] of this.pending) this.complete(id, errorMessage(pending.originalId, fail('BRIDGE_UNAVAILABLE', 'Native bridge disconnected')));
      for (const { socket } of this.clients.values()) socket.destroy();
      this.clients.clear();
      this.native.close();
      this.options.input.destroy();
      if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
      // Node removes only its own bound socket on close; never unlink any guessed/stale endpoint.
      if (this.descriptor) {
        const owned = this.descriptor;
        try { const stat = await lstat(owned.path); if (stat.dev === owned.dev && stat.ino === owned.ino) await unlink(owned.path); } catch { /* already removed */ }
      }
    })();
    return this.stopping;
  }
}

export function runNativeHost(): NativeHost {
  return new NativeHost({ input: process.stdin, output: process.stdout, argv: process.argv.slice(2), expectedExtensionId: process.env.INTRA_EXTENSION_ID ?? '', home: process.env.INTRA_HOME });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const host = runNativeHost();
    const stop = () => { void host.stop().finally(() => { process.stdin.destroy(); }); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    process.stdin.once('end', stop);
  } catch {
    process.stderr.write('Intra native bridge startup rejected. Check the configured extension origin and private runtime directory.\n');
    process.exitCode = 1;
  }
}
