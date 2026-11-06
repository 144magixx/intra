import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { endianness } from 'node:os';
import { mkdtemp, rm, lstat, readdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { domainMatch, pathMatch } from 'tough-cookie';
import { NativeHost } from '../apps/native-host/src/index.js';
import { BrowserBridge } from '../apps/native-host/src/client.js';
import { FrameDecoder, FramedPeer, MAX_FRAME_BYTES, encodeFrame, request, response, validateExtensionOrigin, validateSnapshot, validateSnapshotParams } from '../apps/native-host/src/protocol.js';
import type { Message, Snapshot, SnapshotParams } from '../apps/native-host/src/protocol.js';

const extensionId = 'a'.repeat(32);
const profileId = randomUUID();
const params: SnapshotParams = { profileId, storeId: '0', url: 'https://risk-api.corp.example/api/list', cookieNames: ['sso.corp.example'], deadlineMs: 1000 };
const sample = (input: SnapshotParams = params): Snapshot => ({ profileId: input.profileId, storeId: input.storeId, snapshotId: randomUUID(), observedAt: new Date().toISOString(), cookies: [{ name: 'sso.corp.example', value: 'SYNTHETIC_NOT_A_CREDENTIAL', domain: 'risk-api.corp.example', path: '/', hostOnly: true, secure: true, httpOnly: true, sameSite: 'lax', session: true, storeId: input.storeId }] });
const hasCode = (code: string) => (error: unknown) => (error as { code?: string })?.code === code;
async function temp(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const home = await mkdtemp('/tmp/intra-bridge-');
  t.after(async () => { assert.ok(home.startsWith('/tmp/intra-bridge-')); await rm(home, { recursive: true, force: true }); });
  return home;
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, home?: string, id = profileId) {
  home ??= await temp(t);
  const input = new PassThrough(); const output = new PassThrough();
  const host = new NativeHost({ home, input, output, expectedExtensionId: extensionId, argv: [`chrome-extension://${extensionId}/`] });
  const extension = new FramedPeer(output, input);
  t.after(async () => { await host.stop(); extension.close(); input.destroy(); output.destroy(); });
  const hello = once(extension, 'message');
  extension.send(request('hello', 'bridge.hello', { profileId: id, extensionVersion: '0.1.0', protocolVersions: [1], storeIds: ['0'] }));
  const [result] = await hello as [Message];
  return { home, host, extension, input, output, hello: result, bridge: new BrowserBridge({ home }) };
}
function nextMessage(peer: FramedPeer): Promise<Message> { return once(peer, 'message').then(([message]) => message as Message); }

test('native framing supports native endian, split/coalesced frames and rejects oversize/truncation/UTF-8', () => {
  const received: unknown[] = []; const errors: unknown[] = [];
  const decoder = new FrameDecoder(value => received.push(value), error => errors.push(error));
  const first = encodeFrame({ message: '合成' }); const second = encodeFrame({ ok: true });
  assert.equal(endianness() === 'LE' ? first.readUInt32LE() : first.readUInt32BE(), first.length - 4);
  for (const byte of Buffer.concat([first, second])) decoder.push(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(received, [{ message: '合成' }, { ok: true }]); assert.equal(errors.length, 0);
  assert.throws(() => encodeFrame({ data: 'x'.repeat(MAX_FRAME_BYTES) }), hasCode('RESPONSE_TOO_LARGE'));
  const header = Buffer.alloc(4); if (endianness() === 'LE') header.writeUInt32LE(MAX_FRAME_BYTES + 1); else header.writeUInt32BE(MAX_FRAME_BYTES + 1);
  new FrameDecoder(() => assert.fail('oversize accepted'), error => errors.push(error)).push(header);
  const truncated = new FrameDecoder(() => assert.fail('truncation accepted'), error => errors.push(error)); truncated.push(first.subarray(0, 6)); truncated.end();
  const invalid = encodeFrame('x'); invalid[5] = 0xff;
  new FrameDecoder(() => assert.fail('invalid UTF-8 accepted'), error => errors.push(error)).push(invalid);
  assert.equal(errors.length, 3);
});

test('native origin must be the exact configured Chrome extension argv', () => {
  assert.equal(validateExtensionOrigin([`chrome-extension://${extensionId}/`], extensionId), extensionId);
  for (const argv of [[], [extensionId], [`chrome-extension://${extensionId}`], [`chrome-extension://${'b'.repeat(32)}/`], [`chrome-extension://${extensionId}/`, '--extra'], ['x', `chrome-extension://${extensionId}/`]]) assert.throws(() => validateExtensionOrigin(argv, extensionId), hasCode('FORBIDDEN'));
  assert.throws(() => validateExtensionOrigin(['chrome-extension://invalid/'], 'invalid'), hasCode('FORBIDDEN'));
});

test('snapshot scope rejects wrong URL/profile/store/name/path, partitioning and insecure forwarding', () => {
  validateSnapshotParams(params); validateSnapshot(sample(), params);
  for (const url of ['https://corp.example/', 'https://reports.corp.example:8443/api', 'http://new.deep.corp.example/api', 'https://www.bilibili.com/api', 'https://api.zhihu.com/api', 'https://custom.example/api', 'http://localhost:1234/api', 'http://127.0.0.1/api', 'http://[::1]/api']) validateSnapshotParams({ ...params, url, cookieNames: ['custom_session'] });
  for (const change of [{ url: 'https://.example.com/' }, { url: 'https://a..example.com/' }, { url: 'https://-bad.example/' }, { url: 'https://bad-.example/' }, { url: 'https://name:secret@risk-api.corp.example/' }, { url: 'ftp://risk-api.corp.example/' }, { url: 'file:///tmp/cookies' }, { url: 'chrome://settings/' }, { url: 'https://risk-api.corp.example/#fragment' }, { url: 'https://risk-api.corp.example/#' }, { cookieNames: [] }, { cookieNames: [''] }, { cookieNames: ['a', 'a'] }, { cookieNames: ['bad;name'] }, { cookieNames: ['a'.repeat(257)] }, { cookieNames: Array.from({ length: 17 }, (_, i) => 'n' + i) }]) assert.throws(() => validateSnapshotParams({ ...params, ...change }));
  for (const change of [{ profileId: randomUUID() }, { storeId: '1' }]) assert.throws(() => validateSnapshot({ ...sample(), ...change }, params), hasCode('CONTRACT_INVALID'));
  for (const change of [{ domain: 'evilcorp.example' }, { path: '/apix' }, { name: 'other' }, { storeId: '1' }]) {
    const value = sample(); Object.assign(value.cookies[0]!, change); assert.throws(() => validateSnapshot(value, params), hasCode('CONTRACT_INVALID'));
  }
  const partitioned = sample(); partitioned.cookies[0]!.partitionKey = { topLevelSite: 'https://corp.example' };
  assert.throws(() => validateSnapshot(partitioned, params), hasCode('PARTITIONED_COOKIE_UNSUPPORTED'));
  const httpParams = { ...params, url: 'http://devcloud.corp.example/' }; const http = sample(httpParams); http.cookies[0]!.domain = 'devcloud.corp.example';
  assert.throws(() => validateSnapshot(http, httpParams), hasCode('CONTRACT_INVALID'));
});

test('confirmed hello publishes private metadata; snapshot matches routed request; EOF cleans own files', async t => {
  const f = await fixture(t); assert.equal(f.hello.ok, true);
  const profiles = await f.bridge.listProfiles(); assert.equal(profiles.length, 1); assert.equal(profiles[0]!.profileId, profileId);
  assert.equal((await lstat(f.home)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.home, 'run'))).mode & 0o777, 0o700);
  assert.equal((await lstat(profiles[0]!.socketPath)).mode & 0o777, 0o600);
  const descriptor = (await readdir(join(f.home, 'run'))).find(name => name.endsWith('.json'))!;
  assert.equal((await lstat(join(f.home, 'run', descriptor))).mode & 0o777, 0o600);
  const nativeRequest = nextMessage(f.extension);
  const result = f.bridge.snapshot(params);
  const forwarded = await nativeRequest; assert.equal(forwarded.method, 'cookies.snapshot');
  f.extension.send(response('unrelated-id', sample()));
  f.extension.send(response(forwarded.requestId, sample()));
  assert.equal((await result).cookies[0]!.value, 'SYNTHETIC_NOT_A_CREDENTIAL');
  f.input.end(); await f.host.stop(); assert.deepEqual(await f.bridge.listProfiles(), []);
  assert.deepEqual(await readdir(join(f.home, 'run')), []);
});

