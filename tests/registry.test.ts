import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { IntraError, projectRoot, type Operation, type Service } from '../packages/contracts/src/index.js';
import { Registry, materialize, validateOperation, validateRequest, validateService } from '../packages/registry/src/index.js';

const rejectsCode = (code: string) => (error: unknown): boolean => error instanceof IntraError && error.code === code;
function service(): Service {
  return { schemaVersion: 1, id: 'synthetic', baseUrl: 'https://synthetic.invalid', allowedOrigins: ['https://synthetic.invalid'], auth: { cookieNames: ['session'] } };
}
function operation(): Operation {
  return {
    schemaVersion: 1, id: 'synthetic.list', service: 'synthetic', description: 'Synthetic read-only test operation', status: 'verified', semantics: 'read',
    arguments: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 }, enabled: { type: 'boolean', default: false } }, additionalProperties: false },
    request: { method: 'POST', path: '/list', query: { enabled: true }, headers: { Accept: 'application/json' }, body: { page: 0, nested: { 'a/b': [null] } } },
    bindings: [{ argument: 'page', target: 'body', pointer: '/page' }, { argument: 'enabled', target: 'query', pointer: '/enabled' }],
    response: { success: { httpStatuses: [200], code: { pointer: '/code', equals: '200' } }, itemsPointer: '/data/items' },
    provenance: { source: 'manual', verifiedAt: '2026-01-01T00:00:00Z', evidence: ['Synthetic fixture only; no production request'] },
  };
}
async function registry(t: TestContext): Promise<Registry> {
  const root = await mkdtemp(join(tmpdir(), 'intra-registry-test-'));
  t.after(async () => {
    const absolute = resolve(root);
    if (dirname(absolute) !== resolve(tmpdir()) || !absolute.includes('intra-registry-test-')) throw new Error('Unexpected cleanup path');
    await rm(absolute, { recursive: true, force: true });
  });
  return new Registry(root);
}

test('materialize preserves scalar types, defaults and template isolation', () => {
  const definition = operation();
  const before = structuredClone(definition);
  const args = { page: 2 };
  const request = materialize(service(), definition, args);
  assert.deepEqual(request.body, { page: 2, nested: { 'a/b': [null] } });
  assert.equal(request.query?.enabled, false);
  assert.equal(request.url, 'https://synthetic.invalid/list?enabled=false');
  assert.deepEqual(definition, before);
  assert.deepEqual(args, { page: 2 });
  assert.deepEqual(materialize(service(), definition, {}).body, { page: 1, nested: { 'a/b': [null] } });
  assert.throws(() => materialize(service(), definition, { page: '2' }), rejectsCode('INVALID_ARGUMENT'));
  assert.throws(() => materialize(service(), definition, { unexpected: 2 }), rejectsCode('INVALID_ARGUMENT'));
});

test('bindings preserve structured JSON and escaped paths; root replacements are explicit', () => {
  const definition = operation();
  definition.arguments = { type: 'object', properties: { filter: { type: ['object', 'array', 'null', 'boolean'] } }, required: ['filter'], additionalProperties: false };
  definition.bindings = [{ argument: 'filter', target: 'body', pointer: '/nested/a~1b/0' }];
  const filter = { ids: [1, 2], active: false };
  assert.deepEqual((materialize(service(), definition, { filter }).body as { nested: { 'a/b': unknown[] } }).nested['a/b'][0], filter);
  definition.bindings = [{ argument: 'filter', target: 'body', pointer: '' }];
  assert.deepEqual(materialize(service(), definition, { filter }).body, filter);
  assert.equal(materialize(service(), definition, { filter: null }).body, null);
});

