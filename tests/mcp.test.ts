import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { Core, type Bridge } from '../packages/core/src/index.js';
import { Registry } from '../packages/registry/src/index.js';
import { Credentials, MemorySecretStore } from '../packages/credentials/src/index.js';
import { validate, type SnapshotParams, type CookieSnapshot, type ToolResult } from '../packages/contracts/src/index.js';
import { ToolSet } from '../apps/mcp/src/tools.js';
import { McpServer } from '../apps/mcp/src/server.js';
import { temp, server, body, service as serviceDefinition, operation } from './support.js';

async function harness(t: TestContext, options: { defaultProfile?: string; protocolVersion?: string } = {}) {
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
        cookies: [{ name: 'session', value: 'SYNTHETIC_SESSION', domain: new URL(params.url).hostname, path: '/', hostOnly: true, secure: false, httpOnly: true, sameSite: 'unspecified', session: true, storeId: '0' }] };
      return snapshot;
    },
  };
  const core = new Core({ home, credentials, registry, bridge });
  await core.pairProfile('work', profileId);
  const tools = new ToolSet({ core, home, maxTimeoutMs: 100_000, artifacts: new Set(), ...(options.defaultProfile ? { defaultProfile: options.defaultProfile } : {}) });
  const input = new PassThrough(), output = new PassThrough();
  const mcp = new McpServer(tools, input, output, () => undefined);
  const frames: any[] = [];
  const waiters = new Map<unknown, (frame: any) => void>();
  let pending = '';
  output.on('data', chunk => {
    pending += chunk.toString('utf8');
    for (let index = pending.indexOf('\n'); index !== -1; index = pending.indexOf('\n')) {
      const frame = JSON.parse(pending.slice(0, index)); // Every stdout line must be one JSON-RPC frame.
      pending = pending.slice(index + 1);
      frames.push(frame);
      waiters.get(frame.id)?.(frame);
    }
  });
  let nextId = 1;
  const send = (message: unknown) => input.write(typeof message === 'string' ? message + '\n' : JSON.stringify(message) + '\n');
  const request = (method: string, params?: unknown, id: number = nextId++) => new Promise<any>(resolve => {
    waiters.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  });
  const call = async (name: string, args: unknown): Promise<{ result: ToolResult; frame: any }> => {
    const frame = await request('tools/call', { name, arguments: args });
    const result = frame.result.structuredContent ?? JSON.parse(frame.result.content[0].text);
    validate('tool-result', result);
    assert.equal(frame.result.isError, !result.ok);
    return { result, frame };
  };
  t.after(() => { input.end(); });
  const init = await request('initialize', { protocolVersion: options.protocolVersion ?? '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { home, registry, snapshots, mcp, frames, send, request, call, init, input };
}

test('initialize negotiates the protocol and lists the tool contract', async t => {
  const h = await harness(t);
  assert.equal(h.init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(h.init.result.capabilities, { tools: { listChanged: false } });
  const { result } = await h.request('tools/list');
  const names = result.tools.map((tool: any) => tool.name);
  assert.deepEqual(names, ['intra_request', 'intra_call', 'intra_read_artifact', 'intra_list_operations', 'intra_describe_operation', 'intra_status', 'intra_auth_check']);
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.type, 'object');
  }
  const request = result.tools[0];
  assert.equal(request.annotations.readOnlyHint, false); assert.equal(request.annotations.idempotentHint, false);
  assert.equal(request.inputSchema.properties.timeoutMs.maximum, 100_000);
  assert.equal(names.some((name: string) => /pair|register|sync/.test(name)), false);
  const read = result.tools.find((tool: any) => tool.name === 'intra_read_artifact');
  assert.equal(read.annotations.readOnlyHint, true);
});

test('older protocol versions get text content without structured output', async t => {
  const h = await harness(t, { protocolVersion: '2024-11-05' });
  assert.equal(h.init.result.protocolVersion, '2024-11-05');
  const { result } = await h.request('tools/list');
  assert.equal(result.tools[0].outputSchema, undefined);
  const frame = await h.request('tools/call', { name: 'intra_list_operations', arguments: {} });
  assert.equal(frame.result.structuredContent, undefined);
  assert.equal(JSON.parse(frame.result.content[0].text).ok, true);
  const unsupported = await harness(t, { protocolVersion: '1999-01-01' });
  assert.equal(unsupported.init.result.protocolVersion, '2025-06-18');
});