test('no metadata before hello; invalid/duplicate profile cannot select an arbitrary live connection', async t => {
  const home = await temp(t); const input = new PassThrough(); const output = new PassThrough();
  const host = new NativeHost({ home, input, output, expectedExtensionId: extensionId, argv: [`chrome-extension://${extensionId}/`] });
  t.after(async () => { await host.stop(); input.destroy(); output.destroy(); });
  assert.deepEqual(await new BrowserBridge({ home }).listProfiles(), []);
  const first = await fixture(t, home); assert.equal(first.hello.ok, true);
  const second = await fixture(t, home); assert.equal(second.hello.error?.code, 'PROFILE_AMBIGUOUS');
  await second.host.stop();
  assert.equal((await first.bridge.listProfiles()).length, 1);
});

test('deadline rejects pending; late responses are discarded; disconnect clears pending', async t => {
  const f = await fixture(t);
  let message = nextMessage(f.extension);
  const expired = f.bridge.snapshot({ ...params, deadlineMs: 50 });
  const rejection = assert.rejects(expired, hasCode('REQUEST_TIMEOUT'));
  const late = await message; await rejection;
  f.extension.send(response(late.requestId, sample()));
  message = nextMessage(f.extension);
  const disconnected = f.bridge.snapshot(params);
  const rejected = assert.rejects(disconnected, hasCode('BRIDGE_UNAVAILABLE'));
  await message; f.input.end(); await rejected; await f.host.stop();
});

test('host rejects non-snapshot methods and malformed result scoped to pending request', async t => {
  const f = await fixture(t); const profile = await f.bridge.getConnection(profileId);
  const socket = createConnection(profile.socketPath); await once(socket, 'connect');
  const local = new FramedPeer(socket, socket); t.after(async () => { socket.destroy(); local.close(); });
  for (const method of ['credentials.resolve', 'http.execute', 'bridge.hello']) {
    const responsePromise = nextMessage(local);
    local.send(request(randomUUID(), method, method === 'bridge.hello' ? { profileId, extensionVersion: '0', protocolVersions: [1], storeIds: ['0'] } : {}));
    assert.equal((await responsePromise).error?.code, 'FORBIDDEN');
  }
  const incoming = nextMessage(f.extension); const result = f.bridge.snapshot(params); const rejection = assert.rejects(result, hasCode('CONTRACT_INVALID'));
  const nativeRequest = await incoming; f.extension.send(response(nativeRequest.requestId, { ...sample(), profileId: randomUUID() })); await rejection;
});

test('host bounds pending requests and preserves other live sockets and stale records', async t => {
  const f = await fixture(t); const profile = await f.bridge.getConnection(profileId);
  const stale = join(f.home, 'run', 'b-000000000000.json'); await writeFile(stale, '{}', { mode: 0o600 });
  const foreignPath = join(f.home, 'run', 'foreign.sock'); const foreign = createServer(socket => socket.end());
  await new Promise<void>(resolve => foreign.listen(foreignPath, resolve));
  t.after(async () => { await new Promise<void>(resolve => foreign.close(() => resolve())); });
  const socket = createConnection(profile.socketPath); await once(socket, 'connect');
  const local = new FramedPeer(socket, socket); t.after(async () => { socket.destroy(); local.close(); });
  const rejected = new Promise<Message>(resolve => local.on('message', (message: Message) => { if (message.requestId === '32') resolve(message); }));
  for (let i = 0; i < 33; i++) local.send(request(String(i), 'cookies.snapshot', { ...params, deadlineMs: 3000 }));
  assert.equal((await rejected).error?.code, 'BRIDGE_UNAVAILABLE');
  socket.destroy(); await f.host.stop();
  assert.equal((await lstat(foreignPath)).isSocket(), true); assert.equal(await readFile(stale, 'utf8'), '{}');
});