test('bindings reject missing targets, unsafe pointers, undeclared arguments and overlap', () => {
  const invalidBindings: Operation['bindings'][] = [
    [{ argument: 'page', target: 'body', pointer: '/missing' }],
    [{ argument: 'page', target: 'body', pointer: '/missing/child' }],
    [{ argument: 'page', target: 'body', pointer: '/__proto__/polluted' }],
    [{ argument: 'absent', target: 'body', pointer: '/page' }],
    [{ argument: 'page', target: 'body', pointer: '/page' }, { argument: 'enabled', target: 'body', pointer: '/page' }],
    [{ argument: 'page', target: 'body', pointer: '' }, { argument: 'enabled', target: 'body', pointer: '/page' }],
  ];
  for (const bindings of invalidBindings) {
    const definition = operation(); definition.bindings = bindings;
    assert.throws(() => validateOperation(definition), rejectsCode('CONTRACT_INVALID'));
  }
  const missing = operation(); delete missing.request.query;
  assert.throws(() => validateOperation(missing), rejectsCode('CONTRACT_INVALID'));
});

test('URLs encode scalar queries once, retain percent/Unicode data and reject implicit arrays', () => {
  const url = validateRequest(service(), { method: 'GET', path: '/search', query: { q: '中文 & a=1 100%', active: false, page: 2 } });
  assert.equal(url.searchParams.get('q'), '中文 & a=1 100%');
  assert.equal(url.searchParams.get('active'), 'false');
  assert.equal(url.searchParams.get('page'), '2');
  const embedded = validateRequest(service(), { method: 'GET', path: '/search?q=100%25&name=%E4%B8%AD%E6%96%87%20text' });
  assert.equal(embedded.searchParams.get('q'), '100%');
  assert.equal(embedded.searchParams.get('name'), '中文 text');
  assert.equal(validateRequest(service(), { method: 'GET', path: '/literal%25bc' }).pathname, '/literal%25bc');
  for (const value of [[1, 2], { a: 1 }, null]) assert.throws(() => validateRequest(service(), { method: 'GET', path: '/', query: { q: value } }), rejectsCode('CONTRACT_INVALID'));
  assert.throws(() => validateRequest(service(), { method: 'GET', path: '/?q=1', query: { q: 2 } }), rejectsCode('CONTRACT_INVALID'));
});

test('URL policies reject origin injection, ambiguous URL metadata and unsupported methods', () => {
  for (const path of ['https://evil.invalid/x', '//evil.invalid/x', '/\\evil.invalid/x', '/%2Fevil.invalid/x', '/%252fevil.invalid/x', '/%5cevil.invalid/x', '/%255cevil.invalid/x', '/x#secret', '/x\n', '/%00x']) {
    assert.throws(() => validateRequest(service(), { method: 'GET', path }), rejectsCode('CONTRACT_INVALID'), path);
  }
  for (const method of ['get', 'TRACE', 'CONNECT', 'GET\r\nHost:evil.invalid']) {
    assert.throws(() => validateRequest(service(), { method, path: '/' }), rejectsCode('CONTRACT_INVALID'));
  }
  assert.throws(() => validateRequest(service(), { method: 'GET', path: '/', url: 'https://evil.invalid/' }), rejectsCode('CONTRACT_INVALID'));
  assert.throws(() => validateRequest(service(), { method: 'GET', path: '/', body: {} }), rejectsCode('CONTRACT_INVALID'));
  let invoked = false;
  const request = { method: 'GET', path: '/' };
  Object.defineProperty(request, 'headers', { enumerable: true, get: () => { invoked = true; return {}; } });
  assert.throws(() => validateRequest(service(), request), rejectsCode('CONTRACT_INVALID'));
  assert.equal(invoked, false);
});

test('service origins are exact and HTTP exceptions do not broaden origin policy', () => {
  for (const baseUrl of ['https://user:pass@synthetic.invalid', 'https://synthetic.invalid/path', 'https://synthetic.invalid/', 'https://synthetic.invalid#x', 'https://synthetic.invalid:443', 'https://SYNTHETIC.invalid']) {
    const definition = service(); definition.baseUrl = baseUrl;
    assert.throws(() => validateService(definition), rejectsCode('CONTRACT_INVALID'));
  }
  const http = service(); http.baseUrl = 'http://synthetic.invalid'; http.allowedOrigins = [http.baseUrl];
  assert.throws(() => validateService(http), rejectsCode('CONTRACT_INVALID'));
  http.protocolExceptions = [{ origin: http.baseUrl, reason: 'Synthetic HTTP fixture' }];
  assert.equal(validateRequest(http, { method: 'GET', path: '/' }).protocol, 'http:');
  http.allowedOrigins.push('http://other.invalid');
  assert.throws(() => validateService(http), rejectsCode('CONTRACT_INVALID'));
  http.allowedOrigins.pop(); http.protocolExceptions[0]!.reason = ' ';
  assert.throws(() => validateService(http), rejectsCode('CONTRACT_INVALID'));
});

