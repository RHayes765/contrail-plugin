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
  const tarball = run(`npm pack @napi-rs/keyring-${triple}@${krVersion} --pack-destination "${tmp}"`, tmp).trim().split('\n').pop().trim();
  fs.writeFileSync(path.join(krDest, nodeFile), await readTgzEntry(path.join(tmp, tarball), `package/${nodeFile}`));
  console.error(`keyring ${triple}: vendored ${krVersion}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

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
const repoRoot = path.resolve(serverRoot, '..');
for (const lic of ['NOTICE', 'LICENSE-APACHE-2.0', 'LICENSE-MIT', 'LICENSE-BSD-3-CLAUSE']) {
  const src = path.join(repoRoot, lic);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(staging, lic));
}

// 8. Validate + pack.
run(`npx --yes @anthropic-ai/mcpb validate "${path.join(staging, 'manifest.json')}"`);
const outFile = path.join(outRoot, `contrail-${pkg.version}.mcpb`);
run(`npx --yes @anthropic-ai/mcpb pack "${staging}" "${outFile}"`);

const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
console.error(`packed → ${outFile} (${mb} MB)`);
