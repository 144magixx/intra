import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Core, type Bridge } from '../packages/core/src/index.js';
import { Registry } from '../packages/registry/src/index.js';
import { Credentials, MemorySecretStore } from '../packages/credentials/src/index.js';
import { validate, type CookieSnapshot, type Service } from '../packages/contracts/src/index.js';
import { temp, server, service, operation } from './support.js';

const profileId = 'd6256076-b8c5-4dfc-86bb-51f2823d6236';
const extensionId = 'a'.repeat(32);
function snapshot(value: string, id = 'snapshot-1'): CookieSnapshot {
  return { profileId, storeId: '0', snapshotId: id, observedAt: new Date().toISOString(), cookies: [{
    name: 'session', value, domain: '127.0.0.1', hostOnly: true, path: '/', secure: false,
    httpOnly: true, sameSite: 'unspecified', session: true, storeId: '0',
  }] };
}
async function harness(t: TestContext, site: Service, nextValue = 'SYNTHETIC_NEW_SECRET') {
  const home = await temp(t), registry = new Registry(path.join(home, 'registry'));
  const credentials = new Credentials({ store: new MemorySecretStore(), home });
  const connection = { profileId, storeIds: ['0'], extensionId, confirmed: true };
  let syncs = 0;
  const bridge: Bridge = { async listProfiles() { return [connection]; }, async getConnection() { return connection; },
    async snapshot() { syncs++; return snapshot(nextValue, `snapshot-${syncs + 1}`); } };
  const core = new Core({ registry, credentials, bridge, home });
  await registry.register(site); await registry.register(operation());
  await core.pairProfile('work', profileId);
  await credentials.saveSnapshot('work', site, snapshot('SYNTHETIC_OLD_SECRET'), undefined, site.baseUrl + '/');
  return { core, registry, credentials, home, syncs: () => syncs };
}

test('core calls local server using cached credentials without browser and emits validated summary', async t => {
  let seenCookie: string | undefined;
  const origin = await server(t, (req, res) => { seenCookie = req.headers.cookie; res.end(JSON.stringify({ code: '200', data: { items: [{ id: 2 }], total: 9 }, token: 'SECRET_RESPONSE_TOKEN' })); });
  const h = await harness(t, service(origin));
  h.core.dependencies.bridge.getConnection = async () => { throw Error('browser is closed'); };
  const result = await h.core.call('local-test.list', { page: 3 }, { profile: 'work', output: path.join(h.home, 'out.json') });
  validate('tool-result', result);
  assert.equal(result.ok, true); assert.equal(seenCookie, 'session=SYNTHETIC_OLD_SECRET'); assert.equal(h.syncs(), 0);
  assert.deepEqual(result.data, { count: 1, total: 9 });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.match(await readFile(result.artifact!.path, 'utf8'), /SECRET_RESPONSE_TOKEN/);
});

test('read authentication recovery refreshes once and retries once with new credentials', async t => {
  let calls = 0;
  const origin = await server(t, (req, res) => { calls++; res.end(JSON.stringify(req.headers.cookie?.includes('OLD') ? { code: 304 } : { code: '200', data: { items: [], total: 0 } })); });
  const h = await harness(t, service(origin));
  const result = await h.core.call('local-test.list', {}, { profile: 'work' });
  assert.equal(result.ok, true); assert.equal(result.meta.authRefreshed, true); assert.equal(calls, 2); assert.equal(h.syncs(), 1);
});

test('unchanged credentials stop recovery before replay', async t => {
  let calls = 0;
  const origin = await server(t, (_req, res) => { calls++; res.end('{"code":304}'); });
  const h = await harness(t, service(origin), 'SYNTHETIC_OLD_SECRET');
  const result = await h.core.call('local-test.list', {}, { profile: 'work' });
  assert.equal(result.ok, false); assert.equal(result.error?.code, 'LOGIN_REQUIRED'); assert.equal(calls, 1); assert.equal(h.syncs(), 1);
});

test('second authentication failure stops without another refresh', async t => {
  let calls = 0;
  const origin = await server(t, (_req, res) => { calls++; res.end('{"code":304}'); });
  const h = await harness(t, service(origin));
  const result = await h.core.call('local-test.list', {}, { profile: 'work' });
  assert.equal(result.error?.code, 'LOGIN_REQUIRED'); assert.equal(calls, 2); assert.equal(h.syncs(), 1);
});

test('unknown raw and write operations do not refresh on auth failure', async t => {
  let calls = 0;
  const origin = await server(t, (_req, res) => { calls++; res.end('{"code":304}'); });
  const h = await harness(t, service(origin));
  const op = operation(); op.id = 'local-test.write'; op.semantics = 'write'; await h.registry.register(op);
  assert.equal((await h.core.call(op.id, {}, { profile: 'work' })).error?.code, 'LOGIN_REQUIRED');
  assert.equal((await h.core.request('local-test', { method: 'POST', path: '/', body: {} }, { profile: 'work' })).error?.code, 'LOGIN_REQUIRED');
  assert.equal(calls, 2); assert.equal(h.syncs(), 0);
});

