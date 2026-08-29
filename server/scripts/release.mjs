import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cut a release: sync the version from server/package.json into every file
 * that carries it, run the gates (lint + tests + build), produce the
 * artifacts locally, commit, tag v{version}, and push with tags. The GitHub
 * release itself (with the mcpb + zip attached) is created by CI on the tag
 * push (.github/workflows/release.yml) — no token needed on this machine.
 *
 * Flow: bump server/package.json by hand, then `npm run release`.
 * `npm run release -- --dry-run` does everything except commit/tag/push.
 */

const dryRun = process.argv.includes('--dry-run');
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverRoot, '..');
const version = JSON.parse(
  fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8'),
).version;

function run(cmd, cwd = serverRoot) {
  console.error(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function syncJson(file, mutate) {
  const abs = path.join(repoRoot, file);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  mutate(data);
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.error(`synced ${file}`);
}

function syncText(file, pattern, replacement) {
  const abs = path.join(repoRoot, file);
  const text = fs.readFileSync(abs, 'utf8');
  const next = text.replace(pattern, replacement);
  if (next === text) {
    console.error(`WARNING: ${file} — pattern found nothing to sync`);
    return;
  }
  fs.writeFileSync(abs, next, 'utf8');
  console.error(`synced ${file}`);
}

console.error(`Releasing v${version} (${dryRun ? 'DRY RUN' : 'for real'})`);

// ── 1. Version sync ──
syncJson('.claude-plugin/plugin.json', (d) => {
  d.version = version;
});
syncJson('.claude-plugin/marketplace.json', (d) => {
  for (const p of d.plugins) p.version = version;
});
syncJson('package.json', (d) => {
  d.version = version;
});
syncText(
  'server/src/core/version.ts',
  /ENGINE_VERSION = '[^']+'/,
  `ENGINE_VERSION = '${version}'`,
);
syncText('README.md', /Status: v[\d.]+/, `Status: v${version}`);

// ── 2. Gates ──
run('npm run lint:skills');
run('npm run build');
run('npx vitest run');

// ── 3. Artifacts ──
// Vendor-presence gate: the repo's unanchored `dist/` gitignore once nearly
// swallowed these silently — `git add -A` skips ignored files without a
// word, and CI's clean checkout would ship check_apex permanently broken.
// `--error-unmatch` fails loudly if any of them is untracked.
run(
  'git ls-files --error-unmatch ' +
    [
      'server/vendor/apex-ls/dist/server.node.js',
      'server/vendor/apex-ls/dist/worker.platform.js',
      'server/vendor/apex-ls/package.json',
      'server/vendor/apex-ls/VERSION',
      'server/vendor/bin/soql-lsp.bundled.js',
      'server/vendor/bin/package.json',
    ]
      .map((f) => `"${f}"`)
      .join(' '),
  repoRoot,
);
run('npm run bundle');
fs.mkdirSync(path.join(serverRoot, 'dist-plugin'), { recursive: true });
fs.copyFileSync(
  path.join(serverRoot, 'dist-bundle', 'index.mjs'),
  path.join(serverRoot, 'dist-plugin', 'index.mjs'),
);
console.error('server/dist-plugin/index.mjs refreshed');
run('npm run mcpb');
run('node scripts/zip.mjs');

// ── 4. Commit, tag, push ──
if (dryRun) {
  console.error('\nDRY RUN complete — nothing committed. Artifacts in server/dist-mcpb/.');
  process.exit(0);
}
run('git add -A', repoRoot);
const dirty = execSync('git status --porcelain', { cwd: repoRoot }).toString().trim();
if (dirty) {
  run(
    `git commit -m "v${version}" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`,
    repoRoot,
  );
} else {
  console.error('working tree already clean — tagging the existing HEAD');
}
const tags = execSync('git tag -l', { cwd: repoRoot }).toString().split(/\r?\n/);
if (!tags.includes(`v${version}`)) run(`git tag v${version}`, repoRoot);
run('git push', repoRoot);
// Push the tag EXPLICITLY: `--follow-tags` only pushes ANNOTATED tags, and
// `git tag` above creates a lightweight one — v0.14.0 shipped with no CI run
// because the tag silently never left this machine.
run(`git push origin v${version}`, repoRoot);
console.error(
  `\nv${version} pushed. CI is building the GitHub release with the mcpb + zip attached:` +
    `\n  https://github.com/RHayes765/contrail-plugin/releases`,
);
