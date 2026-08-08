# Contrail install — instructions for Claude

**You are being asked to install the Contrail Engine plugin for your human.** This
file lives at the root of the unzipped Contrail package. Follow these steps in
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
2. Check Node.js is installed and version ≥ 20: `node --version`. If it's missing
   or older, stop and tell the human to install Node 20+ from nodejs.org, then
   resume.

## Step 1 — Build the engine

From `CONTRAIL_ROOT/server`, run:

```bash
npm install
```

This installs dependencies and builds `dist/` automatically (via the `prepare`
script). It downloads two native modules (`better-sqlite3`, `@napi-rs/keyring`) as
prebuilt binaries — no compiler needed on Windows/macOS. When it finishes, confirm
`server/dist/index.js` exists. If `npm install` reports a build error, run
`npm run build` and report the output.

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
     "args": ["<CONTRAIL_ROOT>/server/dist/index.js"]
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

If the human runs Contrail in Claude Code rather than Desktop, skip step 2's config
file and instead add the server to the project/user MCP config (e.g. a `.mcp.json`
with the same `contrail-engine` entry, absolute path to `server/dist/index.js`), or
add `CONTRAIL_ROOT` as a local plugin directory. The build step (step 1) is the same.

## Gotchas we already learned (don't rediscover them)

- **The config file is shared** with the human's Claude Desktop preferences — merge
  the `mcpServers` key, never overwrite the file, and back it up first.
- **Forward slashes in the path.** Backslashes in JSON string values get mangled;
  `C:/Users/.../server/dist/index.js` works fine in a Node arg on Windows.
- **Restart is mandatory** and must be a full quit — the MCP server is a persistent
  process started at launch; rebuilding or editing config does nothing until restart.
- **Keep the folder put.** The config points at an absolute path; moving or deleting
  `CONTRAIL_ROOT` breaks the plugin.
- **Consent screen says "Salesforce CLI".** During org login (later), Salesforce
  shows the app as *Salesforce CLI*, not Contrail — this is expected in this build
  (it borrows the Salesforce CLI's OAuth client). It's safe; log in as normal.
