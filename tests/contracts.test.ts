import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  IntraError, assertJson, exitCodeFor, getPointer, projectRoot, safeError,
  setPointer, validate, validateArguments, type ContractKind,
} from '../packages/contracts/src/index.js';

const rejectsCode = (code: string) => (error: unknown): boolean => error instanceof IntraError && error.code === code;
const example = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(projectRoot, 'examples', name), 'utf8'));

test('AJV validates every committed example, including IPC local schema references', async () => {
  for (const filename of ['risk-api', 'logwatch', 'devcloud']) validate('service', await example(`services/${filename}.json`));
  for (const filename of ['risk-api.auto-interfaces.list', 'logwatch.principal', 'devcloud.current-user']) validate('operation', await example(`operations/${filename}.json`));
  for (const filename of ['snapshot-request', 'snapshot-response', 'hello-request']) validate('ipc', await example(`messages/${filename}.json`));
  for (const filename of ['success-result', 'login-required-result']) validate('tool-result', await example(`messages/${filename}.json`));
  const response = await example('messages/snapshot-response.json') as { result: unknown };
  validate('snapshot', response.result);
  const request = await example('messages/snapshot-request.json') as { params: unknown };
  validate('snapshotParams', request.params);
  const hello = await example('messages/hello-request.json') as { params: unknown };
  validate('hello', hello.params);
});

test('IPC dependent schemas and success/error oneOf are enforced, without value disclosure', async () => {
  const request = await example('messages/snapshot-request.json') as { params: Record<string, unknown> };
  request.params.deadlineMs = 30_001;
  request.params.secret = 'SYNTHETIC_SUBMITTED_VALUE';
  assert.throws(() => validate('ipc', request), error => {
    assert.ok(error instanceof IntraError);
    assert.equal(error.code, 'CONTRACT_INVALID');
    assert.ok(!JSON.stringify(error).includes('SYNTHETIC_SUBMITTED_VALUE'));
    assert.ok(!error.message.includes('SYNTHETIC_SUBMITTED_VALUE'));
    return true;
  });
  const result = await example('messages/success-result.json') as Record<string, unknown>;
  result.error = { code: 'FAIL', message: 'failure', retryable: false };
  assert.throws(() => validate('tool-result', result), rejectsCode('CONTRACT_INVALID'));
  assert.throws(() => validate('not-a-kind' as ContractKind, {}), rejectsCode('CONTRACT_INVALID'));
});

test('optional cookie selectors distinguish URL mode from empty or invalid named filters', async () => {
  const service = await example('services/risk-api.json') as { auth: Record<string, unknown> };
  delete service.auth.cookieNames;
  validate('service', service);
  const request = await example('messages/snapshot-request.json') as { params: Record<string, unknown> };
  delete request.params.cookieNames;
  validate('ipc', request);
  validate('snapshotParams', request.params);
  for (const invalid of [[], ['session', 'session'], ['session\n'], ['bad name'], ['x'.repeat(257)]]) {
    assert.throws(() => validate('service', { ...service, auth: { ...service.auth, cookieNames: invalid } }), rejectsCode('CONTRACT_INVALID'));
    assert.throws(() => validate('snapshotParams', { ...request.params, cookieNames: invalid }), rejectsCode('CONTRACT_INVALID'));
  }
});

