---
name: salesforce-flow-visualize
description: "Show a Salesforce flow as an interactive diagram, or two flows side by side as a diff — Flow-Builder-style layout, change highlighting, a parsed node inspector — through Contrail (the render_flow tool in the Claude Code plugin and the Claude Desktop extension; the app's own diagram views in the Contrail desktop app). TRIGGER when the user wants to see, display, visualize, or diagram a flow; compare a flow across two orgs, two versions of one flow, or before/after an edit; or asks for a flow diagram or flow diff as an artifact. DO NOT TRIGGER for authoring or editing flow XML (building-salesforce-metadata), deploying it (salesforce-house-rules), or debugging flow runtime failures (get_flow_errors / platform-apex-logs-debug)."
---

# Showing flows as interactive pages

`render_flow` builds the page. Your job is to choose the sources, read its
result honestly, and get the page in front of the human. Never hand-build a
flow diagram, and never rebuild the page from the template yourself — the tool
embeds the flow XML safely, which a string replace does not.

The page shows:

- a **layered, Flow-Builder-style canvas** (the flow's own `locationX/Y` are
  deliberately ignored; they assume tiny icon glyphs and crowd real node cards);
- **right-angle connectors between adjacent rows only** — anything longer,
  backward, or sideways is a clickable "→ target" pill under its source;
- in a diff, **name-keyed change marks** (added / removed / changed), edge-level
  drift tinting, and a strip for off-canvas changes (variables, formulas, text
  templates);
- a **parsed inspector** on click: decision rules as readable conditions, lookup
  objects and filters, assignment items, action parameters — side by side
  across the two versions with differing rows tinted, raw element XML behind a
  toggle.

## 1. Call render_flow

| The human wants | Arguments |
|---|---|
| One flow from an org's snapshot (the flow's latest version - the footer gives its status; add `version: "active"` for the version that runs) | `connection`, `flow` |
| An older version | `connection`, `flow`, `version: 12` (or `"active"` / `"latest"`) |
| The same flow in two orgs | `connection`, `flow`, `connection_b` |
| Two versions in one org | `connection`, `flow`, `version: 12`, `version_b: 13` |
| Before/after an edit | `file` (the saved "before") + `connection_b`, `flow` — or `connection`, `flow` + `file_b` (a staged edit) |

Side A is the left / old / source pane and side B the right / new / target
pane: added = B only, removed = A only. `flow_b` names a different flow on side
B; `label` / `label_b` set the pane headings; `title` names the page.

The result gives `file` (the page on disk, under `renders/` in Contrail's data
directory), `opened`, one entry per side (where it came from, how many
elements, whether it is over the diagram limit) and `notes`. Relay the notes —
they are the page's footer (a Remote Control note, when present, is in the
result only).

## 2. Get it in front of the human

- By default the tool asks this computer to open the page in its default app
  for .html files. That only helps a human sitting at this computer.
- When the human is somewhere else (the result says when Remote Control was
  last reported on, or they tell you they are on their phone), pass
  `open: false` and publish `file` as a **private artifact** with whatever
  artifact tool this session has. Publish the file itself; never paste or
  retype its contents — a flow's XML does not survive a trip through a model.
- No artifact tool and a remote human: say so plainly and give the path. Do not
  fall back to drawing the flow by hand.
- **In the Contrail desktop app** there is no `render_flow` and no artifact
  tool. Point the human at the app instead: **Metadata** → open the flow (it
  opens as a diagram; a button switches to Raw XML); **Diff** → the two orgs →
  the flow's row → **Split** for the side-by-side view. The app compares two
  orgs; it has no view for two versions inside one org — say that rather than
  improvising.

## 3. Where each side comes from

- **A connection's snapshot** (`connection` + `flow`, no `version`): the
  Metadata API retrieve held locally. Run `refresh_snapshot types:["Flow"]`
  first if it is stale — the footer states the snapshot's date. The snapshot
  holds each flow's latest version, which can be a draft above the active one.
  A flow the snapshot lacks is read live from the Tooling API instead (its
  active version, else its latest), and the footer says so.
- **A historical version** (`version`): the Tooling API's JSON for that
  version, converted to flow XML. `"latest"` and `"active"` resolve the number
  for you; to list versions use `soql_query` with `tooling: true` — `SELECT
  VersionNumber, Status FROM Flow WHERE Definition.DeveloperName = '<name>'
  ORDER BY VersionNumber`.
- **A saved file** (`file` / `file_b`): flow XML under Contrail's staging
  directory (`list_connections` returns `staging_dir`). For before/after an
  edit you rarely need to save anything: before deploying, `connection` +
  `flow` + `file_b` (your staged edit) compares the snapshot copy with the
  edit; after an executed deploy that changed an existing flow, pass the flow
  file from the revert package (`revert_package.dir` on the execute result) as
  `file`. For any other "before", copy the snapshot file into staging with a
  file copy - when the flow is in the snapshot, `retrieve_metadata` with
  `max_bytes` 1000 cuts the content and returns the file's `snapshot_path`.
  Never write a flow file out from `content` yourself: a flow's XML does not
  survive a trip through a model, and `render_flow` refuses a file that is not
  well-formed. A path inside the snapshot folder is refused - name the
  connection instead, so the read passes its grant.
- **Fidelity contract.** Two snapshot copies compare like for like, and so do
  two converted versions. A converted version against a snapshot (or a saved
  retrieve) is a mixed comparison: element order differs, so nodes can be
  marked changed when nothing real differs. The tool allows it and says so in
  `notes` and the footer; prefer a version on BOTH sides (`version: 12`,
  `version_b: "latest"`). Converted XML is never deploy-ready. Never fabricate
  an "old version" from memory.
- **Flows no API exposes.** Platform- and feature-delivered flows have only a
  descriptor. The tool refuses them; relay the refusal — there is nothing to
  draw.

## 4. Confidentiality (client orgs)

Artifacts are private to their owner by default — fine for client flows the
human asks to see. But: keep client-data pages in their OWN artifact, never
republished over a shareable demo's URL; and client XML never goes into repos,
fixtures, skills, or memory. Same-named flows from different clients are
different artifacts. The page file embeds the flow's full XML. Contrail deletes
pages in `renders/` that are more than 7 days old, but only when its server
starts or `render_flow` writes another page - if the human wants a page gone sooner,
delete the file. You also delete any other copy you made (a "before" file in
staging, a scratchpad copy) once the human has what they need.

## 5. Limits, honestly

- A pane with more than **250 elements** shows a plain message instead of a
  diagram. The result flags it per side (`over_diagram_limit`) — relay it;
  don't shrink the flow to force a render.
- The classification is structural: element reordering inside a node counts as
  a change; label-only edits count as changes (deliberate — labels are
  content). Unresolved connector targets are listed in the footer, never
  silently dropped.
- The page embeds everything it needs and references nothing on the network.
  Opened from disk in a browser, its Content-Security-Policy also stops it
  loading any resource from the network; inside a published artifact the
  host's own policy applies, and Contrail has not verified that the page's
  policy is honoured there. The result reports `page_bytes`; a very large flow
  makes a very large page, and an artifact host may refuse it — say so if it
  does.
