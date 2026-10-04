// Copies the public docroot into dist/ for Workers static assets.
// The asset directory cannot be the repo root: wrangler dev watches it, and
// it also writes .wrangler inside the project, which reload-loops forever.
// .assetsignore is the filter. _headers is included so Wrangler can parse it;
// Wrangler does not serve that file.

import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function collectAssetPaths(from = root) {
  const raw = await readFile(path.join(from, '.assetsignore'), 'utf8');
  const ignorer = ignore().add(raw);
  const kept = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(from, abs).split(path.sep).join('/');
      if (rel === 'dist' || rel.startsWith('dist/')) continue;
      if (ignorer.ignores(rel) || ignorer.ignores(`${rel}/`)) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        kept.push(rel);
      }
    }
  }

  await walk(from);
  kept.sort();
  return kept;
}

export async function stageAssets(from = root, to = path.join(from, 'dist')) {
  const files = await collectAssetPaths(from);
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  for (const rel of files) {
    const dest = path.join(to, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(from, rel), dest);
  }
  const headers = path.join(to, '_headers');
  try {
    await stat(headers);
  } catch {
    throw new Error('staged assets are missing _headers');
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await stageAssets();
  console.log(`Staged ${files.length} assets into dist/`);
}
