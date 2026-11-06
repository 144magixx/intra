import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { projectRoot, validate } from '../packages/contracts/src/index.js';
import { temp, server } from './support.js';

async function cli(home: string, args: string[]) {
  const entry = fileURLToPath(new URL('../apps/cli/src/main.js', import.meta.url));
  return await new Promise<{ exit: number | null; stdout: string; stderr: string; result: any }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, INTRA_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('exit', exit => {
      try { const result = JSON.parse(stdout); validate('tool-result', result); resolve({ exit, stdout, stderr, result }); }
      catch (error) { reject(error); }
    });
  });
}

test('CLI help and doctor work without credentials or a running browser', async t => {
  const home = await temp(t);
  const help = await cli(home, ['--help']); assert.equal(help.exit, 0); assert.ok(help.result.data.usage.length > 0);
  const doctor = await cli(home, ['doctor']); assert.equal(doctor.exit, 0); assert.equal(doctor.result.data.nativeHost, 'not-connected');
  assert.equal(doctor.result.data.keychain, process.platform === 'darwin' ? 'not-checked' : 'unsupported-platform');
  assert.equal(doctor.stderr, ''); assert.equal(doctor.stdout.trim().split('\n').length, 1);
});

test('CLI registers a service and operation, describes it, and refuses replacement by default', async t => {
  const home = await temp(t);
  assert.equal((await cli(home, ['api', 'register', '--file', path.join(projectRoot, 'examples/services/risk-api.json')])).exit, 0);
  assert.equal((await cli(home, ['api', 'register', '--file', path.join(projectRoot, 'examples/operations/risk-api.auto-interfaces.list.json')])).exit, 0);
  const describe = await cli(home, ['api', 'describe', 'risk-api.auto-interfaces.list']);
  assert.equal(describe.result.data.request.method, 'POST'); assert.equal(describe.result.data.semantics, 'read');
  const conflict = await cli(home, ['api', 'register', '--file', path.join(projectRoot, 'examples/services/risk-api.json')]);
  assert.equal(conflict.exit, 2); assert.equal(conflict.result.error.code, 'REGISTRY_CONFLICT');
});

test('CLI invalid flags, invalid JSON, and unpaired profiles yield one safe JSON result', async t => {
  const home = await temp(t);
  const unknown = await cli(home, ['doctor', '--cookie', 'SYNTHETIC_SECRET_ARGUMENT']);
  assert.equal(unknown.exit, 2); assert.equal(unknown.result.error.code, 'INVALID_ARGUMENT');
  assert.equal((unknown.stdout + unknown.stderr).includes('SYNTHETIC_SECRET_ARGUMENT'), false);
  const invalid = await cli(home, ['call', 'missing', '--profile', 'work', '--args-json', '{']);
  assert.equal(invalid.exit, 2); assert.equal(invalid.result.error.code, 'INVALID_ARGUMENT');
  await cli(home, ['api', 'register', '--file', path.join(projectRoot, 'examples/services/risk-api.json')]);
  await cli(home, ['api', 'register', '--file', path.join(projectRoot, 'examples/operations/risk-api.auto-interfaces.list.json')]);
  const unpaired = await cli(home, ['call', 'risk-api.auto-interfaces.list', '--profile', 'not-paired']);
  assert.equal(unpaired.exit, 3); assert.equal(unpaired.result.error.code, 'PROFILE_NOT_PAIRED');
});

test('CLI import preserves unknown method/path rather than inventing an executable operation', async t => {
  const home = await temp(t), input = path.join(home, 'unknown.json');
  await writeFile(input, JSON.stringify({ id: 'risk-api.inter.list', description: 'Screenshot only', provenance: { source: 'manual' } }));
  const imported = await cli(home, ['api', 'import', '--file', input]);
  assert.equal(imported.exit, 0); assert.ok(imported.result.data.missing.includes('request.method')); assert.ok(imported.result.data.missing.includes('request.path'));
  const missing = await cli(home, ['api', 'describe', 'risk-api.inter.list']); assert.equal(missing.exit, 2);
  assert.equal(JSON.parse(await readFile(input, 'utf8')).request, undefined);
});