test('client rejects public runtime directories and duplicate live descriptors', async t => {
  const home = await temp(t); await chmod(home, 0o755);
  await assert.rejects(new BrowserBridge({ home }).listProfiles(), hasCode('FORBIDDEN')); await chmod(home, 0o700);
  const f = await fixture(t, home); const profile = await f.bridge.getConnection(profileId);
  const duplicatePath = join(await import('node:fs/promises').then(fs => fs.realpath(join(home, 'run'))), 'b-111111111111.sock');
  const duplicate = createServer(socket => socket.end()); await new Promise<void>(resolve => duplicate.listen(duplicatePath, resolve)); await chmod(duplicatePath, 0o600);
  t.after(async () => { await new Promise<void>(resolve => duplicate.close(() => resolve())); });
  await writeFile(duplicatePath.replace('.sock', '.json'), JSON.stringify({ ...profile, connectionId: randomUUID(), socketPath: duplicatePath }), { mode: 0o600 });
  await assert.rejects(f.bridge.listProfiles(), hasCode('PROFILE_AMBIGUOUS'));
});

const sharedCookieOrigins = ['http://corp.example/*', 'https://corp.example/*'];
const domainOrigins = ['http://*.corp.example/*', 'https://*.corp.example/*'];
const allOrigins = ['http://*/*', 'https://*/*'];
const originsForDomain = (domain: string) => [`http://*.${domain}/*`, `https://*.${domain}/*`];
const targetOrigins = ['https://risk-api.corp.example/*', 'https://logwatch.corp.example/*', 'http://devcloud.corp.example/*'];
const sharedCookies = (): Snapshot['cookies'] => [
  { ...sample().cookies[0]!, domain: '.corp.example', hostOnly: false, secure: false },
  { ...sample().cookies[0]!, domain: '.corp.example', hostOnly: false, secure: true, path: '/api' },
];

async function fakeExtension(grantedOrigins = domainOrigins) {
  const modulePath = pathToFileURL(resolve('apps/extension/bridge.js')).href;
  const { createExtensionBridge } = await import(modulePath);
  const storage: Record<string, unknown> = {}; const posted: any[] = []; const incoming: ((value: any) => void)[] = []; const disconnected: (() => void)[] = [];
  let connections = 0; let cookies = sample().cookies; let reads = 0; let storeReads = 0; let allow = true; let rawCookies = false;
  const grants = new Set(grantedOrigins);
  const hasHostPermission = (url: URL) => [...grants].some(pattern => {
    const match = /^(https?):\/\/(\*\.)?([^/]+)\/\*$/.exec(pattern);
    return match && url.protocol === match[1] + ':' &&
      (match[3] === '*' || url.hostname === match[3] || (match[2] && url.hostname.endsWith('.' + match[3])));
  });
  const containsPattern = (requested: string) => [...grants].some(granted => {
    const parse = (pattern: string) => /^(https?):\/\/(\*|\*\.[^/]+|[^/]+)\/\*$/.exec(pattern)!;
    const wanted = parse(requested); const held = parse(granted);
    if (wanted[1] !== held[1]) return false;
    if (held[2] === '*') return true;
    if (wanted[2] === '*') return false;
    if (!held[2]!.startsWith('*.')) return wanted[2] === held[2];
    const root = held[2]!.slice(2); const host = wanted[2]!.replace(/^\*\./, '');
    return host === root || host.endsWith('.' + root);
  });
  const permissionChecks: string[][] = [];
  const cookieQueries: { url: string; storeId: string }[] = [];
  const port = { onMessage: { addListener: (fn: (value: any) => void) => incoming.push(fn) }, onDisconnect: { addListener: (fn: () => void) => disconnected.push(fn) }, disconnect() {}, postMessage(value: any) { posted.push(value); if (value.method === 'bridge.hello') queueMicrotask(() => incoming.forEach(fn => fn(response(value.requestId, { protocolVersion: 1 })))); } };
  const api = {
    runtime: { connectNative() { connections++; incoming.length = 0; disconnected.length = 0; return { ...port }; }, getManifest: () => ({ version: '0.3.2' }) },
    permissions: { contains: async ({ origins }: { origins: string[] }) => { permissionChecks.push([...origins]); return allow && origins.every(containsPattern); } },
    storage: { local: { get: async () => storage, set: async (value: object) => Object.assign(storage, value) } },
    cookies: {
      getAllCookieStores: async () => { storeReads++; return [{ id: '0' }]; },
      getAll: async (query: { url: string; storeId: string }) => {
        assert.deepEqual(Object.keys(query).sort(), ['storeId', 'url'], 'Cookie reads must never query the entire browser store');
        assert.equal(typeof query.url, 'string'); assert.ok(query.url.length); assert.equal(typeof query.storeId, 'string');
        reads++; cookieQueries.push({ ...query });
        const url = new URL(query.url);
        if (rawCookies) return cookies;
        // Model Chrome's URL/store matching plus its independent domain + Secure
        // host-permission filter (cookies_helpers.cc), using synthetic cookies only.
        return cookies.filter(cookie => {
          const domain = cookie.domain.replace(/^\./, '');
          const permissionUrl = new URL((cookie.secure ? 'https' : 'http') + '://' + domain + '/');
          return allow && hasHostPermission(permissionUrl) && cookie.storeId === query.storeId &&
            (cookie.hostOnly ? url.hostname === domain : domainMatch(url.hostname, domain)) &&
            pathMatch(url.pathname, cookie.path) && (!cookie.secure || url.protocol === 'https:');
        });
      },
    },
  };
  const bridge = createExtensionBridge(api);
  const dispatch = async (message: unknown) => { incoming.forEach(fn => fn(message)); await new Promise(resolve => setImmediate(resolve)); return posted.at(-1); };
  return {
    bridge, storage, posted, dispatch, permissionChecks, cookieQueries,
    connections: () => connections, reads: () => reads, storeReads: () => storeReads,
    setCookies: (value: typeof cookies) => { cookies = value; }, setPermission: (value: boolean) => { allow = value; },
    setGrants: (origins: string[]) => { grants.clear(); for (const origin of origins) grants.add(origin); },
    setRawCookies: (value: boolean) => { rawCookies = value; },
    queryCookies: api.cookies.getAll, disconnect: () => disconnected.forEach(fn => fn()),
  };
}

