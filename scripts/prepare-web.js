import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'www');
const files = ['index.html', 'style.css', 'app.js', 'app-core.js', 'manifest.json', 'sw.js'];
const dirs = ['icons', 'vendor'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of files) cpSync(resolve(root, file), resolve(out, file));
for (const dir of dirs) cpSync(resolve(root, dir), resolve(out, dir), { recursive: true });
console.log('PWA fail disalin ke www/ untuk pembungkusan Android.');
