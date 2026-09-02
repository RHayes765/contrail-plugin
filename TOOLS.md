# Contrail Reference — tools, features, configuration

Everything Contrail can do, in one place. Current as of **v0.19.1** (34 tools).
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
| [`list_connections`](#list_connections) | — | List connected orgs + grants (+ update notice when behind) |
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
| [`soql_query`](#soql_query) | data_read | Read-only SOQL, row-capped, truncation-honest |
| [`get_record`](#get_record) | data_read | One record by id |
| [`explain_access`](#explain_access) | data_read | Why a user can/can't see an object or field (CRUD + FLS) |
| [`get_debug_logs`](#get_debug_logs) | diagnostics_read | List or read Apex debug logs |
| [`run_apex_tests`](#run_apex_tests) | diagnostics_read | Run deployed Apex tests standalone (submit + poll) |
| [`get_flow_errors`](#get_flow_errors) | diagnostics_read | Persisted flow interview problems |
| [`set_trace_flag`](#set_trace_flag) | diagnostics_read | Turn on debug logging for a bounded window |
| [`check_apex`](#check_apex) | — | Free local static Apex check (offline, pre-deploy) |
| [`check_soql`](#check_soql) | — | Free local SOQL syntax check (offline) |
| [`validate_deploy`](#validate_deploy) | metadata_write | Build + checkOnly-validate a package; code goes to the human |
| [`execute_deploy`](#execute_deploy) | metadata_write | Execute a validated deploy with the human's code |
| [`deactivate_flow`](#deactivate_flow) | metadata_write | Turn off a flow, through the same ritual |
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
| `metadata_write` | Validate and execute metadata deploys. Requires `metadata_read`. |
| `diagnostics_read` | Debug logs, flow errors, standalone Apex test runs, trace flags. May expose incidental record data present in logs. |
| `data_read` | SOQL queries and record reads (row-capped). |
| `data_write` | DML, anonymous Apex, and bulk loads — propose and execute. Requires `data_read`. |

**Layer 2 — the write approval ritual.** Every write, in every environment
(sandboxes included), is two-step:

1. A `*_propose` / `validate_deploy` call computes the full consequence
   summary and opens an **approval page in the human's browser**: target org
   unmissable, every change listed (destructive changes first, in red), and a
   short **confirmation code**.
2. The code appears **only on that page** — never in any tool result — so the
   only way a write executes is the human reading the code back into chat.
   Close the tab and nothing happens.

Codes are single-use, expire in ~1 hour, are invalidated by any newer
proposal **of the same kind** (deploy, DML, Apex, or bulk) on the same
connection, and lock after repeated wrong guesses (brute-force guard). Every decision — proposals, executions, refusals — lands
in the local audit log.

Refresh tokens live in the OS keychain only. The daily release check
(`updates.checkEnabled`) is the product's only phone-home, and it can be
turned off.

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

### `list_connections`

Every connected org with alias, org identity, type, and grants. When a newer
Contrail release exists (from the cached daily check — never a network call
at tool time), the result carries an update notice with the download link.

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
dependency graph. Long-running on big orgs — an in-progress result means
call again to check on it. `check_only: true` reports staleness without
retrieving anything.

- `connection` — alias (or id).
- `types` *(optional)* — types to refresh (default: the configured manifest —
  see [`snapshot.types`](#configuration-configjson)).
- `check_only` *(optional)* — compare timestamps only.

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
tools always agree.

- `connection` — alias (or id).
- `query` — the SELECT statement.
- `limit` *(optional)* — 1–2000, default 500.

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

### `get_flow_errors`

Recent persisted flow interviews (paused/errored) with their stuck element.
Honest limitation, stated in the tool: Salesforce does not persist most
failed interviews queryably — the full story lives in flow error emails and
debug logs (`get_debug_logs` around the failure time).

- `connection`; `limit` *(optional, 1–100, default 20)*.

### `set_trace_flag`

Turns on debug logging for the connected user for a bounded window so Apex
runs, test runs, and flows produce logs readable via `get_debug_logs`. Side
effects, honestly: writes a self-expiring TraceFlag row and (first use) a
reusable `Contrail_Debug` DebugLevel; generated logs consume the org's
shared log allocation. An existing flag gets its expiry extended — its own
(possibly human-configured) debug level is preserved, and flags never stack.

- `connection`; `minutes` *(optional, 1–60, default 30)*.

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
code never appears in any tool result.

### `validate_deploy`

Builds a deploy package and validates it against the org with
`checkOnly=true` — nothing is committed. Returns the change summary
(destructive changes flagged), validation/test results, permission warnings
for components deploying without access, and blast radius from the
dependency graph; puts the confirmation code on the approval page. A failed
validation issues **no** code.

- `connection` — target, named unmissably to the human.
- `components` *(≤50)* — each `{type, api_name, content | content_file}`.
  Types include `ApexClass`, `ApexTrigger`, `ApexPage`, `Flow`,
  `CustomObject`, `PermissionSet`, `CustomTab`, `FlexiPage`,
  `CustomApplication`, `ReportType`, `GlobalValueSet`, `ConnectedApp`,
  `NamedCredential`, `ExternalCredential`, `PlatformEventChannel(Member)`,
  `ManagedEventSubscription`, `Layout`, `CustomMetadata` (records, dotted
  `Type.Record` names), and child types `CustomField` / `ValidationRule` /
  `CustomLabel` / `ListView` / `RecordType` (dotted API names).
- `destructive` *(≤50)* — `{type, api_name}` to DELETE; led prominently on
  the page. Deletions are accepted for **any** metadata type, including
  types Contrail cannot author — cleanup is a feature; the guard is the
  human approval, not a type gate.
- `test_level` *(optional)* — `NoTestRun` (default) | `RunLocalTests` |
  `RunSpecifiedTests` | `RunAllTestsInOrg`; `run_tests` for
  `RunSpecifiedTests`.

`content_file` reads a file byte-exactly (mandatory habit for large flows —
retyping tens of KB of XML risks silent corruption), confined to Contrail's
staging directory, its snapshots, or `deploy.allowedSourceRoots` from
config. The file is read at validation and **frozen** into the approved
package — editing it afterwards changes nothing.

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
conversation**: you prepare UTF-8, comma-delimited CSVs (API-name headers;
cross-object references as relationship-by-external-ID columns like
`Account.External_Id__c`, resolved org-side — no id-mapping pipelines), and
name one file per step. Steps execute sequentially in the order given —
parents before children. Every file is scanned (headers, quote-aware row
counts; malformed files are refused here with a position instead of failing
mysteriously org-side) and **frozen** at propose with a SHA-256 the page
shows and execute re-verifies. One approval page carries the whole plan.

- `connection` — target, named unmissably.
- `steps` — ordered, one CSV each (cap: `bulkLoad.maxFilesPerPlan`,
  default 20; per-file cap `bulkLoad.maxFileBytes`, default 100 MB). Each:
  `csv_file` (absolute path, same containment as `content_file`; in the
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

Drives the approved plan: sequential ingest jobs from the frozen CSVs,
polled to completion with live progress. Large jobs take minutes — an
in-progress result means call again with the **same** code (the running
load is never restarted). Per-step results report processed/succeeded/failed
counts; failed and unprocessed rows are fetched from the org and written as
CSV files referenced **by path** (the trailing `sf__Error` column names each
cause) — row data never enters the conversation in either direction.
`executed: true` only when every step completed with zero failed rows.

- `connection`, `confirmation_code`.

---

## The skill pack

Ten skills ship with Contrail (in `skills/`), encoding the judgment layer —
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

---

## Configuration (config.json)

Lives in the data directory; human-editable; a default file is written on
first run so the knobs are discoverable. Existing files pick up new
sections' defaults automatically.

| Section | Key | Default | Meaning |
|---|---|---|---|
| `salesforce` | `clientId` | `PlatformCLI` | OAuth client (public, PKCE). Swap in your own connected app. |
| | `apiVersion` | `v63.0` | REST/Tooling/Metadata API version. |
| | `scopes` | `refresh_token, api, web` | OAuth scopes requested. |
| `oauth` | `callbackPort` / `callbackPath` | `1717` / `/OauthRedirect` | Must match the connected app's registered callback. |
| | `flowTimeoutMs` | 10 min | Browser-flow hard limit. |
| `snapshot` | `types` | 14 types | The default retrieve manifest (ApexClass, ApexTrigger, Flow, CustomObject, CustomLabels, PermissionSet, CustomTab, FlexiPage, CustomApplication, ReportType, ApexPage, GlobalValueSet, Layout, CustomMetadata). |
| | `pollIntervalMs` / `retrieveTimeoutMs` | 2 s / 10 min | Retrieve polling. |
| `updates` | `checkEnabled` | `true` | Daily anonymous release check — the only phone-home; `false` disables it entirely. |
| `localDiagnostics` | `enabled` | `true` | `check_apex`/`check_soql`; `false` makes them report honestly unavailable. |
| | `timeoutMs` | 30 s | Per-check budget including cold spawn. |
| `deploy` | `pollIntervalMs` / `deployTimeoutMs` | 2 s / 15 min | Deploy polling. |
| | `codeTtlMs` | 1 h | Confirmation-code lifetime. |
| | `maxFailedAttempts` | 5 | Wrong-code guesses before the pending code locks. |
| | `allowedSourceRoots` | `[]` | Extra dirs `content_file`/`csv_file` may read from. Config-file-only by design — no tool call can widen it. |
| `bulkLoad` | `pollIntervalMs` / `ingestTimeoutMs` | 5 s / 30 min | Ingest-job polling, per job. |
| | `maxFileBytes` | 100 MB | Per-CSV cap (Salesforce's raw ceiling per job). |
| | `maxFilesPerPlan` | 20 | Max steps in one bulk plan. |
| Various | `toolWaitMs` | 25 s | How long long-running tools wait inline before returning an in-progress result (call again to poll). |

Env overrides: `CONTRAIL_SF_CLIENT_ID`, `CONTRAIL_SF_API_VERSION`,
`CONTRAIL_OAUTH_CALLBACK_PORT`, `CONTRAIL_OAUTH_CALLBACK_PATH`, and
`CONTRAIL_DATA_DIR` for the data directory itself.

---

## The desktop app

The [Contrail desktop app](https://github.com/RHayes765/contrail-desktop)
runs the same engine and the same 34 capabilities under an embedded agent
runtime, and adds:

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
  `list_project_notes`, `add_project_note`, `read_skill`.
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
- `snapshots/<connection-id>/current/` — the retrieved metadata tree in
  standard source format (`classes/`, `flows/`, `objects/`, …).
- `staging/` — where agents write files for `content_file` / `csv_file`.
- `deploys/` — frozen approved payloads (cleaned when spent) and
  `<request>-results/` directories with failed-row exports (kept).
- `config.json` — everything in the table above.
