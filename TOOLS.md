# Contrail Reference — tools, features, configuration

Everything Contrail can do, in one place. Current as of **v0.40.0** (43 tools).
The same tool surface is available in all three installs — the Claude Desktop
extension (`.mcpb`), the Claude Code plugin, and the Contrail desktop app —
with a few desktop-app differences [noted at the end](#the-desktop-app).

**Contents:** [Security model](#the-security-model) ·
[Connections](#connections--lifecycle) · [Metadata](#metadata-read--search) ·
[Drift & audit](#org-drift--setup-audit) · [Diff](#cross-org-diff) ·
[Flow pages](#flow-pages) · [Data](#data-reads) · [Diagnostics](#diagnostics) ·
[Local checks](#local-static-checks) · [Writes](#writes--the-approval-ritual) ·
[Skills](#the-skill-pack) · [Configuration](#configuration-configjson) ·
[Desktop app](#the-desktop-app) · [Where things live](#where-things-live-on-disk)

## Tool index

| Tool | Grant | One line |
|---|---|---|
| [`connect_org`](#connect_org) | — | Browser OAuth connect; human sets grants on the completion page |
| [`disconnect_org`](#disconnect_org) | — | Revoke the token and remove a connection |
| [`manage_connection`](#manage_connection) | — | Open the grants page (the only place grants change) |
| [`open_settings`](#open_settings) | — | Open the Settings page: approval codes to the human's phone (Pushover) |
| [`list_connections`](#list_connections) | — | List connected orgs + grants (+ each connection's policy, + update notice when behind, + phone-notification status) |
| [`get_permissions`](#get_permissions) | — | The full grants matrix, including what is NOT granted |
| [`get_audit_log`](#get_audit_log) | — | Local audit log: connections, refusals, every write decision |
| [`export_change_evidence`](#export_change_evidence) | — | Write a change-evidence dossier (md + json) for Contrail's writes; returns the path, never contents |
| [`list_metadata`](#list_metadata) | metadata_read | Inventory from the snapshot index, or live from the org |
| [`retrieve_metadata`](#retrieve_metadata) | metadata_read | Artifact source (flows, Apex, objects…) + one-hop dependencies |
| [`describe_schema`](#describe_schema) | metadata_read | Live object/field describe for one SObject |
| [`search_metadata`](#search_metadata) | metadata_read | Name + full-text search over the snapshot |
| [`get_dependencies`](#get_dependencies) | metadata_read | Dependency graph: what uses this, what breaks if it changes |
| [`refresh_snapshot`](#refresh_snapshot) | metadata_read | Re-retrieve the org (or only named components) into the local snapshot/index/graph |
| [`get_org_changes`](#get_org_changes) | metadata_read | Drift report: live org vs your snapshot, grouped by who |
| [`get_setup_audit`](#get_setup_audit) | metadata_read | SetupAuditTrail — config changes that never surface as metadata |
| [`diff_orgs`](#diff_orgs) | metadata_read (both) | Whole-org snapshot diff, bucketed by type |
| [`diff_artifact`](#diff_artifact) | metadata_read (both) | Semantic diff of one artifact across two orgs |
| [`render_flow`](#render_flow) | metadata_read (every connection read) | Build an interactive flow diagram or flow diff page; asks this computer to open it, or publish the file as an artifact |
| [`soql_query`](#soql_query) | data_read | Read-only SOQL, row-capped, truncation-honest (`tooling: true` needs metadata_read too) |
| [`get_record`](#get_record) | data_read | One record by id |
| [`explain_access`](#explain_access) | data_read | Why a user can/can't see an object or field (CRUD + FLS) |
| [`get_report_data`](#get_report_data) | data_read | Run a saved report and read its results (sync Analytics API) |
| [`get_debug_logs`](#get_debug_logs) | diagnostics_read | List or read Apex debug logs |
| [`run_apex_tests`](#run_apex_tests) | diagnostics_read | Run deployed Apex tests standalone (submit + poll) |
| [`run_agent_eval`](#run_agent_eval) | diagnostics_read (+data_write to start; +metadata_read to auto-detect the runner) | Run an agent test — Testing Center or Agentforce Studio (Beta); REAL actions execute |
| [`get_flow_errors`](#get_flow_errors) | diagnostics_read | Persisted flow interview problems |
| [`set_trace_flag`](#set_trace_flag) | diagnostics_read | Turn on debug logging for a bounded window |
| [`check_apex`](#check_apex) | — | Free local static Apex check (offline, pre-deploy) |
| [`check_soql`](#check_soql) | — | Free local SOQL syntax check (offline) |
| [`validate_deploy`](#validate_deploy) | metadata_write | Build + checkOnly-validate a package; code goes to the human |
| [`execute_deploy`](#execute_deploy) | metadata_write | Execute a validated deploy with the human's code |
| [`deactivate_flow`](#deactivate_flow) | metadata_write | Turn off a flow, through the same ritual |
| [`agent_activation_propose`](#agent_activation_propose) | metadata_write | Stage activating/deactivating a published agent version (live behavior) |
| [`agent_activation_execute`](#agent_activation_execute) | metadata_write | Apply the approved flip; result reports the org-confirmed status |
| [`dml_propose`](#dml_propose) | data_write | Stage a data change (flat ≤200 rows, or a 2–25-step plan) |
| [`dml_execute`](#dml_execute) | data_write | Execute a proposed data change with the human's code |
| [`apex_propose`](#apex_propose) | data_write | Stage an anonymous Apex script (shown verbatim to the human) |
| [`apex_execute`](#apex_execute) | data_write | Run the approved script; DML commits on success |
| [`bulk_load_propose`](#bulk_load_propose) | data_write | Stage a multi-file Bulk API 2.0 load; CSVs frozen at propose |
| [`bulk_load_execute`](#bulk_load_execute) | data_write | Drive the approved load; failed rows come back as file paths |
| [`list_skills`](#list_skills) | — | The skills bundled with this install: names, full descriptions, files |
| [`read_skill`](#read_skill) | — | Load a bundled skill (or one of its files) from this install |

---

## The security model

Two independent layers sit between the model and the org, and neither can be
changed from inside a conversation.

**Layer 1 — five per-connection grants.** A human sets them on the localhost
management page (and only there); the server re-checks them on every call.

| Grant | Allows |
|---|---|
| `metadata_read` | Retrieve flows, Apex, objects/fields; search, diff, dependency analysis. |
| `metadata_write` | Validate and execute metadata deploys, and activate/deactivate Agentforce agent versions (live behavior). Requires `metadata_read`. |
| `diagnostics_read` | Debug logs, flow errors, standalone Apex test runs, agent test-run polling and results (Testing Center or Agentforce Studio), trace flags. May expose incidental record data present in logs. |
| `data_read` | SOQL queries and record reads (row-capped). |
| `data_write` | DML, anonymous Apex, and bulk loads — propose and execute — plus starting agent test runs on either runner (the agent under test executes its REAL actions; the definition was ritual-approved, so a run start needs no code). Requires `data_read`. |

**Layer 2 — the write approval ritual.** Every write (one carve-out:
starting an agent test run, whose only input is a definition that
already passed this ritual — see `run_agent_eval`), in every environment
(sandboxes included), is two-step:

1. A `*_propose` / `validate_deploy` call computes the full consequence
   summary and opens an **approval page in the human's browser**: target org
   unmissable, every change listed (destructive changes first, in red), and a
   short **confirmation code**.
2. Contrail gives the code **only to the human** — on that page, and on their
   phone if they set that up (below) — never in any tool result, so a
   write executes only when that code is passed back. Contrail never passes it
   to the agent; the human does, by reading it into chat (a screenshot of the
   page, or an agent that can view the human's screen, exposes it too — the
   house rules say when such a code may be used). Close the tab without
   passing the code and nothing happens. If the human has set up **phone
   notifications** ([`open_settings`](#open_settings)), the engine also pushes
   the review summary and the code to their phone at the moment it mints
   them — so they can approve from anywhere — but the push approves nothing by
   itself: the code still counts only when the human gives it to the agent as
   their approval, and Contrail still never gives it to the agent. By default the push goes out **only while the Claude Code session
   has Remote Control connected** (the one situation in which a code on a
   phone can be typed from the phone); see [`open_settings`](#open_settings)
   for how Contrail learns that, and `notifications.when` to push every
   approval instead.

Codes are single-use, expire in ~1 hour, are invalidated by any newer
proposal **of the same kind** (deploy, DML, Apex, or bulk) on the same
connection, and lock after repeated wrong guesses (brute-force guard). A
deploy, DML or agent-activation code is also voided when Contrail finds, just
before claiming it, that the target changed since validation or proposal
(S45 — see [`execute_deploy`](#execute_deploy)); anonymous Apex has no fixed
org target to re-check, and bulk loads are not re-checked (their approval
page shows no current values for the rows to compare against); their results
say so (`target_check.status: "not_applicable"`). Every decision — proposals, executions, refusals — lands
in the local audit log.

**Policies.** The human can add rules to the `policies` section of
`config.json` — matched by org type, connection label or org id — that require
a justification or ticket, deny destructive metadata changes, data deletes or
anonymous Apex, set a minimum test level, or freeze a connection during set
windows. Contrail checks them when a write is proposed (for a deploy, again
when its validation finishes), whenever the approval page is drawn, and again
before a code is claimed; no Contrail tool or page writes that section. During
a freeze the approval page shows no code until the human types an emergency
reason there, and the phone push carries none. Policies cover the six
proposing tools. Starting an agent test run (`run_agent_eval`) has no approval
page: it is refused while a freeze is in effect or while the policies cannot be
read, and no other rule applies to it. Setting a trace flag is outside the
policies. Freeze windows use this machine's clock. An agent that has general
file access on the machine is outside Contrail's control — every change to the
section that Contrail observes is recorded in the audit log
(`policy.config_seen`), and for 24 hours afterwards the approval page, Deploy
Review and the phone push say that the policies changed. Policies are enforced
by Contrail 0.40.0 and later. The Claude Desktop extension, the Claude Code
plugin and the desktop app update separately and share one data directory; a
copy older than 0.40.0 neither checks policies nor honours a freeze, so update
every copy on the machine before relying on them. The change-evidence dossier
marks any request such a copy created or executed. The rule keys are in the
[configuration table](#configuration-configjson); what the write tools take and
return for them is under [Writes](#writes--the-approval-ritual).

Refresh tokens live in the OS keychain only. Contrail makes exactly two kinds
of outbound call that are not to your Salesforce orgs, and both are
disclosed here: the daily release check (`updates.checkEnabled`, one
anonymous request to GitHub, can be turned off) and — only if the human
switched it on — Pushover: one request per pushed approval, carrying the summary
and the code (`notifications.method`), plus one key check and one test
message when the human presses "Send test notification". Nothing else
leaves the machine.

---

## Connections & lifecycle

No grant required — these are zero-cost local reads plus the OAuth lifecycle.

### `connect_org`

Starts the browser OAuth flow. The human logs in as themselves and sets the
five grants on a local completion page — grants can never be chosen through
the tool. Re-running with an existing connection label **re-authorizes** it:
the recovery path after a sandbox refresh.

- `login` *(optional)* — `"production"` (default, login.salesforce.com),
  `"sandbox"` (test.salesforce.com), or a My Domain host verbatim (preferred
  when known — sandbox credentials fail on the production endpoint).
  Ignored when re-authorizing an existing label.
- `label` *(optional)* — suggested connection label; matching an existing one
  re-authorizes it.

### `disconnect_org`

Revokes the stored refresh token and removes the connection, its cached
tokens, and its snapshot data. Irreversible without a new OAuth flow —
Claude is instructed to confirm with the human first. Deploy artifacts it
produced are kept: revert packages under `staging/_reverts/` and bulk
failed-row exports under `deploys/`; each is removed by its own retention
sweep.

- `connection` — alias (or id) to remove.

### `manage_connection`

Opens the localhost page where the human changes a connection's grants. The
page opens directly in the browser, and its session-bearing URL is never
returned to the agent: if the browser cannot be opened, Contrail writes the
address to its own server log (stderr) for the human, and the tool result
says so — the agent asks the human to open the page from there, then calls
`get_permissions` after they save.

- `connection` — alias (or id).

### `open_settings`

Opens the human-only localhost **Settings** page — today, approval codes on
your phone. There the human switches Pushover delivery on or off, chooses
how much of the review travels in the message (**minimal** = the connection
alias, org type, counts and the code; **full** adds component names and
warnings — never record field values — which then transit Pushover's
servers), chooses **when** a push goes out (below), enters their Pushover
user key and application token, and sends a test notification (Save first;
the test button saves typed keys, checks them with Pushover, then sends one
test message). The keys go from the browser straight into the OS keychain,
shared with the desktop app; the page never renders a stored key back (only
a masked tail), and the agent gets nothing but *opened: yes/no* plus the
current method / when / configured status and the last Remote Control state
reported. Like the approval page, the session-bearing URL is never returned
to the agent — if the browser cannot be opened it goes to the server log for
the human to open. The page lives 10 minutes; call again for a fresh one. No
arguments.

**When a push goes out (`notifications.when`).** The default,
`remote_control`, pushes a code only while the Claude Code session it was
minted in has **Remote Control** connected — a code on a phone is useless when
it cannot be typed from one, so the desk case stays quiet. A stdio MCP server
cannot see Remote Control (its environment is fixed at spawn, and Claude Code
exposes no file or event for it); what a **hook** process can see is either
`CLAUDE_CODE_BRIDGE_SESSION_ID` in its environment while a connection is
active (documented; Claude Code ≥ 2.1.199) or — in the Claude Desktop app's
Code tab, where that variable is not exported — Claude Code's own per-process
session record `~/.claude/sessions/<pid>.json`, whose `bridgeSessionId` is
present while connected (observed on Claude Code 2.1.317, undocumented; the
hook trusts it only when the record's session id is its own). A version that
exposes neither makes the hook report off — upgrade, or choose Always. So
Contrail runs a tiny **PreToolUse hook** on its code-minting tools (plus
`list_connections` and this one): right before the tool runs, the hook writes
a marker under the Contrail data directory — `remote-control/<tool_use_id>.json`
and `latest.json`, holding a boolean, a timestamp, the tool name, the tool-use
id and which signal fired, never the session link, never tool arguments — and the engine
reads that marker when the tool call starts (the mint may come minutes later,
after org validation). The hook ships with the Claude Code **plugin**
(`hooks/hooks.json`, `node hooks/remote-control.mjs`). For the Claude Desktop
extension used from the Desktop app's Code tab, and for manual installs, the
Settings page has an **Install hook into Claude Code** button: it adds one
`PreToolUse` entry to Claude Code's user `settings.json` (`~/.claude/`, or the
`CLAUDE_CONFIG_DIR` the Contrail server sees) carrying the hook's few lines of
script **inline** — `powershell.exe -Command …` on Windows, `sh -c …`
elsewhere — so nothing executable lands on disk where an agent could edit it.
Everything else in the file is preserved (re-serialised as 2-space JSON), the
first write keeps a backup of the untouched file beside it, a file that is
not valid JSON is never touched, and **Remove hook** takes the entry out
again. Claude Code watches its settings files, so running sessions pick the
hook up within moments (start a new session if a proposal still reports no
hook). The hook never blocks a tool call; a matcher regex keeps it to the
eight Contrail tools (the six that mint a code — `validate_deploy`,
`deactivate_flow`, `dml_propose`, `apex_propose`, `agent_activation_propose`,
`bulk_load_propose` — plus `list_connections` and `open_settings`) under any server name
(`mcp__plugin_contrail_contrail-engine__…`, `mcp__contrail-engine__…`,
`mcp__Contrail__…`).

With no usable report for a call — hook not installed, or not a Claude Code
session at all (Claude Desktop chats have no Remote Control) — the push is
**skipped**, not sent: the result says `phone_notification.status: skipped`
with `remote_control_unknown`, and the human can install the hook or choose
**Always** (`when: always`, the S42 behaviour: every approval is pushed).
Remote Control off is `skipped` with `remote_control_off`, the designed quiet
case. The state is sampled when the proposing tool is called: turning Remote
Control on during a long validation does not change that call's decision (a
fresh proposal, once the first has completed and been collected, does). How
the engine pairs a call with its report: Claude Code's tool-use id, when the
request's `_meta` carries it (`claudecode/toolUseId` — observed in Claude
Code, not documented; its passage through the Claude Desktop extension bridge
is unverified) selects that call's marker and nothing else; without an id,
a report for the same tool within the last 30 minutes stands in — which can
be another session's, so a Claude Desktop chat proposing within 30 minutes of
a Remote Control session's call to the same tool may still be pushed.

Behaviour worth knowing: the phone message deletes itself when the code
expires, and the code is the message's **last line, alone** so it can be
selected and copied in one motion; after Pushover rejects the stored keys,
sends pause for 10 minutes (saving on this page clears the pause); the agent
is told only `phone_notification.status` and a reason category, and is to
OFFER this tool for `not_configured` / `rejected` / `circuit_open` /
`remote_control_unknown`, merely report `timeout` / `network` / `quota`, and
say nothing about `remote_control_off`.

Why a page rather than a tool argument: the notification destination is the
one setting a prompt-injected agent must never be able to change — and the
user key must be the human's own, since whoever owns it receives the codes.
The hook installer is on the same page for the same reason: it writes to a
file outside Contrail's own data directory, and only a human's click does.

### `list_connections`

Every connected org with alias, org identity, type, and grants, plus
`staging_dir` — the directory agents author `content_file`/`csv_file`
sources into, named proactively on the session-start tool so it is never
learned from a refusal — and `approval_notifications` (`method`, `when`,
whether both Pushover keys are stored — never the keys — and `remote_control`:
the last state Contrail's hook reported, `on` / `off` / `unknown`, when, and
`user_hook` — whether the entry in Claude Code's user `settings.json` is
installed; `not_installed` is normal for plugin installs, whose hook ships
bundled), and `skills` (how many skills Contrail can serve — the ones this
install bundles, or, when the note says so, the ones in the folder
`CONTRAIL_SKILLS_DIR` names — plus the read_skill call that loads the house
rules when the pack has them; or, with `bundled: 0`, why there is nothing to
serve). The pointer is repeated here because it is not verified
that every client shows a server's MCP instructions to the model. When a newer
Contrail release exists (from the cached daily check — never a network call at
tool time), the result carries an update notice with the download link.

**Policies (S46).** Each connection also carries `policy` — the
[policies](#the-security-model) that apply to it right now, so a proposal can
comply the first time: `rules` (their names), `requires_justification`,
`requires_ticket`, `ticket_patterns`, `denies` (any of
`destructive_metadata`, `data_deletes`, `anonymous_apex`), `min_test_level`,
`freeze_windows` (each with its `rule`, `name`, `when` and `time_zone`) and
`freeze_now` (the `rule`, `window` and `until` of the freeze in effect, or
`null`; when windows overlap, the active window with the most time left is
named, so `until` is the latest end among the windows active now). `policy`
is `null` on every connection when the policies cannot be read. `policies_status` says which: `{status: "ok", source, unmatched_rules}`
— `source` is `config` (the `policies` section of `config.json`) or `default`
(Contrail's built-in rule: the file has no such section), and
`unmatched_rules` names each rule whose label or org id matches no connection
on this machine (a connection re-created under a new label may have left it
behind; the agent tells the human) — or `{status: "unreadable", problem,
note}`, and then every write proposal is refused until the human fixes the
file. All of it comes from one read of the policies over one listing of the
connections.

### `get_permissions`

The full permission matrix for one or all connections, including what is
**not** granted — so capabilities are never discovered by trial and error.

- `connection` *(optional)* — omit for all connections.

### `get_audit_log`

The local audit log: connection lifecycle, OAuth flows, grant and policy
refusals, freeze overrides, and every deploy/DML/apex/bulk/agent-activation
decision, newest first. Local; for a client-facing change record,
[`export_change_evidence`](#export_change_evidence) writes a per-request
dossier from it.

- `connection` *(optional)* — filter to one connection.
- `since` *(optional)* — ISO 8601 timestamp; only events at or after it. It is
  compared as the instant it names, whatever its offset or precision; a value
  Contrail cannot read as a date and time is refused.
- `request_id` *(optional, S46)* — only events that name this request id (the
  `request_id` a validate or propose result returned) — among them its
  proposal, phone push, refusals (a wrong-code attempt names the request it was
  counted against, never the code; an execute refused by a policy included),
  freeze override, justification edits, execution, and the sweep that expired
  it. Supersession by a newer validation is recorded per connection and is not
  included; a policy check that passes is recorded on the request, not in the
  log. It must be that UUID; anything else is refused, never matched loosely.
- `event_type` *(optional, S46)* — one event type (`policy.refused`), or every
  type under a prefix ending in a dot (`policy.`). A malformed value is
  refused.
- `until` *(optional, S46)* — ISO 8601 timestamp; only events at or before it,
  compared the same way as `since`.
- `limit` *(optional)* — 1–1000, default 100.

The S46 events: `policy.refused` (a proposal, a deploy's mint, an agent
test-run start or an execute refused by policy — `phase`, `kind`, `reason`
and the rule, never a code), `policy.freeze_overridden` (the emergency reason
the human typed, with the rule and window), `policy.config_seen` (a Contrail process read
policies that differ both from what it last saw and from the newest such row
on this database — their
fingerprint and the previous one, `source`, the rule names, `status`, and
`changed`, which is false for the first observation and for an unreadable
interlude that ends with the same policies), `approval.justification_edited`
(the human saved a different justification — its length and where, never the
text), `evidence.exported`, `snapshot.members_refreshed` /
`snapshot.members_refresh_failed` (a member-scoped refresh, from the tool or
after a deploy), and `deploy.snapshot_rebaseline_unavailable` (the re-read
after a deploy did not run or did not finish).

### `export_change_evidence`

No grant, no org call, no code. Writes a **change-evidence dossier** —
`evidence.md` and `evidence.json` — for the writes Contrail validated,
proposed and executed, into a new folder directly under `evidence/` in the
data directory (`<YYYYMMDD-HHMMSS>-<label>`, the label built from the alias,
ticket and request id; never under staging, never a deploy source root), and
returns only the folder path and counts — never the dossier's text. Per
request: kind, connection and org, ticket, the justification and who wrote it
(the agent's draft, or the human on the approval page or in Deploy Review —
with the agent's original draft when the human replaced or cleared it), the
policy rules that applied at proposal and the re-check at execution, the
freeze in effect and any override with its emergency reason, the acting
Salesforce user as recorded at proposal (and at execution where that differs),
when it was proposed and executed, what the approval page showed (never the
confirmation code, never diff bodies), deploy pre-image fingerprints and
last-modified stamps with their `stamp_source`, the execute-time target check,
the org's result (failure messages reduced to status codes), the revert
package location, and the request's audit events (their detail reduced to an
allow-list). Then the policy refusals in the window that created no request.
Record field values are left out: data-change rows are reduced to operation,
object and record id, scripts and CSV files to fingerprints. It reports what
Contrail recorded on this machine — not the org's current state, and not
changes made outside Contrail. A request created or executed by a Contrail
older than 0.40.0 is marked as such (no policy check was recorded for that
step), and the summary table's `Policy checks` column says which checks ran.

- `connection` *(optional)* — alias (or id) whose requests to include.
- `ticket` *(optional, ≤120)* — only requests recorded with exactly this
  ticket (case-insensitive). The search reads up to 20,000 requests, newest
  first, so an old match is not lost behind a row cap; past that the dossier
  says the search stopped.
- `request_id` *(optional)* — one request, by the `request_id` a validate or
  propose result returned.
- `since` / `until` *(optional)* — ISO 8601 timestamps bounding when the
  request was proposed.

Name at least one of `connection`, `ticket`, `request_id` or `since` — an
unfiltered dossier would mix every connection's changes in one folder. At most
the newest 200 matching requests are included and 1,000 audit events per
request; where a list was cut the dossier says so in place and the result's
`truncated` is true. Nothing matched → no folder (`path: null`). The result:
`path`, `files`, `requests`, `by_status`, `audit_events`, `policy_refusals`,
`truncated`; `evidence.exported` is audited with the counts, the folder's name
(never its path) and the filters. The dossier is the human's deliverable and
is never swept.

---

## Metadata read & search

Grant: `metadata_read`. Most of these read the **local snapshot** — a full,
indexed, dependency-mapped copy of the org's metadata that Contrail retrieves
and keeps under its data directory (see `refresh_snapshot`).

### `list_metadata`

Inventory from the snapshot index: all type counts, or the artifacts of one
type (capped at 500 items). With `live: true` (requires `type`) it queries
the org directly instead; live Flow listings union in FlowDefinitionView so
standard/feature-delivered flows — invisible to the Metadata API — appear,
with their source marked per item.

- `connection` — alias (or id).
- `type` *(optional)* — e.g. `ApexClass`, `Flow`, `CustomObject`, `CustomField`.
- `live` *(optional)* — query the org directly (requires `type`).

### `retrieve_metadata`

The source of specific artifacts — flow XML, Apex bodies, object/field
definitions, validation rules, labels — each with a one-hop dependency
summary. Apex comes live from the Tooling API (falling back to the snapshot
copy, noted, if the live read fails); everything else reads the snapshot,
except that flows absent from it are fetched live from the Tooling API when
Salesforce exposes them there. Truncation is never silent: results carry
`bytes_total` and `truncated_reason`, plus the `snapshot_path` of the file
on disk (when the artifact is in the local snapshot) so oversized artifacts
can be read directly.

- `connection` — alias (or id).
- `type` — e.g. `ApexClass`, `ApexTrigger`, `Flow`, `CustomObject`,
  `CustomField`, `ValidationRule`, `CustomLabel`, `PermissionSet`.
- `names` — 1–10 full API names; children dotted (`Account.MyField__c`).
- `max_bytes` *(optional)* — per-artifact budget; default 250,000 (fits a
  large real flow whole), max 2,000,000; ~2 MB budget across the whole call.
- `include_dependencies` *(optional, default true)* — one-hop uses/used_by
  summaries (capped at 15 edges each).
- `flow_version` *(optional)* — a historical flow VERSION number; applies
  only to type `Flow` with exactly one name. The version is fetched from the
  Tooling API (which serves old versions as JSON) and converted to flow XML.
  The conversion is faithful for reading and diffing — element order is
  alphabetical, so diff two CONVERTED versions against each other — but NOT
  guaranteed deploy-ready, and the result says so. An unknown version number
  lists the versions that exist. Discover numbers first with `soql_query`
  `tooling: true`: `SELECT VersionNumber, Status FROM Flow WHERE
  Definition.DeveloperName = '<name>' ORDER BY VersionNumber`.

Platform/feature-delivered flows return only a descriptor — Salesforce
exposes no definition content for them via any API, and the result says so.

### `describe_schema`

Live object describe for one SObject: fields with types and references,
record types, relationship counts. Compact by design (fields capped at 300,
picklists sampled) — `retrieve_metadata` has the full XML.

- `connection` — alias (or id).
- `object` — SObject API name.

### `search_metadata`

Name and full-text content search over the snapshot index — find artifacts
by name fragment or by what their source mentions (a field, a label, a
class name).

- `connection` — alias (or id).
- `query` — search text (min 2 chars).
- `types` *(optional)* — restrict to these metadata types.
- `limit` *(optional)* — 1–50, default 20.

### `get_dependencies`

The dependency graph (org dependency API + Contrail's own reference
extractor): neighborhood, reverse dependencies, blast radius. `used_by`
answers "what breaks if I change this?"

- `connection` — alias (or id).
- `type`, `name` — the root artifact.
- `direction` *(optional)* — `uses` | `used_by` | `both` (default `both`).
- `depth` *(optional)* — 1–3 hops (default 1).

### `refresh_snapshot`

Manifest-driven re-retrieve of the org into the local snapshot, index, and
dependency graph. Long-running on big orgs — an in-progress result carries a
`job_id`; poll with `{connection, job_id}` alone. Jobs are keyed by their
requested type set (S41), so a caller only ever collects the refresh it
asked for — two sessions' refreshes can no longer cross-deliver — and
concurrent refreshes on one connection queue and run one after the other.
Refreshes also take a cross-process lease per connection: if the desktop
app is mid-sync on the same org, the refresh refuses with a clear message
instead of racing it over the shared snapshot — try again once its sync
finishes. `check_only: true` reports staleness without retrieving anything.

**Member-scoped refresh (S46).** `members: [{type, api_name}]` (at most 100,
alone with `connection`) re-reads only those components into an existing
snapshot: a child (CustomField, ValidationRule, ListView, RecordType,
CustomLabel, BotVersion) re-reads its whole parent document and every sibling
in it; a bundle directory is replaced whole; a report or dashboard brings its
folder definition; a `FlowDefinition` name re-reads the Flow. Each member comes
back `refreshed`, `removed` (no longer in what the org returned for it: a
component the org neither listed nor returned, or a child missing from its
re-read parent document — its snapshot rows, its files when it has its own,
and its outgoing dependency edges are deleted) or `skipped` with the reason.
Skipped by design: Profile, types Contrail does not snapshot, a component (or
the parent of a child) the org lists as package-owned that this snapshot does
not already hold — for example a custom field on a managed-package object —
and a member of a type this connection's snapshot does not cover — unless the
org's listing shows no unpackaged component of that type other than the named
ones (the first trigger or first LWC in an org; never a foldered type), in
which case the type is complete as far as the listing shows and
`get_org_changes` and `diff_orgs` keep meaning what they meant. Last-modified
stamps come from the org's listing of the re-read document (the source the
live checks read for a top-level component), or from the retrieve when the
listing has none; a child's row carries its parent document's stamp, as after
a whole refresh. Not done: no archive zip, no re-query of the org-computed
dependency data, and references TO a new or deleted component from other
components are rebuilt only by a whole-type refresh. Member jobs have their own
ids (`members-…`), queue on the same per-connection chain and take the same
cross-process lease where one exists: the lease lives in a table the Contrail
desktop app creates, so on a machine that has never run the desktop app two
Contrail plugin processes (for example two Claude sessions) are not serialised
against each other, and a whole refresh running in one can replace a member
re-read made by the other with what it retrieved earlier. A finished member job
that nobody collected is handed to a re-send of the same members for 60 s;
after that a re-send re-reads from the org. If a member refresh stops after it
has begun writing, its error says the snapshot may be only partly updated for
those components; re-run it with the same `members` to repair it.

The result carries `members` (one entry per member: `outcome`, the `unit` that
was re-read as `Type:name`, and for a skip its `reason` code —
`unregistered_type`, `profile`, `type_not_in_snapshot`, `type_unsupported`,
`package_owned`, `not_returned`, `presence_unknown`, `not_confirmed`,
`child_not_in_parent` or `not_indexable`), `counts`, `units`,
`artifact_counts`, `edge_counts`, `retrieved_at`, `notes` and `duration_ms`.
Refused before anything is read: `members` beside `types`, `check_only` or
`job_id`; a member whose name cannot be placed; more than 100 members; a
connection with no snapshot yet. `snapshot.members_refreshed` is audited for
every finished run (`origin`, counts, the units re-read, `duration_ms`).

- `connection` — alias (or id).
- `types` *(optional)* — types to refresh (default: the configured manifest —
  see [`snapshot.types`](#configuration-configjson)).
- `check_only` *(optional)* — compare timestamps only.
- `members` *(optional, alone)* — `[{type, api_name}]`, at most 100: re-read
  only these components (children dotted, foldered names `Folder/Name`).
- `job_id` *(optional, alone)* — poll a running refresh without re-sending
  types or members; a `members-…` id names a member job.

---

## Org drift & setup audit

Grant: `metadata_read`. The consultant's "what changed under me?"

### `get_org_changes`

Compares the org's **live** metadata inventory against your snapshot:
modified / new-in-org / gone-from-org, grouped by who changed it. Baselines
are per artifact (its indexed last-modified date) unless `since` overrides;
managed-package items are skipped and counted; child types ride their parent
object. Lists cap at 150 per bucket with exact totals. Drill in with
`retrieve_metadata` / `diff_artifact`; re-baseline with `refresh_snapshot`.

- `connection` — alias (or id).
- `since` *(optional)* — ISO date/datetime baseline override.
- `types` *(optional)* — restrict, max 20.

### `get_setup_audit`

Reads SetupAuditTrail — the configuration changes that never surface as
metadata: profile edits in Setup, user activations, permission assignments,
deliverability changes, login-as sessions. Grouped by section and by admin,
entries verbatim, truncation explicit against the org-side total.
(Salesforce retains ~180 days.)

- `connection` — alias (or id).
- `days` *(optional)* — 1–90, default 7.
- `limit` *(optional)* — 1–500, default 200.

---

## Cross-org diff

Grant: `metadata_read` on **both** connections — one granted org can never
leak another's metadata.

### `diff_orgs`

Whole-org comparison of two snapshots (e.g. sandbox vs production): only-in-A,
only-in-B, changed, identical — bucketed by type with exact per-type counts
(entry lists capped at 50 each, flagged when cut). Both sides need a
snapshot; each side reports the oldest and newest retrieval time among the
rows compared (`snapshot_taken: {<alias>: {oldest, newest}}`, S46 — the type
filter applied). Rows in one snapshot can have different ages: a refresh of
some types, or the re-baseline after a deploy, updates only what it touched,
so a side is only as fresh as its oldest row.

- `connection_a`, `connection_b` — the "from" and "to" aliases.
- `types` *(optional)* — restrict to these types.

### `diff_artifact`

Structural diff of one artifact across two orgs: XML metadata diffs by
element (reorders are not changes; keyed children match by name), Apex diffs
by line with hunks. Direction is A → B — "added" means present only in B.
In the desktop app this also powers the visual flow diff, including the
split-screen two-org view.

- `connection_a`, `connection_b` — aliases.
- `type`, `name` — the artifact; children dotted.

---

## Flow pages

Grant: `metadata_read` on **every** connection a call reads — both of them for
a two-org diff, checked before anything is read. A side read from a saved file
needs no grant.

### `render_flow`

Builds an interactive HTML page for one flow (a diagram) or two side by side
(a diff): a layered, Flow-Builder-style canvas, change marks in a diff, and a
parsed node inspector on click. Contrail fills the `salesforce-flow-visualize`
skill's template itself — the flow XML is embedded by the engine and never
passes through the model — writes the page under `renders/` in the data
directory and returns its path. By default it also asks this computer to open
the page (in the OS default app for `.html` files). To show it anywhere else —
a human on their phone, a shared review — pass `open: false` and publish the
returned file as a private artifact: the file itself, never its contents
pasted or retyped. The page embeds the flow's full XML, so treat the file as
client-confidential. Plugin and Claude Desktop extension only; the desktop app
draws flows on its own Metadata and Diff screens.

Side A is the left / old pane and side B the right / new pane; give no side-B
argument for a single view.

- `flow` *(optional)* — flow API name (DeveloperName). Used for both sides
  unless `flow_b` is given; required whenever a side reads from a connection.
- `connection` *(optional)* — side A: connection alias (or id).
- `version` *(optional)* — side A: a version number, or `"active"` /
  `"latest"`. Omit for the snapshot copy. Needs `connection`.
- `file` *(optional)* — side A instead of a connection: absolute path of a
  saved flow XML file under Contrail's staging directory.
- `label` *(optional, ≤80)* — side A pane heading (default: the connection
  alias, plus the version when one is given; or the file name).
- `connection_b` *(optional)* — side B: connection alias (or id). Omit to
  reuse side A's connection when `version_b` or `flow_b` is given.
- `flow_b` *(optional)* — side B: a different flow API name.
- `version_b` *(optional)* — side B: a version number, or `"active"` /
  `"latest"`.
- `file_b` *(optional)* — side B instead of a connection: absolute path of a
  saved flow XML file under Contrail's staging directory.
- `label_b` *(optional, ≤80)* — side B pane heading.
- `title` *(optional, ≤120)* — page title (default: the flow name and the pane
  headings).
- `open` *(optional, default true)* — ask this computer to open the page; pass
  `false` when the human is not at this computer.

| Case | Arguments |
|---|---|
| One flow from a snapshot | `connection`, `flow` |
| A historical version | `connection`, `flow`, `version: 12` |
| Cross-org diff | `connection`, `flow`, `connection_b` |
| Version against version in one org | `connection`, `flow`, `version: 12`, `version_b: 13` |
| Before/after against a saved file | `file` + `connection_b`, `flow`; or `connection`, `flow` + `file_b` |

**Where each side comes from.**

- **Snapshot** (`connection` + `flow`, no `version`) — the connection's
  snapshot copy, which holds the flow's **latest** version: that can be a
  draft saved above the active one. The side's `status` and the footer give
  that version's `<status>`; when it is not `Active` (or the XML carries none)
  the note points at `version: "active"` to draw the version that runs. A
  flow the snapshot lacks is read live from the Tooling API instead — its
  active version, else its latest — and converted (origin
  `tooling_fallback`); the footer says so.
- **Version** (`version: 12`, or `"active"` / `"latest"`, which one Tooling
  query resolves to a number) — the Tooling API's JSON for that version,
  converted to flow XML (origin `tooling_version`): faithful for reading and
  diffing, element order alphabetical, not deploy-ready.
- **File** (`file` / `file_b`) — saved flow XML under the staging directory,
  or under an absolute folder listed in `deploy.allowedSourceRoots`. It is
  read as a file: no connection and no grant, a revert package's pre-image
  under `staging/_reverts/` included; the audit row records its path and the
  sha256 of its bytes. No filesystem call touches the path until it is
  absolute, not a network or device path (one beginning with two slashes or
  two backslashes is refused outright), not inside Contrail's snapshot folder,
  and lexically inside one of those folders; only then is it resolved — a link
  that leads outside is refused — and read, up to 5,000,000 bytes. A path
  outside those folders is refused with the same text whether or not it
  exists.

**Fidelity.** Two snapshot copies compare like for like, and so do two
converted versions. A converted version against a snapshot (or a saved
retrieve) is allowed, but their child elements are ordered differently, so
nodes can be marked changed when nothing real differs; the result and the
footer say so and suggest a version on both sides. In a diff the result's
`fidelity` is `like_for_like`, `mixed`, or `unknown` (a file side, whose
origin Contrail cannot tell).

**Refusals worth knowing.** Every side must be well-formed flow XML, whatever
its origin — snapshot, converted version or file — and Contrail checks each
side before writing anything. It refuses, with nothing written:

- a platform/feature-delivered flow — Salesforce exposes only a descriptor for
  it and no API returns its definition, so there is nothing to draw;
- a network or device path (`render_flow reads saved XML only from local
  folders`) — copy the file into staging;
- a path inside the snapshot folder — name the org instead (`connection` +
  `flow`), so the read goes through that connection's `metadata_read` grant;
- XML whose root element is not `<Flow>`;
- XML that declares a DOCTYPE or an entity — flow metadata never does, and the
  page's XML parser would expand it;
- XML that is not well-formed (a cut or retyped file, a cut snapshot file) —
  the refusal names the parser's error code and line.

**Result.** `file` and `file_url` (the page), `mode` (`single` | `diff`),
`title`, `opened`, and one `sides` entry per side — `label`, `origin`
(`snapshot` | `tooling_version` | `tooling_fallback` | `file`), `connection`,
`flow`, `version`, `status`, `retrieved_at` (snapshot sides), `file` and
`sha256` (file sides), `bytes`, `elements`, and `over_diagram_limit` (a side
with more than 250 elements, where the page shows a plain message instead of a
diagram; a note says so) — plus `fidelity` (diff only), `notes` (the page's
footer), `page_bytes`, `retention` and a publishing `note`. When Contrail's
Remote Control hook last reported Remote Control on, the result also carries
`remote_control` and a note that the human may be away from this computer and
the file should be published as a private artifact; that note is in the result
only, not on the page. Each page written audits one `flow.rendered` row (the
sides' origins, connection ids, versions, file paths and hashes, the page path
and size, whether it was opened) — never the XML.

**Where pages live.** `renders/` in the data directory, one new file per page
written (`<flow>-<view|diff>-<UTC time>Z-<4 hex>.html`, never overwritten).
Pages older than 7 days are deleted when the Contrail server starts and each
time `render_flow` writes a page; nothing deletes them in between, and the desktop app,
which shares the data directory, never sweeps the folder. `renders/` is not a
deploy source root.

---

## Data reads

Grant: `data_read`.

### `soql_query`

Read-only SOQL. Row-capped (default 500, max 2000) with the org-side total
always included, so truncation is never silent; responses are size-budgeted
and long string fields are clipped at 10k chars, all flagged. Only `SELECT`
is accepted; `FOR UPDATE` is refused. Setup sObjects that carry metadata or
diagnostics content are additionally grant-gated: `ApexClass`, `ApexTrigger`,
`ApexPage`, `ApexComponent`, `EmailTemplate`, `StaticResource`,
`FlowDefinitionView`, `SetupAuditTrail` need `metadata_read`; `ApexLog`,
`FlowInterview` need `diagnostics_read` — the raw-SOQL path and the dedicated
tools always agree. `tooling: true` queries the **Tooling API** instead —
needed for setup/agent-graph sObjects like `GenAiPluginDefinition` — and
requires `metadata_read` on top of `data_read` (Tooling rows are
metadata-class content, wholesale).

- `connection` — alias (or id).
- `query` — the SELECT statement.
- `limit` *(optional)* — 1–2000, default 500.
- `tooling` *(optional)* — query the Tooling API (needs `metadata_read` too).

### `get_record`

One record by SObject API name and 15/18-char id, optionally restricted to
named fields (default: all accessible).

- `connection`, `object`, `id`; `fields` *(optional)*.

### `explain_access`

"Can this user see/edit this object (or field) — and **why**?" Resolves the
user (id, username, or full name; ambiguity is refused with candidates),
rolls up ObjectPermissions/FieldPermissions across profile and permission
sets (permission set groups included, muting applied), names which
assignment grants each bit, and counts how many users hold each granting
set (the queried user included).
Scope is stated honestly: **CRUD/FLS only** — record-level sharing
(org-wide defaults, roles, sharing rules) is not evaluated. Warns on
inactive users; explains fields that legitimately carry no FLS rows
(required/master-detail/system).

- `connection`, `user`, `object`; `field` *(optional)*.

### `get_report_data`

Runs a **saved report** as it stands through the synchronous Analytics REST
API and returns its results: report metadata (format, report type), detail
columns, grouping label paths with numeric aggregate values, grand totals,
and detail rows as display-formatted labels. The report runs as the
**connected user** — folder sharing and record sharing shape what comes back.
Accepts a report id (`00O…`), a DeveloperName, or the metadata-side
`Folder/DeveloperName` (the leaf resolves via the Report sobject; the folder
disambiguates duplicates). Three truncation signals, never conflated:
`all_data:false` (the synchronous run's org-side 2,000-detail-row cap — the
report has more), rows dropped to the caller's cap, and rows dropped to the
response byte budget. Not-found and folder-not-shared are indistinguishable
org-side and the error says so; Joined-format and very large reports cannot
run synchronously.

- `connection`, `report`; `limit` *(optional, 1–2000, default 200)*;
  `details` *(optional — `false` returns aggregates/groupings only)*.

---

## Diagnostics

Grant: `diagnostics_read`. Log bodies can contain record data — Contrail's
skills treat them as client-confidential.

### `get_debug_logs`

Without `log_id`: lists recent debug logs (user, operation, status, size).
With `log_id`: fetches the body — large logs come back as head + tail slices
(30k chars each) with the full length noted.

- `connection`; `log_id` *(optional)*; `limit` *(optional, 1–50, default 10)*.

### `run_apex_tests`

Runs **already-deployed** Apex tests via the Tooling API. Test transactions
commit no DML, so no approval is needed — but the run does write test
history/coverage rows, spend the org's daily async-test allowance, and
produce debug logs under an active trace flag, and the description says so.
Two-step: submit (`class_names` or method-level `tests`) → `test_run_id`,
then call again with that id to poll. Terminal is not the same as green:
Aborted/Failed queue states are reported distinctly. Coverage is the
org-wide aggregate for the exercised classes — the union of all tests that
ever touched them, labeled as such, never attributed to this run alone.

- `connection`; exactly one of `class_names` (1–50), `tests`
  (1–50 of `{class_name, methods?}`), or `test_run_id`.

New or edited test classes reach the org via `validate_deploy` /
`execute_deploy` first (`test_level: RunSpecifiedTests` verifies both the
class and its tests in one validation).

### `run_agent_eval`

Runs a deployed **agent test** — a Testing Center `AiEvaluationDefinition`,
or (S44) an Agentforce Studio Tests-tab `AiTestingDefinition` — and reads
per-case results (Testing Center: routed topic, executed action sequence and
every expectation outcome; Studio: the subject's response and every scorer's
outcome). Same two-step
shape as `run_apex_tests` (submit with `eval` → `run_id`; call again to
poll), with one crucial difference stated everywhere: **the agent under
test executes its REAL actions — nothing rolls back**, so prefer
sandboxes/dev orgs for agents whose actions write. Runs take minutes
(~10 concurrent per org, documented per runner — whether the two runners
share one pool is unconfirmed; Testing Center allows ≤1,000 cases per
definition). Polling and results
ride `diagnostics_read`; **starting** a run additionally requires
`data_write` — no confirmation code, because the definition is the run's
only input and it already passed the deploy ritual. Testing Center requires an ACTIVE
agent version (whether a Studio suite's `subjectVersion` can target a
non-active version is unverified); a Testing Center run-level `ERROR` is the
run failing (not a test verdict), and its pass/fail mapping tolerates both result schemas Salesforce emits
(anything label-shaped — e.g. `instruction_adherence`'s HIGH/LOW/UNCERTAIN —
comes back as `passed: null` with the label visible). Each case carries an
expectation-derived `verdict` — `failed` if any expectation failed, `passed`
only when all passed (and ≥1 existed), else `indeterminate` — and `totals`
counts those verdicts (`cases/passed/failed/indeterminate`); the org's own
case `status` (COMPLETED means ran, not passed) is shown raw but never
counted as a pass. Costs: Salesforce's
own sources differ (newer Help says Testing Center is unmetered as of
Summer '26; older docs mention Einstein Requests) — check your org's
consumption cards rather than trusting either claim; Salesforce's Beta
documentation says Studio-runner runs consume Einstein Requests.

**Policies (S46).** Starting a run is refused while a change freeze applies
to the connection (`CHANGE FREEZE — the test run was not started …`, naming the
rule, the window and until when) and while the policies cannot be read
(`POLICY CHECK FAILED CLOSED …`); both refusals come before any org call and
are audited as `policy.refused` with `phase: "start"`. No other rule applies to
a run, and there is no override: a run has no approval page on which the human
could record an emergency reason. A poll by `run_id` is never checked.

**Two runners (S44).** The same tool also drives **Agentforce Studio test
suites** — a deployed `AiTestingDefinition` (the type behind the Studio
Tests tab; on the org probed a Contrail-deployed suite appeared in that tab
only after this tool had run it once), run through the Studio runner that
Salesforce's own Agentforce DX test commands call. Salesforce
labels both the type and that runner **Beta**, and the runner is absent
from the Connect REST reference, so every Studio result says so and its
statuses and result fields may change. Runner selection: a `run_id` picks
its runner by key prefix (`4KB` = Testing Center, `3A2` = Studio — both
live-confirmed; any other prefix is refused); a bare
`eval` is looked up live via `listMetadata` across both types — that read
needs **`metadata_read`** on the connection (without it the tool refuses
and asks for `runner`), one match picks the runner, a name held by both is
refused as ambiguous, a name held by neither is refused (naming any type
the org does not know), and a failed lookup is refused rather than
defaulted — a real-actions run never starts on a guess. `runner` forces
either runner and skips the lookup (no `metadata_read` needed then). Every
result carries `runner` and `runner_detection`; when the lookup picks the
runner, the org's exact-case name is what gets submitted, and the submit
echoes it as the canonical `definition` name.
Studio statuses — `IN_PROGRESS` and `FAILED` observed live, the rest per
Salesforce's library — are `CREATED | IN_PROGRESS | SUCCESS | FAILED |
TERMINATED`; `FAILED` reads results tolerantly and says the RUN failed
(`error_message` — nested under `errorRepresentation` on this runner; the
one observed cause, a scorer column missing on some case, left the API
with no case rows while the Tests tab showed them — give every case the
same scorer set); `TERMINATED` is never a
pass; an unrecognised status is shown raw as still running. Studio cases
carry `subject_response` (the agent's reply, lifted out of the org's
HTML-encoded session blob), `routed_topics` (the session's
`runs[].topicName`), `session_id`, and one row per scorer, named by the
Tests tab's column label with the catalog name under `scorer` when known
(shapes live-observed 2026-11-11). The org returns each scorer's judgment
as an HTML-entity-encoded JSON string, which the tool decodes into `raw`;
`passed` is **derived** from exactly two shapes — the `status` Pass/Fail an
LLM-judged scorer returns (with `score`, `explanation` from its reasoning,
`evaluation_type` and `compute_status`), or `actualValue === expectedValue`
on the match scorers — and is `null` otherwise; execution markers such as
`computeStatus` are never read as verdicts, and the S40 case
`verdict`/`totals` rules apply unchanged. A 2xx submit without a
run id is reported as "a run of this definition is already in progress"
(Salesforce's own client's reading) and starts nothing.

- `connection`; exactly one of `eval` (definition DeveloperName, either
  type) or `run_id`; `runner` *(optional)* `testing_center` |
  `agentforce_studio`; `include_details` *(optional)* for the raw org
  payload.

### `get_flow_errors`

Recent persisted flow interviews (paused/errored) with their stuck element.
Honest limitation, stated in the tool: Salesforce does not persist most
failed interviews queryably — the full story lives in flow error emails and
debug logs (`get_debug_logs` around the failure time).

- `connection`; `limit` *(optional, 1–100, default 20)*.

### `set_trace_flag`

Turns on debug logging for a bounded window so Apex runs, test runs, and
flows produce logs readable via `get_debug_logs` — for the connected user,
or for **any named user** via `user:` (a User Id, exact Username, or a Name
to search; "Platform Integration User" is the headline case — Agentforce
agent conversations and autolaunched flows execute as it, invisible to a
self-trace). Ambiguous name matches are listed, never guessed; inactive
users are refused (they run nothing, so the flag would capture nothing).
Side
effects, honestly: writes a self-expiring TraceFlag row and (first use per
preset) a reusable DebugLevel; generated logs consume the org's shared log
allocation. An existing flag gets its expiry extended — never shortened (a
longer human-configured window is left untouched and reported as
`already-on`) — its own (possibly human-configured) debug level is
preserved, and flags never stack. The `level` preset therefore applies only
when the call CREATES a flag; an extend says the preset was not applied.

- `connection`; `minutes` *(optional, 1–60, default 30)*; `user`
  *(optional — Id, Username, or Name of the user to trace)*; `level`
  *(optional preset for a NEW flag, default `standard` = `Contrail_Debug`)*:
  `performance` (ApexCode FINE, profiling FINEST — limits/CPU work),
  `exception` (stack-trace focus), `callout` (Callout FINEST), `minimal`
  (small logs). Hand-picked category combos beyond these stay Setup work.

---

## Local static checks

No grant, no org, no network — these run Salesforce's own language servers
from bundles vendored into the install (`server/vendor/`, Apache-2.0; see
NOTICE), so they work offline and cost nothing. Their honesty contract: a
check that did not run **never masquerades as clean** — `checked: false`
with an `unavailable` reason is an answer, not a pass, and the fallback is
always the org gate (`validate_deploy` / `soql_query`).

### `check_apex`

Static Apex diagnostics before a deploy round trip: syntax errors are
definitive; semantic findings are checked against the Apex standard library
and flagged as advisory. It is not the org's compiler and sees no org
metadata — org-specific custom types and fields are silently tolerated, so
a clean result never replaces `validate_deploy`. Each call runs a fresh
checker (a few seconds — the price of trustworthy results).

- `code` — the Apex source (≤500k chars).
- `type` *(optional)* — `class` | `trigger` | `anonymous` (default `class`).

### `check_soql`

Local SOQL parse — **syntax only**. A clean parse says the grammar is right,
not that the org has those objects and fields. Use before sending novel or
generated SOQL to `soql_query`.

- `query` — the SOQL (≤50k chars).

---

## Writes — the approval ritual

Grants: `metadata_write` (deploys) / `data_write` (DML, Apex, bulk). Every
tool here follows the [two-step ritual](#the-security-model): propose →
human reads the code off the approval page (or their phone) → execute with
that code. Contrail gives the code only to the human (their approval page, and
their phone if they set that up); it never appears in any tool result. Every
propose/validate result carries `approval_page.phone_notification` —
`sent`, `failed` (with a reason category and what to do), `skipped`
(`remote_control_off`, the quiet desk case; or `remote_control_unknown`, no
hook report for this call), or `off` — so the agent knows whether the human also has the code on their
phone, without ever learning the code.

**Change record (S46).** The six proposing tools — `validate_deploy`,
`deactivate_flow`, `dml_propose`, `apex_propose`, `agent_activation_propose`,
`bulk_load_propose` — take two optional parameters:

- `justification` *(≤1,000 characters)* — one or two sentences on why the
  change is being made now, drafted by the agent from what the human asked for,
  in their terms — the reason, not the mechanics. The approval page shows it
  under **Change record** in an editable field, marked as drafted by the agent;
  the human can save a different text there (audited as
  `approval.justification_edited` — its length and where, never the text), and
  the record says who wrote what. A human who approves from the phone
  notification alone does not see it. Required where a policy says so — by
  default on production orgs and on orgs whose type Contrail could not
  determine.
- `ticket` *(≤120 characters, one line)* — the change ticket or reference the
  human named, passed only when they gave one; never invented, guessed or
  reused. Shown read-only on the page.

Both are recorded with the request, together with the policy rules that
applied, the freeze in effect and the connection's org and Salesforce user at
proposal, and the result returns them to the agent as `governance` (`ticket`,
`justification`, the `policy` rules and lines, `freeze`) — never a code. They
are not part of what executes.

**Policy checks at proposal (S46).** Every proposal is checked against the
[policies](#the-security-model) first. One that breaks a rule — or any
proposal while the policies cannot be read — is refused with the bare text
(`POLICY REFUSAL — …`, one line per broken rule, or `POLICY CHECK FAILED CLOSED
— …` naming the problem in `config.json`): no org call, nothing superseded (a
pending code on the connection still executes), one `policy.refused` row. A
deploy is checked again with a fresh read when its check-only validation
finishes; a refusal then says the validation ran, creates no approval and
leaves any pending one untouched. A re-send of the same full arguments while
that validation is still running is checked first as well; its refusal says
the call did not attach, and the running validation goes on to that second
check. During a **freeze** the request is created, but the result's closing
note is the **CHANGE FREEZE in effect** note in place of the approval
instructions (`governance.freeze` carries the rule, the window and `until`),
the approval page shows a CHANGE FREEZE card and no code until the human
types an emergency reason (15–1,000 characters) there — recorded as
`policy.freeze_overridden` for that request only, the freeze itself stays
configured — and a phone push carries no code. When windows overlap, the
freeze names the active window with the most time left, so its `until` is the
latest end among the windows active now (a window that begins before then can
extend the freeze). An open approval page follows the policies as they stand:
it reloads within one status poll when a freeze begins or ends, another window
becomes the one it names, a reason or justification is saved, or the policies
change, and it shows **BLOCKED BY POLICY** without the code when the request
no longer meets a rule or the policies cannot be read.

**Policy checks at execute (S46).** Each `*_execute` tool re-checks the
policies before the code is claimed, with no org call: a request a rule no
longer allows is refused (`POLICY REFUSAL — not executed`), a frozen request
with no emergency reason recorded is refused (`CHANGE FREEZE — not executed`),
and unreadable policies refuse it too. In each case the code is not used up, no
wrong attempt is counted and the request stays pending: the same code works
again, until it expires, once nothing refuses it — the freeze has ended or the
human recorded an emergency reason, the file is fixed, or the request meets the
rules (a missing justification the human can type on the approval page). The
check is repeated inside the claim, and the executed request
records it (`governance.execute_check`, with the org id and user the
connection had at that moment).

### `validate_deploy`

Builds a deploy package and validates it against the org with
`checkOnly=true` — nothing is committed. Returns the change summary
(destructive changes flagged), validation/test results, permission warnings
for components that need permissions the package does not grant, and blast
radius from the dependency graph; puts the confirmation code on the approval
page. A failed
validation issues **no** code. With `dry_run: true` a PASSED validation
issues no code either: same full results, but no approval request, page, or
payload is created, nothing becomes executable through Contrail, and a
pending approval on
the connection is left untouched (a normal validate supersedes it) — the
mid-build check that stops half-finished work from piling up approval
pages that were never meant to be used.

Every outcome carries a `job_id` keyed to the validation's exact input
(components, options, dry/real — and, from S46, `ticket` and
`justification`), so parallel validations — two dry runs,
a dry run beside a real validate, two sessions — never read each other's
results (S41); an in-progress validation is polled with
`{connection, job_id}` alone, nothing re-sent and no `content_file`
re-read (`ticket` or `justification` beside `job_id` is refused like any other
argument). The in-progress message says so: re-sending with a reworded
justification starts a second validation, and any code it issues replaces the
first one's.

**Policies on a validation (S46).** A real validation is checked against the
[policies](#the-security-model) before it starts — a refusal sends nothing to
the org — and again, with a fresh read, when the check-only validation
finishes, before any pending approval is superseded or a code minted (see
[Writes](#writes--the-approval-ritual)). A dry run is never refused for policy:
its result carries `policy_check` — `status` (`ok`, `would_refuse` or
`unreadable`, with `problem`), the `rules` that apply, `would_refuse` (the
texts a real validation with the same arguments would be refused with),
`freeze` and a `note` — so the package can be fixed before the real validate.
Where a policy sets a minimum test level, `test_level` must be passed
explicitly at that level or stricter: omitted is refused, because the org's
own default cannot show the minimum is met. A package with deletions is
refused where a policy denies destructive metadata changes.

**Live diff and clobber flags (S45).** A real validation (never a dry run)
also retrieves the org's current version of every component and deletion —
concurrently with the checkOnly deploy, bounded by
`deploy.preImageTimeoutMs` — and the approval page diffs each changed row
against that **live** version: a collapsed diff per row (XML changes for
documents and child components, per-file text hunks for bundles, files on
one side only listed as added or removed), capped per row and at 150 KB per
page, after which rows show counts only. Classification follows the org,
not the snapshot: a component the org holds but the snapshot lacks is
**EXISTS IN TARGET** and classifies as MODIFY (the deploy overwrites it),
one the snapshot has but the org lacks is **NOT IN TARGET** (the deploy
creates it), and a component whose proposed content matches the live
version reads "identical to the live version" whatever the snapshot says.
A row the live check reclassifies carries the warnings of its new
classification, computed against the live copy: a snapshot ADD the org
already has gains, say, the whole-document REPLACE or deactivate-first
warning and loses an add-only advisory such as "NEW LAYOUT IS NOT
ASSIGNED"; a snapshot MODIFY the org lacks goes the other way round.
**CHANGED IN TARGET** is driven by dates only — the org's last-modified
stamp differs from the snapshot's — with who and when in the row's detail,
never in a warning (so never on the phone); when either stamp is
unavailable, a row whose live bytes differ from the snapshot gets a neutral
note instead ("… Contrail cannot say who or when"). A child component
(a field, a validation rule …) whose snapshot row carries its object's
stamp has no stamp of its own to compare, so its live stamp is compared
with the time the snapshot was taken — the org's clock against this
computer's — and CHANGED IN TARGET needs it more than 60 seconds after the
snapshot; within a minute either way, differing bytes get the neutral note
only. A deletion whose member the org does not show is noted ("not
present in the target … the org decides whether this delete fails or
no-ops"), naming what was consulted. Types whose retrieved bytes cannot be
compared (Profile) keep the
snapshot's content verdict and are diffed against the snapshot, labelled
"diff vs your snapshot". When the
**retrieve** fails or times out, a LIVE COMPARISON UNAVAILABLE banner says
the org was not re-read and classifications and diffs come from the
snapshot; when only the last-modified **stamps** are missing — the listing
failed for some types, a stamp query failed or returned no usable stamp for a
member, or Contrail has no stamp query for a member — the live diff stands
and one line names those types and members, each with its reason (the
execute-time check then reports them as unchecked). The
result carries `live_check` (`status`, `reason`, `started_at`, `at`, the
checkOnly deploy's org-side `org_clock`, `dates_unavailable_types`,
`stamp_scheme`, `probe_failures`, `probe_unmatched`, `retrieve_note`) and a
`pre_image` per change and deletion (`present`, `source`, `stamp_source`,
`sha256`, last-modified date/by, `comparable`, `restorable`); the diffs
themselves live on the page only. The restorable pre-images are written to
`staging/_reverts/<requestId>/` for the revert package (see
[`execute_deploy`](#execute_deploy)).

**Where stamps come from (S46).** Last-modified stamps for CustomField,
ValidationRule, CustomLabel and ListView members come from one small query
per type that names only the package's own members (Tooling API
`CustomField`, `ValidationRule`, `ExternalString`; the `ListView` object),
and their bytes from a retrieve that names the child itself (through the
parent document instead for a standard field, or when the package also
retrieves that document); every other type is listed with `listMetadata` as
before. Each `pre_image` records its `stamp_source`, and `execute_deploy`
reads the same source. On a dev org with about 24,000 custom fields the
listing took over 90 seconds and the query under one — an observation on that
org, not a Salesforce guarantee. Contrail issues no stamp query for a
standard field (a CustomField member whose name does not end in `__c`), so it
is diffed live from its parent object's document, carries no stamp and is
unchecked at execute; the page names it. For these four types, "absent" at
execute means that query returned no row for the member; whether it sees
every member in an org that has its own namespace was not verified. A failed
stamp query is not replaced by the listing: `live_check.probe_failures` names
the type and the page says so. `live_check.retrieve_note`, when present, is
what the org's retrieve reported, quoted as sent — Contrail does not decide
what exists from it.

- `connection` — target, named unmissably to the human.
- `components` *(≤50)* — each `{type, api_name, content | content_file}`.
  Types include `ApexClass`, `ApexTrigger`, `ApexPage`, `Flow`,
  `CustomObject`, `PermissionSet`, `CustomTab`, `FlexiPage`,
  `CustomApplication`, `ReportType`, `GlobalValueSet`, `ConnectedApp`,
  `NamedCredential` / `ExternalCredential` / `AuthProvider` (credential
  metadata never carries working secrets — per-principal values are
  Setup-entered after deploy, retrieves return placeholders, literal legacy
  secrets are flagged on the approval page, and each principal needs an
  `externalCredentialPrincipalAccesses` grant the coverage checker counts),
  `PlatformEventChannel(Member)`,
  `ManagedEventSubscription`, `Layout`, `CustomMetadata` (records, dotted
  `Type.Record` names), `LeadConvertSettings` (the lead-conversion
  singleton — api_name literally `LeadConvertSettings`; a modify replaces
  ALL lead field mappings, and the page says so),
  `Report` / `Dashboard` (folder-qualified
  `Folder/Name` api_names; access is FOLDER sharing, and the approval page
  says so), `ReportFolder` / `DashboardFolder` (the folder definition itself,
  carrying the `folderShares` — deploy it with a report headed for a new
  folder), Agentforce types `Bot` (one document, versions inline — an
  omitted version block is a VERSION DELETE and the page says so),
  `GenAiPlugin` (topics — modifying one on an ACTIVE agent needs the human
  to deactivate it first; the page warns), `GenAiPromptTemplate`
  (`activeVersionIdentifier` is org-generated — retrieve-first, and the page
  warns on hand-typed/altered tokens), `GenAiPromptTemplateActv`,
  `AiEvaluationDefinition`, `AiTestingDefinition` (Agentforce Studio
  Tests-tab suites — a **Beta** type with a Beta runner; on the org probed a
  deployed suite appeared in the Tests tab only after its first run; the
  page says a deploy stores the suite and runs nothing, that a modify replaces the
  whole suite, and warns when single-turn and multi-turn cases share a
  suite; `AGENT` suites deploy at v66, `PROMPT` suites need API v68 — v66
  refuses `promptInput`), `AiAgentScorerDefinition` (custom scorers — versions are
  APPEND-ONLY org-side and the page lists any version a modify omits or
  regresses; the engine must be a scorer-typed `GenAiPromptTemplate`
  (`agentforce_session_tracing__scorer*`), which may ship in the same
  package, listed first in package.xml; `std_*` names are
  system-provisioned and the page says so), `BotTemplate`, `BotBlock`,
  `CustomPermission`
  (grants nothing until a permission set's `customPermissions` block enables
  it — the coverage checker counts that grant), `PermissionSetGroup` (a
  modify DETACHES omitted members, and the org recalculates grants
  ASYNCHRONOUSLY after every deploy — the page says both),
  `MutingPermissionSet` (an omitted mute is UN-MUTED — silently restored to
  every assigned user; the page says so), `QuickAction` (object actions
  dotted `Account.New_X`, global actions bare; a NEW action is surfaced by
  nothing until a layout or a dynamic-actions record page includes it, and
  the page says so), and child types
  `CustomField` / `ValidationRule` / `CustomLabel` / `ListView` /
  `RecordType` / `BotVersion` (dotted API names — `MyBot.v1`). Bundle types
  `GenAiFunction` / `GenAiPlannerBundle` / `AiAuthoringBundle` /
  `LightningComponentBundle` / `AuraDefinitionBundle` (one
  component = a directory of files) deploy via a **Contrail bundle
  envelope** — content is JSON
  `{"contrail_bundle":1, "files": {"<relative path>": "<body>", …}}`
  carrying the whole file set (main file included); the approval page
  classifies file-by-file. `LightningComponentBundle` (LWC) requires
  `<Name>.js` + `<Name>.js-meta.xml` (`.html`/`.css`/`.svg` and
  subdirectories are normal; `__tests__` and dot-files are refused locally —
  local tooling never deploys); the org compiles on deploy.
  `AuraDefinitionBundle` (S41) is **FLAT** — every file `<Name>`-prefixed,
  exactly ONE primary (`.cmp`/`.app`/`.evt`/`.intf`/`.tokens`) plus its
  required `<Name>.<kind>-meta.xml` (pins apiVersion); secondaries are
  `Controller/Helper/Renderer.js`, `.css`, `.design` (component bundles
  only), `.svg`, `.auradoc`; namespace-free names only, and the whole bundle
  is REPLACED on deploy (omitted files are deleted org-side — the page lists
  them). Validation live-checks Aura against the org: a bundle the org
  holds but the snapshot lacks (hand-made in Developer Console) classifies
  as MODIFY with a live file delta — never a misleading ADD — and an LWC
  name collision warns before the org refuses it.
  `AiAuthoringBundle` deploys as a **DRAFT
  STAGE**: exactly `<Name>.agent` (plaintext Agent Script) +
  `<Name>.bundle-meta.xml`; nothing compiles — the page says the running
  agent is unchanged until a human publishes the draft. Agent
  **publish / preview** stay org-side human steps;
  **activate / deactivate** goes through
  `agent_activation_propose`/`execute` behind its own ritual, and agent test
  runs — Testing Center or the Agentforce Studio runner (Beta) — through
  `run_agent_eval` (the
  `agentforce-metadata-generate` skill carries the full boundary).
- `destructive` *(≤50)* — `{type, api_name}` to DELETE; led prominently on
  the page. Deletions are accepted for **any** metadata type, including
  types Contrail cannot author — cleanup is a feature; the guard is the
  human approval, not a type gate. S41 sharpens the blind corner: a type
  Contrail cannot read additionally requires `allow_unregistered_delete:
  true` and carries an **UNREGISTERED TYPE DELETE** warning (no content, no
  dependent listing); translation types are refused outright (their safe
  routes are Translation Workbench or per-entry Tooling writes).
- `test_level` *(optional)* — `NoTestRun` | `RunLocalTests` |
  `RunSpecifiedTests` | `RunAllTestsInOrg`; `run_tests` for
  `RunSpecifiedTests`. **Omitted means omitted**: the org applies its own
  default (sandboxes: no tests; production: local tests when the package
  carries Apex, none otherwise). An explicit `NoTestRun` on a production
  connection is refused LOCALLY (S41 §3.14) — the org would reject it
  anyway, at the cost of a round trip — so a no-Apex production deploy
  simply leaves this out, which is exactly what Contrail sends when the
  agent doesn't specify one. Where a policy sets a minimum test level, pass
  it (or a stricter one) explicitly — see above.
- `job_id` *(optional, alone)* — poll a running validation without
  re-sending components; it also collects a validation `deactivate_flow`
  started.
- `ticket`, `justification` *(optional, S46)* — the change record; see
  [Writes](#writes--the-approval-ritual).

`content_file` reads a file byte-exactly (mandatory habit for large flows —
retyping tens of KB of XML risks silent corruption), confined to Contrail's
staging directory, its snapshots, or `deploy.allowedSourceRoots` from
config. Agents are told to author into staging **from the start** (the tool
description and `list_connections` both name the concrete path; the session
working folder is not a source root, and the containment refusal instructs
copy-into-staging, never a config change). The file is read at validation
and **frozen** into the approved package — editing it afterwards changes
nothing.

### `execute_deploy`

Executes what the code approves. Quick-deploys the org-validated package
when tests ran (stricter and faster than replaying bytes), falling back to
the frozen zip. In-progress results mean call again with the same code — the
running deploy is never restarted.

**Target check (S45).** Before the code is claimed, Contrail re-reads each
member's last-modified stamp from the source its frozen pre-image names — the
same `listMetadata` calls, or the same per-member query, the validate-time
live check made — and compares **stamps, not bytes** against that
validate-time retrieve. A member that changed, disappeared or
newly appeared is **TARGET MOVED**: nothing is deployed, the code is voided
(the request reads `superseded`), the frozen payload and the revert files are
removed, and the result is `{executed: false, target_moved: true, moved,
refusal, …}` — the refusal names each member (with who and when, where the
org reports them), and re-sending the same code replays it ("This code was
already voided and was not executed — …"), never "a newer validation
replaced it". Re-validate for the current state and a fresh code. A member
Contrail cannot compare is
**unchecked** — named in `target_check.unchecked` with a reason
(`type_not_enumerable`, `dates_unavailable_at_validate`,
`dates_unavailable_at_execute` — its stamp source gave it no usable stamp now,
`stamp_query_failed_at_execute` — the member's stamp query failed now,
`stamp_row_unmatched` — the stamp query, now or at validate, returned the
member's name only under a namespace the package did not name, so Contrail
cannot tell whether that row is the member's, `stamp_not_probeable` — no
stamp query can name the member and no validate-time date said so earlier (a
standard field that was present at validate is reported as
`dates_unavailable_at_validate`), `stamp_source_mismatch` — the frozen
pre-image names a stamp query this build does not read for that type, or
`absent_no_baseline` — see below) — never refused. `target_check.checked`
entries may carry `absent: true` (the execute-time read returned nothing for
the member, as the approval assumed; no stamp was compared). This list is the
only place the reasons are spelled out — the tool description no longer
carries them.
When validation captured no live baseline, the check falls back to the
org's own clock: a stamp at or after the checkOnly deploy's org-side
creation time, minus a 5-second ordering margin, counts as moved (so an edit
in those 5 seconds before validation also refuses — re-validate; the refusal
says "within 5 seconds before", never "after"); a member the execute-time
read does not return is unchecked (`absent_no_baseline` — without a live
baseline Contrail cannot tell whether it vanished before or after validation),
except an ADD, whose absence is what the approval assumed; with no
org-side time either — or for a request validated before the live check
existed — there is no baseline: every member is unchecked
(`live_check_unavailable_no_org_clock`). Whenever **no member could be
compared** — no baseline, or every member unchecked for its own reason
(types the org cannot enumerate, stamps unavailable at validate) — the
deploy **still runs**, and `target_check` is `{status: "not_checked",
checked_at, checked: [], unchecked, note}`, the note saying so;
`deploy.target_check_unavailable` is audited before the claim with
`reason: "no_baseline"` or `"nothing_compared"`. When the org cannot
be re-read at all (an error, or no answer within 15 s), the deploy **still
runs** — a deliberate fail-open, disclosed: `target_check` is
`{status: "unavailable", reason, note}`, the note says the approval page's
diff may not describe what was overwritten, and
`deploy.target_check_unavailable` is audited before the claim. On a pass,
`target_check` is `{status: "ok", checked_at, checked, unchecked}` — `ok`
means at least one member was compared and none had moved. Every
`target_check` carries a `status` — `ok`, `not_checked`, `unavailable` or
`not_applicable`; `not_checked` and `unavailable` both mean the write ran
without a completed check. A result where nothing was submitted (the frozen
package missing from disk) carries no `target_check`. The check covers
changes up to the moment the code is claimed; a change landing while the
org processes the deploy is not caught.

**Revert package (S45).** On success the result carries `revert_package`
(`dir`, `restores`, `deletes`, `not_restorable`, `covered` — present only when
some child member is restored by its container's document — `plan`, `note`),
where `dir`
is `staging/_reverts/<requestId>/`: the pre-images Contrail retrieved when
this deploy was **validated** — not immediately before executing — as
documents at their zip-relative paths, child components under
`children/<Type>/` and bundles as `bundles/<Type>/<Name>.contrail-bundle.json`
envelopes, plus `revert-plan.json` (`components` with each one's
`content_file`, `destructive` = the components this deploy added,
`not_restorable` with reasons — Profiles, and types Contrail cannot
retrieve — `covered` = child members restored by their container's document,
which gets the only file because `validate_deploy` refuses a container and
its own children in one package — and the `target_check`) and `README.txt`,
which says what a revert does not undo — data changes, automation that
ran, permission effects, changes to components outside the package — and
that it overwrites anything changed since in the components it restores,
another user's edits included; and re-deploying a Flow whose
latest version is active creates a new version. When the package holds
nothing to re-deploy, the README says so and that what it can revert is the
components the deploy added, which a revert deletes. Contrail never deploys a
revert on its own: pass each `content_file` (and the `destructive` list) to
`validate_deploy`, and the human approves it like any deploy. When a timeout
or transport error leaves the outcome unknown, the directory is **kept** and
finalized with `outcome: "unknown"` — the deploy may have committed, so the
failure result names the directory (check Setup → Deployment Status). An
org-reported failure (rolled back, nothing committed) removes it. With no
live pre-image (the retrieve was unavailable at validate), `revert_package`
is `null` with a `revert_note` — Contrail never builds a revert from the
snapshot, which may describe a state the org never had. Directories of
expired, superseded or locked validations are swept at the next real
validate; executed (and outcome-unknown) ones are removed by the first real
validate after `deploy.revertRetentionDays` (`0` keeps them forever).

**Snapshot re-baseline (S46).** After a successful deploy — and, in the
desktop app, after the project manifest has captured its before-side —
Contrail runs a member-scoped refresh of the deploy's components (a child
re-reads its whole parent document, never the child alone) and reports it as
`snapshot: {status, rebaselined, removed, skipped, note}`; the top-level
`note` stops asking for a `refresh_snapshot` when the status is `complete`.
Statuses: `complete`, `partial`, `none` (every component skipped, each with its
reason), `unavailable` (`reason`: `timeout`, `locked`, `refresh_running`,
`failed`, `failed_after_write`, `no_snapshot`, `too_many_members`,
`no_metadata_read`, `connection_removed`), `disabled`, and `pending` — what
the stored result says until the re-read finishes, and what a replay shows if
Contrail stopped in between. Every `unavailable` reason but one means nothing
was written; `failed_after_write` means the re-read stopped while writing, so
the snapshot's files and its index can disagree for the deploy's components
until `refresh_snapshot` with `members` re-reads them. After a deploy only the
deploy's own deletions are reported `removed`: a component the deploy created
or changed that the re-read did not find is `skipped` with its reason
(`not_returned`, `presence_unknown`, `not_confirmed`, or `child_not_in_parent`
for a child missing from its re-read parent document), and the status is then
`partial` or `none`, never `complete`. Each `skipped` entry carries its `code`
and the `reason` in words. Nothing here can fail or undo the deploy. The
re-read is bounded by `snapshot.rebaselineTimeoutMs` (60 s; a re-read that has
begun writing is always let finish), waits at most 10 s behind another refresh
on the connection (`refresh_running`), takes at most 100 components
(`too_many_members` — the note names the `types` to refresh instead), and is
turned off by `snapshot.rebaselineAfterDeploy: false` (`disabled`). While the
re-read runs the call may return in-progress with a message saying the deploy
itself has completed; call again with the same code. It covers only the
deploy's own components and does not re-query the org-computed dependency
data. `deploy.snapshot_rebaseline_unavailable` is audited when it did not run
or did not finish; `snapshot.members_refreshed` (origin `execute_deploy`) when
it did.

- `connection`, `confirmation_code`.

### `deactivate_flow`

Turns off a flow's active version through the same ritual (a native
`FlowDefinition` deploy; execution via `execute_deploy`). Also the required
first step before attempting flow deletion — which the Metadata API handles
unreliably even then, and the tools say so rather than pretending. After
`execute_deploy` runs it, the flow's snapshot copy is re-read like any
deployed component. An in-progress result names its `job_id`; collect it with
`validate_deploy {connection, job_id}`, or call `deactivate_flow` again with
exactly the same arguments — `ticket`, `justification` and `test_level` are
part of the job's identity, so changing any of them starts a second
validation whose code replaces the first one's.

- `connection`, `flow` (DeveloperName).
- `test_level`, `run_tests` *(optional, S46)* — only when a policy on this
  connection sets a minimum test level (`list_connections` reports it): pass
  that level or a stricter one. Otherwise omit them — the org then applies
  its own default. `RunSpecifiedTests` needs `run_tests`; `NoTestRun` is
  refused locally on production, as for `validate_deploy`.
- `ticket`, `justification` *(optional, S46)* — the change record; see
  [Writes](#writes--the-approval-ritual).

### `dml_propose`

Stages a data change with a before/after preview. Two shapes:

- **Flat** — one operation on one object, ≤200 rows, all-or-none:
  `operation` (`insert`|`update`|`delete`), `object`, and `records` or `ids`.
- **Plan** — 2–25 ordered single-record `steps`, where a later step cites an
  earlier insert's created id with the whole-value token `"@{ref.id}"` (in
  field values or as an update/delete target). The org resolves tokens
  server-side — ids never round-trip through the model. Seeds linked test
  data (Account → Contact → Opportunity → …) in **one** approval.
  `all_or_none` (default true) rolls the whole plan back on any failure;
  `false` keeps successes and fails dependents — the page states which mode
  is being approved.

Custom metadata (`__mdt`) records are refused here with a pointer to their
real path (`validate_deploy`, type `CustomMetadata`) — they are metadata,
not data.

- `ticket`, `justification` *(optional, S46)* — the change record; see
  [above](#writes--the-approval-ritual). A change that deletes records (a
  flat `delete`, or a plan with a delete step) is refused where a policy
  denies data deletes.

### `dml_execute`

Executes the proposed change with the human's code. Returns per-row/per-step
outcomes and created ids.

**Target check (S45).** Before the code is claimed, the preview query is
re-run: an updated field whose value no longer matches the before-value the
page showed, or an approved record the query no longer returns (deleted, or
no longer visible to this connection's user — indistinguishable from here),
is **TARGET MOVED** — nothing is written, the code is voided, and the
refusal names the records. Field values are compared, not
`SystemModstamp`, so an unrelated edit does not refuse; a value changed and
changed back is invisible. Field names are matched case-insensitively
against the preview row, and a 15-character id is matched to its
18-character record. Records the preview did not return, whose pre-check
failed, or for which the page showed no before-value
(`no_before_value_shown` — the record's existence is still re-checked) are
reported as unchecked; when no record could be compared (the pre-check
failed at propose, or every record was not found at propose), the write
still runs with `target_check.status: "not_checked"` and
`deploy.target_check_unavailable` audited (`reason: "no_baseline"` or
`"nothing_compared"`); an
insert has nothing to re-check (`target_check.status: "not_applicable"`).
When the org cannot be re-read, the write still runs with
`target_check.status: "unavailable"`; a pass (`"ok"`) means at least one
record was compared and none had moved.
The untruncated before-values this check compares are kept with the request
and are not added to the `dml_propose` result (its rows carry only the
page's truncated `old → new` labels).

- `connection`, `confirmation_code`.

### `agent_activation_propose`

Stages activating or deactivating a **published** Agentforce agent version
behind the ritual (S34). Resolution happens at propose: the BotVersion Id and
its current status are frozen into the request, a version already in the
requested state is refused without burning an approval, and the page carries
the LIVE-BEHAVIOR warning — this is not a metadata deploy; there is no draft
in between. Publishing/compiling Agent Script is deliberately NOT this tool.

- `connection`, `agent` (Bot DeveloperName), `version` (e.g. `v2`),
  `status` (`Active` | `Inactive`).
- `ticket`, `justification` *(optional, S46)* — the change record; see
  [Writes](#writes--the-approval-ritual). The policy check comes before the
  version lookup, so a refusal makes no org call.

### `agent_activation_execute`

One documented Connect REST call
(`POST /connect/bot-versions/{id}/activation`), then a re-read: the result
reports the org's **confirmed** status, never the requested one, with the
platform's `messages[]` verbatim when it refuses (e.g. an unpublished
version). Single-use code, ~1h expiry, superseded by a new propose.

**Target check (S45).** Before the code is claimed, the version's `Status`
is re-read; a status other than the one the approval was for (or no row) is
**TARGET MOVED** — nothing is applied and the code is voided. When the org
cannot be re-read, the change still runs with
`target_check.status: "unavailable"`; a request with no recorded starting
status runs with `"not_checked"` (nothing was compared); a pass is `"ok"`.

- `connection`, `confirmation_code`.

### `apex_propose`

The **only** path to `executeAnonymous`. Stages a script (≤32,000 chars) the
approval page shows **verbatim** under the sharpest warning in the product:
it runs with the human's permissions, DML commits on success, an uncaught
exception rolls the whole script back, and there is no dry-run — the org
compiles and executes in one shot at execute, and a compile error spends the
code like any failed write. Scripts return no output — `set_trace_flag`
first when the debug log matters.

- `connection`, `code` (the script).
- `ticket`, `justification` *(optional, S46)* — the change record; see
  [Writes](#writes--the-approval-ritual). A policy can deny anonymous Apex on
  a connection outright. Contrail does not inspect a script for deletes, so a
  policy that denies data deletes (but not anonymous Apex) adds a **POLICY
  NOTE** to the page saying so — the human reads the script.

### `apex_execute`

Runs the approved script; compile errors, runtime errors (transaction rolled
back), and success (DML **committed**) are reported distinctly and honestly.

- `connection`, `confirmation_code`.

### `bulk_load_propose`

Stages a multi-file **Bulk API 2.0** data load — the migration-scale
counterpart to `dml_propose`. Rows go **file → org and never through the
conversation**: you prepare UTF-8 CSVs (API-name headers; a `.tsv` file is
treated as TAB-delimited — the extension is the declaration;
cross-object references as relationship-by-external-ID columns like
`Account.External_Id__c`, resolved org-side — no id-mapping pipelines), and
name one file per step. Steps execute sequentially in the order given —
parents before children. Every file is scanned (headers, quote-aware row
counts; malformed files are refused here with a position instead of failing
mysteriously org-side) and **frozen** at propose with a SHA-256 the page
shows and execute re-verifies. One approval page carries the whole plan.

- `connection` — target, named unmissably.
- `steps` — ordered, one file each (cap: `bulkLoad.maxFilesPerPlan`,
  default 20; per-file cap `bulkLoad.maxFileBytes`, default 100 MB). Each:
  `csv_file` (absolute path, `.csv` or `.tsv`, same containment as
  `content_file`; in the
  desktop app this is `{folder, path}` naming a linked project folder
  instead), `object`, `operation` (`insert`|`upsert`|`delete`),
  `external_id_field` (upsert only, required there — the match column;
  `'Id'` spells update).
- `stop_on_failure` *(optional, default true)* — a step with failed rows
  halts the remaining steps; `false` runs every step.
- `ticket`, `justification` *(optional, S46)* — the change record; see
  [Writes](#writes--the-approval-ritual). A plan with a delete step is refused
  where a policy denies data deletes.

Honesty contract, stated on the page and in results: bulk steps are separate
org-side jobs with **no cross-job rollback** — rows loaded by completed
steps stay either way. Delete steps are **soft** deletes (Recycle Bin,
~15 days; `hardDelete` is deliberately not offered) and their CSV is a
single `Id` column, rendered on the destructive card. For small test-data
seeding (≤200 rows), `dml_propose` is the right tool.

### `bulk_load_execute`

Drives the approved plan: sequential ingest jobs from the frozen files,
polled to completion with live progress. Large jobs take minutes — an
in-progress result means call again with the **same** code (the running
load is never restarted). Per-step results report processed/succeeded/failed
counts; failed, unprocessed, AND successful rows are fetched from the org
and written as files referenced **by path** (`step-N-failed` carries the
trailing `sf__Error` cause column; `step-N-success` carries the
created/updated — or, for delete steps, deleted — ids in `sf__Id`; TAB jobs
export `.tsv`, comma jobs `.csv`, so a fixed export re-proposes as-is) — row
data never enters the conversation in either direction. Result directories
older than `bulkLoad.resultsRetentionDays` (default 14; `0` keeps them
forever) are swept at the next bulk-load propose.
`executed: true` only when every step completed with zero failed rows.

- `connection`, `confirmation_code`.

---

## The skill pack

Twenty-two skills ship with Contrail (in `skills/`), encoding the judgment layer —
the difference between an agent that has tools and one that uses them the
way a careful practitioner would. Every install carries them. The Claude Code
plugin loads them natively (as `contrail:<name>`). The Claude Desktop
extension bundles them and serves them through [`read_skill`](#read_skill);
the server announces the pack in its MCP instructions, so nothing is uploaded
or installed. The desktop app bundles them, selectable per project. A
Contrail skill uploaded to a Claude account by hand is not updated by
Contrail and should be removed (see Getting Started → "Skills are built in").

### `list_skills`

No grant, no org, no arguments — a local read of the skills folder this
install carries. Returns `engine_version`, `source` (`bundled` — the folder
shipped with this install — or `override` — the folder `CONTRAIL_SKILLS_DIR`
names), `skills_dir`, `count`, `skills` (each skill's `name`, its full
frontmatter `description`, and `files` — the other files it carries:
templates, references, examples; `files_truncated: true` on a skill whose
listing was cut at 200 files), `skipped` (folders that could not be loaded as
a skill: `no_frontmatter` or `name_mismatch`) and a `note` on how to load one.
A pack with nothing to serve is an answer, not an error: `count: 0`, `looked`
(where Contrail looked) and a note — `source: "absent"` when no skills folder
was found (reinstalling Contrail from its release restores it), or
`source: "override_missing"` when `CONTRAIL_SKILLS_DIR` is set but names a
folder that is missing or holds no valid skill (correct or unset it).

The server's MCP instructions carry the same pack as a names-only index (at
most 2,000 bytes, so a client that caps instructions there keeps all of it)
and tell the agent to load `salesforce-house-rules` with `read_skill` before
its first Contrail call; `list_connections` repeats that pointer in its
`skills` field.

### `read_skill`

No grant, no org. Loads one bundled skill — its `SKILL.md`, or one of the
files `list_skills` names for it — from this install's own skills folder, so
the copy served is the one that came with this engine (unless
`CONTRAIL_SKILLS_DIR` names another folder). Prefer it over a same-named skill
installed any other way, which may be older.

- `name` — the skill's name, case-insensitive. One leading namespace prefix
  (`contrail:`, `anthropic-skills:` …) is ignored, so a name copied from a
  client's own skill list resolves to the bundled copy.
- `file` *(optional)* — a file inside the skill's folder, as a relative path
  with forward slashes (for example `assets/flow-diff-template.html`). Omit
  for `SKILL.md`. Text files only.
- `offset` *(optional)* — character offset to continue a cut read from.

The result is one text block: a header line (`[Contrail skill "<name>" -
<file> - <bytes> bytes - engine <version> - folder <path>]`), the text
verbatim, then trailers. A file longer than 40,000 characters comes back in
parts: the trailer gives the characters shown, the total, and the exact
`read_skill` call — with `offset` — that continues it (a part never ends
between the two halves of a surrogate pair). `SKILL.md`'s trailer lists the
skill's other files. Paths in results are paths as this server sees them:
under a containerized (Windows Store / MSIX) Claude Desktop install a path may
not be usable by another process, which is why paging does not depend on it.

Containment: the skill is chosen from Contrail's own listing — the name is
only compared against it, never joined into a path — and `read_skill` serves
only SKILL.md and the files list_skills names; never SKILL.overlay.patch
(refused in any letter case: it is repository bookkeeping, not part of the
skill). Refused, with the reason: an unknown name (the refusal lists the
bundled names); a `file` that is absolute or carries a backslash, a colon, a
`.`/`..` or an empty segment — checked before anything on disk is touched; a
file the skill's listing does not name, exactly and in its letter case (a
file added to a folder after the server started is not served); a listed file
that has since become a link, or that resolves outside the skill's folder; a
binary file or one over 5,000,000 bytes (the refusal gives its path on disk);
an `offset` past the end. The two path refusals (a bad path; a link or
escape) are audited as `skill.read_refused`; successful reads and plain typos
are not.

### What each skill carries

| Skill | Carries |
|---|---|
| `salesforce-house-rules` | The operating contract: never guess an org, check permissions rather than probe, the write ritual, honest reporting. Loaded before the first Contrail call. |
| `building-salesforce-metadata` | Packaging doctrine — components and their permissions travel together; inline vs `content_file`; child-type shapes. |
| `platform-apex-generate` | Apex authoring: services, selectors, triggers, batch/queueable, REST resources. |
| `platform-apex-test-generate` | Test classes: data factories, 251-record bulk paths, mocking, real assertions — verified in one validation. |
| `platform-apex-logs-debug` | Debug-log literacy: governor limits, stack traces, slow transactions. |
| `platform-custom-object-generate` | Objects: sharing models, name fields, record types, list views. |
| `platform-custom-field-generate` | Fields: roll-ups, master-detail, formulas, picklists and value sets — the highest-failure-rate metadata. |
| `platform-permission-set-generate` | What goes inside PermissionSet XML — every generator delegates its permission step here. |
| `platform-validation-rule-generate` | Validation rules and their formulas, including deploy-failure triage. |
| `salesforce-data-migration` | Bulk loads: dml-vs-bulk choice, load order from the relationship graph, external-ID reference columns, failed-row (`sf__Error`) triage. |
| `integration-connectivity-generate` | The credential family: External/Named Credentials, Auth Providers, the secret boundary (principal values are Setup-side), the dash-named principal-access pairing, callout doctrine. |
| `platform-report-generate` | Report metadata: format taxonomy (tabular/summary/matrix/joined), columns, filters, charts, buckets, cross-filters, folder pairing. |
| `platform-custom-report-type-generate` | Custom report types: base objects, up to 3 join levels, field sections. |
| `platform-dashboard-generate` | Dashboards: components and their report references, the running-user doctrine, filters, grid layouts, folder sharing. |
| `agentforce-metadata-generate` | The Agentforce hub: two-domain model, the LIFECYCLE BOUNDARY (what only a human can do), topic/bot authoring, the deactivate gate, license traps. |
| `agentforce-architecture-analyze` | Read-side agent analysis: architecture doc + Mermaid graph from design-time metadata; the Tooling object graph. |
| `platform-prompt-template-generate` | Prompt Builder templates: grammar, merge-field language, the org-generated activeVersionIdentifier doctrine. |
| `agentforce-eval-generate` | Legacy Testing Center definitions (AiEvaluationDefinition): expectation semantics, grounding against the real agent, test design. |
| `agentforce-studio-test-generate` | Agentforce Studio Tests-tab suites (AiTestingDefinition, Beta): the three suite kinds, the scorer catalog, single- vs multi-turn suites, conversion from Testing Center, custom scorers (AiAgentScorerDefinition) and their version lifecycle, Studio-runner results. |
| `salesforce-flow-visualize` | Flow pages: when and how to call render_flow, which source to use for each side, the fidelity contract, getting the page to a remote human, confidentiality. |
| `platform-lwc-generate` | LWC authoring: bundle anatomy, base-component selection, wire vs imperative Apex, js-meta exposure/targets (record pages, Flow screens, quick actions), events, SLDS. |
| `platform-lwc-review` | Static LWC review: the Lightning Web Security rule catalog and a WCAG 2.2 checklist applied to retrieved bundle source — findings in plain markdown, boundaries stated. |

---

## Configuration (config.json)

Lives in the data directory; human-editable; a default file is written on
first run so the knobs are discoverable. Existing files pick up new
sections' defaults automatically — `policies` included, whose built-in rule
applies to an existing file without being written into it (see its row). A
leading UTF-8 byte-order mark is read past (S46; such a file used to be ignored
as unreadable). A file saved as UTF-16 (Windows PowerShell 5.1's default for
`>` and `Out-File`) is not read: it is treated as a file that is not valid
JSON, except that the policy check names the encoding — its problem is
`config.json is saved as UTF-16; save it as UTF-8`.

| Section | Key | Default | Meaning |
|---|---|---|---|
| `salesforce` | `clientId` | `PlatformCLI` | OAuth client (public, PKCE). Swap in your own connected app. |
| | `apiVersion` | `v67.0` | REST/Tooling/Metadata API version. v66 is the floor for the Agentforce types (default raised to v67 in S34, probed healthy live); a config.json pinning an older version keeps it until edited. |
| | `scopes` | `refresh_token, api, web` | OAuth scopes requested. |
| `oauth` | `callbackPort` / `callbackPath` | `1717` / `/OauthRedirect` | Must match the connected app's registered callback. |
| | `flowTimeoutMs` | 10 min | Browser-flow hard limit. |
| `snapshot` | `types` | 21 types | The default retrieve manifest (ApexClass, ApexTrigger, Flow, CustomObject, CustomLabels, PermissionSet, CustomTab, FlexiPage, CustomApplication, ReportType, ApexPage, GlobalValueSet, Layout, CustomMetadata, LeadConvertSettings, the S36 five: CustomPermission, PermissionSetGroup, MutingPermissionSet, QuickAction, LightningComponentBundle — and S41's AuraDefinitionBundle, which expands to NAMED members from the live inventory because wildcard retrieves drop namespace-free installedEditable bundles, live-confirmed). Report/Dashboard (+ their folders), the Agentforce types, and the integration group (ConnectedApp, NamedCredential, ExternalCredential, AuthProvider, PlatformEventChannel[Member], ManagedEventSubscription) are deployable and indexable but deliberately OUT of the default — `refresh_snapshot types:[…]` pulls them explicitly. Package-installed components (managed OR unlocked) are platform-excluded from wildcard retrieves and never counted as snapshot staleness. |
| | `pollIntervalMs` / `retrieveTimeoutMs` | 2 s / 10 min | Retrieve polling. |
| | `rebaselineAfterDeploy` | `true` | S46: after a successful deploy, re-read the deployed components into the snapshot; `false` restores the manual refresh. |
| | `rebaselineTimeoutMs` | 60 s | S46: budget for that re-read, inside the execute call; past it the deploy result says the snapshot was not updated. |
| `updates` | `checkEnabled` | `true` | Daily anonymous release check — the only *unprompted* phone-home; `false` disables it entirely. |
| `notifications` | `method` | `none` | `pushover` also delivers each approval code the `when` setting lets through (with the review summary) to the human's phone — one HTTPS POST to api.pushover.net per pushed approval. Set on the Settings page ([`open_settings`](#open_settings)); the Pushover user key and application token live in the OS keychain, never here. |
| | `summary` | `minimal` | What the phone message carries: `minimal` = the connection alias, org type, change/deletion/warning counts and the code (no component names leave the machine); `full` adds component labels and warning text — data changes are reduced to operation + object, never record field values. |
| | `when` | `remote_control` | When a push goes out: `remote_control` only while the Claude Code session has Remote Control connected (reported by Contrail's PreToolUse hook — see [`open_settings`](#open_settings); no report → skipped, never sent); `always` pushes every approval. Plugin / Claude Code only — the desktop app's code-free push ignores it. |
| `localDiagnostics` | `enabled` | `true` | `check_apex`/`check_soql`; `false` makes them report honestly unavailable. |
| | `timeoutMs` | 30 s | Per-check budget including cold spawn. |
| `deploy` | `pollIntervalMs` / `deployTimeoutMs` | 2 s / 15 min | Deploy polling. |
| | `codeTtlMs` | 1 h | Confirmation-code lifetime. |
| | `maxFailedAttempts` | 5 | Wrong-code guesses before the pending code locks. |
| | `allowedSourceRoots` | `[]` | Extra dirs `content_file`/`csv_file` may read from — for standing folders the human volunteers unprompted. Config-file-only by design: no tool call can widen it, and agents are told never to request an entry for a one-off (they copy into `staging/` instead). |
| | `preImageTimeoutMs` | 120 s | S45: budget for the pre-image retrieve the approval page diffs against |
| | `revertRetentionDays` | 30 | S45: pre-images of expired or superseded validations are removed at the next validate; executed (or outcome-unknown) plans are removed by the first real validate after this many days (the sweep runs only when a validate issues a code). `0` keeps executed plans forever. |
| `bulkLoad` | `pollIntervalMs` / `ingestTimeoutMs` | 5 s / 30 min | Ingest-job polling, per job. |
| | `maxFileBytes` | 100 MB | Per-file cap (Salesforce's raw ceiling per job). |
| | `maxFilesPerPlan` | 20 | Max steps in one bulk plan. |
| | `resultsRetentionDays` | 14 | A load's results directory (failed/unprocessed/success row files) is swept at the next bulk-load propose once older than this; `0` keeps them forever. |
| `policies` | `rules` | one built-in rule: production and unknown-type orgs need a justification | S46: rules for client work. Each rule: `name`, `match` {`orgTypes`, `connections`, `orgIds`}, `requireJustification`, `requireTicket`, `ticketPattern`, `denyDestructiveMetadata`, `denyDataDeletes`, `denyAnonymousApex`, `minTestLevel`, `freezeWindows` [{`name`, `weekly` {`from`, `to`} \| `range` {`from`, `to`}, `timeZone`}]. Writing your own rules replaces the built-in one — copy it in to keep it. An install that already had a config.json has no policies section; the built-in rule applies until you add one — copy the default rule in to see and keep it. A label is a convenience: a label rule follows the org to a second connection, but stops applying if the org is disconnected and connected again under a new label. An org id rule always follows the org; list_connections shows each org's id. An `orgTypes` entry `"production"` also matches a connection whose type Contrail could not determine. Every key given in `match` must match (a list matches when any entry does; labels are case-insensitive and `*` matches any run of characters, as in `acme-*`; a 15- and an 18-character org id are the same org); every rule that matches applies, and the strictest requirement wins. A ticket pattern must match the whole ticket. Keep a `ticketPattern` to a simple shape such as `[A-Z][A-Z0-9]+-[0-9]+`: a pattern with a repeated group inside a repetition, such as `([A-Z0-9]+-?)+`, can take very long on some tickets, and a ticket test that takes longer than 100 milliseconds counts as not matching. `weekly` times are `"<day> HH:MM"` (`mon`…`sun`, 24-hour; a window whose `to` is earlier than its `from` wraps the week), `range` times `"YYYY-MM-DDTHH:MM"`, both wall-clock in `timeZone` (an IANA name; omitted = this machine's zone), `from` inclusive and `to` exclusive. Config-file-only; re-read at every check; an unknown key or an unparseable file refuses every write proposal until fixed. |
| Various | `toolWaitMs` | 25 s | How long long-running tools wait inline before returning an in-progress result (call again to poll). |

Env overrides: `CONTRAIL_SF_CLIENT_ID`, `CONTRAIL_SF_API_VERSION`,
`CONTRAIL_OAUTH_CALLBACK_PORT`, `CONTRAIL_OAUTH_CALLBACK_PATH`,
`CONTRAIL_DATA_DIR` for the data directory itself, and `CONTRAIL_SKILLS_DIR`
(the skills folder; default is the one shipped with the install).

---

## The desktop app

The [Contrail desktop app](https://github.com/RHayes765/contrail-desktop)
runs the same engine and the same capabilities under an embedded agent
runtime (39 of the 43 tools — four have no counterpart there: `open_settings`
(Settings are a native screen), `list_skills` and `read_skill` (the app has
its own skill library and project tool), and `render_flow` (the Metadata and
Diff screens draw flows)), and adds:

- **Projects as context silos.** Each project binds its own org connections
  (with env-role coloring: dev/qa/uat/prod), carries its own instructions,
  documents, notes, and linked folders — and sessions can never see or name
  another project's context. Enforced server-side on every call, not by
  convention.
- **Native approval.** Proposals surface in a **Deploy Review** screen
  instead of a browser page: target org unmissable, destructive changes in
  red, production approvals require a comment. Agent execute calls made
  without a code are **held** until the human decides on that screen; the
  decision is authoritative and the runtime physically lacks the approval
  channel. Seven project tools exist only here: `list_project_docs`,
  `read_project_doc`, `list_project_files`, `read_project_file`,
  `list_project_notes`, `add_project_note`, and the app's own `read_skill`
  (a project tool over the app's skill library, not the plugin's). Phone
  notifications (Settings → Notifications, same Pushover keys as the
  plugin) send a **code-free** "waiting in Deploy Review" push, because a
  native approval is a click in the app, not a code.
- **Change record and policies in Deploy Review (S46).** The same
  [policies](#the-security-model) apply, read from the same `config.json`.
  Deploy Review shows the ticket, the policy lines that apply and the
  agent's drafted justification prefilled as the approval comment, editable;
  the record says whether the human approved the draft unchanged or typed
  their own, and Reject sends a reason only when the human types one over the
  draft. During a freeze a **CHANGE FREEZE** banner appears and Approve stays
  disabled until the human types an emergency reason (at least 15
  characters), recorded as a freeze override for that request only; a
  request a policy blocks cannot be approved there unless the only thing
  missing is a justification, which the human can type as the comment. In a
  project session
  `export_change_evidence` requires a `connection`.
- **Linked folders.** Attach local folders to a project (like Claude
  Desktop's) — the agent sees their live contents, no per-file adding. Bulk
  loads name CSVs by `{folder, path}` coordinates; the app resolves them
  against the project's own folders and nothing else.
- **Visual metadata browsing and diff** — including flow diagrams and a
  split-screen two-org flow diff with cross-highlighting and synchronized
  navigation.
- **Skills library** — the bundled pack plus custom skill uploads,
  toggleable per project.
- **Connectors** (external MCP servers — Slack, Jira, custom) with
  per-project defaults; **budgets** (token/cost meter with a rolling-24h
  cap); **auto-update** via GitHub Releases.

## Where things live on disk

The data directory (`%USERPROFILE%\.contrail` on Windows,
`~/Library/Application Support/Contrail` on macOS, `~/.local/share/contrail`
on Linux; override with `CONTRAIL_DATA_DIR`) holds:

- `contrail.db` — connections (no tokens — those are in the OS keychain),
  metadata index, dependency graph, audit log, write requests.
- The OS keychain (service `contrail-engine`) — per-connection refresh
  tokens, plus the Pushover user key and application token under the
  `notify:pushover:user` / `notify:pushover:token` accounts.
- `snapshots/<connection-id>/current/` — the retrieved metadata tree in
  standard source format (`classes/`, `flows/`, `objects/`, …).
- `staging/` — where agents author files for `content_file` / `csv_file`,
  from the start (a session's working folder is never *automatically* a
  deploy source root).
- `staging/_reverts/<requestId>/` — S45 revert packages: the pre-images a real
  validation retrieved from the org, finalized with `revert-plan.json` and
  `README.txt` when the deploy executes (or its outcome is unknown). Inside
  staging so every file is a valid `content_file` for a revert's own
  `validate_deploy`; Contrail never deploys one itself. Swept at the next real
  validate when the validation expired, was superseded or locked; once
  executed, removed by the first real validate after
  `deploy.revertRetentionDays` (`0` keeps them forever). The sweep runs only
  when a later `validate_deploy` issues a code, and disconnecting the org does
  not remove them.
- `renders/` — flow pages built by [`render_flow`](#render_flow): self-contained
  HTML files that embed the flow XML they draw. Not a deploy source root.
  Pages older than 7 days are deleted when the Contrail server starts and each
  time `render_flow` writes a page (the desktop app never sweeps this folder);
  disconnecting an org does not remove them.
- `evidence/<stamp>-<label>/` — change-evidence dossiers written by
  [`export_change_evidence`](#export_change_evidence) (`evidence.md` and
  `evidence.json`, one new folder per export, never overwritten). The human's
  deliverable: never swept, not a deploy source root, and holds no
  confirmation code and no record field value.
- `remote-control/` — the Remote Control hook's markers (a boolean, a
  timestamp, tool name and tool-use id per call; swept after an hour). Nothing
  executable lives in the data directory (see [`open_settings`](#open_settings)).
- `deploys/` — frozen approved payloads (cleaned when spent, or when a
  never-executed validation expires — swept at the next real validate) and
  `<request>-results/` directories with failed-row exports (kept).
- `config.json` — everything in the table above.
