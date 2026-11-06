import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test, { type TestContext } from 'node:test';
import { projectRoot, validate } from '../packages/contracts/src/index.js';
import { Credentials, MacKeychainStore, MemorySecretStore, buildKeychainHelper, runNativeHelper } from '../packages/credentials/src/index.js';
import type { CredentialService, CredentialStore, NativeRunner, SnapshotCookie, SnapshotResult } from '../packages/credentials/src/index.js';

const secret = 'SYNTHETIC_COOKIE_DO_NOT_PRINT';
const profileId = 'profile-synthetic-01';
const extensionId = 'a'.repeat(32);
const service: CredentialService = {
  schemaVersion: 1, id: 'synthetic', baseUrl: 'https://app.example.com',
  allowedOrigins: ['https://app.example.com'], auth: { cookieNames: ['sid'] },
};
const urlService: CredentialService = { ...service, auth: {} };
function cookie(overrides: Partial<SnapshotCookie> = {}): SnapshotCookie {
  return { name: 'sid', value: secret, domain: 'app.example.com', path: '/', hostOnly: true,
    secure: false, httpOnly: true, sameSite: 'lax', session: true, storeId: '0', ...overrides };
}
function snapshot(cookies: SnapshotCookie[] = [cookie()], overrides: Partial<SnapshotResult> = {}): SnapshotResult {
  return { profileId, storeId: '0', snapshotId: 'snapshot-synthetic-01', observedAt: '2026-11-01T00:00:00Z', cookies, ...overrides };
}
async function fixture(t: TestContext, store: CredentialStore = new MemorySecretStore()) {
  const home = await mkdtemp(join(tmpdir(), 'intra-credentials-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const credentials = new Credentials({ store, home });
  await credentials.pair({ alias: 'work', profileId, storeId: '0', extensionId });
  return { home, credentials, store };
}
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected);
  assert.ok(!inspect(error).includes(secret));
  return true;
};

test('MemorySecretStore is async and keeps its contents out of serialization', async () => {
  const store = new MemorySecretStore();
  assert.equal(await store.get('missing'), null);
  await store.set('key', secret);
  assert.equal(await store.get('key'), secret);
  assert.ok(!JSON.stringify(store).includes(secret));
  assert.ok(!inspect(store).includes(secret));
  await store.delete('key');
  assert.equal(await store.get('key'), null);
});

