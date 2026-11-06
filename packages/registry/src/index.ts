import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  IntraError, assertJson, cloneJson, getPointer, isRecord, pointerTokens, setPointer,
  validate, validateArguments, validateArgumentSchema,
  type JSONValue, type MaterializedRequest, type Operation, type Service,
} from '../../contracts/src/index.js';

export type DefinitionKind = 'service' | 'operation';
export interface RegisterOptions { replace?: boolean }
export interface ResolvedOperation { service: Service; operation: Operation; request: MaterializedRequest }
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const forbiddenHeaders = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'cookie2', 'set-cookie', 'host',
  'connection', 'content-length', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect',
  'forwarded', 'via', 'origin', 'referer', 'x-http-method-override',
]);
const maxDefinitionBytes = 1024 * 1024;

export function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    || id.includes('..') || id.endsWith('.') || ['constructor', 'prototype', '__proto__'].includes(id)) {
    throw new IntraError('CONTRACT_INVALID');
  }
}
function exactOrigin(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new IntraError('CONTRACT_INVALID'); }
  if (!['https:', 'http:'].includes(url.protocol) || value !== url.origin || url.username || url.password) {
    throw new IntraError('CONTRACT_INVALID');
  }
  return url;
}
export function validateHeaders(headers: unknown): void {
  if (headers === undefined) return;
  if (!isRecord(headers)) throw new IntraError('CONTRACT_INVALID');
  assertJson(headers);
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || seen.has(lower)
      || forbiddenHeaders.has(lower) || /^(?:proxy-|sec-|x-forwarded-|x-original-|x-rewrite-)/.test(lower)
      || /(?:auth|token|cookie|secret|signature|api[-_]?key|credential|csrf|xsrf)/.test(lower)
      || typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new IntraError('CONTRACT_INVALID');
    seen.add(lower);
  }
}
export function validateService(value: unknown): Service {
  const service = validate('service', value);
  validateId(service.id);
  const base = exactOrigin(service.baseUrl);
  if (!service.allowedOrigins.includes(base.origin) || new Set(service.allowedOrigins).size !== service.allowedOrigins.length) {
    throw new IntraError('CONTRACT_INVALID');
  }
  for (const exception of service.protocolExceptions ?? []) {
    if (exactOrigin(exception.origin).protocol !== 'http:' || !service.allowedOrigins.includes(exception.origin) || !exception.reason.trim()) {
      throw new IntraError('CONTRACT_INVALID');
    }
  }
  for (const origin of service.allowedOrigins) {
    const url = exactOrigin(origin);
    if (url.protocol === 'http:' && !service.protocolExceptions?.some(exception => exception.origin === origin)) {
      throw new IntraError('CONTRACT_INVALID');
    }
  }
  if (service.auth.cookieNames && service.auth.cookieNames.length > 16) throw new IntraError('CONTRACT_INVALID');
  for (const name of service.auth.cookieNames ?? []) {
    if (name.length > 256 || /[\x00-\x20\x7f]/.test(name) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new IntraError('CONTRACT_INVALID');
  }
  if (service.auth.identityProbeOperation !== undefined) validateId(service.auth.identityProbeOperation);
  for (const rule of service.auth.authFailureRules ?? []) {
    if (rule.pointer !== undefined) pointerTokens(rule.pointer);
    if (rule.kind === 'loginRedirect') {
      if (rule.origin === undefined || rule.pathPrefix === undefined) throw new IntraError('CONTRACT_INVALID');
      exactOrigin(rule.origin);
      validatePath(rule.pathPrefix);
    }
    if (rule.kind === 'businessCode' && (rule.pointer === undefined || !Object.hasOwn(rule, 'equals'))) {
      throw new IntraError('CONTRACT_INVALID');
    }
    if (rule.kind === 'probeFailure' && !service.auth.identityProbeOperation) throw new IntraError('CONTRACT_INVALID');
  }
  return service;
}
function validatePath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(path)) {
    throw new IntraError('CONTRACT_INVALID');
  }
  // Only the pathname can alter URL structure. Query values are URLSearchParams data.
  let decoded: string;
  try { decoded = decodeURIComponent(path.split('?', 1)[0]!); } catch { throw new IntraError('CONTRACT_INVALID'); }
  for (let depth = 0; depth < 8; depth++) {
    if (decoded.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(decoded)) throw new IntraError('CONTRACT_INVALID');
    // Decode nested structural escapes without interpreting literal percent text as UTF-8.
    const next = decoded.replace(/%(?:25|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/gi,
      escape => String.fromCharCode(Number.parseInt(escape.slice(1), 16)));
    if (next === decoded) return;
    decoded = next;
  }
  throw new IntraError('CONTRACT_INVALID');
}
function queryString(value: JSONValue): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new IntraError('CONTRACT_INVALID');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new IntraError('CONTRACT_INVALID');
  return String(value);
}
function validateRequestShape(request: MaterializedRequest): void {
  if (!isRecord(request)) throw new IntraError('CONTRACT_INVALID');
  const known = new Set(['method', 'path', 'query', 'headers', 'body', 'rawBody', 'url']);
  for (const key of Reflect.ownKeys(request)) {
    if (typeof key !== 'string' || !known.has(key)) throw new IntraError('CONTRACT_INVALID');
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new IntraError('CONTRACT_INVALID');
    if (descriptor.value !== undefined) assertJson(descriptor.value);
  }
  if (!methods.has(request.method)) throw new IntraError('CONTRACT_INVALID');
  validatePath(request.path);
  validateHeaders(request.headers);
  if (request.query !== undefined) {
    assertJson(request.query);
    if (!isRecord(request.query)) throw new IntraError('CONTRACT_INVALID');
    for (const value of Object.values(request.query)) queryString(value);
  }
  if (request.body !== undefined) {
    assertJson(request.body);
    if (request.rawBody !== undefined || request.method === 'GET' || request.method === 'HEAD') throw new IntraError('CONTRACT_INVALID');
  }
  if (request.rawBody !== undefined) {
    const type = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    if (typeof request.rawBody !== 'string' || request.method === 'GET' || request.method === 'HEAD'
      || !type || !type.trim()) throw new IntraError('CONTRACT_INVALID');
  }
  if (request.url !== undefined && typeof request.url !== 'string') throw new IntraError('CONTRACT_INVALID');
}
/** Returns the actual encoded URL, including scalar query values. Does not send a request. */
export function validateRequest(service: Service, request: MaterializedRequest): URL {
  validateService(service);
  validateRequestShape(request);
  let url: URL;
  try { url = new URL(request.path, service.baseUrl); } catch { throw new IntraError('CONTRACT_INVALID'); }
  if (url.origin !== service.baseUrl || !service.allowedOrigins.includes(url.origin) || url.username || url.password || url.hash) {
    throw new IntraError('CONTRACT_INVALID');
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    // Avoid two sources giving different values for the same query parameter.
    if (url.searchParams.has(key)) throw new IntraError('CONTRACT_INVALID');
    url.searchParams.append(key, queryString(value));
  }
  if (request.url !== undefined && request.url !== url.href) throw new IntraError('CONTRACT_INVALID');
  return url;
}
function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1
    || Number(day) > new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now();
}
export function validateOperation(value: unknown): Operation {
  const operation = validate('operation', value);
  validateId(operation.id);
  validateId(operation.service);
  validateArgumentSchema(operation.arguments);
  validateRequestShape(operation.request);
  if (operation.provenance.verifiedAt !== undefined && !validTimestamp(operation.provenance.verifiedAt)) throw new IntraError('CONTRACT_INVALID');
  if (operation.status === 'verified' && (!operation.provenance.verifiedAt
    || !operation.provenance.evidence?.length || operation.provenance.evidence.some(item => !item.trim()))) {
    throw new IntraError('CONTRACT_INVALID');
  }
  const properties = isRecord(operation.arguments.properties) ? operation.arguments.properties : {};
  const previous: { target: string; tokens: string[] }[] = [];
  for (const binding of operation.bindings) {
    if (!Object.hasOwn(properties, binding.argument)) throw new IntraError('CONTRACT_INVALID');
    const tokens = pointerTokens(binding.pointer);
    if (operation.request[binding.target] === undefined || getPointer(operation.request[binding.target], binding.pointer) === undefined) {
      throw new IntraError('CONTRACT_INVALID');
    }
    // Whole-root replacement is supported, but cannot overlap another binding.
    if (previous.some(item => item.target === binding.target &&
      item.tokens.slice(0, Math.min(tokens.length, item.tokens.length)).every((token, index) => token === tokens[index]))) {
      throw new IntraError('CONTRACT_INVALID');
    }
    previous.push({ target: binding.target, tokens });
  }
  for (const pointer of [operation.response.success.code?.pointer, operation.response.itemsPointer,
    operation.response.totalPointer, operation.response.identityPointer]) if (pointer !== undefined) pointerTokens(pointer);
  return operation;
}
export function materialize(service: Service, operation: Operation, args: unknown): MaterializedRequest {
  validateService(service);
  validateOperation(operation);
  if (operation.service !== service.id) throw new IntraError('CONTRACT_INVALID');
  if (operation.status !== 'verified') throw new IntraError('OPERATION_UNVERIFIED');
  const argumentsWithDefaults = validateArguments(operation.arguments, args);
  const request = cloneJson(operation.request) as MaterializedRequest;
  for (const binding of operation.bindings) {
    if (!Object.hasOwn(argumentsWithDefaults, binding.argument)) continue;
    const result = setPointer(request[binding.target], binding.pointer, argumentsWithDefaults[binding.argument]);
    if (binding.target === 'query') {
      if (!isRecord(result)) throw new IntraError('CONTRACT_INVALID');
      request.query = result as Record<string, JSONValue>;
    } else request.body = result;
  }
  request.url = validateRequest(service, request).href;
  return request;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
async function readDefinition(path: string, missingCode: string, noFollow: boolean): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (noFollow ? constants.O_NOFOLLOW : 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxDefinitionBytes) throw new IntraError('CONTRACT_INVALID');
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > maxDefinitionBytes) throw new IntraError('CONTRACT_INVALID');
    try { return JSON.parse(text); } catch { throw new IntraError('CONTRACT_INVALID'); }
  } catch (error) {
    if (error instanceof IntraError) throw error;
    throw new IntraError(errorCode(error) === 'ENOENT' ? missingCode : 'REGISTRY_ERROR');
  } finally { await handle?.close(); }
}

