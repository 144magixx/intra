import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { executeHttp, classify, persist, HttpFailure } from '../packages/http/src/index.js';
import { materialize } from '../packages/registry/src/index.js';
import { temp, server, service, operation, body } from './support.js';

const credentials = { async cookieHeader() { return 'session=SYNTHETIC_HTTP_SECRET'; }, async acceptSetCookie() {} };
const jsonSuccess = { code: '200', data: { items: [{ id: 1 }], total: 37 }, token: 'BUSINESS_TOKEN_NOT_FOR_SUMMARY' };

async function requestBytes(request: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('raw form payloads retain exact UTF-8 bytes while scalar queries and safe headers reach HTTP', async t => {
  const observed: Array<{ bytes: Buffer; url: string; contentType?: string; accept?: string; cookie?: string; context?: string }> = [];
  const origin = await server(t, async (req, res) => {
    observed.push({ bytes: await requestBytes(req), url: req.url!, contentType: req.headers['content-type'],
      accept: req.headers.accept, cookie: req.headers.cookie, context: req.headers['x-request-context'] as string });
    res.end('{}');
  });
  const payloads = ['name=%E4%B8%AD&space=a+b&literal=%2B&active=false\r\n', '\uFEFFmessage=中文&emoji=☀️\n', ''];
  for (const rawBody of payloads) {
    await executeHttp({ service: service(origin), request: { method: 'POST', path: '/form?existing=original', rawBody,
      query: { page: 2, active: false, search: 'a b&c' },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Accept: 'application/json', 'X-Request-Context': 'synthetic' } },
    semantics: 'unknown', credentials });
  }
  assert.equal(observed.length, payloads.length);
  for (const [index, received] of observed.entries()) {
    assert.deepEqual(received.bytes, Buffer.from(payloads[index], 'utf8'));
    const url = new URL(received.url, origin);
    assert.equal(url.pathname, '/form');
    assert.deepEqual([...url.searchParams.entries()], [['existing', 'original'], ['page', '2'], ['active', 'false'], ['search', 'a b&c']]);
    assert.equal(received.contentType, 'application/x-www-form-urlencoded; charset=utf-8');
    assert.equal(received.accept, 'application/json'); assert.equal(received.context, 'synthetic');
    assert.equal(received.cookie, 'session=SYNTHETIC_HTTP_SECRET');
  }
});

test('JSON scalar bodies preserve types and only JSON bodies receive default JSON Content-Type', async t => {
  const observed: Array<{ bytes: Buffer; contentType?: string }> = [];
  const origin = await server(t, async (req, res) => {
    observed.push({ bytes: await requestBytes(req), contentType: req.headers['content-type'] }); res.end('{}');
  });
  const payloads = [2, false, null, 'text', [1, false], { page: 2, active: false }];
  for (const payload of payloads) {
    await executeHttp({ service: service(origin), request: { method: 'POST', path: '/', body: payload }, semantics: 'unknown', credentials });
  }
  await executeHttp({ service: service(origin), request: { method: 'GET', path: '/' }, semantics: 'unknown', credentials });
  for (const [index, payload] of payloads.entries()) {
    assert.equal(observed[index].bytes.toString('utf8'), JSON.stringify(payload));
    assert.deepEqual(JSON.parse(observed[index].bytes.toString('utf8')), payload);
    assert.equal(observed[index].contentType, 'application/json');
  }
  assert.equal(observed.at(-1)!.bytes.length, 0); assert.equal(observed.at(-1)!.contentType, undefined);
});