test('CLI direct requests require explicit unambiguous options before credentials or HTTP', async t => {
  const home = await temp(t);
  let calls = 0;
  const origin = await server(t, (_req, res) => { calls++; res.end('{}'); });
  const target = origin + '/request?ticket=SYNTHETIC_URL_SECRET';
  const direct = ['--url', target, '--method', 'POST', '--profile', 'not-paired'];
  const cases = [
    ['--url', target, '--profile', 'not-paired', '--json', '{}'],
    ['--url', target, '--method', '', '--profile', 'not-paired'],
    ['--url', target, '--method', 'POST'],
    ['--method', 'POST', '--profile', 'not-paired'],
    ['--service', 'missing', '--method', 'POST', '--profile', 'not-paired'],
    ['--path', '/request', '--method', 'POST', '--profile', 'not-paired'],
    [...direct, '--service', 'missing'],
    [...direct, '--path', '/request'],
    [...direct, '--method=GET'],
    [...direct, '--url', target],
    [...direct, '--json', '{}', '--json', '{}'],
    [...direct, '--json', '{}', '--json-file', 'SYNTHETIC_PRIVATE_PATH'],
    [...direct, '--json-file', 'SYNTHETIC_PRIVATE_PATH', '--body-file', 'SYNTHETIC_PRIVATE_PATH', '--content-type', 'text/plain'],
    [...direct, '--json', '{}', '--body-file', 'SYNTHETIC_PRIVATE_PATH', '--content-type', 'text/plain'],
    [...direct, '--body-file', 'SYNTHETIC_PRIVATE_PATH'],
    [...direct, '--content-type', 'text/plain'],
    [...direct, '--json', '{}', '--content-type', 'application/json'],
    [...direct, '--json', '{}', '--headers-json', '{"Content-Type":"application/json"}'],
    [...direct, '--body-file', 'SYNTHETIC_PRIVATE_PATH', '--content-type', 'text/plain', '--headers-json', '{"content-type":"text/plain"}'],
    [...direct, '--json', '{SYNTHETIC_PAYLOAD_SECRET'],
    [...direct, '--query-json', '{SYNTHETIC_QUERY_SECRET'],
    [...direct, '--headers-json', '{SYNTHETIC_HEADER_SECRET'],
    [...direct, '--args-json', '{}'],
    [...direct, '--timeout-ms', '0'],
    [...direct, '--max-bytes', '1', '--max-bytes', '2'],
    [...direct, 'SYNTHETIC_EXTRA_SECRET'],
  ];
  for (const args of cases) {
    const result = await cli(home, ['request', ...args]);
    assert.equal(result.exit, 2);
    assert.equal(result.result.error.code, 'INVALID_ARGUMENT');
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_/);
    assert.equal(result.stderr, '');
  }
  assert.equal(calls, 0);
});

test('CLI direct requests use Registry header, query, URL and method validation before credentials', async t => {
  const home = await temp(t);
  let calls = 0;
  const origin = await server(t, (_req, res) => { calls++; res.end('{}'); });
  const direct = ['request', '--url', origin + '/request?existing=SYNTHETIC_URL_SECRET', '--method', 'POST', '--profile', 'not-paired'];
  const invalidHeaders = [
    ...['Cookie', 'Authorization', 'Proxy-Authorization', 'X-CSRF-Token', 'X-Api-Key', 'Host'].map(name => ({ [name]: 'SYNTHETIC_HEADER_SECRET' })),
    { Accept: 'application/json', accept: 'text/plain' },
    { Accept: 'SYNTHETIC_HEADER_SECRET\r\nCookie: bad' },
    { Accept: 1 }, [], null,
  ];
  for (const headers of invalidHeaders) {
    const result = await cli(home, [...direct, '--headers-json', JSON.stringify(headers)]);
    assert.equal(result.exit, 2); assert.equal(result.result.error.code, 'CONTRACT_INVALID');
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_/);
  }
  for (const query of [{ existing: 'SYNTHETIC_QUERY_SECRET' }, { list: [1, 2] }, { nested: { value: 1 } }, { value: null }, [], null]) {
    const result = await cli(home, [...direct, '--query-json', JSON.stringify(query)]);
    assert.equal(result.exit, 2); assert.ok(['CONTRACT_INVALID', 'INVALID_ARGUMENT'].includes(result.result.error.code));
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_/);
  }
  for (const method of ['GET', 'HEAD', 'post', 'CONNECT']) {
    const result = await cli(home, ['request', '--url', origin + '/', '--method', method, '--profile', 'not-paired', '--json', 'false']);
    assert.equal(result.exit, 2); assert.equal(result.result.error.code, 'CONTRACT_INVALID');
  }
  for (const url of ['not-a-url', `${origin}/#SYNTHETIC_FRAGMENT_SECRET`, 'https://user:SYNTHETIC_PASSWORD_SECRET@example.invalid/']) {
    const result = await cli(home, ['request', '--url', url, '--method', 'GET', '--profile', 'not-paired']);
    assert.equal(result.exit, 2); assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_/);
  }
  assert.equal(calls, 0);
});

