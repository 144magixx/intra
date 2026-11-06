import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Explicit build only: this file is not imported by the runtime or postinstall.
const manifest = JSON.parse(await readFile(new URL('./manifest.template.json', import.meta.url), 'utf8'));
await writeFile(new URL('./manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(`Created ${fileURLToPath(new URL('./manifest.json', import.meta.url))}; no extension was installed.`);