test('permission selections have no built-in presets and cover chosen domains without inferred parents or match-pattern injection', async () => {
  const { SERVICES, permissionOriginsFor } = await import(pathToFileURL(resolve('apps/extension/bridge.js')).href);
  assert.deepEqual(SERVICES.map((group: { id: string }) => group.id), []);
  assert.deepEqual(permissionOriginsFor(['all']), allOrigins);
  assert.deepEqual(permissionOriginsFor(['domain:bilibili.com', 'domain:zhihu.com']), [...originsForDomain('bilibili.com'), ...originsForDomain('zhihu.com')]);
  assert.deepEqual(permissionOriginsFor(['domain:api.example.com']), originsForDomain('api.example.com'));
  assert.deepEqual(permissionOriginsFor(['domain:localhost']), originsForDomain('localhost'));
  for (const input of ['', 'https://example.com', 'example.com/path', 'user@example.com', 'example.com?x=1', 'example.com#x', '*.example.com', 'exam*ple.com', '.example.com', 'example..com', '-bad.example', 'bad-.example', 'a'.repeat(64) + '.com', 'example.com:443', '127.0.0.1', '127.1', '0x7f.1', '[::1]', 'example.com\n']) assert.throws(() => permissionOriginsFor(['domain:' + input]), hasCode('FORBIDDEN'));
  assert.deepEqual(permissionOriginsFor(['domain:corp.example']), domainOrigins);
  assert.deepEqual(permissionOriginsFor(['domain:corp.example', 'domain:corp.example']), domainOrigins);
  for (const ids of [null, 'jd', [], ['unknown'], ['risk-api'], ['jd'], ['domain:corp.example', 'unknown'], [1], new Array(1)]) {
    assert.throws(() => permissionOriginsFor(ids), hasCode('FORBIDDEN'));
  }
});

test('extension manifests declare optional HTTP/HTTPS scope without network observation at version 0.3.2', async () => {
  for (const file of ['manifest.template.json', 'manifest.json']) {
    const content = await readFile(resolve('apps/extension', file), 'utf8').catch(error => {
      if (file === 'manifest.json' && error.code === 'ENOENT') return null; // Generated only by explicit setup.
      throw error;
    });
    if (content === null) continue;
    const manifest = JSON.parse(content);
    assert.equal(manifest.version, '0.3.2');
    assert.deepEqual(manifest.optional_host_permissions, allOrigins);
    assert.deepEqual(manifest.permissions, ['cookies', 'nativeMessaging', 'storage']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.externally_connectable, undefined);
  }
});

test('Chrome getAll model filters shared cookies by cookie domain and Secure scheme', async () => {
  const f = await fakeExtension([targetOrigins[0]!]); const cookies = sharedCookies(); f.setCookies(cookies);
  const endpoint = { url: params.url, storeId: params.storeId };
  assert.deepEqual(await f.queryCookies({ ...endpoint, url: 'https://risk-api.corp.example/' }), []);
  assert.deepEqual(await f.queryCookies(endpoint), []);
  f.setGrants([targetOrigins[0]!, sharedCookieOrigins[0]!]);
  assert.deepEqual(await f.queryCookies(endpoint), [cookies[0]]);
  f.setGrants([targetOrigins[0]!, sharedCookieOrigins[1]!]);
  assert.deepEqual(await f.queryCookies(endpoint), [cookies[1]]);
  f.setGrants(domainOrigins);
  assert.deepEqual(await f.queryCookies(endpoint), cookies);
  assert.deepEqual(await f.queryCookies({ ...endpoint, url: 'http://risk-api.corp.example/api/list' }), [cookies[0]]);
});

test('target-only or incomplete shared-domain grants refuse connection before cookie or store reads', async () => {
  for (const grants of [[targetOrigins[0]!], [...targetOrigins, ...sharedCookieOrigins], [domainOrigins[0]!], [domainOrigins[1]!]]) {
    const f = await fakeExtension(grants); f.setCookies(sharedCookies());
    await assert.rejects(f.bridge.confirm(['domain:corp.example']), hasCode('FORBIDDEN'));
    assert.deepEqual(f.permissionChecks, [domainOrigins]);
    assert.equal(f.connections(), 0); assert.equal(f.reads(), 0); assert.equal(f.storeReads(), 0);
    assert.deepEqual(f.storage, {});
  }
});

