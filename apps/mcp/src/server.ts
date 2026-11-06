import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { projectRoot, type ToolResult } from '../../../packages/contracts/src/index.js';
import type { ToolSet } from './tools.js';

/** MCP over stdio: newline-delimited JSON-RPC 2.0; stdout carries protocol frames only. */
export const supportedProtocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const serverVersion = '0.1.0';
const maxFrameBytes = 8 * 1024 * 1024;

export const instructions = [
  'Intra executes explicit HTTP(S) requests with the user\'s paired browser login state. You normalize the user\'s URL, method, payload and intent; Intra does not discover endpoints, parse screenshots or infer business parameters.',
  'Fast path: when inputs are complete and the profile alias is known, call intra_request (or intra_call for a registered operation) directly. Do not run intra_status or intra_auth_check first.',
  'Response bodies are saved to artifact.path; inspect them with intra_read_artifact (structure first, then pointer) instead of loading whole files.',
  'For raw requests ok=true only means a 2xx response was received; businessSuccess is unknown. Never resend after REQUEST_OUTCOME_UNKNOWN. Do not treat every 401/403 as an expired login.',
  'Never ask the user for cookies, tokens or passwords; pairing and registration are user-run CLI steps.',
  'If Intra tools cannot complete the user\'s instruction, or the user\'s information is incomplete, stop and ask the user what is missing. Do not switch to other means (browser automation, o2/WebCLI, jd-login, enterprise CLIs, hand-written HTTP clients) unless the user explicitly names that means.',
].join('\n');

type Id = string | number;
interface Message { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
const outputSchema = (() => {
  const schema = JSON.parse(readFileSync(path.join(projectRoot, 'schemas', 'tool-result.schema.json'), 'utf8')) as Record<string, unknown>;
  delete schema.$schema; delete schema.$id; delete schema.title;
  return schema;
})();

export class McpServer {
  #buffer: Buffer = Buffer.alloc(0);
  #discarding = false;
  #initialized = false;
  #protocolVersion = supportedProtocolVersions[0]!;
  #cancelled = new Set<Id>();
  #inflight = new Map<Id, Promise<void>>();
  #exclusive: Promise<unknown> = Promise.resolve();
  #closed: Promise<void>;

  constructor(private readonly tools: ToolSet, private readonly input: Readable, private readonly output: Writable,
    private readonly log: (line: string) => void = line => process.stderr.write(line + '\n')) {
    this.#closed = new Promise(resolve => {
      input.on('data', (chunk: Buffer) => this.#receive(chunk));
      input.on('end', () => { void Promise.allSettled([...this.#inflight.values()]).then(() => resolve()); });
      input.on('error', () => resolve());
    });
  }
  /** Resolves after stdin closes and every in-flight call has settled. */
  closed(): Promise<void> { return this.#closed; }

  #receive(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (let index = this.#buffer.indexOf(0x0a); index !== -1; index = this.#buffer.indexOf(0x0a)) {
      const line = this.#buffer.subarray(0, index);
      this.#buffer = this.#buffer.subarray(index + 1);
      if (this.#discarding) { this.#discarding = false; continue; }
      if (line.length > maxFrameBytes) { this.#error(null, -32700, 'Frame exceeds 8 MiB'); continue; }
      this.#line(line.toString('utf8').replace(/\r$/, ''));
    }
    if (this.#buffer.length > maxFrameBytes) {
      this.#buffer = Buffer.alloc(0);
      if (!this.#discarding) this.#send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Frame exceeds 8 MiB' } });
      this.#discarding = true;
    }
  }
  #send(message: unknown): void { this.output.write(JSON.stringify(message) + '\n'); }
  #error(id: Id | null, code: number, message: string): void { this.#send({ jsonrpc: '2.0', id, error: { code, message } }); }

  #line(text: string): void {
    if (!text.trim()) return;
    let message: Message;
    try { message = JSON.parse(text); } catch { this.#error(null, -32700, 'Parse error'); return; }
    if (Array.isArray(message)) { this.#error(null, -32600, 'Batch requests are not supported'); return; }
    if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') { this.#error(null, -32600, 'Invalid request'); return; }
    const hasId = typeof message.id === 'string' || (typeof message.id === 'number' && Number.isInteger(message.id));
    if (typeof message.method !== 'string') return; // Responses to server requests: none are sent, so ignore.
    if (!hasId) { this.#notification(message.method, message.params); return; }
    const id = message.id as Id;
    if (this.#inflight.has(id)) { this.#error(id, -32600, 'Duplicate request id in flight'); return; }
    const work = this.#request(id, message.method, message.params)
      .catch(error => { this.log(`intra-mcp: request failed: ${error instanceof Error ? error.name : 'error'}`); this.#error(id, -32603, 'Internal error'); })
      .finally(() => { this.#inflight.delete(id); this.#cancelled.delete(id); });
    this.#inflight.set(id, work);
  }

  #notification(method: string, params: unknown): void {
    if (method === 'notifications/initialized') { this.#initialized = true; return; }
    if (method === 'notifications/cancelled') {
      const id = (params as { requestId?: unknown } | undefined)?.requestId;
      // The underlying request is not aborted: a sent request may already have executed,
      // so it runs to completion and saves its artifact; only the response is suppressed.
      if ((typeof id === 'string' || typeof id === 'number') && this.#inflight.has(id)) this.#cancelled.add(id);
    }
  }

  async #request(id: Id, method: string, params: unknown): Promise<void> {
    const reply = (result: unknown) => { if (!this.#cancelled.has(id)) this.#send({ jsonrpc: '2.0', id, result }); };
    if (method === 'initialize') {
      const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      this.#protocolVersion = typeof requested === 'string' && supportedProtocolVersions.includes(requested) ? requested : supportedProtocolVersions[0]!;
      this.#initialized = true;
      reply({ protocolVersion: this.#protocolVersion, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'intra', title: 'Intra browser-credential HTTP', version: serverVersion }, instructions });
      return;
    }
    if (method === 'ping') { reply({}); return; }
    if (!this.#initialized) { this.#error(id, -32002, 'Server not initialized'); return; }
    if (method === 'tools/list') {
      const structured = this.#structured();
      reply({ tools: this.tools.definitions.map(tool => ({ name: tool.name, title: tool.annotations.title, description: tool.description,
        inputSchema: tool.inputSchema, annotations: tool.annotations, ...(structured ? { outputSchema } : {}) })) });
      return;
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
      const tool = typeof name === 'string' ? this.tools.get(name) : undefined;
      if (!tool) { this.#error(id, -32602, `Unknown tool: ${typeof name === 'string' ? name.slice(0, 64) : ''}`); return; }
      // A queued call cancelled before it starts never reaches the network.
      const run = (): Promise<ToolResult | undefined> => this.#cancelled.has(id) ? Promise.resolve(undefined) : this.tools.call(tool.name, args);
      let result: ToolResult | undefined;
      if (tool.exclusive) {
        const next = this.#exclusive.then(run, run);
        this.#exclusive = next.catch(() => undefined);
        result = await next;
      } else result = await run();
      if (result) reply(this.#toolResponse(result));
      return;
    }
    this.#error(id, -32601, `Method not found: ${method.slice(0, 64)}`);
  }

  #structured(): boolean { return this.#protocolVersion >= '2025-06-18'; }
  #toolResponse(result: ToolResult): unknown {
    return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(this.#structured() ? { structuredContent: result } : {}), isError: !result.ok };
  }
}
