#!/usr/bin/env node
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// stdout is reserved for MCP frames; route any stray console output to stderr.
for (const level of ['log', 'info', 'debug', 'warn'] as const) console[level] = (...items: unknown[]) => console.error(...items);

const { createCore } = await import('../../cli/src/main.js');
const { ToolSet } = await import('./tools.js');
const { McpServer } = await import('./server.js');

export function serverOptions(env: NodeJS.ProcessEnv = process.env) {
  const home = path.resolve(env.INTRA_HOME ?? path.join(homedir(), '.intra'));
  const rawTimeout = env.INTRA_MCP_MAX_TIMEOUT_MS;
  const maxTimeoutMs = rawTimeout === undefined ? 100_000 : Number(rawTimeout);
  if (!/^\d+$/.test(rawTimeout ?? '100000') || !Number.isSafeInteger(maxTimeoutMs) || maxTimeoutMs < 1 || maxTimeoutMs > 300_000) {
    throw new Error('INTRA_MCP_MAX_TIMEOUT_MS must be an integer between 1 and 300000');
  }
  const defaultProfile = env.INTRA_DEFAULT_PROFILE?.trim() || undefined;
  if (defaultProfile !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(defaultProfile)) throw new Error('INTRA_DEFAULT_PROFILE is not a valid alias');
  return { home, maxTimeoutMs, defaultProfile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options: ReturnType<typeof serverOptions>;
  try { options = serverOptions(); }
  catch (error) { process.stderr.write(`intra-mcp: ${(error as Error).message}\n`); process.exit(2); }
  const tools = new ToolSet({ core: createCore(options.home), home: options.home, maxTimeoutMs: options.maxTimeoutMs,
    ...(options.defaultProfile ? { defaultProfile: options.defaultProfile } : {}), artifacts: new Set() });
  const server = new McpServer(tools, process.stdin, process.stdout);
  process.stdout.on('error', () => process.exit(0));
  await server.closed();
  process.exit(0);
}