export class Registry {
  readonly root: string;
  constructor(root: string) {
    if (typeof root !== 'string' || !root.trim()) throw new IntraError('INVALID_ARGUMENT');
    this.root = resolvePath(root);
  }
  private folder(kind: DefinitionKind): string { return join(this.root, kind === 'service' ? 'services' : 'operations'); }
  private file(kind: DefinitionKind, id: string): string {
    validateId(id);
    const folder = this.folder(kind);
    const file = resolvePath(folder, `${id}.json`);
    if (dirname(file) !== folder) throw new IntraError('CONTRACT_INVALID');
    return file;
  }
  private async checkDirectory(directory: string, create: boolean): Promise<void> {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IntraError('REGISTRY_ERROR');
  }
  private async load(kind: DefinitionKind, id: string): Promise<Service | Operation> {
    const path = this.file(kind, id);
    const missingCode = kind === 'service' ? 'SERVICE_NOT_FOUND' : 'OPERATION_NOT_FOUND';
    try {
      await this.checkDirectory(this.root, false);
      await this.checkDirectory(this.folder(kind), false);
      const value = await readDefinition(path, missingCode, true);
      const definition = kind === 'service' ? validateService(value) : validateOperation(value);
      if (definition.id !== id) throw new IntraError('CONTRACT_INVALID');
      return definition;
    } catch (error) {
      if (error instanceof IntraError) throw error;
      throw new IntraError(errorCode(error) === 'ENOENT' ? missingCode : 'REGISTRY_ERROR');
    }
  }
  async getService(id: string): Promise<Service> { return this.load('service', id) as Promise<Service>; }
  async getOperation(id: string): Promise<Operation> { return this.load('operation', id) as Promise<Operation>; }
  /** Summaries of locally registered operations; invalid files are reported, never executed. */
  async listOperations(): Promise<{ operations: Array<Pick<Operation, 'id' | 'service' | 'description' | 'status' | 'semantics'> & { verifiedAt?: string }>; invalid: string[] }> {
    const folder = this.folder('operation');
    let names: string[];
    try {
      await this.checkDirectory(this.root, false);
      await this.checkDirectory(folder, false);
      names = await readdir(folder);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { operations: [], invalid: [] };
      if (error instanceof IntraError) throw error;
      throw new IntraError('REGISTRY_ERROR');
    }
    const operations: Array<Pick<Operation, 'id' | 'service' | 'description' | 'status' | 'semantics'> & { verifiedAt?: string }> = [];
    const invalid: string[] = [];
    for (const name of names.sort()) {
      if (name.startsWith('.') || !name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        const operation = await this.getOperation(id);
        operations.push({ id: operation.id, service: operation.service, description: operation.description, status: operation.status,
          semantics: operation.semantics, ...(operation.provenance.verifiedAt ? { verifiedAt: operation.provenance.verifiedAt } : {}) });
      } catch { invalid.push(id); }
    }
    return { operations, invalid };
  }
  async register(definition: unknown, options: RegisterOptions = {}): Promise<{ id: string; kind: DefinitionKind }> {
    const copy = cloneJson(definition);
    if (!isRecord(copy) || typeof options.replace !== 'undefined' && typeof options.replace !== 'boolean') throw new IntraError('CONTRACT_INVALID');
    const kind: DefinitionKind = Object.hasOwn(copy, 'baseUrl') ? 'service' : 'operation';
    const checked = kind === 'service' ? validateService(copy) : validateOperation(copy);
    const target = this.file(kind, checked.id);
    const directory = this.folder(kind);
    const temporary = resolvePath(directory, `.intra-${randomUUID()}.tmp`);
    // Paths are verified before rename/unlink below, and the temp is created exclusively by this call.
    if (dirname(temporary) !== directory || dirname(target) !== directory) throw new IntraError('REGISTRY_ERROR');
    let created = false;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.checkDirectory(this.root, true);
      await this.checkDirectory(directory, true);
      handle = await open(temporary, 'wx', 0o600);
      created = true;
      await handle.writeFile(JSON.stringify(checked, null, 2) + '\n');
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (options.replace) {
        await rename(temporary, target);
        created = false;
      } else await link(temporary, target);
      return { id: checked.id, kind };
    } catch (error) {
      if (error instanceof IntraError) throw error;
      throw new IntraError(errorCode(error) === 'EEXIST' ? 'REGISTRY_CONFLICT' : 'REGISTRY_ERROR');
    } finally {
      await handle?.close();
      if (created) await unlink(temporary).catch(() => undefined);
    }
  }
  async registerFile(path: string, options: RegisterOptions = {}): Promise<{ id: string; kind: DefinitionKind }> {
    return this.register(await readDefinition(resolvePath(path), 'INVALID_ARGUMENT', false), options);
  }
  async resolve(id: string, args: unknown = {}): Promise<ResolvedOperation> {
    const operation = await this.getOperation(id);
    const service = await this.getService(operation.service);
    const probeId = service.auth.identityProbeOperation;
    if (probeId) {
      const probe = probeId === operation.id ? operation : await this.getOperation(probeId);
      if (probe.service !== service.id || probe.status !== 'verified' || probe.semantics !== 'read' || probe.response.identityPointer === undefined) {
        throw new IntraError('CONTRACT_INVALID');
      }
      // An identity probe must be callable without business arguments and pass URL policy too.
      materialize(service, probe, {});
    }
    return { service, operation, request: materialize(service, operation, args) };
  }
}