test('pairing atomically stores private public metadata and refuses duplicates', async t => {
  const { credentials, home } = await fixture(t);
  const profile = await credentials.profile('work');
  assert.equal(profile.profileId, profileId);
  assert.equal((profile as unknown as { accountVerified?: boolean }).accountVerified, undefined);
  await assert.rejects(credentials.pair({ alias: 'work', profileId: 'other', storeId: '0', extensionId }), code('PROFILE_AMBIGUOUS'));
  await assert.rejects(credentials.pair({ alias: 'alias-two', profileId, storeId: '1', extensionId }), code('PROFILE_AMBIGUOUS'));
  await assert.rejects(credentials.profile('missing'), code('PROFILE_NOT_PAIRED'));
  await assert.rejects(credentials.pair({ alias: '../escape', profileId: 'other', storeId: '0', extensionId }), code('INVALID_ARGUMENT'));
  const path = join(home, 'credentials', 'profiles.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, 'credentials'))).mode & 0o777, 0o700);
  assert.ok(!(await readFile(path, 'utf8')).includes(secret));
  assert.deepEqual((await readdir(join(home, 'credentials'))).sort(), ['locks', 'profiles.json']);
});

test('pair rejects extra secret-bearing properties instead of writing them to disk', async t => {
  const { credentials, home } = await fixture(t);
  await assert.rejects(credentials.pair({ alias: 'other', profileId: 'other', storeId: '0', extensionId, cookies: secret } as never), code('INVALID_ARGUMENT'));
  assert.ok(!(await readFile(join(home, 'credentials', 'profiles.json'), 'utf8')).includes(secret));
});

test('private metadata refuses a symlink instead of following it', async t => {
  const { credentials, home } = await fixture(t);
  const path = join(home, 'credentials', 'profiles.json');
  const original = await readFile(path, 'utf8');
  await rm(path);
  const outside = join(home, 'outside.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outside, original, { mode: 0o600 });
  await symlink(outside, path);
  await assert.rejects(credentials.profile('work'), code('INTERNAL_ERROR'));
});

test('concurrent pair attempts preserve exactly one public profile', async t => {
  const { home } = await fixture(t);
  const first = new Credentials({ home, store: new MemorySecretStore() });
  const second = new Credentials({ home, store: new MemorySecretStore() });
  const input = { alias: 'second', profileId: 'profile-two', storeId: '0', extensionId };
  const results = await Promise.allSettled([first.pair(input), second.pair(input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const data = JSON.parse(await readFile(join(home, 'credentials', 'profiles.json'), 'utf8')) as { profiles: unknown[] };
  assert.equal(data.profiles.length, 2);
});

test('snapshot commit and independent process-style resolve preserve metadata without serializing secrets', async t => {
  const { credentials, home, store } = await fixture(t);
  const saved = await credentials.saveSnapshot('work', service, snapshot(), 'account-a');
  const another = new Credentials({ home, store });
  const resolved = await another.resolve('work', service, service.baseUrl + '/api');
  assert.equal(await resolved.cookieHeader(service.baseUrl + '/api'), `sid=${secret}`);
  assert.equal(resolved.metadata.accountId, 'account-a');
  assert.equal(resolved.metadata.accountVerified, true);
  assert.equal(resolved.metadata.expiresAt, null);
  assert.equal(resolved.generation, saved.generation);
  assert.notEqual(resolved.credentialRef, saved.credentialRef);
  assert.ok(!JSON.stringify(resolved).includes(secret));
  assert.ok(!inspect(resolved).includes(secret));
  assert.equal((credentials as unknown as { resolveReference?: unknown }).resolveReference, undefined);
  assert.ok(!(await readFile(join(home, 'credentials', 'profiles.json'), 'utf8')).includes(secret));
});

test('preview snapshot stays transient and account-unverified until explicit commit', async t => {
  const { credentials } = await fixture(t);
  const preview = await credentials.previewSnapshot('work', service, snapshot());
  assert.equal(await preview.cookieHeader(service.baseUrl), `sid=${secret}`);
  assert.equal(preview.metadata.accountVerified, false);
  assert.equal(preview.metadata.accountId, undefined);
  await assert.rejects(credentials.resolve('work', service, service.baseUrl), code('COOKIE_NOT_FOUND'));
  await credentials.saveSnapshot('work', service, snapshot(), 'verified-account');
  await assert.rejects(credentials.saveSnapshot('work', service, snapshot(), 'other-account'), code('ACCOUNT_MISMATCH'));
  await assert.rejects(credentials.saveSnapshot('work', service, snapshot()), code('ACCOUNT_MISMATCH'));
  assert.equal((await credentials.resolve('work', service, service.baseUrl)).metadata.accountId, 'verified-account');
});

test('pairing account metadata only constrains later explicit identity verification', async t => {
  const { credentials } = await fixture(t);
  await credentials.pair({ alias: 'bound', profileId: 'profile-bound', storeId: '0', extensionId, accountId: 'expected-account' });
  const input = snapshot([cookie()], { profileId: 'profile-bound' });
  const preview = await credentials.previewSnapshot('bound', service, input);
  assert.equal(preview.metadata.accountVerified, false);
  await assert.rejects(credentials.saveSnapshot('bound', service, input), code('ACCOUNT_MISMATCH'));
  await assert.rejects(credentials.saveSnapshot('bound', service, input, 'different-account'), code('ACCOUNT_MISMATCH'));
  assert.equal((await credentials.saveSnapshot('bound', service, input, 'expected-account')).metadata.accountVerified, true);
});

test('cookie generation ignores snapshot bookkeeping and reflects values and expiry', async t => {
  const { credentials } = await fixture(t);
  const first = await credentials.saveSnapshot('work', service, snapshot());
  const same = await credentials.saveSnapshot('work', service, snapshot([cookie()], { snapshotId: 'new-id', observedAt: '2026-11-02T00:00:00Z' }));
  assert.equal(same.generation, first.generation);
  const changed = await credentials.saveSnapshot('work', service, snapshot([cookie({ value: 'NEW_SYNTHETIC_VALUE' })]));
  assert.notEqual(changed.generation, first.generation);
});

test('complete validation rejects malformed snapshots before any secret store write', async t => {
  class CountingStore extends MemorySecretStore { writes = 0; override async set(key: string, value: string) { this.writes++; return super.set(key, value); } }
  const store = new CountingStore();
  const { credentials } = await fixture(t, store);
  const invalid: unknown[] = [
    { ...snapshot(), unexpected: secret },
    snapshot([{ ...cookie(), httpOnly: undefined } as never]),
    snapshot([cookie({ value: `${secret}\r\nCookie: stolen` })]),
    snapshot([cookie({ domain: 'evilapp.example.com' })]),
    snapshot([cookie({ domain: 'com', hostOnly: false })]),
    snapshot([cookie({ path: '/api' })]),
    snapshot([cookie({ session: false })]),
    snapshot([cookie({ expirationDate: Infinity, session: false })]),
    snapshot([cookie({ expirationDate: 1800000000 })]),
    snapshot([cookie({ name: 'unrequested' })]),
    snapshot([cookie(), cookie()]),
    snapshot([cookie()], { observedAt: 'not-a-date' }),
  ];
  for (const input of invalid) await assert.rejects(credentials.saveSnapshot('work', service, input as SnapshotResult), code('CONTRACT_INVALID'));
  assert.equal(store.writes, 0);
});

test('RFC 6265 DQUOTE-wrapped cookie values are accepted verbatim; stray quotes and separators are not', async t => {
  const { credentials } = await fixture(t);
  const quoted = `"z=1&dm=example.com&ss=${secret}"`;
  const session = await credentials.saveSnapshot('work', urlService, snapshot([cookie(), cookie({ name: 'RT', value: quoted })]));
  assert.equal(await session.cookieHeader(service.baseUrl + '/'), `sid=${secret}; RT=${quoted}`);
  await session.acceptSetCookie(service.baseUrl + '/', ['RT="SYNTHETIC_QUOTED"']);
  assert.match(await session.cookieHeader(service.baseUrl + '/'), /RT="SYNTHETIC_QUOTED"/);
  for (const value of ['"unbalanced', 'mid"quote', '""inner""', '"a,b"', '"a b"', 'a,b', '"a\\b"']) {
    await assert.rejects(credentials.saveSnapshot('work', urlService, snapshot([cookie({ value })])), code('CONTRACT_INVALID'));
  }
});

test('profile and store identity mismatches fail closed', async t => {
  const { credentials } = await fixture(t);
  for (const input of [snapshot(undefined, { profileId: 'other-profile' }), snapshot(undefined, { storeId: '1' }), snapshot([cookie({ storeId: '1' })])]) {
    await assert.rejects(credentials.saveSnapshot('work', service, input), code('ACCOUNT_MISMATCH'));
  }
});

test('partitioned snapshots and Set-Cookie are refused without degrading them', async t => {
  const { credentials } = await fixture(t);
  await assert.rejects(credentials.saveSnapshot('work', service, snapshot([cookie({ partitionKey: {} })])), code('PARTITIONED_COOKIE_UNSUPPORTED'));
  const session = await credentials.saveSnapshot('work', service, snapshot());
  await assert.rejects(session.acceptSetCookie(service.baseUrl, ['sid=CHIPS; Secure; Partitioned']), code('PARTITIONED_COOKIE_UNSUPPORTED'));
  assert.equal(await session.cookieHeader(service.baseUrl), `sid=${secret}`);
});

test('domain and path matching preserve hostOnly, domain cookies and same-name paths', async t => {
  const { credentials } = await fixture(t);
  const session = await credentials.saveSnapshot('work', service, snapshot([
    cookie({ domain: '.example.com', hostOnly: false, value: 'ROOT_SYNTHETIC' }),
    cookie({ path: '/api', value: 'PATH_SYNTHETIC' }),
  ]), undefined, service.baseUrl + '/api/items');
  assert.equal(await session.cookieHeader(service.baseUrl + '/api/items'), 'sid=PATH_SYNTHETIC; sid=ROOT_SYNTHETIC');
  assert.equal(await session.cookieHeader(service.baseUrl + '/apix'), 'sid=ROOT_SYNTHETIC');
  const restored = await credentials.resolve('work', service, service.baseUrl + '/api/other');
  assert.equal(await restored.cookieHeader(service.baseUrl + '/api/other'), 'sid=PATH_SYNTHETIC; sid=ROOT_SYNTHETIC');
  await assert.rejects(session.cookieHeader('https://evilapp.example.com/api'), code('INVALID_ARGUMENT'));
});

test('expired and absent required cookies cannot become valid cached sessions', async t => {
  const { credentials } = await fixture(t);
  await assert.rejects(credentials.saveSnapshot('work', service, snapshot([])), code('COOKIE_NOT_FOUND'));
  await assert.rejects(credentials.saveSnapshot('work', service, snapshot([cookie({ session: false, expirationDate: 1 })])), code('COOKIE_NOT_FOUND'));
  const twoNames = { ...service, auth: { cookieNames: ['sid', 'csrf'] } };
  await assert.rejects(credentials.saveSnapshot('work', twoNames, snapshot()), code('COOKIE_NOT_FOUND'));
});

test('omitted names accept all URL-applicable cookies and expose only names and status', async t => {
  const { credentials, home, store } = await fixture(t);
  const url = service.baseUrl + '/api/items?view=one';
  const saved = await credentials.saveSnapshot('work', urlService, snapshot([
    cookie({ domain: '.example.com', hostOnly: false }),
    cookie({ name: 'csrf', value: 'SYNTHETIC_CSRF', path: '/api', secure: true }),
    cookie({ name: 'theme', value: 'SYNTHETIC_THEME', httpOnly: false }),
    cookie({ name: 'expired', value: 'SYNTHETIC_EXPIRED', session: false, expirationDate: 1 }),
  ]), undefined, url);
  const expected = [`sid=${secret}`, 'csrf=SYNTHETIC_CSRF', 'theme=SYNTHETIC_THEME'];
  assert.deepEqual((await saved.cookieHeader(url)).split('; ').sort(), expected.sort());
  assert.deepEqual(saved.metadata.cookieNames, ['csrf', 'sid', 'theme']);
  assert.equal(saved.metadata.accountVerified, false);
  assert.equal(saved.metadata.source, 'browser');
  assert.equal(saved.metadata.expiresAt, null);
  const restored = await new Credentials({ home, store }).resolve('work', urlService, url);
  assert.equal(restored.generation, saved.generation);
  assert.notEqual(restored.credentialRef, saved.credentialRef);
  assert.deepEqual((await restored.cookieHeader(url)).split('; ').sort(), expected);
  for (const value of [secret, 'SYNTHETIC_CSRF', 'SYNTHETIC_THEME', 'SYNTHETIC_EXPIRED']) {
    assert.ok(!JSON.stringify(restored).includes(value));
    assert.ok(!inspect(restored).includes(value));
    assert.ok(!(await readFile(join(home, 'credentials', 'profiles.json'), 'utf8')).includes(value));
  }
});

test('explicit cookie names remain a strict required whitelist and an empty list is invalid', async t => {
  const { credentials } = await fixture(t);
  const required: CredentialService = { ...service, auth: { cookieNames: ['sid', 'csrf'] } };
  const input = snapshot([cookie(), cookie({ name: 'csrf', value: 'SYNTHETIC_CSRF' })]);
  const session = await credentials.saveSnapshot('work', required, input);
  await session.acceptSetCookie(service.baseUrl, ['theme=SYNTHETIC_IGNORED; Path=/']);
  assert.deepEqual((await session.cookieHeader(service.baseUrl)).split('; ').sort(), ['csrf=SYNTHETIC_CSRF', `sid=${secret}`]);
  await assert.rejects(credentials.saveSnapshot('work', required, snapshot()), code('COOKIE_NOT_FOUND'));
  await assert.rejects(credentials.saveSnapshot('work', required, snapshot([...input.cookies, cookie({ name: 'theme' })])), code('CONTRACT_INVALID'));
  const emptyNames = { ...service, auth: { cookieNames: [] } };
  assert.throws(() => validate('service', emptyNames), code('CONTRACT_INVALID'));
  await assert.rejects(credentials.saveSnapshot('work', emptyNames, snapshot()), code('CONTRACT_INVALID'));
});

test('URL-mode snapshots are complete only for their original origin and pathname', async t => {
  const { credentials } = await fixture(t);
  const root = await credentials.saveSnapshot('work', urlService, snapshot(), undefined, service.baseUrl + '/?page=1');
  const queryOnly = await credentials.resolve('work', urlService, service.baseUrl + '/?page=2');
  assert.equal(await queryOnly.cookieHeader(service.baseUrl + '/?page=3'), `sid=${secret}`);
  assert.equal(queryOnly.generation, root.generation);
  await assert.rejects(credentials.resolve('work', urlService, service.baseUrl + '/api/items'), code('COOKIE_NOT_FOUND'));
  await assert.rejects(root.cookieHeader(service.baseUrl + '/api/items'), code('COOKIE_NOT_FOUND'));
  await assert.rejects(root.acceptSetCookie(service.baseUrl + '/api/items', ['other=SYNTHETIC; Path=/']), code('COOKIE_NOT_FOUND'));
  const pathURL = service.baseUrl + '/api/items';
  const complete = await credentials.saveSnapshot('work', urlService, snapshot([
    cookie(), cookie({ name: 'path-specific', path: '/api', value: 'SYNTHETIC_PATH' }),
  ]), undefined, pathURL + '?page=1');
  const restored = await credentials.resolve('work', urlService, pathURL + '?page=2');
  assert.equal(await restored.cookieHeader(pathURL), `path-specific=SYNTHETIC_PATH; sid=${secret}`);
  for (const pathname of ['/', '/api', '/api/other', '/api/items/', '/api/items/detail']) {
    await assert.rejects(credentials.resolve('work', urlService, service.baseUrl + pathname), code('COOKIE_NOT_FOUND'));
    await assert.rejects(complete.cookieHeader(service.baseUrl + pathname), code('COOKIE_NOT_FOUND'));
  }
});

test('named and legacy snapshots cannot establish URL-mode cache completeness', async t => {
  const { credentials } = await fixture(t);
  await credentials.saveSnapshot('work', service, snapshot());
  await assert.rejects(credentials.resolve('work', urlService, service.baseUrl), code('COOKIE_NOT_FOUND'));
  assert.equal(await (await credentials.resolve('work', service, service.baseUrl + '/api')).cookieHeader(service.baseUrl + '/api'), `sid=${secret}`);
  await credentials.saveSnapshot('work', urlService, snapshot([cookie(), cookie({ name: 'other', value: 'SYNTHETIC_OTHER' })]));
  const complete = await credentials.resolve('work', urlService, service.baseUrl);
  assert.deepEqual(complete.metadata.cookieNames, ['other', 'sid']);
});

test('URL mode rejects empty and expired snapshots and rechecks cached expiry', async t => {
  const { credentials } = await fixture(t);
  await assert.rejects(credentials.previewSnapshot('work', urlService, snapshot([])), code('COOKIE_NOT_FOUND'));
  await assert.rejects(credentials.saveSnapshot('work', urlService, snapshot([])), code('COOKIE_NOT_FOUND'));
  await assert.rejects(credentials.saveSnapshot('work', urlService, snapshot([cookie({ session: false, expirationDate: 1 })])), code('COOKIE_NOT_FOUND'));
  await assert.rejects(credentials.resolve('work', urlService, service.baseUrl), code('COOKIE_NOT_FOUND'));
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  await credentials.saveSnapshot('work', urlService, snapshot([cookie({ session: false, expirationDate: now / 1000 + 60 })]));
  t.mock.timers.tick(61_000);
  await assert.rejects(credentials.resolve('work', urlService, service.baseUrl), code('COOKIE_NOT_FOUND'));
});

test('URL mode rejects unrelated or malformed snapshot cookies before writing', async t => {
  class CountingStore extends MemorySecretStore { writes = 0; override async set(key: string, value: string) { this.writes++; return super.set(key, value); } }
  const store = new CountingStore();
  const { credentials } = await fixture(t, store);
  for (const extra of [
    cookie({ name: 'unrelated', domain: 'other.example.com' }),
    cookie({ name: 'unrelated', domain: '.evil-example.com', hostOnly: false }),
    cookie({ name: 'unrelated', domain: '.com', hostOnly: false }),
    cookie({ name: 'unrelated', path: '/elsewhere' }),
    cookie({ name: 'bad name' }),
    cookie({ name: 'bad-value', value: secret + '\r\nHeader: bad' }),
    cookie({ name: 'bad-expiry', session: false }),
    cookie(),
  ]) {
    await assert.rejects(credentials.saveSnapshot('work', urlService, snapshot([cookie(), extra])), code('CONTRACT_INVALID'));
  }
  await assert.rejects(credentials.saveSnapshot('work', urlService, snapshot([cookie({ name: 'partitioned', partitionKey: {} })])), code('PARTITIONED_COOKIE_UNSUPPORTED'));
  assert.equal(store.writes, 0);
});

test('URL-mode HTTP cookies accept new names only within this session', async t => {
  const { credentials } = await fixture(t);
  const url = service.baseUrl + '/api/items';
  const session = await credentials.saveSnapshot('work', urlService, snapshot(), undefined, url);
  const independent = await credentials.resolve('work', urlService, url);
  const before = session.generation;
  await session.acceptSetCookie(url, ['csrf=SYNTHETIC_HTTP; Path=/api; Secure; HttpOnly', 'theme=SYNTHETIC_THEME; Path=/']);
  assert.notEqual(session.generation, before);
  assert.equal(session.metadata.source, 'http');
  assert.deepEqual(session.metadata.cookieNames, ['csrf', 'sid', 'theme']);
  assert.deepEqual((await session.cookieHeader(url + '?page=2')).split('; ').sort(), ['csrf=SYNTHETIC_HTTP', `sid=${secret}`, 'theme=SYNTHETIC_THEME']);
  assert.equal(await independent.cookieHeader(url), `sid=${secret}`);
  assert.equal(await (await credentials.resolve('work', urlService, url)).cookieHeader(url), `sid=${secret}`);
  assert.ok(!JSON.stringify(session).includes('SYNTHETIC_HTTP'));
  assert.ok(!inspect(session).includes('SYNTHETIC_HTTP'));
  const updated = session.generation;
  await assert.rejects(session.acceptSetCookie(url, ['new=SYNTHETIC_PARTIAL; Path=/', 'other=SYNTHETIC_INVALID; Domain=other.example.com']), code('CONTRACT_INVALID'));
  await assert.rejects(session.acceptSetCookie(url, ['partitioned=SYNTHETIC; Secure; Partitioned']), code('PARTITIONED_COOKIE_UNSUPPORTED'));
  assert.equal(session.generation, updated);
  await session.acceptSetCookie(url, ['csrf=gone; Path=/api; Max-Age=0']);
  assert.ok(!(await session.cookieHeader(url)).includes('csrf='));
  assert.deepEqual(session.metadata.cookieNames, ['sid', 'theme']);
});

test('URL mode retains HTTP Secure restrictions and separate origin snapshots', async t => {
  const { credentials } = await fixture(t);
  const local: CredentialService = { ...urlService, id: 'local-url', baseUrl: 'http://localhost:8181', allowedOrigins: ['http://localhost:8181'], protocolExceptions: [{ origin: 'http://localhost:8181', reason: 'synthetic local test' }] };
  await assert.rejects(credentials.saveSnapshot('work', local, snapshot([cookie({ domain: 'localhost', secure: true })])), code('CONTRACT_INVALID'));
  const localSession = await credentials.saveSnapshot('work', local, snapshot([cookie({ domain: 'localhost' })]));
  await assert.rejects(localSession.acceptSetCookie(local.baseUrl, ['new=SYNTHETIC_SECURE; Secure']), code('CONTRACT_INVALID'));
  const otherOrigin = 'https://other.example.com';
  const multiple: CredentialService = { ...urlService, allowedOrigins: [...urlService.allowedOrigins, otherOrigin] };
  const first = await credentials.saveSnapshot('work', multiple, snapshot([cookie({ domain: '.example.com', hostOnly: false })]));
  await assert.rejects(credentials.resolve('work', multiple, otherOrigin), code('COOKIE_NOT_FOUND'));
  await assert.rejects(first.cookieHeader(otherOrigin), code('INVALID_ARGUMENT'));
  await assert.rejects(first.acceptSetCookie(otherOrigin, ['new=SYNTHETIC_OTHER']), code('INVALID_ARGUMENT'));
  await credentials.saveSnapshot('work', multiple, snapshot([cookie({ name: 'other-session', value: 'SYNTHETIC_OTHER_ORIGIN', domain: '.example.com', hostOnly: false })]), undefined, otherOrigin);
  assert.equal(await (await credentials.resolve('work', multiple, otherOrigin)).cookieHeader(otherOrigin), 'other-session=SYNTHETIC_OTHER_ORIGIN');
  assert.equal(await (await credentials.resolve('work', multiple, service.baseUrl)).cookieHeader(service.baseUrl), `sid=${secret}`);
  await assert.rejects(credentials.resolve('work', { ...urlService, id: 'different-service' }, service.baseUrl), code('COOKIE_NOT_FOUND'));
  await credentials.pair({ alias: 'other-url', profileId: 'profile-other-url', storeId: '0', extensionId });
  await assert.rejects(credentials.resolve('other-url', multiple, service.baseUrl), code('COOKIE_NOT_FOUND'));
});

test('HTTPS Secure cookies never enter an HTTP localhost jar, even with an explicit HTTP exception', async t => {
  const { credentials } = await fixture(t);
  const local: CredentialService = { ...service, id: 'local', baseUrl: 'http://localhost:8181', allowedOrigins: ['http://localhost:8181'], protocolExceptions: [{ origin: 'http://localhost:8181', reason: 'synthetic local test' }] };
  await assert.rejects(credentials.saveSnapshot('work', local, snapshot([cookie({ domain: 'localhost', secure: true })])), code('CONTRACT_INVALID'));
  const session = await credentials.saveSnapshot('work', local, snapshot([cookie({ domain: 'localhost' })]));
  await assert.rejects(session.acceptSetCookie(local.baseUrl, ['sid=SECURE_SYNTHETIC; Secure']), code('CONTRACT_INVALID'));
  assert.equal(await session.cookieHeader(local.baseUrl), `sid=${secret}`);
  const noException = { ...local, protocolExceptions: [] };
  await assert.rejects(credentials.resolve('work', noException, local.baseUrl), code('INVALID_ARGUMENT'));
});

test('service/profile/origin scopes require fresh resolution and never share jars', async t => {
  const { credentials } = await fixture(t);
  const multiple: CredentialService = { ...service, allowedOrigins: [...service.allowedOrigins, 'https://other.example.com'] };
  const session = await credentials.saveSnapshot('work', multiple, snapshot([cookie({ domain: '.example.com', hostOnly: false })]));
  await assert.rejects(session.cookieHeader('https://other.example.com/'), code('INVALID_ARGUMENT'));
  await assert.rejects(session.acceptSetCookie('https://other.example.com/', ['sid=OTHER']), code('INVALID_ARGUMENT'));
  await assert.rejects(credentials.resolve('work', multiple, 'https://other.example.com/'), code('COOKIE_NOT_FOUND'));
  await assert.rejects(credentials.resolve('work', { ...service, id: 'other-service' }, service.baseUrl), code('COOKIE_NOT_FOUND'));
  await credentials.pair({ alias: 'other', profileId: 'other-profile', storeId: '0', extensionId });
  await assert.rejects(credentials.resolve('other', service, service.baseUrl), code('COOKIE_NOT_FOUND'));
});

test('Set-Cookie updates only this session, match RFC path/expiry rules and are atomic', async t => {
  const { credentials } = await fixture(t);
  const session = await credentials.saveSnapshot('work', service, snapshot());
  const unchanged = await credentials.resolve('work', service, service.baseUrl);
  const generation = session.generation;
  await session.acceptSetCookie(service.baseUrl + '/api/items', ['sid=HTTP_SYNTHETIC; Path=/api; HttpOnly', 'unrequested=IGNORED; Path=/']);
  assert.notEqual(session.generation, generation);
  assert.equal(session.metadata.source, 'http');
  assert.equal(await session.cookieHeader(service.baseUrl + '/api/items'), `sid=HTTP_SYNTHETIC; sid=${secret}`);
  assert.equal(await session.cookieHeader(service.baseUrl + '/outside'), `sid=${secret}`);
  assert.equal(await unchanged.cookieHeader(service.baseUrl + '/api/items'), `sid=${secret}`);
  assert.equal(await (await credentials.resolve('work', service, service.baseUrl)).cookieHeader(service.baseUrl + '/api/items'), `sid=${secret}`);
  const before = session.generation;
  await assert.rejects(session.acceptSetCookie(service.baseUrl, ['sid=BAD_PARTIAL; Path=/', 'sid=EVIL; Domain=evil.example.com']), code('CONTRACT_INVALID'));
  assert.equal(session.generation, before);
  assert.equal(await session.cookieHeader(service.baseUrl), `sid=${secret}`);
  await session.acceptSetCookie(service.baseUrl, ['sid=gone; Path=/; Max-Age=0']);
  assert.equal(await session.cookieHeader(service.baseUrl), '');
});

test('Set-Cookie prefixes and malformed values fail with redacted errors', async t => {
  const { credentials } = await fixture(t);
  const session = await credentials.saveSnapshot('work', service, snapshot());
  for (const header of [`sid=${secret}\r\nHeader: bad`, `sid=${secret}; Domain=bad.invalid`, `sid=${secret};\0`]) {
    await assert.rejects(session.acceptSetCookie(service.baseUrl, [header]), code('CONTRACT_INVALID'));
  }
  const prefixed = { ...service, auth: { cookieNames: ['__Host-sid'] } };
  await assert.rejects(credentials.saveSnapshot('work', prefixed, snapshot([cookie({ name: '__Host-sid', secure: true, domain: '.example.com', hostOnly: false })])), code('CONTRACT_INVALID'));
});

test('a failed atomic publication preserves the prior snapshot and redacts store exceptions', async t => {
  class FailingStore extends MemorySecretStore {
    fail = false;
    override async set(key: string, value: string) {
      if (this.fail && key.startsWith('intra:v1:active:')) throw new Error(secret);
      await super.set(key, value);
    }
  }
  const store = new FailingStore();
  const { credentials } = await fixture(t, store);
  await credentials.saveSnapshot('work', service, snapshot());
  store.fail = true;
  await assert.rejects(credentials.saveSnapshot('work', service, snapshot([cookie({ value: 'NEW_SYNTHETIC' })])), code('KEYCHAIN_UNAVAILABLE'));
  assert.equal(await (await credentials.resolve('work', service, service.baseUrl)).cookieHeader(service.baseUrl), `sid=${secret}`);
});

test('an ambiguous publication failure never leaves an active pointer without its snapshot', async t => {
  class AmbiguousStore extends MemorySecretStore {
    failAfterWrite = false;
    override async set(key: string, value: string) {
      await super.set(key, value);
      if (this.failAfterWrite && key.startsWith('intra:v1:active:')) throw new Error(secret);
    }
  }
  const store = new AmbiguousStore();
  const { credentials } = await fixture(t, store);
  await credentials.saveSnapshot('work', service, snapshot());
  store.failAfterWrite = true;
  await assert.rejects(credentials.saveSnapshot('work', service, snapshot([cookie({ value: 'COMPLETE_NEW_SNAPSHOT' })])), code('KEYCHAIN_UNAVAILABLE'));
  assert.equal(await (await credentials.resolve('work', service, service.baseUrl)).cookieHeader(service.baseUrl), 'sid=COMPLETE_NEW_SNAPSHOT');
});

test('cross-instance refresh locks serialize and expire bounded waits', async t => {
  const { credentials, home, store } = await fixture(t);
  const second = new Credentials({ home, store });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const block = new Promise<void>(resolve => { release = resolve; });
  const first = credentials.withRefreshLock('work', service, async () => { entered(); await block; return 'first'; });
  await started;
  await assert.rejects(second.withRefreshLock('work', service, async () => 'must not run', { timeoutMs: 30, pollMs: 5 }), code('REFRESH_LOCK_TIMEOUT'));
  release();
  assert.equal(await first, 'first');
  assert.equal(await second.withRefreshLock('work', service, async () => 'after'), 'after');
});

test('refresh locks also exclude a separate Node process', async t => {
  const { credentials, home } = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const block = new Promise<void>(resolve => { release = resolve; });
  const holder = credentials.withRefreshLock('work', service, async () => { entered(); await block; });
  await started;
  const moduleURL = new URL('../packages/credentials/src/index.js', import.meta.url).href;
  const program = `import { Credentials, MemorySecretStore } from ${JSON.stringify(moduleURL)};
    const credentials = new Credentials({ home: ${JSON.stringify(home)}, store: new MemorySecretStore() });
    try { await credentials.withRefreshLock('work', ${JSON.stringify(service)}, async () => {}, { timeoutMs: 40, pollMs: 5 }); process.exitCode = 2; }
    catch (error) { if(error.code !== 'REFRESH_LOCK_TIMEOUT') process.exitCode = 3; }`;
  try {
    const result = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore' });
      child.on('error', reject); child.on('exit', resolve);
    });
    assert.equal(result, 0);
  } finally { release(); await holder; }
});

test('MacKeychainStore sends secrets only through captured JSON stdin and stays lazy', async () => {
  const calls: { executable: string; args: readonly string[]; input: string; environment: unknown }[] = [];
  const runner: NativeRunner = async (executable, args, input, options) => {
    calls.push({ executable, args, input, environment: options.env });
    const request = JSON.parse(input) as { op: string };
    return { stdout: JSON.stringify(request.op === 'get' ? { ok: true, value: secret } : { ok: true }), exitCode: 0 };
  };
  const store = new MacKeychainStore({ helperPath: '/synthetic/helper', runner });
  assert.equal(calls.length, 0);
  await store.set('test-key', secret);
  assert.equal(await store.get('test-key'), secret);
  await store.delete('test-key');
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[0]!.input).value, secret);
  for (const call of calls) {
    assert.deepEqual(call.args, []);
    assert.ok(!JSON.stringify(call.environment).includes(secret));
    assert.ok(!call.executable.includes(secret));
  }
  assert.ok(!JSON.stringify(store).includes(secret));
  assert.ok(!inspect(store).includes(secret));
});

test('helper failures, malformed outputs and rejected promises are always redacted', async () => {
  const failures: NativeRunner[] = [
    async () => ({ stdout: secret, stderr: secret, exitCode: 1 }),
    async () => ({ stdout: secret, stderr: secret, exitCode: 0 }),
    async () => ({ stdout: JSON.stringify({ ok: false, error: secret }), exitCode: 0 }),
    async () => ({ stdout: JSON.stringify({ ok: true, value: secret, debug: secret }), exitCode: 0 }),
    async () => { throw new Error(secret); },
  ];
  for (const runner of failures) {
    const store = new MacKeychainStore({ helperPath: '/synthetic/helper', runner });
    await assert.rejects(store.get('test-key'), code('KEYCHAIN_UNAVAILABLE'));
  }
});

test('native process runner captures stdout and discards stderr without invoking Keychain', async () => {
  const input = JSON.stringify({ value: secret });
  const result = await runNativeHelper(process.execPath, ['-e', "process.stdin.pipe(process.stdout);process.stderr.write('SYNTHETIC_DIAGNOSTIC')"], input,
    { env: {}, timeoutMs: 3000, maxOutputBytes: 4096 });
  assert.equal(result.stdout, input);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, undefined);
});

