# Contrail manual install — instructions for Claude

**You are being asked to install the Contrail Engine plugin for your human.**

> **Check first:** this is the FALLBACK path. The normal way to install Contrail is
> the one-click extension — the human opens Claude Desktop **Settings → Extensions →
> Advanced settings → Install Extension…** and picks `contrail-<version>.mcpb` from
> the distribution folder. No build, no config editing, done. Only continue with
> this file if the extension route failed on their machine, their Claude Desktop has
> no Extensions page, or they're installing into **Claude Code** rather than Claude
> Desktop.

This file lives at the root of the unzipped Contrail package. Follow the steps in
order. You need terminal (Bash/PowerShell) and file-editing tools — you have them
if you're Claude Code or a Cowork desktop session with this folder connected.

Work carefully: step 2 edits the human's Claude Desktop config, which also holds
their personal preferences. **Merge, never overwrite**, and back it up first.

---

## Step 0 — Orient

1. Confirm the folder you're working in is the unzipped Contrail package: it must
   contain `server/`, `.claude-plugin/plugin.json`, and `skills/`. Note its
   **absolute path** — call it `CONTRAIL_ROOT`. It must be a permanent location
   (e.g. `~/Documents/Contrail`, not a temp/Downloads folder), because the plugin
   runs from this path every time Claude Desktop starts.
2. Check Node.js is installed and version ≥ 22: `node --version`. If it's missing
   or older, stop and tell the human to install the current **LTS** from
   nodejs.org, then resume. Any Node 22+ works — the native modules ship prebuilt
   binaries that are not tied to a specific Node version, so do **not** downgrade
   Node if something fails; diagnose instead.

## Step 1 — Install the runtime dependencies (no build)

The server ships prebuilt at `server/dist-plugin/index.mjs` — confirm that file
exists. From `CONTRAIL_ROOT` (the repo/zip ROOT, not server/), run:

```bash
npm ci --ignore-scripts
```

This installs only the two native modules (`better-sqlite3`, `@napi-rs/keyring`),
which arrive as prebuilt binaries — no compiler, no build step, ever; if you see
node-gyp output at all, something is wrong (check the Node version is ≥ 22 and
retry). There is nothing to compile: the bundle is committed.

## Step 2 — Register the plugin in Claude Desktop

Claude Desktop reads MCP servers from `claude_desktop_config.json`. Locate it by OS:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
  (i.e. `C:\Users\<name>\AppData\Roaming\Claude\claude_desktop_config.json`)
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Then:

1. **If the file exists, read it and make a backup copy** (e.g.
   `claude_desktop_config.backup-<date>.json`) before touching it. It very likely
   already contains a `preferences` block and other keys — you must preserve all of
   it. If the file doesn't exist, create it as `{ "mcpServers": {} }`.
2. **Merge** this entry into the top-level `mcpServers` object (add the key
   alongside anything already there — do not replace the file). Use the **absolute
   path** to the built server, with **forward slashes** (they work on every OS in a
   Node argument, and avoid Windows backslash-escaping bugs in JSON):

   ```json
   "contrail-engine": {
     "command": "node",
     "args": ["<CONTRAIL_ROOT>/server/dist-plugin/index.mjs"]
   }
   ```

   Do the edit by parsing the JSON, adding the key, and writing it back — not with
   text substitution — so you can't corrupt the existing structure. After writing,
   re-read and verify the JSON parses and that both the new `mcpServers` entry and
   the pre-existing keys are intact.
3. **Important:** Claude Desktop rewrites this file when it exits, and won't pick up
   MCP changes until it restarts. So: tell the human to **fully quit Claude Desktop
   (check the system tray / menu bar — closing the window isn't enough) and reopen
   it.** If your edit doesn't appear after a restart, the app overwrote it — reopen
   the config while Claude Desktop is fully closed, re-apply, and restart again.

## Step 3 — Verify (after the human restarts Claude Desktop)

In a fresh Claude Desktop conversation, the Contrail tools should be available. Ask
Claude (or have the human ask) to run `list_connections` — it should return an empty
list `{ "connections": [], "count": 0 }` rather than an error. That confirms the
engine is running. The human can now connect orgs (see their getting-started guide).

---

## Alternative: Claude Code (instead of Claude Desktop)

In Claude Code, prefer the marketplace — it handles installs AND updates:

```
/plugin marketplace add RHayes765/contrail-plugin
/plugin install contrail@contrail
```

Later updates: `/plugin marketplace update contrail` (or enable that
marketplace's auto-update in `/plugin`). No manual config, no zip.

Manual fallback: skip step 2's config file and add the server to the
project/user MCP config instead (e.g. a `.mcp.json` with the same
`contrail-engine` entry, absolute path to `server/dist-plugin/index.mjs`), or add
`CONTRAIL_ROOT` as a local plugin directory. Step 1 is the same.

## Gotchas we already learned (don't rediscover them)

- **The config file is shared** with the human's Claude Desktop preferences — merge
  the `mcpServers` key, never overwrite the file, and back it up first.
- **Forward slashes in the path.** Backslashes in JSON string values get mangled;
  `C:/Users/.../server/dist-plugin/index.mjs` works fine in a Node arg on Windows.
- **Windows Store (MSIX) installs of Claude Desktop can read a *virtualized* config**
  at `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json`
  instead of the `%APPDATA%` one. If your edit verifiably parses but the server never
  loads, check whether that path exists and edit the copy the app actually reads
  (compare modification timestamps after a restart).
- **macOS: GUI apps don't inherit your shell PATH.** If Node was installed via nvm
  or another shell-profile-managed tool, `"command": "node"` may fail even though
  `node` works in Terminal. Use the absolute path to the node binary (from
  `which node`) as `command` instead.
- **Restart is mandatory** and must be a full quit — the MCP server is a persistent
  process started at launch; rebuilding or editing config does nothing until restart.
- **Keep the folder put.** The config points at an absolute path; moving or deleting
  `CONTRAIL_ROOT` breaks the plugin.
- **Consent screen says "Salesforce CLI".** During org login (later), Salesforce
  shows the app as *Salesforce CLI*, not Contrail — this is expected in this build
  (it borrows the Salesforce CLI's OAuth client). It's safe; log in as normal.
