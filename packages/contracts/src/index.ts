import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONObject | JSONValue[];
export interface JSONObject { [key: string]: JSONValue }
export type JsonValue = JSONValue;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export interface AuthFailureRule {
  kind: 'loginRedirect' | 'businessCode' | 'probeFailure';
  origin?: string;
  pathPrefix?: string;
  pointer?: string;
  equals?: JSONValue;
}
export interface Service {
  schemaVersion: 1;
  id: string;
  baseUrl: string;
  allowedOrigins: string[];
  auth: {
    cookieNames?: string[];
    identityProbeOperation?: string;
    authFailureRules?: AuthFailureRule[];
  };
  protocolExceptions?: { origin: string; reason: string }[];
}
export interface MaterializedRequest {
  method: string;
  path: string;
  query?: Record<string, JSONValue>;
  headers?: Record<string, string>;
  body?: JSONValue;
  /** Explicit direct-request bytes represented as UTF-8; not an Operation template field. */
  rawBody?: string;
  url?: string;
}
export interface ResponseRules {
  success: { httpStatuses: number[]; code?: { pointer: string; equals: JSONValue } };
  itemsPointer?: string;
  totalPointer?: string;
  identityPointer?: string;
}
export interface Operation {
  schemaVersion: 1;
  id: string;
  service: string;
  description: string;
  status: 'draft' | 'verified';
  semantics: 'read' | 'write' | 'unknown';
  arguments: JSONObject;
  request: Omit<MaterializedRequest, 'url' | 'rawBody'>;
  bindings: { argument: string; target: 'query' | 'body'; pointer: string }[];
  response: ResponseRules;
  provenance: {
    source: 'documentation' | 'source' | 'curl' | 'har' | 'observation' | 'manual' | 'historical-experiment';
    verifiedAt?: string;
    evidence?: string[];
    notes?: string;
  };
}
export interface Artifact {
  path: string;
  format: 'json' | 'text' | 'binary' | 'jsonl';
  bytes: number;
  complete: boolean;
}
export interface ErrorDetails { code: string; message: string; retryable: boolean; action?: string }
export interface ResultMeta {
  operationId?: string;
  serviceId?: string;
  profileId?: string;
  httpStatus?: number;
  businessCode?: string | number;
  authRefreshed?: boolean;
  timingMs?: { credential: number; http: number; output: number; total: number };
}
export interface ToolResult {
  schemaVersion: 1;
  requestId: string;
  ok: boolean;
  data?: unknown;
  artifact?: Artifact;
  meta: ResultMeta;
  error?: ErrorDetails;
}
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  session: boolean;
  expirationDate?: number;
  storeId: string;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
}
export interface CookieSnapshot {
  profileId: string;
  storeId: string;
  snapshotId: string;
  observedAt: string;
  cookies: Cookie[];
}
export type SnapshotResult = CookieSnapshot;
export interface SnapshotParams {
  profileId: string;
  storeId: string;
  url: string;
  cookieNames?: string[];
  deadlineMs: number;
}
export interface HelloParams {
  profileId: string;
  extensionVersion: string;
  protocolVersions: 1[];
  storeIds: string[];
}
export interface IpcMessage {
  schemaVersion: 1;
  requestId: string;
  type: 'request' | 'response' | 'event';
  method?: 'bridge.hello' | 'cookies.snapshot' | 'credentials.resolve' | 'http.execute' | 'cookies.changed';
  params?: JSONObject;
  ok?: boolean;
  result?: JSONObject;
  error?: ErrorDetails;
}