test('CLI input files are bounded regular UTF-8 files and never appear in errors', async t => {
  const home = await temp(t);
  let calls = 0;
  const origin = await server(t, (_req, res) => { calls++; res.end('{}'); });
  const direct = ['request', '--url', origin + '/', '--method', 'POST', '--profile', 'not-paired'];
  const malformed = path.join(home, 'SYNTHETIC_PRIVATE_MALFORMED.json');
  const invalidUTF8 = path.join(home, 'SYNTHETIC_PRIVATE_UTF8.txt');
  const oversized = path.join(home, 'SYNTHETIC_PRIVATE_LARGE.txt');
  await writeFile(malformed, '{"value":"SYNTHETIC_FILE_SECRET"');
  await writeFile(invalidUTF8, Buffer.from([0xc3, 0x28]));
  await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));
  for (const filename of [path.join(home, 'SYNTHETIC_PRIVATE_MISSING.txt'), home, invalidUTF8, oversized]) {
    for (const flags of [['--json-file', filename], ['--body-file', filename, '--content-type', 'text/plain']]) {
      const result = await cli(home, [...direct, ...flags]);
      assert.equal(result.exit, 2); assert.equal(result.result.error.code, 'INVALID_ARGUMENT');
      assert.equal(result.stderr, ''); assert.equal(result.stdout.includes(home), false);
      assert.doesNotMatch(result.stdout, /SYNTHETIC_/);
    }
  }
  const invalid = await cli(home, [...direct, '--json-file', malformed]);
  assert.equal(invalid.exit, 2); assert.equal(invalid.result.error.code, 'INVALID_ARGUMENT');
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /SYNTHETIC_/);
  assert.equal(calls, 0);
});

test('CLI rejects input FIFOs promptly without reading their contents', { skip: process.platform === 'win32' }, async t => {
  const home = await temp(t), fifo = path.join(home, 'SYNTHETIC_PRIVATE_FIFO');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('mkfifo', [fifo], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not create test FIFO')));
  });
  const result = await cli(home, ['request', '--url', 'https://example.invalid/', '--method', 'POST', '--profile', 'not-paired',
    '--body-file', fifo, '--content-type', 'text/plain']);
  assert.equal(result.exit, 2); assert.equal(result.result.error.code, 'INVALID_ARGUMENT');
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_/);
});

test('CLI direct and legacy inputs accept valid files and scalar types without registration in URL mode', async t => {
  const home = await temp(t);
  let calls = 0;
  const origin = await server(t, (_req, res) => { calls++; res.end('{}'); });
  const jsonFile = path.join(home, 'payload.json'), rawFile = path.join(home, 'payload.txt');
  const boundaryFile = path.join(home, 'boundary.json');
  await writeFile(jsonFile, '{"page":2,"active":false}');
  await writeFile(rawFile, '\uFEFFname=%E4%B8%AD&flag=false\r\n');
  await writeFile(boundaryFile, '"' + 'x'.repeat(1024 * 1024 - 2) + '"');
  const direct = ['request', '--url', origin + '/request?existing=true', '--method', 'POST', '--profile', 'not-paired'];
  for (const flags of [
    [], ['--json', '2'], ['--json', 'false'], ['--json', 'null'], ['--json-file', jsonFile], ['--json-file', boundaryFile],
    ['--body-file', rawFile, '--content-type', 'application/x-www-form-urlencoded'],
    ['--query-json', '{"page":2,"active":false,"term":"a b"}', '--headers-json', '{"Accept":"application/json","X-Request-Context":"synthetic"}'],
  ]) {
    const result = await cli(home, [...direct, ...flags]);
    assert.equal(result.exit, 3); assert.equal(result.result.error.code, 'PROFILE_NOT_PAIRED');
    assert.equal(result.stderr, '');
  }
  await writeFile(rawFile, '');
  const empty = await cli(home, [...direct, '--body-file', rawFile, '--content-type', 'text/plain']);
  assert.equal(empty.exit, 3); assert.equal(empty.result.error.code, 'PROFILE_NOT_PAIRED');
  await cli(home, ['api', 'register', '--file', path.join(projectRoot, 'examples/services/risk-api.json')]);
  const legacy = await cli(home, ['request', '--service', 'risk-api', '--path', '/explicit', '--method', 'POST', '--profile', 'not-paired',
    '--body-file', rawFile, '--content-type', 'text/plain', '--query-json', '{"page":2}', '--headers-json', '{"Accept":"application/json"}']);
  assert.equal(legacy.exit, 3); assert.equal(legacy.result.error.code, 'PROFILE_NOT_PAIRED');
  assert.equal(calls, 0);
});