test('request definitions cannot inject authentication, host, proxy or transport headers', () => {
  for (const name of ['Cookie', 'cOoKiE', 'Authorization', 'Proxy-Authorization', 'Host', 'Content-Length', 'Connection', 'Transfer-Encoding', 'X-Api-Key', 'X-Csrf-Token', 'X-Forwarded-Host', 'Sec-Fetch-Site', 'Origin', 'Referer', 'Bad Header']) {
    const definition = operation(); definition.request.headers = { [name]: 'SYNTHETIC_SECRET' };
    assert.throws(() => validateOperation(definition), error => {
      assert.ok(error instanceof IntraError);
      assert.ok(!error.message.includes('SYNTHETIC_SECRET'));
      return error.code === 'CONTRACT_INVALID';
    });
  }
  for (const headers of [{ Accept: 'application/json', accept: 'text/plain' }, { 'X-Trace': 'ok\r\nCookie: bad' }] as Record<string, string>[]) {
    assert.throws(() => validateRequest(service(), { method: 'GET', path: '/', headers }), rejectsCode('CONTRACT_INVALID'));
  }
});

test('verified provenance needs real timestamp syntax and evidence, and semantics are never inferred', () => {
  for (const verifiedAt of [undefined, '', 'not-a-date', '2026-02-30T00:00:00Z', '2999-01-01T00:00:00Z', '2026-01-01']) {
    const definition = operation();
    if (verifiedAt === undefined) delete definition.provenance.verifiedAt; else definition.provenance.verifiedAt = verifiedAt;
    assert.throws(() => validateOperation(definition), rejectsCode('CONTRACT_INVALID'));
  }
  const noEvidence = operation(); delete noEvidence.provenance.evidence;
  assert.throws(() => validateOperation(noEvidence), rejectsCode('CONTRACT_INVALID'));
  const draft = operation(); draft.status = 'draft'; delete draft.provenance.verifiedAt;
  assert.equal(validateOperation(draft).status, 'draft');
  assert.throws(() => materialize(service(), draft, {}), rejectsCode('OPERATION_UNVERIFIED'));
  const unknown = operation(); unknown.semantics = 'unknown';
  assert.equal(validateOperation(unknown).semantics, 'unknown');
  assert.equal(materialize(service(), unknown, {}).method, 'POST');
});

test('registry persists validated files atomically with conflict detection and explicit replacement', async t => {
  const store = await registry(t);
  assert.deepEqual(await store.register(service()), { id: 'synthetic', kind: 'service' });
  assert.deepEqual(await store.register(operation()), { id: 'synthetic.list', kind: 'operation' });
  await assert.rejects(store.register(operation()), rejectsCode('REGISTRY_CONFLICT'));
  const replaced = operation(); replaced.description = 'Replacement';
  await store.register(replaced, { replace: true });
  assert.equal((await new Registry(store.root).getOperation(replaced.id)).description, 'Replacement');
  assert.equal((await stat(join(store.root, 'operations', `${replaced.id}.json`))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(store.root, 'operations')), [`${replaced.id}.json`]);
  const resolution = await store.resolve(replaced.id, { page: 4 });
  assert.equal(resolution.operation.semantics, 'read');
  assert.equal((resolution.request.body as { page: number }).page, 4);
  assert.equal(resolution.service.id, 'synthetic');
});

