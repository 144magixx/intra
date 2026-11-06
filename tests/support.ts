import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { Service, Operation } from '../packages/contracts/src/index.js';

export async function temp(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'intra-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('intra-test-')) throw Error('Unexpected test directory');
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}
export async function server(t: TestContext, listener: RequestListener): Promise<string> {
  const instance = createServer(listener);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()); }));
  const address = instance.address();
  if (!address || typeof address === 'string') throw Error('Missing port');
  return `http://127.0.0.1:${address.port}`;
}
export function service(origin: string): Service {
  return { schemaVersion: 1, id: 'local-test', baseUrl: origin, allowedOrigins: [origin], auth: { cookieNames: ['session'], authFailureRules: [{ kind: 'businessCode', pointer: '/code', equals: 304 }] },
    protocolExceptions: [{ origin, reason: 'Synthetic loopback test only' }] };
}
export function operation(): Operation {
  return { schemaVersion: 1, id: 'local-test.list', service: 'local-test', description: 'Synthetic read test', status: 'verified', semantics: 'read',
    arguments: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 }, active: { type: 'boolean', default: false } }, additionalProperties: false },
    request: { method: 'POST', path: '/list', body: { pageNo: 1, active: false } },
    bindings: [{ argument: 'page', target: 'body', pointer: '/pageNo' }, { argument: 'active', target: 'body', pointer: '/active' }],
    response: { success: { httpStatuses: [200], code: { pointer: '/code', equals: '200' } }, itemsPointer: '/data/items', totalPointer: '/data/total' },
    provenance: { source: 'manual', verifiedAt: '2026-11-05T00:00:00Z', evidence: ['tests/support.ts'], notes: 'Synthetic test fixture, not a real service' } };
}
export async function body(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
