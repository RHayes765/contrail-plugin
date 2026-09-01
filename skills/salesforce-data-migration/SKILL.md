---
name: salesforce-data-migration
description: "Use this skill when users need to load, migrate, or mass-modify Salesforce DATA from files through Contrail — customer data loads, multi-object migrations (accounts → contacts → opportunities → line items), CSV imports, bulk upserts, bulk deletes/cleanups, or re-running failed rows from a previous load. Trigger on mentions of data loading, Data Loader, Bulk API, CSV files of records, external IDs, or 'load these files into the org'. DO NOT TRIGGER for small test-data seeding (a handful of records — dml_propose handles ≤200 rows directly), for metadata deployment (fields, objects, flows — that is validate_deploy territory), or for one-off record edits."
metadata:
  domains: ["Platform", "Data"]
  relatedSkills:
    - "salesforce-house-rules"
    - "platform-custom-field-generate"
---

# Salesforce data migration through Contrail

Moves real data volumes file → org with the Bulk API 2.0, with you doing the
smart part — load order, reference strategy, file preparation, error triage —
and the org doing the heavy lifting. **Rows never pass through this
conversation**: you name CSV files, Contrail freezes and ships them, and
results come back as counts and file paths. Never paste row data into chat to
"check it", and never read a data CSV into context when its path is all the
tools need.

The write ritual is governed by **salesforce-house-rules §3** — one approval
page, a confirmation code only the human can see, no exceptions. This skill
never restates or works around it.

---

## 1. Pick the right tool for the volume

| Situation | Tool |
|---|---|
| Seed a few linked test records (≤ 25 steps, one record each) | `dml_propose` with a plan |
| One flat change, ≤ 200 rows, values known in chat | `dml_propose` flat |
| Anything from files, anything larger, any multi-object migration | `bulk_load_propose` |
| Deleting thousands of rows (cleanup, rollback of a bad load) | `bulk_load_propose` with delete steps |

The DML tools are test-seeding scale and their rows transit the conversation.
The bulk tools are migration scale and their rows never do. Do not chunk a
10,000-row load into fifty dml_propose calls — that is fifty approvals of the
wrong shape.

## 2. Derive the load order before touching a file

1. `describe_schema` every object in the migration.
2. Walk the relationship fields: lookups and master-details point at parents.
3. **Parents load before children** — accounts before contacts, contacts and
   opportunities before junction records.
4. Delete plans run the same graph BACKWARDS: children first, parents last
   (a parent with live children may be blocked by master-detail or trip
   cascade behaviour you did not plan).
5. Self-referencing hierarchies (Account.ParentId) need two passes: load all
   rows without the parent reference, then upsert the parent link — or load in
   topological generations if the hierarchy is shallow and known.

The step order you give `bulk_load_propose` IS the execution order. Plan it so
that partial completion is safe: bulk steps are separate org-side jobs with
**no cross-job rollback** — if step 3 fails, steps 1–2 are in the org and stay.

## 3. Reference strategy: external IDs, resolved org-side

Never build id-mapping pipelines (load parents → export their new ids → paste
ids into child files). Salesforce resolves cross-object references natively:

- Give every migrated object an **external ID field** (unique, "External ID"
  checked) carrying the source system's key. If one is missing, create it
  first through the metadata ritual (`platform-custom-field-generate`).
- Parent files **upsert on the external ID** (`external_id_field` on the
  step) — re-running a corrected file is then idempotent, not a duplicator.
- Child files reference parents with a **relationship column header**, not an
  ID column:
  - Standard lookup: `Account.External_Id__c` (relationship name dot external
    id field).
  - Custom lookup: `My_Lookup__r.External_Id__c` (`__c` → `__r` in the
    relationship half).
  - Polymorphic lookups (e.g. Task.WhoId) cannot resolve by external ID —
    those need real IDs; keep such objects for a late step and query the IDs
    by external ID with `soql_query` if unavoidable.
- The org resolves every reference during the job. A reference that does not
  match exactly one parent fails THAT ROW (it lands in the failed-rows file
  with the reason) — the rest of the file still loads.

`external_id_field: 'Id'` is how you spell a bulk UPDATE (match on record id).

## 4. Prepare the files

- **UTF-8, comma-delimited, one header row of API names** (`Name`,
  `External_Id__c` — never labels). Uniform line endings (all LF or all CRLF —
  Contrail detects and declares them to the org; a mixed file is refused).
- Quote fields containing commas, quotes, or newlines with `"…"`; double
  embedded quotes (`"He said ""hi"""`).
