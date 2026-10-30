import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'public');
const assets = [
  'index.html',
  'style.css',
  'app.js',
  'app-core.js',
  'sw.js',
  'manifest.json',
  'icons',
  'vendor'
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const asset of assets) {
  const source = resolve(root, asset);
  if (!existsSync(source)) continue;
  await cp(source, resolve(output, asset), { recursive: true });
}

console.log('PWA disalin ke public/ untuk deployment Vercel.');
