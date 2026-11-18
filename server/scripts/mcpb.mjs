import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build a universal .mcpb bundle for Claude Desktop one-click install.
 *
 * Layout produced under dist-mcpb/staging/:
 *   manifest.json            — from mcpb/manifest.template.json, version synced
 *   server/index.mjs         — the esbuild single-file bundle (pure-JS deps inlined)
 *   node_modules/better-sqlite3/   — v13 N-API package; upstream ships prebuilds
 *                                    for every platform inside the tarball
 *   node_modules/@napi-rs/keyring/ — root package + vendored keyring.<triple>.node
 *                                    for every Claude Desktop platform (the napi-rs
 *                                    loader prefers local ./keyring.<triple>.node
 *                                    files over platform packages)
 *   skills/                  — the skill pack read_skill / list_skills serve and
 *                              render_flow's page template, without the
 *                              SKILL.overlay.patch files
 *
 * One bundle therefore serves win32-x64, win32-arm64, darwin-x64, darwin-arm64.
 * Both native deps are N-API, so Claude Desktop's bundled Node version (which
 * Anthropic does not pin publicly) cannot cause an ABI mismatch.
 */

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(serverRoot, 'dist-mcpb');
const staging = path.join(outRoot, 'staging');

// Claude Desktop runs on macOS and Windows only.
const KEYRING_TRIPLES = ['win32-x64-msvc', 'win32-arm64-msvc', 'darwin-x64', 'darwin-arm64'];
const SQLITE_PREBUILDS = ['win32-x64.node', 'win32-arm64.node', 'darwin-x64.node', 'darwin-arm64.node'];

const run = (cmd, cwd = serverRoot) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

// Minimal tar reader: return the content of one entry from a .tgz buffer.
// (Windows' cmd-invoked tar.exe is unreliable; fflate is already a dependency.)
const readTgzEntry = async (tgzPath, wantedName) => {
  const { gunzipSync } = await import('fflate');
  const tar = Buffer.from(gunzipSync(fs.readFileSync(tgzPath)));
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break; // end-of-archive blocks
    const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim(), 8) || 0;
    if (name === wantedName) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wantedName} not found in ${path.basename(tgzPath)}`);
};

const copyDirFiltered = (src, dest, keep) => {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!keep(entry.name, entry.isDirectory())) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) fs.cpSync(s, d, { recursive: true });
    else fs.copyFileSync(s, d);
  }
};

// 1. Fresh build + bundle.
console.error('building…');
run('npm run build');
run('npm run bundle');

// 2. Reset staging.
fs.rmSync(outRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(staging, { recursive: true });

// 3. Manifest with version synced from package.json.
const pkg = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(serverRoot, 'mcpb', 'manifest.template.json'), 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 4. Server bundle.
fs.mkdirSync(path.join(staging, 'server'), { recursive: true });
fs.copyFileSync(path.join(serverRoot, 'dist-bundle', 'index.mjs'), path.join(staging, 'server', 'index.mjs'));

// 5. better-sqlite3: runtime needs lib/ + prebuilds/ + package.json only.
//    (deps/ is the SQLite C source for node-gyp builds — dead weight here.)
const bsSrc = path.join(serverRoot, 'node_modules', 'better-sqlite3');
const bsDest = path.join(staging, 'node_modules', 'better-sqlite3');
copyDirFiltered(bsSrc, bsDest, (name, isDir) =>
  isDir ? name === 'lib' : ['package.json', 'LICENSE'].includes(name));
fs.mkdirSync(path.join(bsDest, 'prebuilds'));
for (const pb of SQLITE_PREBUILDS) {
  const src = path.join(bsSrc, 'prebuilds', pb);
  if (!fs.existsSync(src)) throw new Error(`missing upstream prebuild: ${pb}`);
  fs.copyFileSync(src, path.join(bsDest, 'prebuilds', pb));
}

// 6. @napi-rs/keyring root package + vendored per-platform .node files.
const krSrc = path.join(serverRoot, 'node_modules', '@napi-rs', 'keyring');
const krDest = path.join(staging, 'node_modules', '@napi-rs', 'keyring');
copyDirFiltered(krSrc, krDest, (name, isDir) => !isDir && !name.endsWith('.node'));
const krVersion = JSON.parse(fs.readFileSync(path.join(krSrc, 'package.json'), 'utf8')).version;
const tmp = path.join(outRoot, 'tmp-keyring');
fs.mkdirSync(tmp, { recursive: true });
for (const triple of KEYRING_TRIPLES) {
  const nodeFile = `keyring.${triple}.node`;
  const localPkg = path.join(serverRoot, 'node_modules', '@napi-rs', `keyring-${triple}`, nodeFile);
  if (fs.existsSync(localPkg)) {
    fs.copyFileSync(localPkg, path.join(krDest, nodeFile));
    console.error(`keyring ${triple}: from local install`);
    continue;
  }
  // npm pack pins the exact version matching the installed root package.
  // --dry-run=false: `npm run release -- --dry-run` exports npm_config_dry_run=true
  // to every child, and a dry-run pack prints the tarball name without writing it.
  const tarball = run(`npm pack @napi-rs/keyring-${triple}@${krVersion} --dry-run=false --pack-destination "${tmp}"`, tmp).trim().split('\n').pop().trim();
  fs.writeFileSync(path.join(krDest, nodeFile), await readTgzEntry(path.join(tmp, tarball), `package/${nodeFile}`));
  console.error(`keyring ${triple}: vendored ${krVersion}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