test('intra_request sends one JSON request and the artifact is readable by structure and pointer', async t => {
  let requests = 0, observed: unknown, cookie = '';
  const origin = await server(t, async (req, res) => {
    requests++; observed = await body(req); cookie = req.headers.cookie ?? '';
    res.end(JSON.stringify({ code: '200', data: { records: [{ id: 1, name: '甲' }, { id: 2, name: '乙' }], total: 2 }, token: 'SYNTHETIC_RESPONSE_TOKEN' }));
  });
  const h = await harness(t);
  const { result, frame } = await h.call('intra_request', { url: origin + '/api/list?view=1', method: 'POST', profile: 'work', json: { pageNo: 10, pageSize: 10, enabled: false, filters: null } });
  assert.equal(result.ok, true); assert.equal(requests, 1); assert.equal(h.snapshots.length, 1);
  assert.deepEqual(observed, { pageNo: 10, pageSize: 10, enabled: false, filters: null });
  assert.equal(cookie, 'session=SYNTHETIC_SESSION');
  assert.deepEqual(result.data, { status: 'received', businessSuccess: 'unknown' });
  assert.equal(JSON.stringify(frame).includes('SYNTHETIC'), false);
  const artifact = result.artifact!.path;
  assert.equal(path.dirname(artifact), path.join(h.home, 'outputs'));
  const shape = (await h.call('intra_read_artifact', { path: artifact, structure: true })).result;
  assert.deepEqual((shape.data as any).structure.keys.data.keys.records, { type: 'array', length: 2, item: { type: 'object', keys: { id: { type: 'number' }, name: { type: 'string', length: 1 } } } });
  assert.equal(JSON.stringify(shape).includes('SYNTHETIC'), false);
  const records = (await h.call('intra_read_artifact', { path: artifact, pointer: '/data/records' })).result.data as any;
  assert.equal(records.found, true); assert.equal(records.length, 2); assert.deepEqual(JSON.parse(records.text), [{ id: 1, name: '甲' }, { id: 2, name: '乙' }]);
  const missing = (await h.call('intra_read_artifact', { path: artifact, pointer: '/data/absent' })).result.data as any;
  assert.equal(missing.found, false);
});

test('raw text bodies keep bytes and content type; default profile is applied', async t => {
  let text = '', contentType: string | undefined;
  const origin = await server(t, async (req, res) => {
    for await (const chunk of req) text += chunk.toString('utf8');
    contentType = req.headers['content-type']; res.end('{}');
  });
  const h = await harness(t, { defaultProfile: 'work' });
  const expected = '\uFEFFquery=%E6%B5%8B%E8%AF%95&page=10\r\n';
  const { result } = await h.call('intra_request', { url: origin + '/search', method: 'POST', text: expected, contentType: 'application/x-www-form-urlencoded' });
  assert.equal(result.ok, true); assert.equal(text, expected); assert.equal(contentType, 'application/x-www-form-urlencoded');
});

