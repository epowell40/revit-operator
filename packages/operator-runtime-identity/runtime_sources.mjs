import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Startup-loaded application modules and dependency declarations, not live UI assets. */
export function runtimeSourcesSha256(root) {
  const names = fs.readdirSync(root).filter(name => /\.(?:[cm]?js)$/.test(name) || ['package.json', 'package-lock.json'].includes(name)).sort();
  if (!names.length || names.length > 512) throw new Error('Invalid runtime source inventory');
  const hash = createHash('sha256').update('operator-runtime-sources/v1\n');
  const seen = new Set();
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || seen.has(name.toLowerCase())) throw new Error('Invalid runtime source name');
    seen.add(name.toLowerCase());
    const filename = path.join(root, name);
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error(`Invalid runtime source file: ${name}`);
    hash.update(name).update('\0').update(createHash('sha256').update(fs.readFileSync(filename)).digest('hex')).update('\n');
  }
  return hash.digest('hex');
}
