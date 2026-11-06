#!/usr/bin/env node
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Core, success, failure } from '../../../packages/core/src/index.js';
import { Registry, validateHeaders } from '../../../packages/registry/src/index.js';
import { Credentials, MacKeychainStore } from '../../../packages/credentials/src/index.js';
import { BrowserBridge } from '../../native-host/src/client.js';
import { importDefinition } from '../../../packages/discovery/src/index.js';
import { IntraError, exitCodeFor, validate, assertJson, isRecord, type MaterializedRequest, type ToolResult } from '../../../packages/contracts/src/index.js';

const requestPayloadUsage = '[--json JSON | --json-file PATH | --body-file PATH --content-type TYPE] [--query-json JSON] [--headers-json JSON] [--output PATH] [--timeout-ms N] [--max-bytes N]';
const usage = [
  'intra doctor', 'intra auth profiles',
  'intra auth pair --profile ALIAS --profile-id ID [--store ID]',
  'intra auth sync --service ID --profile ALIAS', 'intra auth check --service ID --profile ALIAS',
  'intra api register --file PATH [--replace]', 'intra api describe ID', 'intra api import --file PATH',
  'intra call ID --profile ALIAS [--args-json JSON] [--output PATH] [--timeout-ms N] [--max-bytes N]',
  `intra request --url FULL_URL --method METHOD --profile ALIAS ${requestPayloadUsage}`,
  `intra request --service ID --path PATH --method METHOD --profile ALIAS ${requestPayloadUsage}`,
];
export type Values = Record<string, string | boolean | undefined>;
function parse(argv: string[], fields: string[], booleans: string[] = []): { values: Values; positionals: string[] } {
  try {
    const parsed = parseArgs({ args: argv, strict: true, allowPositionals: true, tokens: true,
      options: Object.fromEntries([...fields.map(key => [key, { type: 'string' as const }]), ...booleans.map(key => [key, { type: 'boolean' as const }])]) });
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) throw new IntraError('INVALID_ARGUMENT');
      seen.add(token.name);
    }
    return parsed as { values: Values; positionals: string[] };
  } catch { throw new IntraError('INVALID_ARGUMENT'); }
}
function required(value: string | boolean | undefined): string {
  if (typeof value !== 'string' || !value.length) throw new IntraError('INVALID_ARGUMENT');
  return value;
}
function json(value: string | boolean | undefined, fallback?: unknown): unknown {
  if (value === undefined) return fallback;
  try { return JSON.parse(required(value)); } catch { throw new IntraError('INVALID_ARGUMENT'); }
}
const maxInputBytes = 1024 * 1024;
async function inputFile(value: string | boolean | undefined): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Nonblocking open lets fstat reject FIFOs without waiting for a writer.
    file = await open(required(value), constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > maxInputBytes) throw new IntraError('INVALID_ARGUMENT');
    // Bound the actual read too: a regular file can grow after fstat.
    const buffer = Buffer.alloc(maxInputBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxInputBytes) throw new IntraError('INVALID_ARGUMENT');
    // Preserve a BOM, line endings and whitespace in raw payloads.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } catch { throw new IntraError('INVALID_ARGUMENT'); }
  finally { await file?.close().catch(() => undefined); }
}
/** Shared by the CLI and MCP entry points so both enforce identical payload rules. */
export async function requestInput(values: Values): Promise<Omit<MaterializedRequest, 'path' | 'url'>> {
  const method = required(values.method);
  const payloads = ['json', 'json-file', 'body-file'].filter(name => values[name] !== undefined);
  if (payloads.length > 1 || (values['content-type'] !== undefined) !== (values['body-file'] !== undefined)) {
    throw new IntraError('INVALID_ARGUMENT');
  }
  const headers = json(values['headers-json']);
  validateHeaders(headers);
  const request: Omit<MaterializedRequest, 'path' | 'url'> = { method };
  if (headers !== undefined) request.headers = headers as Record<string, string>;
  if (payloads.length && Object.keys(request.headers ?? {}).some(name => name.toLowerCase() === 'content-type')) {
    throw new IntraError('INVALID_ARGUMENT');
  }
  if (values['query-json'] !== undefined) {
    const query = json(values['query-json']);
    assertJson(query, 'INVALID_ARGUMENT');
    if (!isRecord(query)) throw new IntraError('INVALID_ARGUMENT');
    request.query = query;
  }
  if (values['body-file'] !== undefined) {
    const contentType = required(values['content-type']);
    if (!contentType.trim()) throw new IntraError('INVALID_ARGUMENT');
    request.headers = { ...request.headers, 'Content-Type': contentType };
    validateHeaders(request.headers);
    request.rawBody = await inputFile(values['body-file']);
  } else if (payloads.length) {
    const body = json(values['json-file'] !== undefined ? await inputFile(values['json-file']) : values.json);
    assertJson(body, 'INVALID_ARGUMENT');
    request.body = body;
  }
  return request;
}
function positive(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const raw = required(value);
  const number = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 1) throw new IntraError('INVALID_ARGUMENT');
  return number;
}
function positional(values: string[], count: number) {
  if (values.length !== count) throw new IntraError('INVALID_ARGUMENT');
}
export function createCore(home = path.resolve(process.env.INTRA_HOME ?? path.join(homedir(), '.intra'))): Core {
  return new Core({ home, registry: new Registry(path.join(home, 'registry')),
    credentials: new Credentials({ store: new MacKeychainStore({ home }), home }), bridge: new BrowserBridge({ home }) });
}
export async function runCLI(argv: string[], core?: Core): Promise<ToolResult> {
  try {
    if (!argv.length || (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]))) return success({ usage, version: '0.1.0', stage: 'development',
      requestInput: 'Supply the URL or registered service/path, explicit method, and payload. No screenshot parsing, endpoint discovery, or business parameter inference.',
      requestFiles: 'JSON/raw files must be regular UTF-8 files of at most 1 MiB. Raw text requires --content-type. Payload headers must not also set Content-Type.',
      requestAuth: 'URL mode needs no registration; authorized cookies are selected for the URL. Request headers cannot supply credentials.' });
    const app = core ?? createCore();
    const [command, ...rest] = argv;
    if (command === 'doctor') {
      const { positionals } = parse(rest, []); positional(positionals, 0);
      const profiles = await app.dependencies.bridge.listProfiles();
      return success({ node: process.versions.node, platform: process.platform, cli: 'available',
        keychain: process.platform === 'darwin' ? 'not-checked' : 'unsupported-platform',
        nativeHost: profiles.length ? 'connected' : 'not-connected', profiles,
        note: 'Connectivity does not verify account authentication. Keychain access is checked only when requested.' });
    }
    if (command === 'api') {
      const [action, ...tail] = rest;
      if (action === 'register') {
        const { values, positionals } = parse(tail, ['file'], ['replace']); positional(positionals, 0);
        return success(await app.dependencies.registry.registerFile(required(values.file), { replace: values.replace === true }));
      }
      if (action === 'describe') {
        const { positionals } = parse(tail, []); positional(positionals, 1);
        return success(await app.dependencies.registry.getOperation(positionals[0]));
      }
      if (action === 'import') {
        const { values, positionals } = parse(tail, ['file']); positional(positionals, 0);
        let value: unknown;
        try { value = JSON.parse(await readFile(required(values.file), 'utf8')); } catch { throw new IntraError('INVALID_ARGUMENT'); }
        return success(importDefinition(value));
      }
    }
    if (command === 'auth') {
      const [action, ...tail] = rest;
      if (action === 'profiles') {
        const { positionals } = parse(tail, []); positional(positionals, 0);
        return success({ profiles: await app.dependencies.bridge.listProfiles() });
      }
      if (action === 'pair') {
        const { values, positionals } = parse(tail, ['profile', 'profile-id', 'store']); positional(positionals, 0);
        return await app.pairProfile(required(values.profile), required(values['profile-id']), values.store as string | undefined);
      }
      if (action === 'sync' || action === 'check') {
        const { values, positionals } = parse(tail, ['service', 'profile']); positional(positionals, 0);
        return await (action === 'sync' ? app.authSync(required(values.service), required(values.profile)) : app.authCheck(required(values.service), required(values.profile)));
      }
    }
    if (command === 'call' || command === 'request') {
      const names = ['profile', 'output', 'timeout-ms', 'max-bytes'];
      const { values, positionals } = parse(rest, [...names, ...(command === 'call' ? ['args-json']
        : ['url', 'service', 'method', 'path', 'json', 'json-file', 'body-file', 'content-type', 'query-json', 'headers-json'])]);
      positional(positionals, command === 'call' ? 1 : 0);
      const options = { profile: required(values.profile), output: values.output as string | undefined,
        timeoutMs: positive(values['timeout-ms']), maxBytes: positive(values['max-bytes']) };
      if (command === 'call') return await app.call(positionals[0], json(values['args-json'], {}), options);
      const direct = values.url !== undefined;
      if (direct && (values.service !== undefined || values.path !== undefined)) throw new IntraError('INVALID_ARGUMENT');
      const target = direct ? required(values.url) : required(values.service);
      const requestPath = direct ? undefined : required(values.path);
      const request = await requestInput(values);
      return direct ? await app.requestURL(target, request, options)
        : await app.request(target, { ...request, path: requestPath! }, options);
    }
    throw new IntraError('INVALID_ARGUMENT');
  } catch (error) { return failure(error); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result = await runCLI(process.argv.slice(2));
  try { validate('tool-result', result); } catch { result = failure(new IntraError('INTERNAL_ERROR')); }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.ok ? 0 : exitCodeFor(result.error!.code);
}
