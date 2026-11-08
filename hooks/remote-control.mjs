#!/usr/bin/env node
// Contrail — Remote Control hook (Claude Code PreToolUse), the plugin-shipped
// flavour (hooks/hooks.json). Records whether THIS Claude Code session has
// Remote Control connected — Claude Code ≥ 2.1.199 sets
// CLAUDE_CODE_BRIDGE_SESSION_ID in hook processes while it does — keyed by
// the tool call, so the Contrail server can decide whether a freshly minted
// approval code is worth pushing to your phone (server/src/core/remoteControl.ts
// reads these markers). Writes a boolean and timestamps only: never the
// session id, never tool arguments. Exit 0 always; a hook must never block
// or fail a tool call.
//
// The data directory must agree with server/src/core/paths.ts dataDir() —
// the two are kept in step by hand (this file cannot import the server).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function dataDir() {
  const override = process.env.CONTRAIL_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(home, '.contrail');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Contrail');
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'contrail');
  }
}

let input = '';
try {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
} catch {
  /* no stdin — still record the state */
}

let hook = {};
try {
  const parsed = JSON.parse(input);
  hook = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
} catch {
  hook = {};
}
const rawId = typeof hook.tool_use_id === 'string' ? hook.tool_use_id : '';
const id = /^[A-Za-z0-9_-]{1,80}$/.test(rawId) ? rawId : '';
const tool = (typeof hook.tool_name === 'string' ? hook.tool_name : '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 120);

const body = JSON.stringify({
  v: 1,
  remote_control: Boolean(process.env.CLAUDE_CODE_BRIDGE_SESSION_ID),
  at: new Date().toISOString(),
  tool_name: tool,
  tool_use_id: id,
});

try {
  const dir = path.join(dataDir(), 'remote-control');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.json'), body, 'utf8');
  if (id) fs.writeFileSync(path.join(dir, `${id}.json`), body, 'utf8');
} catch {
  /* best-effort: a marker that cannot be written reads as "unknown" */
}
process.exit(0);
