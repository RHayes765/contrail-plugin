# Contrail Reference — tools, features, configuration

Everything Contrail can do, in one place. Current as of **v0.38.2** (39 tools).
The same tool surface is available in all three installs — the Claude Desktop
extension (`.mcpb`), the Claude Code plugin, and the Contrail desktop app —
with a few desktop-app differences [noted at the end](#the-desktop-app).

**Contents:** [Security model](#the-security-model) ·
[Connections](#connections--lifecycle) · [Metadata](#metadata-read--search) ·
[Drift & audit](#org-drift--setup-audit) · [Diff](#cross-org-diff) ·
[Data](#data-reads) · [Diagnostics](#diagnostics) ·
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
| [`list_connections`](#list_connections) | — | List connected orgs + grants (+ update notice when behind, + phone-notification status) |
| [`get_permissions`](#get_permissions) | — | The full grants matrix, including what is NOT granted |
| [`get_audit_log`](#get_audit_log) | — | Local audit log: connections, refusals, every write decision |
| [`list_metadata`](#list_metadata) | metadata_read | Inventory from the snapshot index, or live from the org |
| [`retrieve_metadata`](#retrieve_metadata) | metadata_read | Artifact source (flows, Apex, objects…) + one-hop dependencies |
| [`describe_schema`](#describe_schema) | metadata_read | Live object/field describe for one SObject |
| [`search_metadata`](#search_metadata) | metadata_read | Name + full-text search over the snapshot |
| [`get_dependencies`](#get_dependencies) | metadata_read | Dependency graph: what uses this, what breaks if it changes |
| [`refresh_snapshot`](#refresh_snapshot) | metadata_read | Re-retrieve the org into the local snapshot/index/graph |
| [`get_org_changes`](#get_org_changes) | metadata_read | Drift report: live org vs your snapshot, grouped by who |
| [`get_setup_audit`](#get_setup_audit) | metadata_read | SetupAuditTrail — config changes that never surface as metadata |
| [`diff_orgs`](#diff_orgs) | metadata_read (both) | Whole-org snapshot diff, bucketed by type |
| [`diff_artifact`](#diff_artifact) | metadata_read (both) | Semantic diff of one artifact across two orgs |
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
2. The code appears **only on that page** — never in any tool result — so the
   only way a write executes is the human reading the code back into chat.
   Close the tab and nothing happens. If the human has set up **phone
   notifications** ([`open_settings`](#open_settings)), the engine also pushes
   the review summary and the code to their phone at the moment it mints
   them — so they can approve from anywhere — but the code still counts only
   when the human types it into chat, and the agent still never sees it. By
   default the push goes out **only while the Claude Code session has Remote
   Control connected** (the one situation in which a code on a phone can be
   typed from the phone); see [`open_settings`](#open_settings) for how
   Contrail learns that, and `notifications.when` to push every approval
   instead.

Codes are single-use, expire in ~1 hour, are invalidated by any newer
proposal **of the same kind** (deploy, DML, Apex, or bulk) on the same
connection, and lock after repeated wrong guesses (brute-force guard). Every decision — proposals, executions, refusals — lands
in the local audit log.

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
Claude is instructed to confirm with the human first.

- `connection` — alias (or id) to remove.

### `manage_connection`

Opens the localhost page where the human changes a connection's grants. The
page opens directly in the browser; its session-bearing URL is returned only
if the browser could not be opened (and is then for the human to open, never
for the agent to fetch).

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
bundled). When a newer Contrail
release exists (from the cached daily check — never a network call at tool
time), the result carries an update notice with the download link.

### `get_permissions`

The full permission matrix for one or all connections, including what is
**not** granted — so capabilities are never discovered by trial and error.

- `connection` *(optional)* — omit for all connections.

### `get_audit_log`

The local audit log: connection lifecycle, OAuth flows, grant refusals, and
every deploy/DML/apex/bulk decision. Local and exportable — useful as a
client-facing change record.

- `connection` *(optional)* — filter to one connection.
- `since` *(optional)* — ISO 8601 timestamp.
- `limit` *(optional)* — 1–1000, default 100.

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

- `connection` — alias (or id).
- `types` *(optional)* — types to refresh (default: the configured manifest —
  see [`snapshot.types`](#configuration-configjson)).
- `check_only` *(optional)* — compare timestamps only.
- `job_id` *(optional, alone)* — poll a running refresh without re-sending
  types.

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
snapshot; stale timestamps are called out.

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
either runner and skips the lookup. Every result carries `runner` and
`runner_detection`, and the submit echoes the canonical `definition` name.
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
human reads the code off the approval page → execute with that code. The
code never appears in any tool result. Every propose/validate result carries
`approval_page.phone_notification` — `sent`, `failed` (with a reason
category and what to do), `skipped` (`remote_control_off`, the quiet
desk case; or `remote_control_unknown`, no hook report for this call), or
`off` — so the agent knows whether the human also has the code on their
phone, without ever learning the code.

### `validate_deploy`

Builds a deploy package and validates it against the org with
`checkOnly=true` — nothing is committed. Returns the change summary
(destructive changes flagged), validation/test results, permission warnings
for components deploying without access, and blast radius from the
dependency graph; puts the confirmation code on the approval page. A failed
validation issues **no** code. With `dry_run: true` a PASSED validation
issues no code either: same full results, but no approval request, page, or
payload is created, nothing becomes executable through Contrail, and a
pending approval on
the connection is left untouched (a normal validate supersedes it) — the
mid-build check that stops half-finished work from piling up approval
pages that were never meant to be used.

Every outcome carries a `job_id` keyed to the validation's exact input
(components, options, dry/real), so parallel validations — two dry runs,
a dry run beside a real validate, two sessions — never read each other's
results (S41); an in-progress validation is polled with
`{connection, job_id}` alone, nothing re-sent and no `content_file`
re-read.

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
  agent doesn't specify one.
- `job_id` *(optional, alone)* — poll a running validation without
  re-sending components.

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

- `connection`, `confirmation_code`.

### `deactivate_flow`

Turns off a flow's active version through the same ritual (a native
`FlowDefinition` deploy; execution via `execute_deploy`). Also the required
first step before attempting flow deletion — which the Metadata API handles
unreliably even then, and the tools say so rather than pretending.

- `connection`, `flow` (DeveloperName).

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

### `dml_execute`

Executes the proposed change with the human's code. Returns per-row/per-step
outcomes and created ids.

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

### `agent_activation_execute`

One documented Connect REST call
(`POST /connect/bot-versions/{id}/activation`), then a re-read: the result
reports the org's **confirmed** status, never the requested one, with the
platform's `messages[]` verbatim when it refuses (e.g. an unpublished
version). Single-use code, ~1h expiry, superseded by a new propose.

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
way a careful practitioner would. In Claude Code they load automatically
with the plugin; in Claude Desktop they are added once via the Skills UI; in
the desktop app they are bundled and selectable per project.

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
| `salesforce-flow-visualize` | Interactive flow artifacts: a single version or a two-version diff — layered Flow-Builder-style canvas, go-to pills, parsed node inspector — built from a bundled, live-verified HTML template. |
| `platform-lwc-generate` | LWC authoring: bundle anatomy, base-component selection, wire vs imperative Apex, js-meta exposure/targets (record pages, Flow screens, quick actions), events, SLDS. |
| `platform-lwc-review` | Static LWC review: the Lightning Web Security rule catalog and a WCAG 2.2 checklist applied to retrieved bundle source — findings in plain markdown, boundaries stated. |

---

## Configuration (config.json)

Lives in the data directory; human-editable; a default file is written on
first run so the knobs are discoverable. Existing files pick up new
sections' defaults automatically.

| Section | Key | Default | Meaning |
|---|---|---|---|
| `salesforce` | `clientId` | `PlatformCLI` | OAuth client (public, PKCE). Swap in your own connected app. |
| | `apiVersion` | `v67.0` | REST/Tooling/Metadata API version. v66 is the floor for the Agentforce types (default raised to v67 in S34, probed healthy live); a config.json pinning an older version keeps it until edited. |
| | `scopes` | `refresh_token, api, web` | OAuth scopes requested. |
| `oauth` | `callbackPort` / `callbackPath` | `1717` / `/OauthRedirect` | Must match the connected app's registered callback. |
| | `flowTimeoutMs` | 10 min | Browser-flow hard limit. |
| `snapshot` | `types` | 21 types | The default retrieve manifest (ApexClass, ApexTrigger, Flow, CustomObject, CustomLabels, PermissionSet, CustomTab, FlexiPage, CustomApplication, ReportType, ApexPage, GlobalValueSet, Layout, CustomMetadata, LeadConvertSettings, the S36 five: CustomPermission, PermissionSetGroup, MutingPermissionSet, QuickAction, LightningComponentBundle — and S41's AuraDefinitionBundle, which expands to NAMED members from the live inventory because wildcard retrieves drop namespace-free installedEditable bundles, live-confirmed). Report/Dashboard (+ their folders), the Agentforce types, and the integration group (ConnectedApp, NamedCredential, ExternalCredential, AuthProvider, PlatformEventChannel[Member], ManagedEventSubscription) are deployable and indexable but deliberately OUT of the default — `refresh_snapshot types:[…]` pulls them explicitly. Package-installed components (managed OR unlocked) are platform-excluded from wildcard retrieves and never counted as snapshot staleness. |
| | `pollIntervalMs` / `retrieveTimeoutMs` | 2 s / 10 min | Retrieve polling. |
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
| `bulkLoad` | `pollIntervalMs` / `ingestTimeoutMs` | 5 s / 30 min | Ingest-job polling, per job. |
| | `maxFileBytes` | 100 MB | Per-file cap (Salesforce's raw ceiling per job). |
| | `maxFilesPerPlan` | 20 | Max steps in one bulk plan. |
| | `resultsRetentionDays` | 14 | A load's results directory (failed/unprocessed/success row files) is swept at the next bulk-load propose once older than this; `0` keeps them forever. |
| Various | `toolWaitMs` | 25 s | How long long-running tools wait inline before returning an in-progress result (call again to poll). |

Env overrides: `CONTRAIL_SF_CLIENT_ID`, `CONTRAIL_SF_API_VERSION`,
`CONTRAIL_OAUTH_CALLBACK_PORT`, `CONTRAIL_OAUTH_CALLBACK_PATH`, and
`CONTRAIL_DATA_DIR` for the data directory itself.

---

## The desktop app

The [Contrail desktop app](https://github.com/RHayes765/contrail-desktop)
runs the same engine and the same capabilities under an embedded agent
runtime (38 of the 39 tools — `open_settings` has no counterpart because
Settings are a native screen there), and adds:

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
  `list_project_notes`, `add_project_note`, `read_skill`. Phone
  notifications (Settings → Notifications, same Pushover keys as the
  plugin) send a **code-free** "waiting in Deploy Review" push, because a
  native approval is a click in the app, not a code.
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
- `remote-control/` — the Remote Control hook's markers (a boolean, a
  timestamp, tool name and tool-use id per call; swept after an hour). Nothing
  executable lives in the data directory (see [`open_settings`](#open_settings)).
- `deploys/` — frozen approved payloads (cleaned when spent) and
  `<request>-results/` directories with failed-row exports (kept).
- `config.json` — everything in the table above.
