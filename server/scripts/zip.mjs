import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

/**
 * Build the teammate distribution zip: an archive of exactly the git-tracked
 * tree (which, since v0.13.0, includes the prebuilt server bundle at
 * server/dist-plugin/ — so the zip needs no build step either; a target runs
 * `npm ci --ignore-scripts` at the extracted root and wires the MCP config
 * per INSTALL_FOR_CLAUDE.md).
 *
 * fflate with forward-slash keys ON PURPOSE: PowerShell 5.1's Compress-Archive
 * writes backslash entry names, which extract as a mangled flat mess on macOS
 * (hit 2026-08-08 — do not "simplify" this back to a shell one-liner).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'server', 'package.json'), 'utf8'),
).version;

const tracked = execSync('git ls-files -z', { cwd: repoRoot })
  .toString('utf8')
  .split('\0')
  .filter(Boolean);

const entries = {};
for (const rel of tracked) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) continue; // deleted-but-staged edge
  entries[rel.replaceAll('\\', '/')] = fs.readFileSync(abs);
}

const badKeys = Object.keys(entries).filter((k) => k.includes('\\'));
if (badKeys.length > 0) {
  console.error('zip entry keys contain backslashes — refusing:', badKeys.slice(0, 3));
  process.exit(1);
}

const outDir = path.join(repoRoot, 'server', 'dist-mcpb');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `contrail-plugin-${version}.zip`);
fs.writeFileSync(outFile, Buffer.from(zipSync(entries)));
console.error(`packed → ${outFile} (${Object.keys(entries).length} files)`);
