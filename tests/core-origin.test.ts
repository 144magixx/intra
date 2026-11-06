import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Core, type Bridge } from '../packages/core/src/index.js';
import { Registry } from '../packages/registry/src/index.js';
import { Credentials, MemorySecretStore } from '../packages/credentials/src/index.js';
import type { CookieSnapshot } from '../packages/contracts/src/index.js';
import { temp, server, service, operation } from './support.js';

test('cross-origin authentication failures never borrow the original origin identity probe', async t => {
  let mode = 403, probes = 0, syncs = 0;
  const destination = await server(t, (_req, res) => {
    if (mode === 403) { res.statusCode = 403; res.end('{}'); }
    else if (mode === 304) res.end('{"code":304}');
    else { res.writeHead(302, { location: 'https://sso.example.test/login' }); res.end(); }
  });
  const origin = await server(t, (req, res) => {
    if (req.url === '/identity') { probes++; res.end('{"username":"same-user"}'); }
    else { res.writeHead(302, { location: destination + '/deny' }); res.end(); }
  });
  const home = await temp(t), registry = new Registry(path.join(home, 'registry'));
  const site = service(origin); site.allowedOrigins.push(destination);
  site.protocolExceptions!.push({ origin: destination, reason: 'Synthetic allowed target' });
  site.auth.identityProbeOperation = 'local-test.identity';
  site.auth.authFailureRules!.push({ kind: 'loginRedirect', origin: 'https://sso.example.test', pathPrefix: '/login' });
  await registry.register(site); await registry.register(operation());
  const identity = operation(); identity.id = 'local-test.identity'; identity.bindings = [];
  identity.request = { method: 'GET', path: '/identity' }; identity.response = { success: { httpStatuses: [200] }, identityPointer: '/username' };
  await registry.register(identity);
  const credentials = new Credentials({ store: new MemorySecretStore(), home });
  const profileId = '901f2c70-1111-4111-8111-111111111111', extensionId = 'a'.repeat(32);
  const connection = { profileId, storeIds: ['0'], extensionId, confirmed: true };
  const snapshot: CookieSnapshot = { profileId, storeId: '0', snapshotId: 'synthetic', observedAt: new Date().toISOString(), cookies: [{
    name: 'session', value: 'SYNTHETIC', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: true, sameSite: 'unspecified', session: true, storeId: '0',
  }] };
  const bridge: Bridge = { async listProfiles() { return [connection]; }, async getConnection() { return connection; }, async snapshot() { syncs++; return snapshot; } };
  const core = new Core({ registry, credentials, bridge, home });
  await core.pairProfile('work', profileId);
  await credentials.saveSnapshot('work', site, snapshot, 'same-user', origin + '/');
  await credentials.saveSnapshot('work', site, snapshot, 'same-user', destination + '/');
  for (const status of [403, 304, 302]) {
    mode = status;
    const result = await core.call('local-test.list', {}, { profile: 'work' });
    assert.equal(result.error?.code, 'AUTH_STATE_UNDETERMINED');
  }
  assert.equal(probes, 0); assert.equal(syncs, 0);
});
