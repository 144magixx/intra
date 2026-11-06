import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { Core, success, failure } from '../../../packages/core/src/index.js';
import { validateHeaders } from '../../../packages/registry/src/index.js';
import { IntraError, getPointer, validate, type ToolResult } from '../../../packages/contracts/src/index.js';
import { requestInput, type Values } from '../../cli/src/main.js';

export interface ToolContext {
  core: Core;
  home: string;
  defaultProfile?: string;
  /** Upper bound for one HTTP attempt; must stay below the host's tool-call deadline. */
  maxTimeoutMs: number;
  /** Artifacts written by this server process; reading is limited to these and INTRA_HOME/outputs. */
  artifacts: Set<string>;
}
export interface ToolAnnotations { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** Network tools run one at a time so credential refresh and output paths never race inside one server. */
  exclusive: boolean;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

const maxTextBytes = 1024 * 1024;
const maxSliceBytes = 64 * 1024;
const defaultSliceBytes = 16 * 1024;
const maxParseBytes = 64 * 1024 * 1024;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function invalidArguments(action: string): ToolResult {
  return { schemaVersion: 1, requestId: randomUUID(), ok: false, meta: {},
    error: { code: 'INVALID_ARGUMENT', message: 'The supplied arguments are invalid.', retryable: false, action } };
}
class ArgumentProblem extends Error {}
function profileOf(args: Record<string, unknown>, context: ToolContext): string {
  const profile = (args.profile as string | undefined) ?? context.defaultProfile;
  if (!profile) throw new ArgumentProblem('profile is required: pass the paired profile alias (no INTRA_DEFAULT_PROFILE is configured).');
  return profile;
}
function callOptions(args: Record<string, unknown>, context: ToolContext) {
  return { profile: profileOf(args, context), output: args.output as string | undefined,
    timeoutMs: args.timeoutMs as number | undefined, maxBytes: args.maxBytes as number | undefined };
}
function record(result: ToolResult, context: ToolContext): ToolResult {
  if (result.artifact?.path) context.artifacts.add(path.resolve(result.artifact.path));
  return result;
}

const profileProperty = { type: 'string', minLength: 1, description: 'Paired Intra profile alias, e.g. "work". Optional only when the server sets INTRA_DEFAULT_PROFILE; never guess another alias.' };
const outputProperties = (maxTimeoutMs: number) => ({
  output: { type: 'string', minLength: 1, description: 'Absolute path of a NEW response file (existing files are never overwritten; parent must exist). Default: INTRA_HOME/outputs/<requestId>.json.' },
  timeoutMs: { type: 'integer', minimum: 1, maximum: maxTimeoutMs, description: `Single HTTP attempt deadline in ms (default 30000, max ${maxTimeoutMs}).` },
  maxBytes: { type: 'integer', minimum: 1, maximum: 100 * 1024 * 1024, description: 'Decoded response body budget in bytes (default 10 MiB, max 100 MiB).' },
});

export function toolDefinitions(maxTimeoutMs: number): ToolDefinition[] {
  return [
    {
      name: 'intra_request',
      description: [
        'Send one explicit HTTP(S) request using the paired browser login state (cookies selected for the URL by Intra; never exposed).',
        'Supply either a full `url`, or a registered `service` plus `path`. The method must be explicit; never infer it from a payload.',
        'Body: at most one of `json` (any JSON value), `jsonFile`, `text`+`contentType`, `bodyFile`+`contentType` (UTF-8, max 1 MiB). GET/HEAD take no body.',
        '`query` takes scalar values only and must not repeat a key already in the URL. `headers` are non-auth string headers; Cookie/Authorization/CSRF/token headers and Content-Type alongside a body are rejected.',
        'The response body is saved to `artifact.path`, not returned inline; read it with intra_read_artifact. ok=true only means a 2xx response was received: data.businessSuccess is "unknown", so check the business code yourself.',
        'Requests are never replayed. On REQUEST_OUTCOME_UNKNOWN the server may already have executed the request: do not resend it.',
      ].join(' '),
      inputSchema: { type: 'object', additionalProperties: false, required: ['method'], properties: {
        url: { type: 'string', minLength: 1, description: 'Complete http(s) URL including any existing query. Mutually exclusive with service/path.' },
        service: { type: 'string', minLength: 1, description: 'Registered service id (use with path).' },
        path: { type: 'string', minLength: 1, description: 'Path (and optional query) on the registered service, starting with /.' },
        method: { type: 'string', enum: methods },
        profile: profileProperty,
        query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Extra scalar query parameters.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Non-authentication request headers.' },
        json: { description: 'JSON request body, sent as application/json with types preserved.' },
        jsonFile: { type: 'string', minLength: 1, description: 'Path of a UTF-8 JSON body file (max 1 MiB).' },
        text: { type: 'string', description: 'Raw UTF-8 body sent byte-for-byte; requires contentType.' },
        bodyFile: { type: 'string', minLength: 1, description: 'Path of a raw UTF-8 body file (max 1 MiB); requires contentType.' },
        contentType: { type: 'string', minLength: 1, description: 'Content-Type for text/bodyFile, e.g. application/x-www-form-urlencoded.' },
        ...outputProperties(maxTimeoutMs),
      } },
      annotations: { title: 'Intra HTTP request', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      exclusive: true,
      async run(args, context) {
        const direct = args.url !== undefined;
        if (direct === (args.service !== undefined) || (args.service !== undefined) !== (args.path !== undefined)) {
          throw new ArgumentProblem('Provide exactly one target: `url`, or `service` together with `path`.');
        }
        const bodies = ['json', 'jsonFile', 'text', 'bodyFile'].filter(name => Object.hasOwn(args, name));
        if (bodies.length > 1) throw new ArgumentProblem(`Use only one body field; received ${bodies.join(', ')}.`);
        const raw = bodies[0] === 'text' || bodies[0] === 'bodyFile';
        if (raw !== (args.contentType !== undefined)) throw new ArgumentProblem('contentType is required with text/bodyFile and not allowed otherwise.');
        if (bodies.length && Object.keys((args.headers ?? {}) as object).some(name => name.toLowerCase() === 'content-type')) {
          throw new ArgumentProblem('Do not set Content-Type in headers when a body is supplied; use contentType for raw bodies.');
        }
        if (bodies.length && ['GET', 'HEAD'].includes(args.method as string)) throw new ArgumentProblem(`${args.method} requests take no body.`);
        const values: Values = { method: args.method as string };
        if (args.headers !== undefined) values['headers-json'] = JSON.stringify(args.headers);
        if (args.query !== undefined) values['query-json'] = JSON.stringify(args.query);
        if (Object.hasOwn(args, 'json')) values.json = JSON.stringify(args.json);
        if (args.jsonFile !== undefined) values['json-file'] = args.jsonFile as string;
        if (args.bodyFile !== undefined) { values['body-file'] = args.bodyFile as string; values['content-type'] = args.contentType as string; }
        const options = callOptions(args, context);
        let request;
        try {
          request = await requestInput(values);
          if (args.text !== undefined) {
            const contentType = args.contentType as string;
            if (!contentType.trim() || Buffer.byteLength(args.text as string) > maxTextBytes) throw new IntraError('INVALID_ARGUMENT');
            request.headers = { ...request.headers, 'Content-Type': contentType };
            validateHeaders(request.headers);
            request.rawBody = args.text as string;
          }
        } catch (error) { return failure(error); }
        return record(direct ? await context.core.requestURL(args.url as string, request, options)
          : await context.core.request(args.service as string, { ...request, path: args.path as string }, options), context);
      },
    },
    {
      name: 'intra_call',
      description: 'Run a registered, verified Intra operation with typed arguments (see intra_list_operations / intra_describe_operation). ok=true means HTTP status, business code and response shape matched the definition; data holds the declared count/total summary and the full body is in artifact.path.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['operationId'], properties: {
        operationId: { type: 'string', minLength: 1 },
        args: { type: 'object', description: 'Operation arguments; unknown keys are rejected and defaults are applied by the definition.' },
        profile: profileProperty,
        ...outputProperties(maxTimeoutMs),
      } },
      annotations: { title: 'Intra registered operation', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      exclusive: true,
      async run(args, context) {
        return record(await context.core.call(args.operationId as string, args.args ?? {}, callOptions(args, context)), context);
      },
    },
    {
      name: 'intra_read_artifact',
      description: 'Read part of a response file produced by Intra (only files from this server or INTRA_HOME/outputs). Modes: `structure: true` returns keys/types/array lengths without values; `pointer` (RFC 6901, e.g. /data/records) selects a JSON value; otherwise a UTF-8 byte slice. Use offset/length and nextOffset to page; output is capped at 64 KiB.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', minLength: 1, description: 'artifact.path from intra_request/intra_call.' },
        pointer: { type: 'string', description: 'JSON Pointer into a JSON artifact; "" is the whole document.' },
        structure: { type: 'boolean', description: 'Describe the shape at pointer (default root) instead of returning values.' },
        offset: { type: 'integer', minimum: 0, description: 'Byte offset (raw slice) or character offset (pointer mode).' },
        length: { type: 'integer', minimum: 1, maximum: maxSliceBytes, description: `Bytes/characters to return (default ${defaultSliceBytes}).` },
      } },
      annotations: { title: 'Read Intra artifact', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      exclusive: false,
      run: readArtifact,
    },
    {
      name: 'intra_list_operations',
      description: 'List locally registered operations (id, service, description, status, semantics, verifiedAt). draft operations cannot be called.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { title: 'List Intra operations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      exclusive: false,
      async run(_args, context) { return success(await context.core.dependencies.registry.listOperations()); },
    },
    {
      name: 'intra_describe_operation',
      description: 'Show one registered operation: argument schema, request skeleton, bindings, response rules and provenance.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['operationId'], properties: { operationId: { type: 'string', minLength: 1 } } },
      annotations: { title: 'Describe Intra operation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      exclusive: false,
      async run(args, context) { return success(await context.core.dependencies.registry.getOperation(args.operationId as string)); },
    },
    {
      name: 'intra_status',
      description: 'Report local readiness: Node/platform, browser bridge connections, locally paired profile aliases and the default profile. Does not read the Keychain or prove that any account is logged in. Use only when a request fails with a profile/bridge error, not before every request.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { title: 'Intra status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      exclusive: false,
      async run(_args, context) {
        const { bridge, credentials } = context.core.dependencies;
        let browserProfiles: unknown[] = [];
        let nativeHost = 'not-connected';
        try { browserProfiles = await bridge.listProfiles(); if (browserProfiles.length) nativeHost = 'connected'; }
        catch (error) { nativeHost = `unavailable:${failure(error).error!.code}`; }
        let localProfiles: unknown = [];
        try { localProfiles = await credentials.profiles(); } catch (error) { localProfiles = { error: failure(error).error!.code }; }
        return success({ node: process.versions.node, platform: process.platform, intraHome: context.home,
          keychain: process.platform === 'darwin' ? 'not-checked' : 'unsupported-platform', nativeHost, browserProfiles, localProfiles,
          defaultProfile: context.defaultProfile ?? null, maxTimeoutMs: context.maxTimeoutMs,
          note: 'Pairing (intra auth pair) and registration (intra api register) require the user and stay CLI-only.' });
      },
    },
    {
      name: 'intra_auth_check',
      description: 'Run the registered service\'s read-only identity probe with cached credentials. Returns status UNKNOWN when the service has no probe; it never calls other business endpoints or syncs the browser.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['service'], properties: { service: { type: 'string', minLength: 1 }, profile: profileProperty } },
      annotations: { title: 'Intra identity check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      exclusive: true,
      async run(args, context) { return context.core.authCheck(args.service as string, profileOf(args, context)); },
    },
  ];
}

async function readArtifact(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const requested = path.resolve(args.path as string);
  let resolved: string;
  try { resolved = await realpath(requested); } catch { return failure(new IntraError('INVALID_ARGUMENT')); }
  let outputs: string | undefined;
  try { outputs = await realpath(path.join(context.home, 'outputs')); } catch { /* no default outputs yet */ }
  const known = context.artifacts.has(requested) || context.artifacts.has(resolved);
  const inOutputs = outputs !== undefined && path.dirname(resolved) === outputs;
  if (!known && !inOutputs) throw new ArgumentProblem('Only artifacts returned by this server or files directly in INTRA_HOME/outputs can be read.');
  const info = await lstat(resolved);
  if (!info.isFile()) throw new ArgumentProblem('The artifact is not a regular file.');
  const offset = (args.offset as number | undefined) ?? 0;
  const length = (args.length as number | undefined) ?? defaultSliceBytes;
  if (args.pointer !== undefined || args.structure === true) {
    if (info.size > maxParseBytes) throw new ArgumentProblem(`The artifact exceeds ${maxParseBytes} bytes; read raw slices instead.`);
    let document: unknown;
    try { document = JSON.parse(await readBytes(resolved, 0, info.size).then(bytes => bytes.toString('utf8'))); }
    catch { throw new ArgumentProblem('The artifact is not valid JSON; omit pointer/structure to read raw slices.'); }
    const pointer = (args.pointer as string | undefined) ?? '';
    let value: unknown;
    try { value = getPointer(document, pointer); } catch { throw new ArgumentProblem('pointer must be an RFC 6901 JSON Pointer such as /data/records/0.'); }
    if (value === undefined) return success({ path: resolved, pointer, found: false });
    if (args.structure === true) return success({ path: resolved, pointer, found: true, structure: describe(value, 0) });
    const text = JSON.stringify(value);
    const slice = text.slice(offset, offset + length);
    const next = offset + slice.length;
    return success({ path: resolved, pointer, found: true, type: kind(value), ...(Array.isArray(value) ? { length: value.length } : {}),
      totalChars: text.length, offset, returnedChars: slice.length, nextOffset: next < text.length ? next : null, text: slice });
  }
  const start = Math.min(offset, info.size);
  const window = await readBytes(resolved, start, Math.min(length + 4, info.size - start));
  // Keep slices on UTF-8 boundaries so pages concatenate losslessly.
  let begin = 0;
  while (begin < window.length && begin < 4 && (window[begin]! & 0xc0) === 0x80) begin++;
  let end = Math.min(begin + length, window.length);
  if (start + end < info.size) while (end > begin && (window[end]! & 0xc0) === 0x80) end--;
  const next = start + end;
  return success({ path: resolved, totalBytes: info.size, offset: start + begin, returnedBytes: end - begin,
    nextOffset: next < info.size ? next : null, text: window.subarray(begin, end).toString('utf8') });
}
async function readBytes(file: string, position: number, size: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(Math.max(0, size));
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, position + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally { await handle.close(); }
}
function kind(value: unknown): string { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
/** Shape only: keys, types, array lengths and string lengths; never values. */
function describe(value: unknown, depth: number): unknown {
  const type = kind(value);
  if (type === 'string') return { type, length: (value as string).length };
  if (type === 'array') {
    const items = value as unknown[];
    return { type, length: items.length, ...(items.length && depth < 4 ? { item: describe(items[0], depth + 1) } : {}) };
  }
  if (type === 'object') {
    const keys = Object.keys(value as object);
    if (depth >= 4) return { type, keyCount: keys.length };
    const shown = keys.slice(0, 60);
    return { type, keys: Object.fromEntries(shown.map(key => [key, describe((value as Record<string, unknown>)[key], depth + 1)])),
      ...(keys.length > shown.length ? { omittedKeys: keys.length - shown.length } : {}) };
  }
  return { type };
}

function describeAjvError(error: ErrorObject | undefined): string {
  if (!error) return 'Arguments do not match the tool input schema.';
  const where = error.instancePath || '(root)';
  if (error.keyword === 'additionalProperties') return `${where}: unknown property "${String(error.params.additionalProperty)}".`;
  if (error.keyword === 'enum') return `${where}: must be one of ${JSON.stringify(error.params.allowedValues)}.`;
  return `${where}: ${error.message ?? 'invalid value'}.`;
}

export class ToolSet {
  readonly definitions: ToolDefinition[];
  readonly #validators = new Map<string, ValidateFunction>();
  constructor(readonly context: ToolContext) {
    this.definitions = toolDefinitions(context.maxTimeoutMs);
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: false });
    for (const tool of this.definitions) this.#validators.set(tool.name, ajv.compile(tool.inputSchema));
  }
  get(name: string): ToolDefinition | undefined { return this.definitions.find(tool => tool.name === name); }
  async call(name: string, input: unknown): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) throw new IntraError('INVALID_ARGUMENT');
    const args = input ?? {};
    const validator = this.#validators.get(name)!;
    if (args === null || typeof args !== 'object' || Array.isArray(args) || !validator(args)) {
      return invalidArguments(describeAjvError(validator.errors?.[0]));
    }
    let result: ToolResult;
    try { result = await tool.run(args as Record<string, unknown>, this.context); }
    catch (error) { result = error instanceof ArgumentProblem ? invalidArguments(error.message) : failure(error); }
    try { validate('tool-result', result); } catch { result = failure(new IntraError('INTERNAL_ERROR')); }
    return result;
  }
}
