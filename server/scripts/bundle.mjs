import { build } from 'esbuild';

/**
 * Produce a single-file distribution bundle at dist-bundle/index.js.
 *
 * The two native modules (better-sqlite3, @napi-rs/keyring) stay external —
 * native addons can't be bundled and are platform-specific — so a target
 * still needs `npm install --omit=dev better-sqlite3 @napi-rs/keyring`. Every
 * pure-JS dependency (MCP SDK, zod, fast-xml-parser, fflate, open) is inlined,
 * so that minimal install is all the runtime needs.
 */
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // .mjs so Node treats it as ESM regardless of any package.json beside it.
  outfile: 'dist-bundle/index.mjs',
  external: ['better-sqlite3', '@napi-rs/keyring'],
  // Provide `require` for any CJS dependency that reaches for it at runtime in
  // the ESM output. esbuild injects its own per-module __filename/__dirname
  // shims, so we must NOT declare those here (it collides).
  banner: {
    js: [
      "import { createRequire as __contrailCreateRequire } from 'node:module';",
      'const require = __contrailCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

console.error('bundled → dist-bundle/index.mjs');