const repoRoot = path.resolve(serverRoot, '..');

// 7. Vendored language servers (check_apex / check_soql) + attribution.
//    Staged at the extension ROOT so the bundle at server/index.mjs finds
//    them at ../vendor — the same relative layout every other channel has.
const vendorSrc = path.join(serverRoot, 'vendor');
const VENDOR_REQUIRED = [
  'apex-ls/dist/server.node.js',
  'apex-ls/dist/worker.platform.js',
  'apex-ls/package.json',
  'apex-ls/VERSION',
  'bin/soql-lsp.bundled.js',
  'bin/package.json',
];
for (const rel of VENDOR_REQUIRED) {
  if (!fs.existsSync(path.join(vendorSrc, rel))) {
    throw new Error(`vendored language-server file missing: server/vendor/${rel} (gitignore ate it?)`);
  }
}
fs.cpSync(vendorSrc, path.join(staging, 'vendor'), { recursive: true });
for (const lic of ['NOTICE', 'LICENSE-APACHE-2.0', 'LICENSE-MIT', 'LICENSE-BSD-3-CLAUSE']) {
  const src = path.join(repoRoot, lic);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(staging, lic));
}

// 7b. The skill pack (list_skills / read_skill, and render_flow's template).
//     Staged at the extension ROOT, beside the manifest.json step 3 wrote: the
//     server's resolver accepts ../skills from server/index.mjs only when the
//     folder above it carries a manifest named "contrail" and the pack holds
//     the house rules. SKILL.overlay.patch files (the diff from an upstream
//     SKILL.md to the adapted one) and dotfiles are not skill content and
//     stay out; read_skill never serves them anyway.
const skillsSrc = path.join(repoRoot, 'skills');
const skillsDest = path.join(staging, 'skills');
const SKILLS_REQUIRED = [
  'salesforce-house-rules/SKILL.md',
  'salesforce-flow-visualize/SKILL.md',
  'salesforce-flow-visualize/assets/flow-diff-template.html',
];
for (const rel of SKILLS_REQUIRED) {
  if (!fs.existsSync(path.join(skillsSrc, rel))) {
    throw new Error(`skill pack file missing: skills/${rel}`);
  }
}
const isOverlayPatch = (name) => name.toLowerCase() === 'skill.overlay.patch';
fs.cpSync(skillsSrc, skillsDest, {
  recursive: true,
  // Basename only: the repo itself may sit under a dot-folder.
  filter: (src) => {
    const name = path.basename(src);
    return !isOverlayPatch(name) && !name.startsWith('.');
  },
});
const filesUnder = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const skillFolderCount = (root) =>
  fs.readdirSync(root, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory() &&
    !entry.name.startsWith('.') &&
    fs.existsSync(path.join(root, entry.name, 'SKILL.md'))).length;
const strayPatches = filesUnder(skillsDest).filter((file) => isOverlayPatch(path.basename(file)));
if (strayPatches.length > 0) {
  throw new Error(
    `SKILL.overlay.patch staged into the bundle: ${path.relative(staging, strayPatches[0])}`,
  );
}
const skillsInSource = skillFolderCount(skillsSrc);
const skillsStaged = skillFolderCount(skillsDest);
if (skillsStaged !== skillsInSource) {
  throw new Error(`staged ${skillsStaged} skill folder(s) but skills/ holds ${skillsInSource}`);
}
console.error(`skills: ${skillsStaged} staged`);

// 8. Validate + pack.
run(`npx --yes @anthropic-ai/mcpb validate "${path.join(staging, 'manifest.json')}"`);
const outFile = path.join(outRoot, `contrail-${pkg.version}.mcpb`);
run(`npx --yes @anthropic-ai/mcpb pack "${staging}" "${outFile}"`);

// 9. Check the PACKED archive, not just staging. Which files `mcpb pack`
//    leaves out on its own is not pinned anywhere in this repo, so the two
//    entries the skill tools and render_flow depend on (the house rules the
//    resolver looks for, the flow page template) are looked up in the .mcpb
//    itself (a zip; names only — nothing is inflated). Every other staged
//    skills file is then compared against the same names, so a skill asset
//    the packer drops fails this build instead of going missing from the
//    extension alone.
const { unzipSync } = await import('fflate');
const packed = new Set();
unzipSync(fs.readFileSync(outFile), {
  filter: (entry) => {
    packed.add(entry.name);
    return false;
  },
});
const PACKED_REQUIRED = [
  'skills/salesforce-house-rules/SKILL.md',
  'skills/salesforce-flow-visualize/assets/flow-diff-template.html',
];
for (const entry of PACKED_REQUIRED) {
  if (!packed.has(entry)) {
    throw new Error(`${entry} is not in ${path.basename(outFile)} (mcpb pack left it out?)`);
  }
}
const dropped = filesUnder(skillsDest)
  .map((file) => path.relative(staging, file).split(path.sep).join('/'))
  .filter((name) => !packed.has(name));
if (dropped.length > 0) {
  throw new Error(
    `mcpb pack left ${dropped.length} skill file(s) out of ${path.basename(outFile)}: ${dropped.slice(0, 5).join(', ')}`,
  );
}

const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
console.error(`packed → ${outFile} (${mb} MB)`);
