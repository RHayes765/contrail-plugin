#!/usr/bin/env node
// Contrail — Remote Control hook (Claude Code PreToolUse), the plugin-shipped
// flavour (hooks/hooks.json). Records whether THIS Claude Code session has
// Remote Control connected, keyed by the tool call, so the Contrail server
// can decide whether a freshly minted approval code is worth pushing to your
// phone (server/src/core/remoteControl.ts reads these markers). Two signals,
// either one means ON:
//   1. CLAUDE_CODE_BRIDGE_SESSION_ID in this hook's environment — documented,
//      Claude Code ≥ 2.1.199 (the CLI's /remote-control);
//   2. Claude Code's per-process session record
//      <CLAUDE_CONFIG_DIR | ~/.claude>/sessions/<CLAUDE_PID>.json carrying a
//      non-empty `bridgeSessionId` for THIS session_id — observed in the
//      Claude Desktop app's Code tab (Claude Code 2.1.317), where the
//      variable is not exported; undocumented, so the session id must match
//      before the record is trusted (a reused PID never counts).
// Writes a boolean, timestamps and which signal fired: never the bridge id,
// never tool arguments. Exit 0 always; a hook must never block or fail a
// tool call.
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
const sessionId = typeof hook.session_id === 'string' ? hook.session_id : '';

/** Signal 2: Claude Code's own session record for the process running this hook. */
function sessionRecordSaysOn() {
  const pid = process.env.CLAUDE_PID;
  if (!pid || !/^\d{1,10}$/.test(pid) || !sessionId) return false;
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8'));
    return (
      !!rec &&
      typeof rec === 'object' &&
      rec.sessionId === sessionId &&
      typeof rec.bridgeSessionId === 'string' &&
      rec.bridgeSessionId.length > 0
    );
  } catch {
    return false;
  }
}

const signal = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID ? 'env' : sessionRecordSaysOn() ? 'session_record' : 'none';

const body = JSON.stringify({
  v: 1,
  remote_control: signal !== 'none',
  at: new Date().toISOString(),
  tool_name: tool,
  tool_use_id: id,
  signal,
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
