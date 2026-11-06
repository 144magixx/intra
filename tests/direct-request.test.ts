import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { Core, directServiceForURL, type Bridge } from '../packages/core/src/index.js';
import { Registry } from '../packages/registry/src/index.js';
import { Credentials, MemorySecretStore } from '../packages/credentials/src/index.js';
import { runCLI } from '../apps/cli/src/main.js';
import { validate, type SnapshotParams, type CookieSnapshot } from '../packages/contracts/src/index.js';
import { temp, server, body, service as serviceDefinition, operation } from './support.js';

async function directHarness(t: TestContext) {
  const home = await temp(t);
  const credentials = new Credentials({ home, store: new MemorySecretStore() });
  const registry = new Registry(path.join(home, 'registry'));
  const profileId = '76bc786e-51ac-47ec-9821-062d2c5268b8';
  const connection = { profileId, storeIds: ['0'], extensionId: 'a'.repeat(32), confirmed: true };
  const snapshots: SnapshotParams[] = [];
  const bridge: Bridge = {
    async listProfiles() { return [connection]; },
    async getConnection() { return connection; },
    async snapshot(params) {
      snapshots.push(structuredClone(params));
      const snapshot: CookieSnapshot = { profileId, storeId: '0', snapshotId: `snapshot-${snapshots.length}`, observedAt: new Date().toISOString(),
        cookies: ['session', 'preference'].map(name => ({ name, value: `SYNTHETIC_${name}`, domain: new URL(params.url).hostname, path: '/', hostOnly: true, secure: false, httpOnly: true, sameSite: 'unspecified', session: true, storeId: '0' })) };
      return snapshot;
    },
  };
  const core = new Core({ home, credentials, registry, bridge });
  await core.pairProfile('work', profileId);
  return { core, home, snapshots, registry, credentials, bridge };
}

test('explicit URL plus JSON file executes once without registration or identity probes', async t => {
  let requests = 0, observed: unknown, cookie = '';
  const origin = await server(t, async (req, res) => { requests++; observed = await body(req); cookie = req.headers.cookie ?? ''; res.end('{"code":200,"data":{"count":1},"token":"SYNTHETIC_RESPONSE_TOKEN"}'); });
  const h = await directHarness(t);
  const input = path.join(h.home, 'payload.json'), output = path.join(h.home, 'response.json');
  await writeFile(input, JSON.stringify({ pageNo: 10, pageSize: 10, enabled: false, filters: { active: null } }), { mode: 0o600 });
  h.registry.getService = async () => { throw Error('Registration must not be required'); };
  h.registry.getOperation = async () => { throw Error('No probe or lookup is needed'); };
  const result = await runCLI(['request', '--url', origin + '/api/list', '--method', 'POST', '--profile', 'work', '--json-file', input, '--output', output], h.core);
  validate('tool-result', result);
  assert.equal(result.ok, true); assert.equal(requests, 1); assert.equal(h.snapshots.length, 1);
  assert.equal(Object.hasOwn(h.snapshots[0]!, 'cookieNames'), false);
  assert.deepEqual(observed, { pageNo: 10, pageSize: 10, enabled: false, filters: { active: null } });
  assert.ok(cookie.includes('session=SYNTHETIC_session') && cookie.includes('preference=SYNTHETIC_preference'));
  assert.deepEqual(result.data, { status: 'received', businessSuccess: 'unknown' });
  assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
  assert.match(await readFile(output, 'utf8'), /SYNTHETIC_RESPONSE_TOKEN/);
  await assert.rejects(access(path.join(h.home, 'registry')));
});

test('same URL path with changed page query reuses cache and performs only one request per command', async t => {
  const seen: string[] = [];
  const origin = await server(t, (req, res) => { seen.push(req.url!); res.end('{}'); });
  const h = await directHarness(t);
  const first = await h.core.requestURL(origin + '/items?page=1', { method: 'GET' }, { profile: 'work' });
  const second = await h.core.requestURL(origin + '/items?page=10', { method: 'GET' }, { profile: 'work' });
  assert.ok(first.ok && second.ok); assert.equal(h.snapshots.length, 1);
  assert.deepEqual(seen, ['/items?page=1', '/items?page=10']);
  assert.equal(second.meta.authRefreshed, false);
  assert.equal(first.meta.serviceId, second.meta.serviceId);
});

test('a different path takes a fresh complete URL snapshot', async t => {
  const origin = await server(t, (_req, res) => res.end('{}'));
  const h = await directHarness(t);
  assert.equal((await h.core.requestURL(origin + '/one', { method: 'GET' }, { profile: 'work' })).ok, true);
  assert.equal((await h.core.requestURL(origin + '/two', { method: 'GET' }, { profile: 'work' })).ok, true);
  assert.deepEqual(h.snapshots.map(item => new URL(item.url).pathname), ['/one', '/two']);
});

