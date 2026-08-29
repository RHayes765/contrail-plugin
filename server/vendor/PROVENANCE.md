# Vendored language-server bundles — provenance

Prebuilt, **vendored** artifacts. Do not hand-edit — refresh per the ritual
below. These power the `check_apex` / `check_soql` local-diagnostics tools
(see `server/src/localdiag/`).

## Origin

- Upstream repo: [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills),
  plugin `salesforce-development`, copied at repo commit
  `49064f740d329f3d637df151321efa644b619a2e` (release 1.42.0).
- License: Apache-2.0, Copyright (c) 2026 Salesforce, Inc. — see the repo-root
  `NOTICE` and `LICENSE-APACHE-2.0`. The bundles embed `data-structure-typed`
  (MIT), the ANTLR4 runtime (BSD-3-Clause), and `vscode-jsonrpc` (MIT) — see
  `NOTICE`, `LICENSE-MIT`, and `LICENSE-BSD-3-CLAUSE`.
- `@salesforce/apex-ls` is **not published to public npm** — it is built from
  Salesforce's `apex-language-support` monorepo. The vendored build is pinned
  by `apex-ls/VERSION`:

  ```
  apex-ls@1.0.0 ba0599c6 2026-06-18T17:12:50Z
  ```

## Files and integrity (SHA-256)

| File | Bytes | SHA-256 |
|---|---|---|
| `apex-ls/dist/server.node.js` | 9,594,907 | `4a3c59a2b83a19190e2404036d77ad5b18c15d35d92b9b2e95739298ed9a88f0` |
| `apex-ls/dist/worker.platform.js` | 9,372,762 | `3429659b0dad5f1f4626ec3878063c00e72c6566eaad8afc850b85d1db29eaec` |
| `bin/soql-lsp.bundled.js` | 715,769 | `c96d08d5fb656b2fc72feb4c655be2494e8ad9278df4b57073fa1b142dc71023` |

`apex-ls/package.json` is a LOAD-BEARING anchor, not metadata: the server
locates `worker.platform.js` by walking up from its own directory to the first
`package.json`, then expecting `<pkgRoot>/dist/worker.platform.js`. Removing it
would make that walk escape into this repo. (The worker itself is dormant —
apex-ls loads it only when its worker experiment is explicitly enabled, which
Contrail never does.)

## Refresh ritual (rare, deliberate)

1. Pick and record a new sf-skills commit; clone it.
2. Copy `plugins/builder/salesforce-development/vendor/apex-ls/{dist/server.node.js, dist/worker.platform.js, package.json, VERSION}`
   and `plugins/builder/salesforce-development/bin/soql-lsp.bundled.js` over the
   files here (same layout).
3. Update the table above (sizes + `sha256sum`), the VERSION line, and the
   commit pin — and the same in `src/test/vendor.test.ts` (the CI tripwire).
4. Run the env-gated integration suite (`CONTRAIL_LOCALDIAG_IT=1 npx vitest run src/test/localdiag.integration.test.ts`)
   to prove the new bundles still speak the same protocol.
5. Update the NOTICE if the embedded third-party set changed upstream.