test('safe read redirects drop both body forms on GET conversion and preserve raw bodies for 307/308', async t => {
  const observed: Array<{ method?: string; bytes: Buffer; contentType?: string }> = [];
  const origin = await server(t, async (req, res) => {
    const bytes = await requestBytes(req);
    if (req.url!.startsWith('/redirect/')) {
      res.writeHead(Number(req.url!.split('/').at(-1)), { Location: '/final' }); res.end();
    } else {
      observed.push({ method: req.method, bytes, contentType: req.headers['content-type'] }); res.end('{}');
    }
  });
  for (const status of [301, 302, 303]) {
    for (const payload of [{ rawBody: 'active=false&literal=%2B' }, { body: { active: false } }]) {
      await executeHttp({ service: service(origin), request: { method: 'POST', path: `/redirect/${status}`, ...payload,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, semantics: 'read', credentials });
      assert.deepEqual(observed.at(-1), { method: 'GET', bytes: Buffer.alloc(0), contentType: undefined });
    }
  }
  for (const status of [307, 308]) {
    await executeHttp({ service: service(origin), request: { method: 'POST', path: `/redirect/${status}`, rawBody: 'active=false&literal=%2B',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, semantics: 'read', credentials });
    assert.deepEqual(observed.at(-1), { method: 'POST', bytes: Buffer.from('active=false&literal=%2B'), contentType: 'application/x-www-form-urlencoded' });
  }
  const received = observed.length;
  await assert.rejects(executeHttp({ service: service(origin), request: { method: 'POST', path: '/redirect/303', rawBody: 'active=false',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, semantics: 'unknown', credentials }), { code: 'REQUEST_OUTCOME_UNKNOWN' });
  assert.equal(observed.length, received);
});

test('typed bindings reach HTTP; body bytes persist intact and summary excludes response token', async t => {
  let observed: unknown;
  const origin = await server(t, async (req, res) => { observed = await body(req); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(jsonSuccess)); });
  const directory = await temp(t), target = path.join(directory, 'result.json');
  const site = service(origin), op = operation();
  const exchange = await executeHttp({ service: site, request: materialize(site, op, { page: 2, active: false }), semantics: 'read', credentials, output: target });
  assert.deepEqual(observed, { pageNo: 2, active: false });
  const classified = classify(exchange, op.response, site);
  assert.equal(classified.kind, 'success');
  assert.deepEqual(classified.summary, { count: 1, total: 37 });
  const artifact = await persist(exchange, target);
  assert.equal(await readFile(target, 'utf8'), JSON.stringify(jsonSuccess));
  assert.equal(artifact.bytes, Buffer.byteLength(JSON.stringify(jsonSuccess)));
  assert.equal(artifact.complete, true);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['result.json']);
});

test('HTTP 200 does not mask changed code type, missing lists, or auth 304', () => {
  const site = service('http://127.0.0.1:1234'), rules = operation().response;
  const exchange = (value: unknown) => ({ status: 200, json: value, validJSON: true, bytes: 1, format: 'json' as const, elapsedMs: 0 });
  assert.equal(classify(exchange({ ...jsonSuccess, code: 200 }), rules, site).kind, 'businessError');
  assert.equal(classify(exchange({ code: '200', data: { total: 1 } }), rules, site).kind, 'schemaMismatch');
  assert.equal(classify(exchange({ code: 304 }), rules, site).kind, 'authExpired');
  assert.equal(classify({ ...exchange({ code: 403 }), status: 403 }, rules, site).kind, 'ambiguous');
  assert.equal(classify({ ...exchange(undefined), validJSON: false }, rules, site).kind, 'schemaMismatch');
});

test('existing output is rejected before sending a business request', async t => {
  let calls = 0;
  const origin = await server(t, (_req, res) => { calls++; res.end('{}'); });
  const target = path.join(await temp(t), 'existing.json'); await writeFile(target, 'keep');
  await assert.rejects(executeHttp({ service: service(origin), request: { method: 'GET', path: '/' }, semantics: 'read', credentials, output: target }), { code: 'OUTPUT_EXISTS' });
  assert.equal(calls, 0); assert.equal(await readFile(target, 'utf8'), 'keep');
});

test('commit race never overwrites a destination created during HTTP', async t => {
  const origin = await server(t, (_req, res) => res.end('{}'));
  const target = path.join(await temp(t), 'race.json');
  const exchange = await executeHttp({ service: service(origin), request: { method: 'GET', path: '/' }, semantics: 'read', credentials, output: target });
  await writeFile(target, 'other-result', { flag: 'wx' });
  await assert.rejects(persist(exchange, target), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(target, 'utf8'), 'other-result');
});

test('decoded gzip body obeys byte budget and records real partial bytes', async t => {
  const origin = await server(t, (_req, res) => { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(JSON.stringify({ payload: 'x'.repeat(5000) }))); });
  const directory = await temp(t), target = path.join(directory, 'large.json');
  try {
    await executeHttp({ service: service(origin), request: { method: 'GET', path: '/' }, semantics: 'read', credentials, output: target, maxBytes: 100 });
    assert.fail('Expected budget error');
  } catch (error) {
    assert.ok(error instanceof HttpFailure); assert.equal(error.code, 'RESPONSE_TOO_LARGE');
    assert.equal(error.artifact?.complete, false); assert.equal(error.artifact?.bytes, 100);
    assert.equal((await readFile(error.artifact!.path)).length, 100);
    assert.match(error.artifact!.path, /\.partial$/);
  }
  assert.equal((await readdir(directory)).includes('large.json'), false);
});