test('invalid tool arguments stop before browser sync or network and explain the fix', async t => {
  let requests = 0;
  const origin = await server(t, (_req, res) => { requests++; res.end('{}'); });
  const h = await harness(t);
  const base = { url: origin + '/x', profile: 'work' };
  const cases: Array<[unknown, RegExp | undefined]> = [
    [{ ...base, method: 'GET', headers: { Cookie: 'SYNTHETIC_SECRET' } }, undefined],
    [{ ...base, method: 'GET', headers: { 'X-Auth-Token': 'SYNTHETIC_SECRET' } }, undefined],
    [{ ...base, method: 'GET', json: {} }, /take no body/],
    [{ ...base, method: 'POST', json: {}, text: 'a', contentType: 'text/plain' }, /only one body/],
    [{ ...base, method: 'POST', text: 'a' }, /contentType is required/],
    [{ ...base, method: 'POST', json: {}, headers: { 'Content-Type': 'application/json' } }, /Content-Type/],
    [{ ...base, method: 'POST', service: 'local-test', path: '/x' }, /exactly one target/],
    [{ ...base, method: 'TRACE' }, /must be one of/],
    [{ ...base, method: 'GET', timeoutMs: 100_001 }, /timeoutMs/],
    [{ ...base, method: 'GET', query: { list: [1, 2] } }, /query/],
    [{ ...base, method: 'GET', extra: true }, /unknown property "extra"/],
    [{ url: origin + '/x', method: 'GET' }, /profile is required/],
    [{ ...base, url: 'file:///etc/passwd', method: 'GET' }, undefined],
    [{ ...base, url: origin + '/x?page=1', method: 'GET', query: { page: 2 } }, undefined],
  ];
  for (const [args, action] of cases) {
    const { result, frame } = await h.call('intra_request', args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.error!.code, /INVALID_ARGUMENT|CONTRACT_INVALID/);
    if (action) assert.match(result.error!.action ?? '', action);
    assert.equal(JSON.stringify(frame).includes('SYNTHETIC_SECRET'), false);
  }
  assert.equal(requests, 0); assert.equal(h.snapshots.length, 0);
});

test('unknown requests are not replayed after response loss', async t => {
  let writes = 0;
  const origin = await server(t, (req) => { writes++; req.socket.destroy(); });
  const h = await harness(t);
  const { result } = await h.call('intra_request', { url: origin + '/submit', method: 'POST', profile: 'work', json: {} });
  assert.equal(result.error?.code, 'REQUEST_OUTCOME_UNKNOWN'); assert.equal(writes, 1);
});

test('network tools run one at a time; cancelled queued calls never reach the network', async t => {
  let active = 0, peak = 0;
  const seen: string[] = [];
  const origin = await server(t, (req, res) => {
    active++; peak = Math.max(peak, active); seen.push(req.url!);
    setTimeout(() => { active--; res.end('{}'); }, 60);
  });
  const h = await harness(t);
  const args = (page: number) => ({ name: 'intra_request', arguments: { url: `${origin}/items?page=${page}`, method: 'GET', profile: 'work' } });
  const first = h.request('tools/call', args(1), 101);
  const second = h.request('tools/call', args(2), 102);
  h.request('tools/call', args(3), 103);
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 103, reason: 'test' } });
  await Promise.all([first, second]);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(peak, 1); assert.deepEqual(seen, ['/items?page=1', '/items?page=2']);
  assert.equal(h.frames.some(frame => frame.id === 103), false);
});

test('in-flight cancellation suppresses the response but does not abort or replay the request', async t => {
  let requests = 0;
  const origin = await server(t, (_req, res) => { requests++; setTimeout(() => res.end('{}'), 80); });
  const h = await harness(t);
  h.request('tools/call', { name: 'intra_request', arguments: { url: origin + '/slow', method: 'POST', profile: 'work', json: {} } }, 200);
  await new Promise(resolve => setTimeout(resolve, 30));
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 200 } });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(requests, 1); assert.equal(h.frames.some(frame => frame.id === 200), false);
});

test('intra_read_artifact only reads known artifacts and pages raw UTF-8 losslessly', async t => {
  const content = '前缀-' + 'é中😀'.repeat(400) + '-后缀';
  const origin = await server(t, (_req, res) => { res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end(content); });
  const h = await harness(t);
  const outside = path.join(h.home, 'secret.txt');
  await writeFile(outside, 'SYNTHETIC_SECRET', { mode: 0o600 });
  const denied = (await h.call('intra_read_artifact', { path: outside })).result;
  assert.equal(denied.ok, false); assert.match(denied.error!.action!, /Only artifacts/);
  const linked = (await h.call('intra_read_artifact', { path: path.join(h.home, 'outputs', '..', 'secret.txt') })).result;
  assert.equal(linked.ok, false);
  const custom = path.join(h.home, 'custom-response.txt');
  const { result } = await h.call('intra_request', { url: origin + '/text', method: 'GET', profile: 'work', output: custom });
  assert.equal(result.ok, true);
  let offset: number | null = 0, text = '';
  while (offset !== null) {
    const page = (await h.call('intra_read_artifact', { path: custom, offset, length: 333 })).result.data as any;
    text += page.text; offset = page.nextOffset;
  }
  assert.equal(text, content); assert.equal(text, await readFile(custom, 'utf8'));
  const notJson = (await h.call('intra_read_artifact', { path: custom, structure: true })).result;
  assert.match(notJson.error!.action!, /not valid JSON/);
});

