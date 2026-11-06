import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IntraError, projectRoot, validate, type Operation } from '../packages/contracts/src/index.js';
import { importDefinition } from '../packages/discovery/src/index.js';
import { materialize } from '../packages/registry/src/index.js';

const rejectsContract = (error: unknown): boolean => error instanceof IntraError && error.code === 'CONTRACT_INVALID';
async function definition(): Promise<Operation> {
  return JSON.parse(await readFile(join(projectRoot, 'examples', 'operations', 'risk-api.auto-interfaces.list.json'), 'utf8'));
}

test('complete definition import becomes a schema-valid draft without mutating historical evidence', async () => {
  const original = await definition();
  const before = structuredClone(original);
  const report = importDefinition(original);
  assert.deepEqual(report.missing, []);
  assert.equal(report.source, 'historical-experiment');
  assert.ok(report.draft);
  assert.equal(report.draft.status, 'draft');
  assert.equal(report.draft.provenance.verifiedAt, undefined);
  assert.deepEqual(report.draft.provenance.evidence, original.provenance.evidence);
  assert.deepEqual(original, before);
  validate('operation', report.draft);
  const service = validate('service', JSON.parse(await readFile(join(projectRoot, 'examples', 'services', 'risk-api.json'), 'utf8')));
  assert.throws(() => materialize(service, report.draft!, {}), error => error instanceof IntraError && error.code === 'OPERATION_UNVERIFIED');
});

test('unknown getPageInterIdList method and path stay unknown; no runnable placeholder is produced', () => {
  const report = importDefinition({ id: 'risk-api.getPageInterIdList', description: 'Screenshot clue only', provenance: { source: 'manual' } });
  assert.equal(report.draft, undefined);
  assert.ok(report.missing.includes('request.method'));
  assert.ok(report.missing.includes('request.path'));
  assert.ok(report.missing.includes('arguments'));
  assert.ok(report.missing.includes('response.success.httpStatuses'));
  assert.ok(!JSON.stringify(report).includes('getPageAutoInterfaceList'));
  assert.ok(!JSON.stringify(report).includes('POST'));
  assert.equal(report.source, 'manual');
});

test('partial import reports only absent required facts and does not copy arbitrary source text', async () => {
  const partial = await definition() as unknown as Record<string, unknown>;
  partial.request = { method: 'POST' };
  const report = importDefinition(partial);
  assert.deepEqual(report.missing, ['request.path']);
  assert.equal(report.draft, undefined);
  const source = importDefinition({ provenance: { source: 'SYNTHETIC_SECRET' } });
  assert.equal(source.source, 'unknown');
  assert.ok(!JSON.stringify(source).includes('SYNTHETIC_SECRET'));
});

test('import never infers read semantics from GET or promotes unknown/write operations', async () => {
  for (const semantics of ['unknown', 'write'] as const) {
    const input = await definition();
    input.semantics = semantics;
    input.request = { method: 'GET', path: '/synthetic' };
    input.bindings = [];
    const draft = importDefinition(input).draft!;
    assert.equal(draft.semantics, semantics);
    assert.equal(draft.status, 'draft');
  }
});

test('credentials in headers, URLs, query, body and argument definitions are rejected without disclosure', async () => {
  for (const headers of [{ Cookie: 'SYNTHETIC_SECRET' }, { Authorization: 'Bearer SYNTHETIC_SECRET' }, { 'X-Api-Key': 'SYNTHETIC_SECRET' }]) {
    assert.throws(() => importDefinition({ request: { headers } }), rejectsContract);
  }
  const payloads = [
    { request: { path: 'https://user:SYNTHETIC_SECRET@synthetic.invalid/x' } },
    { request: { path: '/x?access_token=SYNTHETIC_SECRET' } },
    { request: { query: { token: 'SYNTHETIC_SECRET' } } },
    { request: { body: { nested: [{ password: 'SYNTHETIC_SECRET' }] } } },
    { arguments: { properties: { apiKey: { type: 'string', default: 'SYNTHETIC_SECRET' } } } },
  ];
  for (const input of payloads) assert.throws(() => importDefinition(input), error => {
    assert.ok(error instanceof IntraError);
    assert.ok(!error.message.includes('SYNTHETIC_SECRET'));
    assert.ok(!JSON.stringify(error).includes('SYNTHETIC_SECRET'));
    return error.code === 'CONTRACT_INVALID';
  });
  const input = await definition(); input.request.headers = { Accept: 'application/json', 'X-Request-Id': 'synthetic' };
  assert.ok(importDefinition(input).draft);
});

test('malformed complete definitions and prototype-bearing input are rejected', async () => {
  const input = await definition(); input.request.method = 'TRACE';
  assert.throws(() => importDefinition(input), rejectsContract);
  assert.throws(() => importDefinition(JSON.parse('{"__proto__":{"polluted":true}}')), rejectsContract);
  assert.throws(() => importDefinition({ request: { body: new Date() } }), rejectsContract);
  assert.throws(() => importDefinition('curl --header anything'), rejectsContract);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