test('different explicit origins get distinct credential scopes', async t => {
  const first = await server(t, (_req, res) => res.end('{}'));
  const second = await server(t, (_req, res) => res.end('{}'));
  const h = await directHarness(t);
  const a = await h.core.requestURL(first + '/items', { method: 'GET' }, { profile: 'work' });
  const b = await h.core.requestURL(second + '/items', { method: 'GET' }, { profile: 'work' });
  assert.ok(a.ok && b.ok); assert.notEqual(a.meta.serviceId, b.meta.serviceId); assert.equal(h.snapshots.length, 2);
});

test('direct raw form file preserves the supplied UTF-8 bytes and content type', async t => {
  let text = '', contentType: string | undefined;
  const origin = await server(t, async (req, res) => {
    for await (const chunk of req) text += chunk.toString('utf8');
    contentType = req.headers['content-type']; res.end('{}');
  });
  const h = await directHarness(t);
  const input = path.join(h.home, 'form.txt');
  const expected = '\uFEFFquery=%E6%B5%8B%E8%AF%95&page=10\r\n';
  await writeFile(input, expected, { mode: 0o600 });
  const result = await runCLI(['request', '--url', origin + '/search', '--profile', 'work', '--method', 'POST', '--body-file', input, '--content-type', 'application/x-www-form-urlencoded'], h.core);
  assert.equal(result.ok, true); assert.equal(text, expected); assert.equal(contentType, 'application/x-www-form-urlencoded');
});

test('invalid explicit requests stop before browser synchronization or network', async t => {
  let requests = 0;
  const origin = await server(t, (_req, res) => { requests++; res.end('{}'); });
  const h = await directHarness(t);
  const options = { profile: 'work' };
  const invalid = [
    await h.core.requestURL('file:///etc/passwd', { method: 'GET' }, options),
    await h.core.requestURL('https://user:SYNTHETIC_SECRET@example.com/', { method: 'GET' }, options),
    await h.core.requestURL(origin + '/#fragment', { method: 'GET' }, options),
    await h.core.requestURL(origin + '/#', { method: 'GET' }, options),
    await h.core.requestURL(origin, { method: 'TRACE' }, options),
    await h.core.requestURL(origin, { method: 'GET', headers: { Cookie: 'SYNTHETIC_SECRET' } }, options),
    await h.core.requestURL(origin + '/?page=1', { method: 'GET', query: { page: 10 } }, options),
    await h.core.requestURL(origin, { method: 'POST', body: {}, rawBody: 'x', headers: { 'Content-Type': 'text/plain' } }, options),
  ];
  assert.equal(invalid.every(result => !result.ok), true);
  assert.equal(requests, 0); assert.equal(h.snapshots.length, 0);
  assert.equal(JSON.stringify(invalid).includes('SYNTHETIC_SECRET'), false);
});

test('unknown direct requests do not follow redirects or replay after response loss', async t => {
  let destinationCalls = 0, writes = 0;
  const destination = await server(t, (_req, res) => { destinationCalls++; res.end('{}'); });
  const origin = await server(t, (req, res) => {
    writes++;
    if (req.url === '/redirect') { res.writeHead(307, { location: destination + '/target' }); res.end(); }
    else req.socket.destroy();
  });
  const h = await directHarness(t);
  for (const endpoint of ['/redirect', '/lost']) {
    const result = await h.core.requestURL(origin + endpoint, { method: 'POST', body: {} }, { profile: 'work' });
    assert.equal(result.error?.code, 'REQUEST_OUTCOME_UNKNOWN');
  }
  assert.equal(destinationCalls, 0); assert.equal(writes, 2);
});

test('URL-mode sync uses a separate complete snapshot for an identity-probe path', async t => {
  let probes = 0, business = 0;
  const origin = await server(t, (req, res) => {
    if (req.url === '/identity') { probes++; res.end('{"username":"synthetic-user"}'); }
    else { business++; res.end('{"code":"200","data":{"items":[],"total":0}}'); }
  });
  const h = await directHarness(t);
  const site = serviceDefinition(origin); delete site.auth.cookieNames;
  site.auth.identityProbeOperation = 'local-test.identity';
  const probe = operation(); probe.id = 'local-test.identity'; probe.request = { method: 'GET', path: '/identity' }; probe.bindings = [];
  probe.response = { success: { httpStatuses: [200] }, identityPointer: '/username' };
  await h.registry.register(site); await h.registry.register(operation()); await h.registry.register(probe);
  const result = await h.core.call('local-test.list', {}, { profile: 'work' });
  assert.equal(result.ok, true); assert.equal(probes, 1); assert.equal(business, 1);
  assert.deepEqual(h.snapshots.map(snapshot => new URL(snapshot.url).pathname), ['/list', '/identity']);
  const cached = await h.credentials.resolve('work', site, origin + '/list');
  assert.equal(cached.metadata.accountId, 'synthetic-user');
});

test('direct context limits HTTP exception to the explicitly supplied origin', () => {
  const { service } = directServiceForURL('http://example.test:8080/list');
  assert.deepEqual(service.allowedOrigins, ['http://example.test:8080']);
  assert.equal(service.protocolExceptions?.[0]?.origin, 'http://example.test:8080');
  assert.deepEqual(service.auth, {});
  assert.equal(directServiceForURL('https://example.test/a').service.protocolExceptions, undefined);
});