const errorGroups: Record<number, readonly string[]> = {
  2: ['INVALID_ARGUMENT', 'CONTRACT_INVALID', 'SERVICE_NOT_FOUND', 'OPERATION_NOT_FOUND', 'OPERATION_UNVERIFIED', 'REGISTRY_CONFLICT'],
  3: ['PROFILE_NOT_PAIRED', 'PROFILE_AMBIGUOUS', 'ACCOUNT_MISMATCH', 'BRIDGE_UNAVAILABLE', 'COOKIE_NOT_FOUND', 'LOGIN_REQUIRED', 'AUTH_EXPIRED', 'PARTITIONED_COOKIE_UNSUPPORTED', 'AUTH_STATE_UNDETERMINED'],
  4: ['FORBIDDEN'],
  5: ['NETWORK_UNREACHABLE', 'REQUEST_TIMEOUT'],
  6: ['BUSINESS_ERROR', 'RESPONSE_SCHEMA_MISMATCH'],
  7: ['RESPONSE_TOO_LARGE', 'OUTPUT_EXISTS', 'OUTPUT_ERROR', 'INTERNAL_ERROR', 'REGISTRY_ERROR', 'PROTOCOL_MISMATCH', 'KEYCHAIN_UNAVAILABLE', 'REFRESH_LOCK_TIMEOUT'],
  8: ['REQUEST_OUTCOME_UNKNOWN'],
};
const messages: Record<string, string> = {
  INVALID_ARGUMENT: 'The supplied arguments are invalid.',
  CONTRACT_INVALID: 'The supplied data does not satisfy the contract.',
  SERVICE_NOT_FOUND: 'The service definition was not found.',
  OPERATION_NOT_FOUND: 'The operation definition was not found.',
  OPERATION_UNVERIFIED: 'The operation has not been verified.',
  REGISTRY_CONFLICT: 'A definition with this ID already exists.',
  REGISTRY_ERROR: 'The local registry could not be accessed.',
  PROFILE_NOT_PAIRED: 'The browser profile is not paired.',
  PROFILE_AMBIGUOUS: 'The browser profile must be selected explicitly.',
  ACCOUNT_MISMATCH: 'The selected account does not match the expected identity.',
  BRIDGE_UNAVAILABLE: 'The browser bridge is unavailable.',
  COOKIE_NOT_FOUND: 'The required authentication cookies are unavailable.',
  LOGIN_REQUIRED: 'A browser login is required.',
  AUTH_EXPIRED: 'The authentication state has expired.',
  PARTITIONED_COOKIE_UNSUPPORTED: 'Partitioned cookies are not supported.',
  AUTH_STATE_UNDETERMINED: 'The authentication state could not be determined.',
  FORBIDDEN: 'The authenticated identity does not have permission.',
  NETWORK_UNREACHABLE: 'The network request could not be completed.',
  REQUEST_TIMEOUT: 'The request exceeded its deadline.',
  BUSINESS_ERROR: 'The service reported a business failure.',
  RESPONSE_SCHEMA_MISMATCH: 'The response does not satisfy the operation definition.',
  RESPONSE_TOO_LARGE: 'The response exceeded the configured size limit.',
  OUTPUT_EXISTS: 'The output file already exists.',
  OUTPUT_ERROR: 'The response could not be saved.',
  PROTOCOL_MISMATCH: 'The protocol versions are incompatible.',
  REQUEST_OUTCOME_UNKNOWN: 'The request may have executed; its outcome is unknown.',
  KEYCHAIN_UNAVAILABLE: 'The macOS Keychain is unavailable.',
  REFRESH_LOCK_TIMEOUT: 'The credential refresh lock timed out.',
  INTERNAL_ERROR: 'An internal operation failed.',
};

export function exitCodeFor(code: string): number {
  for (const [exit, codes] of Object.entries(errorGroups)) if (codes.includes(code)) return Number(exit);
  return 7;
}
export class IntraError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly action?: string;
  readonly exitCode: number;
  constructor(code: string, message?: string, options: { retryable?: boolean; action?: string; cause?: unknown } = {}) {
    super(message ?? messages[code] ?? messages.INTERNAL_ERROR, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'IntraError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.action !== undefined) this.action = options.action;
    this.exitCode = exitCodeFor(code);
  }
}
/** Never forward an arbitrary source message, stack, cause or action to an agent. */
export function safeError(error: unknown): IntraError {
  if (error instanceof IntraError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) {
    return new IntraError(error.code, undefined, { retryable: error.retryable });
  }
  return new IntraError('INTERNAL_ERROR');
}

const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/** JSON-only inputs prevent getters, inherited properties and lossy JSON coercion. */
export function assertJson(value: unknown, code = 'CONTRACT_INVALID'): asserts value is JSONValue {
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || depth > 128 || seen.has(item)) throw new IntraError(code);
    if (!Array.isArray(item) && !isRecord(item)) throw new IntraError(code);
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string' || dangerousKeys.has(key)) throw new IntraError(code);
      if (Array.isArray(item) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) throw new IntraError(code);
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new IntraError(code);
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new IntraError(code);
    seen.delete(item);
  }
  visit(value, 0);
}
export function cloneJson<T>(value: T, code = 'CONTRACT_INVALID'): T {
  assertJson(value, code);
  return structuredClone(value);
}

function locateProjectRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(directory, 'package.json')) && existsSync(join(directory, 'schemas', 'ipc.schema.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new IntraError('INTERNAL_ERROR');
    directory = parent;
  }
}
/** Resolve from the module, never from the caller's current working directory. */
export const projectRoot = locateProjectRoot();
const ajvOptions = { strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true, ownProperties: true, allErrors: false, logger: false as const };
const ajv = new Ajv2020(ajvOptions);
const argumentAjv = new Ajv2020({ ...ajvOptions, useDefaults: true, addUsedSchema: false });
const schemaBase = 'https://intra.invalid/schemas/';
for (const kind of ['service', 'operation', 'ipc', 'tool-result']) {
  try {
    ajv.addSchema(JSON.parse(readFileSync(join(projectRoot, 'schemas', `${kind}.schema.json`), 'utf8')));
  } catch {
    throw new IntraError('INTERNAL_ERROR');
  }
}
interface ContractMap {
  service: Service;
  operation: Operation;
  ipc: IpcMessage;
  'tool-result': ToolResult;
  snapshot: CookieSnapshot;
  snapshotParams: SnapshotParams;
  hello: HelloParams;
}
export type ContractKind = keyof ContractMap;
const references: Record<ContractKind, string> = {
  service: `${schemaBase}service.schema.json`,
  operation: `${schemaBase}operation.schema.json`,
  ipc: `${schemaBase}ipc.schema.json`,
  'tool-result': `${schemaBase}tool-result.schema.json`,
  snapshot: `${schemaBase}ipc.schema.json#/$defs/snapshotResult`,
  snapshotParams: `${schemaBase}ipc.schema.json#/$defs/snapshotParams`,
  hello: `${schemaBase}ipc.schema.json#/$defs/helloParams`,
};
export function validate<K extends ContractKind>(kind: K, value: unknown): ContractMap[K] {
  assertJson(value);
  let validator: ValidateFunction | undefined;
  try { validator = ajv.getSchema(references[kind]); } catch { throw new IntraError('CONTRACT_INVALID'); }
  if (!validator || !validator(value)) throw new IntraError('CONTRACT_INVALID');
  return value as unknown as ContractMap[K];
}

function argumentValidator(schema: unknown): ValidateFunction {
  assertJson(schema);
  if (!isRecord(schema) || schema.type !== 'object' || (schema.properties !== undefined && !isRecord(schema.properties))) {
    throw new IntraError('CONTRACT_INVALID');
  }
  try {
    const validator = argumentAjv.compile(schema);
    if ('$async' in validator && validator.$async) throw new IntraError('CONTRACT_INVALID');
    return validator;
  } catch { throw new IntraError('CONTRACT_INVALID'); }
}
/** Compile without supplying arguments, for definition registration. */
export function validateArgumentSchema(schema: unknown): void { argumentValidator(schema); }
export function validateArguments(schema: unknown, args: unknown): Record<string, JSONValue> {
  assertJson(args, 'INVALID_ARGUMENT');
  if (!isRecord(args)) throw new IntraError('INVALID_ARGUMENT');
  const validator = argumentValidator(schema);
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  // This precheck is deliberate: unknown inputs must be rejected before AJV inserts defaults.
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) throw new IntraError('INVALID_ARGUMENT');
  }
  const result = cloneJson(args, 'INVALID_ARGUMENT');
  if (!validator(result)) throw new IntraError('INVALID_ARGUMENT');
  assertJson(result, 'INVALID_ARGUMENT');
  return result as Record<string, JSONValue>;
}

/** Strict RFC 6901, with the documented prototype-key safety restriction. */
export function pointerTokens(pointer: string): string[] {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) throw new IntraError('CONTRACT_INVALID');
  if (pointer === '') return [];
  return pointer.slice(1).split('/').map(token => {
    if (/~(?:[^01]|$)/.test(token)) throw new IntraError('CONTRACT_INVALID');
    const decoded = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (dangerousKeys.has(decoded)) throw new IntraError('CONTRACT_INVALID');
    return decoded;
  });
}
function ownMember(value: unknown, key: string): { exists: boolean; value?: unknown } {
  if (value === null || typeof value !== 'object') return { exists: false };
  if (Array.isArray(value)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(Number(key))) throw new IntraError('CONTRACT_INVALID');
  } else if (!isRecord(value)) throw new IntraError('CONTRACT_INVALID');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { exists: false };
  if (!('value' in descriptor)) throw new IntraError('CONTRACT_INVALID');
  return { exists: true, value: descriptor.value };
}
export function getPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const token of pointerTokens(pointer)) {
    const member = ownMember(current, token);
    if (!member.exists) return undefined;
    current = member.value;
  }
  return current;
}
/** Mutates an existing location; callers must accept the returned root for empty pointers. */
export function setPointer(value: unknown, pointer: string, next: unknown): JSONValue {
  assertJson(value);
  assertJson(next);
  const tokens = pointerTokens(pointer);
  if (tokens.length === 0) return cloneJson(next);
  let current: unknown = value;
  for (const token of tokens.slice(0, -1)) {
    const member = ownMember(current, token);
    if (!member.exists) throw new IntraError('CONTRACT_INVALID');
    current = member.value;
  }
  const key = tokens[tokens.length - 1]!;
  if (!ownMember(current, key).exists) throw new IntraError('CONTRACT_INVALID');
  Object.defineProperty(current, key, { value: cloneJson(next), writable: true, enumerable: true, configurable: true });
  return value;
}