- Per operation:
  - **insert**: no Id column; required fields present.
  - **upsert**: the `external_id_field` column must be in the file.
  - **delete**: exactly ONE column, `Id`, of record ids — nothing else.
- Dates `YYYY-MM-DD`, datetimes ISO 8601 UTC; checkboxes `true`/`false`;
  clear a field on upsert with the literal `#N/A`.
- Booleans, picklist API names (not labels), record type DEVELOPER names via a
  `RecordType.DeveloperName` column if needed.
- Where the files live: in Claude Code, write them under Contrail's `staging/`
  directory (under the data dir — any containment error names the exact path)
  and pass absolute paths as `csv_file`. Files are read and FROZEN at propose:
  editing one afterwards changes nothing, and execute re-verifies the frozen
  hashes.

## 5. Pre-flight before proposing

- Reconcile EVERY header against `describe_schema`: field exists, writable,
  correct type. A wrong column name fails the whole job org-side
  (`InvalidBatch: Field name not found`) — catch it here for free.
- Confirm the external ID fields really are flagged External ID (the describe
  shows it) — upsert on a non-external-id field is refused by the org.
- For delete plans: verify the row count you are about to delete with
  `soql_query` (`SELECT COUNT() …`) and say the number out loud to the human
  before proposing.
- Automation runs: bulk loads fire triggers, flows, and validation rules
  normally. Warn the human when a loaded object carries heavy automation —
  that is where most mysterious row failures and slow jobs come from. Never
  suggest disabling automation casually; if it is genuinely required, that is
  its own metadata change through the ritual, with the re-enable planned
  before the first row loads.

## 6. Propose, then execute — the mechanics

- One `bulk_load_propose` call carries the WHOLE migration: ordered steps,
  each `{csv_file, object, operation, external_id_field?}`. The approval page
  shows every step with row counts, columns, and frozen file hashes; delete
  steps lead on the destructive card. Present your own summary first —
  target org unmissable, per-step counts, and the failure mode:
  `stop_on_failure: true` (default) halts remaining steps when one has failed
  rows; `false` runs everything. Say plainly that completed steps are never
  rolled back either way, and that bulk deletes are SOFT (Recycle Bin,
  ~15 days).
- After the human reads the code back: `bulk_load_execute`. Large jobs take
  minutes — an in-progress result means call it again with the SAME code; the
  running load is never restarted by a repeat call.
- A new `bulk_load_propose` on the same connection supersedes the pending one
  (house rules: never leave a stale code alive when the plan changes).

## 7. Triage failed rows

The result reports per-step `processed / succeeded / failed` and writes two
kinds of CSV files (referenced by PATH — do not read them into context unless
they are small and the human asks):

- `step-N-failed.csv` — rows the org attempted and rejected. The trailing
  **`sf__Error`** column names each cause; the leading `sf__Id` is set when a
  record was created before a later error.
- `step-N-unprocessed.csv` — rows never attempted (job died early, or the
  step was halted).

The loop: read the ERROR COLUMN (a `soql_query`-free glance at the file's
first lines is enough to classify), fix the underlying cause — a bad
reference, a validation rule, a missing required field — rebuild a CSV
containing **only those rows**, and propose a follow-up load of just that
file. Because parents upsert on external IDs, re-runs are idempotent; never
re-propose an already-loaded file "to be safe" on insert steps — that
duplicates.

Common `sf__Error` causes: `MALFORMED_ID`/`INVALID_FIELD` on a relationship
column (external ID value matches zero or multiple parents),
`FIELD_CUSTOM_VALIDATION_EXCEPTION` (a validation rule — read it with
`retrieve_metadata`), `REQUIRED_FIELD_MISSING`, `DUPLICATE_VALUE` (external ID
collision), `UNABLE_TO_LOCK_ROW` (parallel automation contention — re-run just
those rows).

## 8. Verify, then clean up after yourself

- After a load, verify with aggregate `soql_query` counts (per object, per
  step), not by re-reading files. Spot-check a few cross-object references
  resolved (`SELECT Id, Account.External_Id__c FROM Contact WHERE …`).
- Created IDs are deliberately not returned (that would be row data). When
  you need them, query by external ID.
- Keep the human's results directory path in your summary — the failed-row
  files are theirs to keep.

## 9. Boundaries (v1)

- No `hardDelete` — bulk deletes go to the Recycle Bin.
- Comma-delimited only (no tab/semicolon files — re-export them).
- One CSV per step, up to the configured per-file and per-plan caps (the
  refusal names the config knob when a plan exceeds them).
- Serial steps only — no parallel jobs, by design: order is the reference
  strategy.