test('domain grant retains applicable shared cookies at new subdomain URLs with exact names and store', async () => {
  const f = await fakeExtension(); const pairing = await f.bridge.confirm(['domain:corp.example']);
  const shared = sharedCookies();
  const custom = { ...shared[0]!, name: 'custom_session' };
  f.setCookies([
    ...shared, custom,
    { ...shared[0]!, path: '/apix' },
    { ...shared[0]!, storeId: '1' },
    { ...shared[0]!, domain: 'other.corp.example', hostOnly: true },
    { ...shared[0]!, domain: '.unrelated.example' },
  ]);
  const input = { ...params, profileId: pairing.profileId, url: 'https://reports.deep.corp.example/api/list' };
  const result = await f.dispatch(request('new-subdomain-service', 'cookies.snapshot', input));
  assert.equal(result.ok, true); assert.deepEqual(result.result.cookies, shared);
  assert.deepEqual(f.cookieQueries, [{ url: input.url, storeId: input.storeId }]);
  assert.deepEqual(f.permissionChecks, [domainOrigins, domainOrigins]);
  validateSnapshotParams(input); validateSnapshot(result.result, input);
  const customInput = { ...input, cookieNames: ['custom_session'] };
  const customResult = await f.dispatch(request('custom-name', 'cookies.snapshot', customInput));
  assert.equal(customResult.ok, true); assert.deepEqual(customResult.result.cookies, [custom]);
  validateSnapshotParams(customInput); validateSnapshot(customResult.result, customInput);
  const httpInput = { ...input, url: 'http://corp.example/api/list' };
  const httpResult = await f.dispatch(request('root-http', 'cookies.snapshot', httpInput));
  assert.equal(httpResult.ok, true); assert.deepEqual(httpResult.result.cookies, [shared[0]]);
  validateSnapshotParams(httpInput); validateSnapshot(httpResult.result, httpInput);
  f.bridge.disconnect();
});

test('shared-domain snapshots reject outside domains, userinfo, fragments and invalid names before reads', async () => {
  const f = await fakeExtension(); const pairing = await f.bridge.confirm(['domain:corp.example']);
  for (const url of ['https://evilcorp.example/', 'https://corp.example.evil/', 'https://other.example/', 'https://.corp.example/', 'https://a..corp.example/', 'ftp://corp.example/', 'https://user:pass@corp.example/', 'https://corp.example/#fragment']) {
    const result = await f.dispatch(request(randomUUID(), 'cookies.snapshot', { ...params, profileId: pairing.profileId, url }));
    assert.equal(result.error.code, 'FORBIDDEN');
  }
  for (const cookieNames of [[], [''], ['a', 'a'], ['bad;name'], ['bad=name'], ['bad,name'], ['bad name'], ['name\n'], ['name\r'], ['中文'], ['a'.repeat(257)], [123], Array.from({ length: 17 }, (_, i) => 'name' + i)]) {
    const result = await f.dispatch(request(randomUUID(), 'cookies.snapshot', { ...params, profileId: pairing.profileId, cookieNames }));
    assert.equal(result.error.code, 'CONTRACT_INVALID');
  }
  for (const change of [{ storeId: '1' }, { profileId: randomUUID() }]) {
    const result = await f.dispatch(request(randomUUID(), 'cookies.snapshot', { ...params, profileId: pairing.profileId, ...change }));
    assert.equal(result.error.code, 'PROFILE_NOT_PAIRED');
  }
  assert.equal(f.reads(), 0); assert.deepEqual(f.permissionChecks, [domainOrigins]);
  f.bridge.disconnect();
});

test('revoking either shared-domain scheme permission refuses snapshots before the next cookie read', async () => {
  for (const remaining of [[domainOrigins[0]!], [domainOrigins[1]!], targetOrigins]) {
    const f = await fakeExtension(); f.setCookies(sharedCookies());
    const pairing = await f.bridge.confirm(['domain:corp.example']); const input = { ...params, profileId: pairing.profileId };
    assert.equal((await f.dispatch(request('before-revoke', 'cookies.snapshot', input))).ok, true);
    assert.equal(f.reads(), 1);
    f.setGrants(remaining);
    const result = await f.dispatch(request('after-revoke', 'cookies.snapshot', input));
    assert.equal(result.error.code, 'FORBIDDEN'); assert.equal(f.reads(), 1);
    assert.deepEqual(f.permissionChecks.at(-1), domainOrigins);
    f.bridge.disconnect();
  }
});

test('extension connects only after explicit confirmation and limited permission; no cookie export in status', async () => {
  const f = await fakeExtension(); assert.equal(f.connections(), 0); assert.equal((await f.bridge.status()).connected, false);
  await assert.rejects(f.bridge.confirm(['unknown']), hasCode('FORBIDDEN')); assert.equal(f.connections(), 0);
  f.setPermission(false); await assert.rejects(f.bridge.confirm(['domain:corp.example']), hasCode('FORBIDDEN')); assert.equal(f.connections(), 0);
  f.setPermission(true); const pairing = await f.bridge.confirm(['domain:corp.example']); assert.equal(f.connections(), 1); assert.match(pairing.profileId, /^[0-9a-f-]{36}$/);
  const response = await f.dispatch(request('snapshot', 'cookies.snapshot', { ...params, profileId: pairing.profileId }));
  assert.equal(response.ok, true); assert.equal(response.result.cookies.length, 1); assert.equal(f.reads(), 1);
  assert.ok(!JSON.stringify(await f.bridge.status()).includes('SYNTHETIC'));
  const denied = await f.dispatch(request('denied', 'cookies.snapshot', { ...params, profileId: pairing.profileId, url: 'https://unrelated.example/', cookieNames: ['uas_jtoken'] }));
  assert.equal(denied.error.code, 'FORBIDDEN'); assert.equal(f.reads(), 1);
  f.disconnect(); assert.equal((await f.bridge.status()).connected, false);
});

test('extension rejects partitioned and oversized snapshots and preserves profile ID across reconnect', async () => {
  const f = await fakeExtension(); const pairing = await f.bridge.confirm(['domain:corp.example']);
  const cookies = sample().cookies; cookies[0]!.partitionKey = { topLevelSite: 'https://corp.example' }; f.setCookies(cookies);
  let result = await f.dispatch(request('partition', 'cookies.snapshot', { ...params, profileId: pairing.profileId })); assert.equal(result.error.code, 'PARTITIONED_COOKIE_UNSUPPORTED');
  const large = sample().cookies; large[0]!.value = 'x'.repeat(MAX_FRAME_BYTES); f.setCookies(large);
  result = await f.dispatch(request('large', 'cookies.snapshot', { ...params, profileId: pairing.profileId })); assert.equal(result.error.code, 'RESPONSE_TOO_LARGE');
  f.bridge.disconnect(); const reconnected = await f.bridge.confirm(['domain:corp.example']); assert.equal(reconnected.profileId, pairing.profileId); f.bridge.disconnect();
});

