---
name: salesforce-flow-visualize
description: "Render Salesforce flows as interactive HTML artifacts — a single version, or a two-version diff with Flow-Builder-style layout, change highlighting, and a parsed node inspector. TRIGGER when the user wants to see, visualize, or diagram a flow; compare a flow across two orgs or before/after an edit; or asks for the flow diff viewer as an artifact. DO NOT TRIGGER for authoring or editing flow XML (building-salesforce-metadata), deploying it (salesforce-house-rules), or debugging flow runtime failures (get_flow_errors / platform-apex-logs-debug)."
---

# Visualizing flows as interactive artifacts

You produce a single self-contained HTML page from one or two flow XML
documents and publish it as a private artifact. No server, no external
libraries — the page parses the XML client-side and renders:

- a **layered, Flow-Builder-style canvas** (BFS depth rows, barycenter
  column ordering — the flow's own `locationX/Y` are deliberately ignored;
  they assume tiny icon glyphs and crowd real node cards);
- **right-angle connectors between adjacent rows only** — anything longer,
  backward, or sideways renders as a clickable "→ target" pill under its
  source (Flow Builder's own legibility trick; loop-backs never draw lines);
- in diff mode, **name-keyed change classification** (added / removed /
  changed via whitespace-normalized element comparison), edge-level drift
  tinting, and a resource strip for off-canvas changes (variables, formulas,
  text templates);
- a **parsed inspector** on click: decision rules as readable conditions,
  lookup objects and filters, assignment items, action params — side by side
  across versions with differing rows tinted, raw element XML behind a
  toggle. Clicking a node highlights it in BOTH panes.

## 1. The template is the product — do not rewrite it

`assets/flow-diff-template.html` (in this skill's folder) is a hardened,
live-verified renderer ported from Contrail desktop's FlowDiagram. Build
every page from it; never regenerate its logic from memory. It has three
placeholders:

| Placeholder | Value |
|---|---|
| `__FLOW_A__` | `JSON.stringify(<flow A XML string>)` |
| `__FLOW_B__` | `JSON.stringify(<flow B XML string>)` — or the literal `null` for single-version view |
| `__META__` | `JSON.stringify({aLabel, bLabel?, subtitle?, note?})` — pane headings and footer |

Also replace the `<title>` with a name for THIS page (e.g. the flow label,
plus "Diff" when comparing). In a diff, A is the left/old/source side and B
the right/new/target side; added = right only, removed = left only.

Build recipe (Claude Code):

```bash
node -e "
const fs = require('fs');
const tpl = fs.readFileSync('<skill>/assets/flow-diff-template.html', 'utf8');
fs.writeFileSync('<scratchpad>/flow-view.html', tpl
  .replace('<title>Flow Diff Viewer</title>', '<title>My Flow Diff</title>')
  .replace('__FLOW_A__', JSON.stringify(fs.readFileSync('<path-to-A.flow>', 'utf8')))
  .replace('__FLOW_B__', JSON.stringify(fs.readFileSync('<path-to-B.flow>', 'utf8'))) // or 'null'
  .replace('__META__', JSON.stringify({ aLabel: 'uat', bLabel: 'prod' })));
"
```

Then publish the built file as an artifact. In Claude Desktop chat (no file
tools), emit the artifact directly: reproduce the template's architecture as
described above and in its source — but say plainly that the file-based
template is the higher-fidelity path.

## 2. Where the flow XML comes from

- **Local snapshot** (preferred): `retrieve_metadata` with type `Flow`
  returns the content and the snapshot path
  (`…/snapshots/<conn-id>/current/flows/<Name>.flow`); in Claude Code read
  the file for byte-exact bytes. `refresh_snapshot types:["Flow"]` first if
  stale.
- **Cross-org diff**: the same flow name from both connections' snapshots —
  the copied-then-tweaked consulting case.
- **Before/after an edit**: copy the snapshot file BEFORE deploying or
  refreshing, then diff against the new snapshot afterward.
- **Historical versions in ONE org** (v12 vs v13): `retrieve_metadata` with
  `flow_version: N` (type `Flow`, one name) returns that version converted
  from the Tooling API's JSON to flow XML. Discover version numbers first
  with `soql_query` `tooling: true` — `SELECT VersionNumber, Status FROM
  Flow WHERE Definition.DeveloperName = '<name>' ORDER BY VersionNumber`.
  Fidelity contract: two CONVERTED versions diff cleanly against each
  other (use converted XML for BOTH panes); a converted version against a
  Metadata API retrieve may show ordering-only noise, and converted output
  is never deploy-ready. Never fabricate an "old version" from memory.

## 3. Confidentiality (client orgs)

Artifacts are private to their owner by default — fine for client flows the
human asks to see. But: keep client-data pages in their OWN artifact, never
republished over a shareable demo's URL; delete scratchpad copies of client
flow XML once published; and client XML never goes into repos, fixtures,
skills, or memory. Same-named flows from different clients are different
artifacts.

## 4. Limits, honestly

- Panes bail out above **250 nodes** per version with a plain message —
  relay it; don't shrink the flow to force a render.
- The classification is structural: element reordering inside a node counts
  as a change; label-only edits count as changes (deliberate — labels are
  content). Unresolved connector targets are listed in the footer, never
  silently dropped.
- The page needs no network; everything is embedded. Flow XMLs of ordinary
  size are far below artifact limits.
