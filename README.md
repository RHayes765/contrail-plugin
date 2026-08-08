# Contrail — Phase 0 (Engine-as-Plugin)

The Contrail engine shipped as a Claude plugin: a local stdio MCP server (the
**Contrail Engine**) plus a skill carrying the house rules. Spec:
`contrail-phase0-spec.md`.

**Status: P0.6 — flow deactivation** (in progress, on top of the completed
P0.1–P0.5 Phase 0 surface). Contrail can now deactivate flows: a `Flow` listed in
`validate_deploy`'s `destructive` list auto-deactivates before deletion (active
flows no longer block teardown), and a `deactivate_flow` tool turns off a flow
without deleting it — both through the same two-step human approval. Native
`FlowDefinition` deploy type added. 23 tools.

**P0.5 — hardening, skills, packaging.** The full P0.1–P0.4 surface (connections,
metadata read, diff, data, diagnostics, two-step deploy/DML write pipeline) plus
the P0.5 hardening:

- **Brute-force guard** on confirmation codes — wrong guesses are counted and the
  pending code is locked after a threshold (config `deploy.maxFailedAttempts`), on
  top of the single-use / ~1h expiry / superseded-on-revalidation guarantees.
- **Permissions-aware deploy warning** — `validate_deploy` flags new components
  that will be invisible/inaccessible without companion permissions (FLS, object,
  Apex, tab) when the package grants none.
- **Native `Profile`/`CustomTab` deploys** and **self-invalidating approval pages**
  (a stale tab polls its status and blanks the code once it's spent).
- **Skills**: tuned house rules + a `building-salesforce-metadata` skill that
  bakes in "components and their permissions travel together."
- **Packaging**: one-command install (`npm install` builds via `prepare`) and an
  esbuild single-file bundle option.

The write-safety invariant (spec §0/§5) remains enforced, not aspirational: the
confirmation code appears **only** on a human-only localhost approval page, never
in a tool result, so a prompt-injected agent with tool access cannot self-approve.

## Layout

```
.claude-plugin/plugin.json      plugin manifest (registers the MCP server)
skills/salesforce-house-rules/  the house rules skill
server/                         the Contrail Engine (TypeScript, Node >= 20)
  src/core/                     config, SQLite store (index/graph/audit), keychain, grants
  src/salesforce/               OAuth (PKCE), REST/Tooling client, Metadata API SOAP client
  src/connect/                  connect/manage flows + localhost pages
  src/snapshot/                 snapshot store, artifact indexer, refresh engine
  src/deps/                     reference extractor, org dependency API, graph queries
  src/diff/                     semantic XML/Apex diff
  src/deploy/                   deploy engine, package builder, confirmation codes, approval page
  src/tools/                    MCP tool registrations (lifecycle + metadata + diff + data + deploy)
```

Snapshots live under `%LOCALAPPDATA%\Contrail\snapshots\{connection}` — raw
retrieve zips in `archive/` (diff history for P0.3) and the extracted tree in
`current/`. The CustomObject manifest expands from the org's `listMetadata`
inventory (the package.xml `*` wildcard misses standard objects, where most real
custom fields live).

## Build

```bash
cd server && npm install
```

`npm install` also builds (`dist/`) via the `prepare` script — one command gets
you a runnable server. `npm run build` rebuilds after source changes; `npm test`
runs the suite.

## Install

**As a Claude Code / Cowork plugin:** add this directory as a local plugin
(marketplace entry or `--plugin-dir`). The manifest starts the server over stdio
from `server/dist/index.js`.

**Packaging reality:** two dependencies are native addons — `better-sqlite3`
(SQLite) and `@napi-rs/keyring` (OS keychain). Native addons can't be bundled or
committed cross-platform, so **every install needs an `npm install` step** to
fetch their platform binaries (both ship prebuilds, so no compiler is required on
common platforms). `dist/`, `dist-bundle/`, and `node_modules/` are gitignored.

- **Pilot install (recommended):** `cd server && npm install` — installs deps and
  builds `dist/` in one command. Point the plugin/Claude Desktop at
  `server/dist/index.js`.
- **Lean single-file artifact:** `npm run bundle` produces `dist-bundle/index.mjs`,
  a single ESM file with every pure-JS dependency inlined and only the two native
  addons left external. A target then needs just
  `npm install --omit=dev better-sqlite3 @napi-rs/keyring` beside it. This is the
  path for a future marketplace release; the pilot path above is simpler for now.

**In Claude Desktop (manual MCP entry):** the config file lives at
`%APPDATA%\Claude\claude_desktop_config.json` on Windows
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS). It also
holds Claude Desktop's own `preferences`, so it will already have content — add
`mcpServers` as a new top-level key alongside what's there, don't replace the file.
You can open it from the app via Settings → Developer → Edit Config. Restart Claude
Desktop afterwards; MCP servers are only read at startup.

```json
{
  "mcpServers": {
    "contrail-engine": {
      "command": "node",
      "args": ["C:/Users/Ryley/Contrail/Phase 0 Plugin/server/dist/index.js"]
    }
  }
}
```

**HTTP (future self-hosted/Docker step):** `node dist/index.js --http 7373` serves
streamable HTTP at `/mcp`, bound to 127.0.0.1 (set `CONTRAIL_HTTP_HOST` to widen —
only behind your own auth/network controls).

## OAuth connected app

Until the Contrail connected app exists (spec §8), the engine defaults to the
Salesforce CLI's public client (`PlatformCLI`, callback
`http://localhost:1717/OauthRedirect`) so dogfooding works out of the box. To use
your own connected app (public client, PKCE, refresh token + api scopes), edit
`config.json` in the data directory:

```json
{
  "salesforce": { "clientId": "<consumer key>" },
  "oauth": { "callbackPort": 7717, "callbackPath": "/callback" }
}
```

The callback port/path must exactly match the connected app's registered callback
URL. Env overrides: `CONTRAIL_SF_CLIENT_ID`, `CONTRAIL_SF_API_VERSION`,
`CONTRAIL_OAUTH_CALLBACK_PORT`, `CONTRAIL_OAUTH_CALLBACK_PATH`.

## Security model (P0.1 surface)

- **Tokens:** refresh tokens live in the OS keychain only (Windows Credential
  Manager here). Never in SQLite, config, logs, or MCP responses.
- **Grants:** five per-connection booleans (`metadata_read`, `metadata_write`,
  `diagnostics_read`, `data_read`, `data_write`), set by a human on the localhost
  page only, enforced server-side on every tool call. The model cannot set or
  change them. `manage_connection` opens the page directly in the browser and
  withholds its session-bearing URL from the tool result (returned only if the
  browser fails to open) so a prompt-injected agent with an HTTP tool cannot
  drive the grants form.
- **Localhost hardening:** both local pages send `X-Frame-Options: DENY` +
  `frame-ancestors 'none'` (clickjacking) and refuse non-loopback Host headers
  (DNS rebinding); the `--http` transport validates Host/Origin the same way.
- **Login targets:** only `*.salesforce.com` / `*.salesforce.mil` hosts are
  accepted, https only.
- **Data:** connection metadata + audit log in SQLite under
  `%LOCALAPPDATA%\Contrail` (override: `CONTRAIL_DATA_DIR`).

## Development

```bash
cd server
npm test          # vitest
npm run build     # tsc → dist/
```
