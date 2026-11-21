import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ignoredSkillFiles } from './ignored-skills.mjs';

/**
 * Cut a release: sync the version from server/package.json into every file
 * that carries it, run the gates (lint + tests + build), produce the
 * artifacts locally, commit, tag v{version}, and push with tags. The GitHub
 * release itself (with the mcpb + zip attached) is created by CI on the tag
 * push (.github/workflows/release.yml) — no token needed on this machine.
 *
 * Flow: bump server/package.json by hand, then `npm run release`.
 * `npm run release -- --dry-run` does everything except commit/tag/push.
 *
 * Step 2 includes the LOCAL mirror gate (scripts/describe-identity.mjs):
 * word-identical describe/refusal/page texts and byte-identical mirror units
 * against the desktop checkout (`--desktop <path>` or CONTRAIL_DESKTOP_ROOT,
 * default the sibling ../desktop). It fails the release on any MISSING or
 * MISMATCH, and REFUSES when the desktop checkout is absent unless
 * `--skip-mirror` is passed explicitly. CI never runs this script.
 */

// npm 10 consumes `npm run release -- --dry-run` as its own dry-run setting and
// does NOT pass the flag on in argv; it exports npm_config_dry_run=true instead.
// Read both, so a dry run can never fall through to commit/tag/push.
const dryRun = process.argv.includes('--dry-run') || process.env.npm_config_dry_run === 'true';
const skipMirror = process.argv.includes('--skip-mirror');
const desktopArg = process.argv.indexOf('--desktop');
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
syncText('TOOLS.md', /Current as of \*\*v[\d.]+\*\*/, `Current as of **v${version}**`);

// ── 2. Gates ──
// Mirror gate first (cheap, and a refusal should not wait out the suite).
// Local only: CI's runner has no desktop checkout — never add it to
// release.yml.
run(
  'node scripts/describe-identity.mjs' +
    (skipMirror ? ' --skip-mirror' : '') +
    (desktopArg >= 0 && process.argv[desktopArg + 1]
      ? ` --desktop "${process.argv[desktopArg + 1]}"`
      : ''),
);
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
// Skill-presence gate, same reasoning: the server reads its skills from the
// install, and the teammate zip and CI's clean checkout (which packs the
// .mcpb) hold only the tracked tree. An untracked house-rules file or flow
// template would pass every local gate (the working tree has it) and be
// missing from what ships.
run(
  'git ls-files --error-unmatch ' +
    [
      'skills/salesforce-house-rules/SKILL.md',
      'skills/salesforce-flow-visualize/SKILL.md',
      'skills/salesforce-flow-visualize/assets/flow-diff-template.html',
    ]
      .map((f) => `"${f}"`)
      .join(' '),
  repoRoot,
);
// ...and every other skill file. The unanchored `dist/`, `*.log` and
// `node_modules/` rules match under skills/ too, and a file they catch passes
// the gate above and the local mcpb build, then is missing from all three
// channels (see scripts/ignored-skills.mjs).
const ignoredSkills = ignoredSkillFiles(repoRoot);
if (ignoredSkills.length > 0) {
  throw new Error(
    `${ignoredSkills.length} gitignored file(s) under skills/ would not ship: ` +
      ignoredSkills.slice(0, 10).join(', ') +
      (ignoredSkills.length > 10 ? ', ...' : '') +
      '. Track each with `git add -f`, or add a .gitignore negation as for server/vendor/apex-ls/dist/.',
  );
}
console.error('skills: no gitignored skill files');
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
    `git commit -m "v${version}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`,
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