test('concurrent no-replace registrations have exactly one winner and never leave partial data', async t => {
  const store = await registry(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => store.register({ ...operation(), description: `Concurrent fixture ${index}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.ok(rejectsCode('REGISTRY_CONFLICT')(result.reason));
  assert.match((await store.getOperation('synthetic.list')).description, /^Concurrent fixture \d$/);
  assert.deepEqual(await readdir(join(store.root, 'operations')), ['synthetic.list.json']);
});

test('registry rejects traversal IDs, corrupt data, mismatched identities and symlinks', async t => {
  const store = await registry(t);
  for (const id of ['../escape', '/absolute', 'a/b', '.', '..', 'constructor', '__proto__', 'a\\b', 'a%2fb']) {
    await assert.rejects(store.getOperation(id), rejectsCode('CONTRACT_INVALID'));
    await assert.rejects(store.register({ ...operation(), id }), rejectsCode('CONTRACT_INVALID'));
  }
  await assert.rejects(store.getOperation('missing'), rejectsCode('OPERATION_NOT_FOUND'));
  await assert.rejects(store.getService('missing'), rejectsCode('SERVICE_NOT_FOUND'));
  await store.register(operation());
  const file = join(store.root, 'operations', 'synthetic.list.json');
  await writeFile(file, '{"secret":"SYNTHETIC_BROKEN_JSON"');
  await assert.rejects(store.getOperation('synthetic.list'), rejectsCode('CONTRACT_INVALID'));
  await writeFile(file, JSON.stringify({ ...operation(), id: 'other.id' }));
  await assert.rejects(store.getOperation('synthetic.list'), rejectsCode('CONTRACT_INVALID'));
  const link = join(store.root, 'operations', 'linked.json');
  await symlink(file, link);
  await assert.rejects(store.getOperation('linked'), rejectsCode('REGISTRY_ERROR'));
  const another = new Registry(join(store.root, 'linked-root'));
  await symlink(join(store.root, 'operations'), another.root);
  await assert.rejects(another.register(operation()), rejectsCode('REGISTRY_ERROR'));
});

test('resolve requires any configured probe to be verified, read-only and same-service', async t => {
  const store = await registry(t);
  const target = service(); target.auth.identityProbeOperation = 'synthetic.identity';
  await store.register(target);
  await store.register(operation());
  await assert.rejects(store.resolve('synthetic.list', {}), rejectsCode('OPERATION_NOT_FOUND'));
  const probe = operation(); probe.id = 'synthetic.identity'; probe.response.identityPointer = '/username';
  probe.service = 'other'; await store.register(probe);
  await assert.rejects(store.resolve('synthetic.list', {}), rejectsCode('CONTRACT_INVALID'));
  probe.service = target.id; probe.semantics = 'write'; await store.register(probe, { replace: true });
  await assert.rejects(store.resolve('synthetic.list', {}), rejectsCode('CONTRACT_INVALID'));
  probe.semantics = 'read'; probe.status = 'draft'; await store.register(probe, { replace: true });
  await assert.rejects(store.resolve('synthetic.list', {}), rejectsCode('CONTRACT_INVALID'));
  probe.status = 'verified'; await store.register(probe, { replace: true });
  assert.equal((await store.resolve('synthetic.list', {})).operation.id, 'synthetic.list');
});

test('registerFile imports every local example and materializes all known operations offline', async t => {
  const store = await registry(t);
  for (const name of ['risk-api', 'logwatch', 'devcloud']) await store.registerFile(join(projectRoot, 'examples', 'services', `${name}.json`));
  for (const name of ['risk-api.auto-interfaces.list', 'logwatch.principal', 'devcloud.current-user']) {
    await store.registerFile(join(projectRoot, 'examples', 'operations', `${name}.json`));
  }
  for (const name of ['risk-api.auto-interfaces.list', 'logwatch.principal', 'devcloud.current-user']) assert.ok((await store.resolve(name, {})).request.url);
  const content = JSON.parse(await readFile(join(store.root, 'operations', 'risk-api.auto-interfaces.list.json'), 'utf8'));
  assert.equal(content.request.body.pageNo, 1);
});