test('body timeout covers body reception and preserves partial data', async t => {
  const origin = await server(t, (_req, res) => { res.writeHead(200); res.write('{"wait":'); });
  const target = path.join(await temp(t), 'timeout.json');
  await assert.rejects(executeHttp({ service: service(origin), request: { method: 'GET', path: '/' }, semantics: 'read', credentials, output: target, timeoutMs: 100 }), (error: unknown) => {
    assert.ok(error instanceof HttpFailure); assert.equal(error.code, 'REQUEST_TIMEOUT'); assert.equal(error.artifact?.complete, false); return true;
  });
});

test('write and unknown requests never replay after server performs write then disconnects', async t => {
  let writes = 0;
  const origin = await server(t, (req, _res) => { writes++; req.socket.destroy(); });
  for (const semantics of ['write', 'unknown'] as const) {
    await assert.rejects(executeHttp({ service: service(origin), request: { method: 'POST', path: '/', body: {} }, semantics, credentials }), { code: 'REQUEST_OUTCOME_UNKNOWN' });
  }
  assert.equal(writes, 2);
});

test('cross-origin redirect uses newly selected cookies and drops CSRF headers', async t => {
  let receivedCookie: string | undefined, receivedCSRF: string | undefined;
  const destination = await server(t, (req, res) => { receivedCookie = req.headers.cookie; receivedCSRF = req.headers['x-request-context'] as string; res.end('{}'); });
  const origin = await server(t, (_req, res) => { res.writeHead(302, { location: destination + '/final' }); res.end(); });
  const site = service(origin); site.allowedOrigins.push(destination); site.protocolExceptions!.push({ origin: destination, reason: 'Synthetic redirect target' });
  const urls: string[] = [];
  const provider = { async cookieHeader(url: string) { urls.push(url); return new URL(url).origin === origin ? 'session=ORIGIN_A' : 'session=ORIGIN_B'; }, async acceptSetCookie() {} };
  await executeHttp({ service: site, request: { method: 'GET', path: '/', headers: { 'X-Request-Context': 'SENSITIVE_A' } }, semantics: 'read', credentials: provider });
  assert.equal(receivedCookie, 'session=ORIGIN_B'); assert.equal(receivedCSRF, undefined); assert.equal(urls.length, 2);
});

test('unapproved redirect origin and write redirects are stopped', async t => {
  let targetCalls = 0;
  const destination = await server(t, (_req, res) => { targetCalls++; res.end('{}'); });
  const origin = await server(t, (_req, res) => { res.writeHead(307, { location: destination }); res.end(); });
  await assert.rejects(executeHttp({ service: service(origin), request: { method: 'GET', path: '/' }, semantics: 'read', credentials }), { code: 'CONTRACT_INVALID' });
  await assert.rejects(executeHttp({ service: service(origin), request: { method: 'POST', path: '/', body: {} }, semantics: 'write', credentials }), { code: 'REQUEST_OUTCOME_UNKNOWN' });
  assert.equal(targetCalls, 0);
});

test('only known login redirects classify as expired without following a ticket URL', async t => {
  const origin = await server(t, (_req, res) => { res.writeHead(302, { location: 'https://sso.example.test/login?ticket=SECRET_TICKET' }); res.end(); });
  const site = service(origin); site.auth.authFailureRules!.push({ kind: 'loginRedirect', origin: 'https://sso.example.test', pathPrefix: '/login' });
  await assert.rejects(executeHttp({ service: site, request: { method: 'GET', path: '/' }, semantics: 'read', credentials }), (error: unknown) => {
    assert.ok(error instanceof HttpFailure); assert.equal(error.code, 'AUTH_EXPIRED'); assert.equal(error.message.includes('SECRET_TICKET'), false); return true;
  });
});