test('registered operations are listed, described and called', async t => {
  const origin = await server(t, async (req, res) => {
    const input = await body(req) as { pageNo: number };
    res.end(JSON.stringify({ code: '200', data: { items: [input.pageNo], total: 7 } }));
  });
  const h = await harness(t);
  await h.registry.register(serviceDefinition(origin)); await h.registry.register(operation());
  const list = (await h.call('intra_list_operations', {})).result.data as any;
  assert.deepEqual(list.operations, [{ id: 'local-test.list', service: 'local-test', description: 'Synthetic read test', status: 'verified', semantics: 'read', verifiedAt: '2026-11-05T00:00:00Z' }]);
  const described = (await h.call('intra_describe_operation', { operationId: 'local-test.list' })).result.data as any;
  assert.equal(described.request.path, '/list');
  const called = (await h.call('intra_call', { operationId: 'local-test.list', profile: 'work', args: { page: 3 } })).result;
  assert.equal(called.ok, true); assert.deepEqual(called.data, { count: 1, total: 7 }); assert.equal(called.meta.operationId, 'local-test.list');
  const unknownArg = (await h.call('intra_call', { operationId: 'local-test.list', profile: 'work', args: { pageNumber: 3 } })).result;
  assert.equal(unknownArg.error?.code, 'INVALID_ARGUMENT');
  const status = (await h.call('intra_status', {})).result.data as any;
  assert.equal(status.nativeHost, 'connected'); assert.equal(status.keychain === 'not-checked' || status.keychain === 'unsupported-platform', true);
  assert.deepEqual(status.localProfiles.map((profile: any) => profile.alias), ['work']);
  assert.equal(JSON.stringify(status).includes('SYNTHETIC'), false);
  const check = (await h.call('intra_auth_check', { service: 'local-test', profile: 'work' })).result.data as any;
  assert.equal(check.status, 'UNKNOWN');
});

test('JSON-RPC framing errors are answered without disturbing later frames', async t => {
  const h = await harness(t);
  h.send('not json');
  h.send('[{"jsonrpc":"2.0","id":9,"method":"ping"}]');
  h.send('{"jsonrpc":"1.0","id":10,"method":"ping"}');
  const unknown = await h.request('resources/list');
  assert.equal(unknown.error.code, -32601);
  const unknownTool = await h.request('tools/call', { name: 'intra_exec', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  assert.deepEqual((await h.request('ping')).result, {});
  const errors = h.frames.filter(frame => frame.id === null).map(frame => frame.error.code);
  assert.deepEqual(errors, [-32700, -32600, -32600]);
  h.input.write('{"jsonrpc":"2.0","id":11,"method":"ping","params":{"pad":"' + 'x'.repeat(9 * 1024 * 1024));
  h.input.write('"}}\n');
  assert.deepEqual((await h.request('ping')).result, {});
  assert.equal(h.frames.some(frame => frame.id === 11), false);
  assert.equal(h.frames.filter(frame => frame.id === null && frame.error.code === -32700).length, 2);
});

test('requests before initialize are rejected except ping', async t => {
  const input = new PassThrough(), output = new PassThrough();
  const home = await temp(t);
  const credentials = new Credentials({ home, store: new MemorySecretStore() });
  const bridge: Bridge = { async listProfiles() { return []; }, async getConnection() { throw Error('unused'); }, async snapshot() { throw Error('unused'); } };
  const core = new Core({ home, credentials, registry: new Registry(path.join(home, 'registry')), bridge });
  new McpServer(new ToolSet({ core, home, maxTimeoutMs: 1000, artifacts: new Set() }), input, output, () => undefined);
  const lines: any[] = [];
  output.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) lines.push(JSON.parse(line)); });
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await new Promise(resolve => setTimeout(resolve, 50));
  input.end();
  assert.equal(lines.find(line => line.id === 1).error.code, -32002);
  assert.deepEqual(lines.find(line => line.id === 2).result, {});
});
