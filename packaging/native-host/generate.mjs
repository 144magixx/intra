import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
const args = process.argv.slice(2);
const allowed = new Set(['--extension-id', '--node', '--host', '--output', '--home']);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.has(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i])) throw new Error('Expected --extension-id ID --node /absolute/node --host /absolute/index.js --output /absolute/new-directory [--home /absolute/home]');
  options[args[i]] = args[i + 1];
}
const extensionId = options['--extension-id'];
if (!/^[a-p]{32}$/.test(extensionId ?? '')) throw new Error('A real 32-character Chrome extension ID is required');
for (const key of ['--node', '--host', '--output']) if (!options[key] || !isAbsolute(options[key])) throw new Error(`${key} must be an absolute path`);
const home = options['--home'] ?? process.env.INTRA_HOME ?? join(homedir(), '.intra');
if (!isAbsolute(home)) throw new Error('--home must be absolute');
await access(options['--node'], constants.X_OK);
await access(options['--host'], constants.R_OK);
const output = resolve(options['--output']);
// A new staging directory avoids overwriting an existing registration or launcher.
await mkdir(output, { mode: 0o700 });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const launcherPath = join(output, 'intra-native-host');
const launcher = `#!/bin/sh\numask 077\nexport INTRA_EXTENSION_ID=${quote(extensionId)}\nexport INTRA_HOME=${quote(home)}\nexec ${quote(options['--node'])} ${quote(options['--host'])} "$@"\n`;
await writeFile(launcherPath, launcher, { flag: 'wx', mode: 0o700 });
const manifest = { name: 'com.intra.bridge', description: 'Intra browser snapshot bridge', path: launcherPath, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
await writeFile(join(output, 'com.intra.bridge.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ launcher: launcherPath, manifest: join(output, 'com.intra.bridge.json'), registered: false }));