test('raw transport success explicitly leaves business success unknown', async t => {
  const origin = await server(t, (_req, res) => res.end('{"code":999,"token":"HIDDEN"}'));
  const h = await harness(t, service(origin));
  const result = await h.core.request('local-test', { method: 'GET', path: '/' }, { profile: 'work' });
  assert.equal(result.ok, true); assert.deepEqual(result.data, { status: 'received', businessSuccess: 'unknown' });
  assert.equal(JSON.stringify(result).includes('HIDDEN'), false);
});

test('403 without probe is undetermined and never triggers refresh', async t => {
  const origin = await server(t, (_req, res) => { res.statusCode = 403; res.end('{}'); });
  const h = await harness(t, service(origin));
  const result = await h.core.call('local-test.list', {}, { profile: 'work' });
  assert.equal(result.error?.code, 'AUTH_STATE_UNDETERMINED'); assert.equal(h.syncs(), 0);
});

test('403 with valid identity probe is forbidden and never triggers refresh', async t => {
  let calls = 0;
  const origin = await server(t, (req, res) => { calls++; if (req.url === '/whoami') res.end('{"username":"test-user"}'); else { res.statusCode = 403; res.end('{}'); } });
  const site = service(origin); site.auth.identityProbeOperation = 'local-test.identity';
  const h = await harness(t, site);
  const identity = operation(); identity.id = 'local-test.identity'; identity.request = { method: 'GET', path: '/whoami' }; identity.bindings = [];
  identity.response = { success: { httpStatuses: [200] }, identityPointer: '/username' }; await h.registry.register(identity);
  const result = await h.core.call('local-test.list', {}, { profile: 'work' });
  assert.equal(result.error?.code, 'FORBIDDEN'); assert.equal(h.syncs(), 0); assert.equal(calls, 2);
});

test('auth check without probe is UNKNOWN and sends no arbitrary request', async t => {
  let calls = 0;
  const origin = await server(t, (_req, res) => { calls++; res.end('{}'); });
  const h = await harness(t, service(origin));
  const result = await h.core.authCheck('local-test', 'work');
  assert.equal(result.ok, true); assert.equal((result.data as { status: string }).status, 'UNKNOWN'); assert.equal(calls, 0);
});

test('overlapping read failures share one bounded refresh lock', async t => {
  let calls = 0;
  const origin = await server(t, (req, res) => { calls++; res.end(JSON.stringify(req.headers.cookie?.includes('OLD') ? { code: 304 } : { code: '200', data: { items: [], total: 0 } })); });
  const h = await harness(t, service(origin));
  const results = await Promise.all([h.core.call('local-test.list', {}, { profile: 'work' }), h.core.call('local-test.list', {}, { profile: 'work' })]);
  assert.equal(results.every(result => result.ok), true); assert.equal(h.syncs(), 1); assert.ok(calls <= 4);
});

test('Core resolves a separate origin-scoped cache on allowed redirects', async t => {
  let receivedCookie: string | undefined;
  const destination = await server(t, (req, res) => { receivedCookie = req.headers.cookie; res.end(JSON.stringify({ code: '200', data: { items: [], total: 0 } })); });
  const origin = await server(t, (_req, res) => { res.writeHead(302, { location: destination + '/list' }); res.end(); });
  const site = service(origin); site.allowedOrigins.push(destination); site.protocolExceptions!.push({ origin: destination, reason: 'Synthetic second origin' });
  const h = await harness(t, site);
  await h.credentials.saveSnapshot('work', site, snapshot('SYNTHETIC_TARGET_SECRET'), undefined, destination + '/');
  const result = await h.core.call('local-test.list', {}, { profile: 'work' });
  assert.equal(result.ok, true); assert.equal(receivedCookie, 'session=SYNTHETIC_TARGET_SECRET'); assert.equal(h.syncs(), 0);
});

test('auth response Set-Cookie does not masquerade as a concurrent cache refresh', async t => {
  let calls = 0;
  const origin = await server(t, (req, res) => {
    calls++;
    if (req.headers.cookie?.includes('OLD')) {
      res.setHeader('Set-Cookie', 'session=revoked; Path=/'); res.end('{"code":304}');
    } else res.end(JSON.stringify({ code: '200', data: { items: [], total: 0 } }));
  });
  const h = await harness(t, service(origin));
  const result = await h.core.call('local-test.list', {}, { profile: 'work' });
  assert.equal(result.ok, true); assert.equal(calls, 2); assert.equal(h.syncs(), 1);
});