test('explicit helper builds use Clang with no request payload and reuse the private binary', { skip: process.platform !== 'darwin' }, async t => {
  const { home } = await fixture(t);
  let builds = 0;
  const runner: NativeRunner = async (executable, args, stdin, options) => {
    builds++;
    assert.equal(executable, '/usr/bin/xcrun');
    assert.deepEqual(args.slice(0, 7), ['clang', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security', '-O2']);
    assert.ok(args[7]!.endsWith('/native/keychain.m'));
    assert.equal(args[8], '-o');
    assert.equal(stdin, '');
    assert.ok(!JSON.stringify(options.env).includes(secret));
    await writeFile(args[9]!, 'synthetic compiled artifact, never executed', { flag: 'wx', mode: 0o600 });
    return { stdout: '', exitCode: 0 };
  };
  const binary = await buildKeychainHelper({ home, runner });
  assert.equal((await stat(binary)).mode & 0o777, 0o700);
  assert.equal(await buildKeychainHelper({ home, runner }), binary);
  assert.equal(builds, 1);
});

test('native helper source has no command-line secret path and uses Security APIs', async () => {
  const source = await readFile(join(projectRoot, 'packages/credentials/native/keychain.m'), 'utf8');
  assert.ok(source.includes('SecItemCopyMatching'));
  assert.ok(source.includes('SecItemUpdate'));
  assert.ok(source.includes('fileHandleWithStandardInput'));
  assert.ok(!source.includes('argv'));
  assert.ok(!source.includes('add-generic-password'));
});
