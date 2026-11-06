import { IntraError, cloneJson, isRecord, type Operation } from '../../contracts/src/index.js';
import { validateHeaders, validateOperation } from '../../registry/src/index.js';

export interface DiscoveryReport {
  draft?: Operation;
  missing: string[];
  source: Operation['provenance']['source'] | 'unknown';
}
const sources = new Set(['documentation', 'source', 'curl', 'har', 'observation', 'manual', 'historical-experiment']);
const secretName = /^(?:authorization|proxy[-_]?authorization|cookies?|set[-_]?cookie|password|passwd|secret|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|csrf(?:[-_]?token)?|xsrf(?:[-_]?token)?|session[-_]?id|credential)$/i;

function rejectCredentialFields(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) rejectCredentialFields(item); return; }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (secretName.test(key)) throw new IntraError('CONTRACT_INVALID');
    rejectCredentialFields(item);
  }
}
function inspectRequest(value: Record<string, unknown>): void {
  if (!isRecord(value.request)) return;
  const request = value.request;
  validateHeaders(request.headers);
  rejectCredentialFields(request.query);
  rejectCredentialFields(request.body);
  if (typeof request.path === 'string') {
    // Reject captured URL credentials even for an incomplete discovery report.
    let url: URL;
    try { url = new URL(request.path, 'https://discovery.invalid'); } catch { throw new IntraError('CONTRACT_INVALID'); }
    if (url.username || url.password || url.origin !== 'https://discovery.invalid') throw new IntraError('CONTRACT_INVALID');
    for (const key of url.searchParams.keys()) if (secretName.test(key)) throw new IntraError('CONTRACT_INVALID');
  }
}
/** Offline definition import only. No requests, schema mutation, or inferred methods/paths. */
export function importDefinition(value: unknown): DiscoveryReport {
  const candidate = cloneJson(value);
  if (!isRecord(candidate)) throw new IntraError('CONTRACT_INVALID');
  inspectRequest(candidate);
  if (isRecord(candidate.arguments)) rejectCredentialFields(candidate.arguments.properties);
  const provenance = isRecord(candidate.provenance) ? candidate.provenance : undefined;
  const source = provenance && typeof provenance.source === 'string' && sources.has(provenance.source)
    ? provenance.source as Operation['provenance']['source'] : 'unknown';
  const missing: string[] = [];
  for (const key of ['schemaVersion', 'id', 'service', 'description', 'semantics', 'arguments', 'bindings']) {
    if (!Object.hasOwn(candidate, key) || candidate[key] === null) missing.push(key);
  }
  const request = isRecord(candidate.request) ? candidate.request : {};
  for (const key of ['method', 'path']) {
    if (typeof request[key] !== 'string' || !request[key]) missing.push(`request.${key}`);
  }
  if (!isRecord(candidate.response) || !isRecord(candidate.response.success)
    || !Array.isArray(candidate.response.success.httpStatuses) || candidate.response.success.httpStatuses.length === 0) {
    missing.push('response.success.httpStatuses');
  }
  if (source === 'unknown') missing.push('provenance.source');
  // A missing method or path is a report, not a schema-conforming fake operation.
  if (missing.length) return { missing, source };
  candidate.status = 'draft';
  if (provenance) delete provenance.verifiedAt;
  const draft = validateOperation(candidate);
  return { draft, missing: [], source };
}
