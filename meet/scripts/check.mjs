import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let count = 0;
for (const dir of ['src', 'public', 'scripts', 'cli', 'tests']) {
  let names;
  try { names = await readdir(path.join(root, dir)); } catch { continue; }
  for (const name of names.filter(n => /\.(m?js)$/.test(n) && n !== 'assets.js')) {
    const p = spawnSync(process.execPath, ['--check', path.join(root, dir, name)], { stdio: 'inherit' });
    if (p.status !== 0) process.exit(p.status || 1);
    count++;
  }
}
console.log(`Syntax checked ${count} JavaScript files.`);