test('schema root is resolved from module location even outside the repository cwd', () => {
  const module = fileURLToPath(new URL('../packages/contracts/src/index.js', import.meta.url));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const {projectRoot, validate} = await import(${JSON.stringify(new URL(`file://${module}`).href)}); validate('hello',{profileId:'test',extensionVersion:'0',protocolVersions:[1],storeIds:['0']}); process.stdout.write(projectRoot);`],
  { cwd: '/', encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, projectRoot);
});

test('arguments reject unknown keys before defaults and retain input types without mutation', () => {
  const schema = { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 2 }, enabled: { type: 'boolean', default: false } }, required: ['page'] };
  const input = {};
  assert.deepEqual(validateArguments(schema, input), { page: 2, enabled: false });
  assert.deepEqual(input, {});
  assert.throws(() => validateArguments(schema, { typo: 'SYNTHETIC_SECRET' }), rejectsCode('INVALID_ARGUMENT'));
  assert.throws(() => validateArguments(schema, { page: '2' }), rejectsCode('INVALID_ARGUMENT'));
  assert.throws(() => validateArguments(schema, { page: 0 }), rejectsCode('INVALID_ARGUMENT'));
  assert.deepEqual(validateArguments(schema, { page: 3, enabled: true }), { page: 3, enabled: true });
});

test('AJV supports 2020-12 refs, conditionals, contains, dependentRequired and nested constraints', () => {
  const schema = {
    type: 'object',
    $defs: { pair: { type: 'array', prefixItems: [{ type: 'string', pattern: '^ok$' }, { type: 'integer' }], items: false, minItems: 2 } },
    properties: {
      pair: { $ref: '#/$defs/pair' },
      mode: { enum: ['normal', 'special'] },
      extra: { type: 'string', minLength: 2 },
      values: { type: 'array', items: { type: 'integer' }, contains: { const: 7 }, minContains: 1, uniqueItems: true },
    },
    required: ['pair', 'mode', 'values'],
    dependentRequired: { extra: ['mode'] },
    if: { properties: { mode: { const: 'special' } } },
    then: { required: ['extra'] },
    additionalProperties: false,
  };
  const good = { pair: ['ok', 2], mode: 'normal', values: [7, 8] };
  assert.deepEqual(validateArguments(schema, good), good);
  for (const invalid of [
    { ...good, pair: ['wrong', 2] }, { ...good, pair: ['ok', 2, 3] },
    { ...good, values: [8] }, { ...good, values: [7, 7] }, { ...good, mode: 'special' },
  ]) assert.throws(() => validateArguments(schema, invalid), rejectsCode('INVALID_ARGUMENT'));
  assert.throws(() => validateArguments({ type: 'object', $async: true, properties: { value: { type: 'integer' } }, required: ['value'] }, {}), rejectsCode('CONTRACT_INVALID'));
  assert.throws(() => validateArguments({ type: 'object', properties: { value: { $ref: 'https://not-fetched.invalid/schema' } } }, {}), rejectsCode('CONTRACT_INVALID'));
  assert.throws(() => validateArguments({ type: 'object', properties: { value: { type: 'integer', default: 'wrong' } } }, {}), rejectsCode('INVALID_ARGUMENT'));
});

test('strict pointers decode RFC6901 escapes, arrays and root replacement with typed values', () => {
  const value = { 'a/b': { '~key': [1, false, null] }, '': 'empty', '~1': 'literal' };
  assert.equal(getPointer(value, '/a~1b/~0key/1'), false);
  assert.equal(getPointer(value, '/'), 'empty');
  assert.equal(getPointer(value, '/~01'), 'literal');
  assert.equal(getPointer(value, ''), value);
  assert.equal(getPointer(value, '/missing'), undefined);
  setPointer(value, '/a~1b/~0key/0', { nested: true });
  assert.deepEqual(getPointer(value, '/a~1b/~0key/0'), { nested: true });
  const replacement = { different: [3] };
  const root = setPointer(value, '', replacement);
  assert.deepEqual(root, replacement);
  assert.notEqual(root, replacement);
});

test('invalid escapes, inherited keys, prototype traversal and nonexistent binding targets fail closed', () => {
  for (const pointer of ['x', '#/x', '/x~', '/x~2', '/__proto__/polluted', '/constructor/prototype/polluted', '/prototype']) {
    assert.throws(() => getPointer({}, pointer), rejectsCode('CONTRACT_INVALID'));
    assert.throws(() => setPointer({}, pointer, true), rejectsCode('CONTRACT_INVALID'));
  }
  assert.throws(() => setPointer({}, '/missing/leaf', true), rejectsCode('CONTRACT_INVALID'));
  assert.throws(() => setPointer({}, '/missing', true), rejectsCode('CONTRACT_INVALID'));
  for (const pointer of ['/01', '/-1', '/-', '/1.0']) assert.throws(() => getPointer([1, 2], pointer), rejectsCode('CONTRACT_INVALID'));
  assert.throws(() => setPointer([1], '/1', 2), rejectsCode('CONTRACT_INVALID'));
  assert.throws(() => getPointer(Object.create({ inherited: true }), '/inherited'), rejectsCode('CONTRACT_INVALID'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('JSON safety rejects non-JSON values, cycles, getters, sparse arrays and dangerous keys', () => {
  let called = false;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get: () => { called = true; return 1; } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const sparse = new Array(2);
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), cyclic, getter, sparse, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.throws(() => assertJson(value), rejectsCode('CONTRACT_INVALID'));
  }
  assert.equal(called, false);
});

test('classified errors retain exit codes while safeError discards untrusted detail', () => {
  for (const [code, exit] of Object.entries({ INVALID_ARGUMENT: 2, LOGIN_REQUIRED: 3, FORBIDDEN: 4, REQUEST_TIMEOUT: 5, BUSINESS_ERROR: 6, OUTPUT_ERROR: 7, REQUEST_OUTCOME_UNKNOWN: 8 })) {
    assert.equal(exitCodeFor(code), exit);
    assert.equal(new IntraError(code).exitCode, exit);
  }
  assert.equal(exitCodeFor('NEW_CODE'), 7);
  const secret = 'SYNTHETIC_DO_NOT_LEAK';
  for (const error of [new Error(secret), { message: secret, code: secret }, new IntraError('CONTRACT_INVALID', secret, { action: secret, cause: new Error(secret) })]) {
    const safe = safeError(error);
    assert.ok(!safe.message.includes(secret));
    assert.equal(safe.action, undefined);
    assert.equal(safe.cause, undefined);
    assert.ok(!JSON.stringify(safe).includes(secret));
  }
});