test('native process verifies argv and exits on EOF without writing diagnostic text to stdout', async t => {
  const home = await temp(t);
  const entry = resolve('dist/apps/native-host/src/index.js');
  const rejected = spawn(process.execPath, [entry], { env: { ...process.env, INTRA_EXTENSION_ID: extensionId, INTRA_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let unexpected = ''; rejected.stdout.on('data', data => { unexpected += data; });
  const [rejectedCode] = await once(rejected, 'close'); assert.equal(rejectedCode, 1); assert.equal(unexpected, '');
  const child = spawn(process.execPath, [entry, `chrome-extension://${extensionId}/`], { env: { ...process.env, INTRA_EXTENSION_ID: extensionId, INTRA_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) child.kill(); });
  const peer = new FramedPeer(child.stdout, child.stdin);
  const hello = nextMessage(peer);
  peer.send(request('process-hello', 'bridge.hello', { profileId, extensionVersion: '0.1.0', protocolVersions: [1], storeIds: ['0'] }));
  assert.equal((await hello).ok, true);
  const closed = once(child, 'close'); child.stdin.end(); const [exit] = await closed; assert.equal(exit, 0);
  assert.deepEqual(await new BrowserBridge({ home }).listProfiles(), []);
});

test('untrusted extension errors cannot echo arbitrary credential-shaped codes or messages', async t => {
  const f = await fixture(t); const incoming = nextMessage(f.extension);
  const rejected = assert.rejects(f.bridge.snapshot(params), error => hasCode('BRIDGE_UNAVAILABLE')(error) && !String(error).includes('SYNTHETIC'));
  const message = await incoming;
  f.extension.send({ schemaVersion: 1, requestId: message.requestId, type: 'response', ok: false, error: { code: 'SYNTHETIC_SECRET', message: 'SYNTHETIC_SECRET', retryable: false } });
  await rejected;
});

test('packaging generator creates absolute launcher with actual extension origin, no registration', async t => {
  const home = await temp(t); const staging = join(home, 'package');
  const child = spawn(process.execPath, ['packaging/native-host/generate.mjs', '--extension-id', extensionId, '--node', process.execPath, '--host', resolve('dist/apps/native-host/src/index.js'), '--output', staging, '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; });
  const [exit] = await once(child, 'close'); assert.equal(exit, 0); assert.equal(JSON.parse(output).registered, false);
  const manifest = JSON.parse(await readFile(join(staging, 'com.intra.bridge.json'), 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]); assert.equal(manifest.path, join(staging, 'intra-native-host'));
  const launcher = await readFile(manifest.path, 'utf8'); assert.ok(launcher.includes(process.execPath)); assert.ok(launcher.includes('"$@"')); assert.equal((await lstat(manifest.path)).mode & 0o777, 0o700);
});

function allURLParams(input: SnapshotParams = params): SnapshotParams {
  const value = { ...input }; delete value.cookieNames; return value;
}

test('host accepts omitted names but still validates every URL-scoped cookie and rejects invalid explicit lists', () => {
  const input = allURLParams();
  assert.equal(Object.hasOwn(validateSnapshotParams(input), 'cookieNames'), false);
  const value = sample(input);
  value.cookies.push({ ...value.cookies[0]!, name: 'another_session' });
  assert.equal(validateSnapshot(value, input).cookies.length, 2);
  assert.throws(() => validateSnapshot(value, params), hasCode('CONTRACT_INVALID'));
  for (const cookieNames of [[], null, [''], ['a', 'a'], [123], ['bad=name'], ['bad name'], ['name\n'], ['name\r'], ['x'.repeat(257)]]) assert.throws(() => validateSnapshotParams({ ...input, cookieNames }));
  for (const change of [{ name: '' }, { name: 'bad=name' }, { name: 'name\n' }, { domain: '.corp.example.evil' }, { path: '/apix' }, { storeId: '1' }, { expirationDate: 1 }]) {
    const invalid = sample(input); Object.assign(invalid.cookies[0]!, change);
    assert.throws(() => validateSnapshot(invalid, input), hasCode('CONTRACT_INVALID'));
  }
  const duplicate = sample(input); duplicate.cookies.push({ ...duplicate.cookies[0]! });
  assert.throws(() => validateSnapshot(duplicate, input), hasCode('CONTRACT_INVALID'));
  const partitioned = sample(input); partitioned.cookies[0]!.partitionKey = {};
  assert.throws(() => validateSnapshot(partitioned, input), hasCode('PARTITIONED_COOKIE_UNSUPPORTED'));
});

test('native socket forwards omitted names and unselected-domain URL under unchanged version 1 shape', async t => {
  const f = await fixture(t);
  const input = allURLParams({ ...params, url: 'https://api.bilibili.com/account' });
  const incoming = nextMessage(f.extension); const result = f.bridge.snapshot(input);
  const forwarded = await incoming;
  assert.equal(forwarded.schemaVersion, 1); assert.equal(Object.hasOwn(forwarded.params as object, 'cookieNames'), false);
  const value = sample(input); value.cookies[0]!.domain = 'api.bilibili.com'; value.cookies[0]!.name = 'bili_session';
  f.extension.send(response(forwarded.requestId, value));
  assert.deepEqual((await result).cookies, value.cookies);
});

test('all-sites opt-in allows Bilibili, Zhihu, chosen domains and valid localhost/IP HTTP URLs', async () => {
  const f = await fakeExtension(allOrigins); const pairing = await f.bridge.confirm(['all']);
  for (const url of ['https://api.bilibili.com/account', 'https://www.zhihu.com/api/account', 'http://api.custom.example/api/list', 'http://localhost:3434/api', 'http://127.0.0.1:3434/api', 'http://[::1]:3434/api']) {
    const input = allURLParams({ ...params, profileId: pairing.profileId, url });
    const cookies = [{ ...sample().cookies[0]!, name: 'site_session', domain: new URL(url).hostname, secure: url.startsWith('https:') }];
    f.setCookies(cookies);
    const result = await f.dispatch(request(randomUUID(), 'cookies.snapshot', input));
    assert.equal(result.ok, true, url); assert.deepEqual(result.result.cookies, cookies);
    validateSnapshotParams(input); validateSnapshot(result.result, input);
    assert.deepEqual(f.cookieQueries.at(-1), { url, storeId: '0' });
  }
  assert.ok(f.permissionChecks.every(origins => JSON.stringify(origins) === JSON.stringify(allOrigins)));
  f.bridge.disconnect();
});

test('omitted names return all exact-URL cookies; explicit names narrow without unscoped getAll', async () => {
  const f = await fakeExtension(originsForDomain('bilibili.com')); const pairing = await f.bridge.confirm(['domain:bilibili.com']);
  const input = allURLParams({ ...params, profileId: pairing.profileId, url: 'https://api.bilibili.com/api/list?limit=20' });
  const base = { ...sample().cookies[0]!, domain: '.bilibili.com', hostOnly: false, secure: false };
  const wanted = Array.from({ length: 20 }, (_, i) => ({ ...base, name: 'session_' + i }));
  wanted.push({ ...base, name: 'secure_session', secure: true });
  f.setCookies([...wanted, { ...base, path: '/apix' }, { ...base, domain: 'other.bilibili.com', hostOnly: true }, { ...base, storeId: '1' }]);
  const result = await f.dispatch(request('all-url-names', 'cookies.snapshot', input));
  assert.equal(result.ok, true); assert.deepEqual(result.result.cookies, wanted); validateSnapshot(result.result, input);
  const namedInput = { ...input, cookieNames: ['session_3'] };
  const named = await f.dispatch(request('named-cookie', 'cookies.snapshot', namedInput));
  assert.equal(named.ok, true); assert.deepEqual(named.result.cookies, [wanted[3]]); validateSnapshot(named.result, namedInput);
  const empty = await f.dispatch(request('empty-names', 'cookies.snapshot', { ...input, cookieNames: [] }));
  assert.equal(empty.error.code, 'CONTRACT_INVALID'); assert.equal(f.reads(), 2);
  const httpInput = { ...input, url: input.url.replace('https:', 'http:') };
  const httpResult = await f.dispatch(request('all-names-http', 'cookies.snapshot', httpInput));
  assert.equal(httpResult.ok, true); assert.deepEqual(httpResult.result.cookies, wanted.filter(cookie => !cookie.secure));
  assert.deepEqual(f.cookieQueries, [{ url: input.url, storeId: '0' }, { url: input.url, storeId: '0' }, { url: httpInput.url, storeId: '0' }]);
  assert.ok(!JSON.stringify(await f.bridge.status()).includes('SYNTHETIC'));
  assert.ok(!JSON.stringify(f.storage).includes('SYNTHETIC'));
  f.bridge.disconnect();
});

test('site-only confirmation denies unrelated hosts even after an all-sites grant and connection', async () => {
  const f = await fakeExtension(allOrigins); await f.bridge.confirm(['all']);
  const selected = ['domain:bilibili.com']; const connecting = f.bridge.confirm(selected);
  selected.push('all'); // A caller cannot mutate the scope while confirmation awaits Chrome.
  const pairing = await connecting;
  f.setCookies([{ ...sample().cookies[0]!, domain: '.bilibili.com', hostOnly: false }]);
  const input = allURLParams({ ...params, profileId: pairing.profileId, url: 'https://api.bilibili.com/' });
  assert.equal((await f.dispatch(request('chosen-site', 'cookies.snapshot', input))).ok, true);
  for (const url of ['https://zhihu.com/', 'https://corp.example/', 'https://unrelated.example/', 'https://evilbilibili.com/', 'https://bilibili.com.evil/']) {
    const result = await f.dispatch(request(randomUUID(), 'cookies.snapshot', { ...input, url }));
    assert.equal(result.error.code, 'FORBIDDEN');
  }
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.permissionChecks.at(-1), originsForDomain('bilibili.com'));
  f.bridge.disconnect();
});

test('custom domain selection includes its root and dot-boundary subdomains only', async () => {
  const f = await fakeExtension(allOrigins); const pairing = await f.bridge.confirm(['domain:api.example.com']);
  const input = allURLParams({ ...params, profileId: pairing.profileId, url: 'https://api.example.com/api/list' });
  f.setCookies([{ ...sample().cookies[0]!, domain: '.api.example.com', hostOnly: false }]);
  for (const url of ['https://api.example.com/api/list', 'https://deep.api.example.com/api/list']) {
    assert.equal((await f.dispatch(request(randomUUID(), 'cookies.snapshot', { ...input, url }))).ok, true);
  }
  for (const url of ['https://example.com/api/list', 'https://other.example.com/', 'https://evilapi.example.com/', 'https://api.example.com.evil/']) {
    assert.equal((await f.dispatch(request(randomUUID(), 'cookies.snapshot', { ...input, url }))).error.code, 'FORBIDDEN');
  }
  assert.equal(f.reads(), 2); assert.deepEqual(f.permissionChecks.at(-1), originsForDomain('api.example.com'));
  f.bridge.disconnect();
});

test('denied or revoked all-sites permissions prevent Cookie reads and do not initiate connections', async () => {
  for (const grants of [[], domainOrigins, [allOrigins[0]!], [allOrigins[1]!]]) {
    const f = await fakeExtension(grants);
    await assert.rejects(f.bridge.confirm(['all']), hasCode('FORBIDDEN'));
    assert.equal(f.connections(), 0); assert.equal(f.reads(), 0); assert.equal(f.storeReads(), 0);
  }
  for (const remaining of [[], [allOrigins[0]!], [allOrigins[1]!], domainOrigins]) {
    const f = await fakeExtension(allOrigins); const pairing = await f.bridge.confirm(['all']);
    const input = allURLParams({ ...params, profileId: pairing.profileId });
    assert.equal((await f.dispatch(request('before-revoke', 'cookies.snapshot', input))).ok, true);
    f.setGrants(remaining);
    assert.equal((await f.dispatch(request('after-revoke', 'cookies.snapshot', input))).error.code, 'FORBIDDEN');
    assert.equal(f.reads(), 1); f.bridge.disconnect();
  }
});

test('all-sites snapshots reject invalid schemes, authority, hostname, fragments and wrong profile before reads', async () => {
  const f = await fakeExtension(allOrigins); const pairing = await f.bridge.confirm(['all']);
  const input = allURLParams({ ...params, profileId: pairing.profileId });
  for (const url of ['file:///tmp/cookies', 'chrome://settings/', 'ftp://example.com/', 'https://user:pass@example.com/', 'https://example.com/#x', 'https://example.com/#', 'https://.example.com/', 'https://a..example.com/', 'https://bad-.example/', 'https://-bad.example/', 'https://exa_mple.com/', 'not a URL']) {
    assert.equal((await f.dispatch(request(randomUUID(), 'cookies.snapshot', { ...input, url }))).error.code, 'FORBIDDEN');
  }
  for (const change of [{ profileId: randomUUID() }, { storeId: '1' }]) assert.equal((await f.dispatch(request(randomUUID(), 'cookies.snapshot', { ...input, ...change }))).error.code, 'PROFILE_NOT_PAIRED');
  assert.equal(f.reads(), 0); f.bridge.disconnect();
});

test('extension fails closed on partitioned, cross-domain, path, store and Secure violations with omitted names', async () => {
  const f = await fakeExtension(allOrigins); const pairing = await f.bridge.confirm(['all']);
  const input = allURLParams({ ...params, profileId: pairing.profileId }); f.setRawCookies(true);
  for (const change of [{ domain: 'evilcorp.example' }, { path: '/apix' }, { storeId: '1' }, { expirationDate: 1 }, { name: 'bad=name' }]) {
    f.setCookies([{ ...sample().cookies[0]!, ...change }]);
    assert.equal((await f.dispatch(request(randomUUID(), 'cookies.snapshot', input))).error.code, 'CONTRACT_INVALID');
  }
  f.setCookies([{ ...sample().cookies[0]!, partitionKey: {} }]);
  assert.equal((await f.dispatch(request('all-partition', 'cookies.snapshot', input))).error.code, 'PARTITIONED_COOKIE_UNSUPPORTED');
  f.setCookies(sample().cookies);
  assert.equal((await f.dispatch(request('all-secure', 'cookies.snapshot', { ...input, url: input.url.replace('https:', 'http:') }))).error.code, 'CONTRACT_INVALID');
  f.bridge.disconnect();
});

test('popup all-sites starts unchecked; denied user grant sends no confirmation or Cookie reads', async () => {
  const html = await readFile(resolve('apps/extension/popup.html'), 'utf8');
  const allInput = /<input[^>]*id="all-websites"[^>]*>/.exec(html)?.[0];
  assert.ok(allInput); assert.ok(!/\bchecked\b/.test(allInput));
  const { SERVICES, permissionOriginsFor } = await import(pathToFileURL(resolve('apps/extension/bridge.js')).href);
  const f = await fakeExtension(allOrigins);
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const elements = new Map<string, any>();
  for (const id of ['status', 'profile', 'services', 'pairing', 'confirmed', 'custom-enabled', 'custom-domain', 'all-websites', 'connect', 'disconnect', 'reset']) elements.set('#' + id, { checked: false, value: '', textContent: '', append() {}, addEventListener: (event: string, fn: (event: unknown) => Promise<void>) => handlers.set(id + ':' + event, fn) });
  elements.get('#all-websites').value = 'all';
  const document = {
    querySelector: (selector: string) => elements.get(selector),
    querySelectorAll: () => elements.get('#all-websites').checked ? [elements.get('#all-websites')] : [],
    createElement: () => ({ append() {} }), createTextNode: (text: string) => text,
  };
  let granted = false; const requests: string[][] = []; let confirmations = 0;
  const chrome = {
    permissions: { request: async ({ origins }: { origins: string[] }) => { requests.push(origins); return granted; } },
    runtime: { sendMessage: async (message: any) => {
      if (message.action === 'confirm') { confirmations++; return { ok: true, result: await f.bridge.confirm(message.services) }; }
      return { ok: true, result: await f.bridge.status() };
    } },
  };
  const source = (await readFile(resolve('apps/extension/popup.js'), 'utf8')).replace(/^import[^\n]+\n/, '');
  new Function('document', 'chrome', 'SERVICES', 'permissionOriginsFor', source)(document, chrome, SERVICES, permissionOriginsFor);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 0); assert.equal(f.connections(), 0);
  elements.get('#confirmed').checked = true; elements.get('#all-websites').checked = true;
  await handlers.get('pairing:submit')!({ preventDefault() {} });
  assert.deepEqual(requests, [allOrigins]); assert.equal(confirmations, 0); assert.equal(f.connections(), 0); assert.equal(f.reads(), 0); assert.equal(f.storeReads(), 0);
  granted = true;
  await handlers.get('pairing:submit')!({ preventDefault() {} });
  assert.equal(confirmations, 1); assert.equal(f.connections(), 1); assert.equal(f.reads(), 0);
  f.bridge.disconnect();
});
