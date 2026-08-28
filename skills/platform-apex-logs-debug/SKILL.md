---
name: platform-apex-logs-debug
description: "Salesforce debug log analysis and troubleshooting through the Contrail engine. TRIGGER when: the user analyzes Apex debug logs, hits governor limits, reads stack traces, investigates slow transactions, or asks why an Apex/trigger/flow-invoked-Apex operation failed — retrieval goes through get_debug_logs. DO NOT TRIGGER when: generating or fixing Apex code (use platform-apex-generate), authoring test classes (use platform-apex-test-generate), or the failure is a flow interview problem with no Apex in play (get_flow_errors covers that directly)."
metadata:
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.1"
    adapted: "2026-08-26"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-apex-generate"
    - "platform-apex-test-generate"
  domains: ["Platform"]
---

# platform-apex-logs-debug: Debug Log Analysis & Troubleshooting

Use this skill for **root-cause analysis from debug logs**: governor-limit diagnosis,
stack-trace interpretation, slow-query investigation, heap/CPU pressure, and the
diagnose-then-fix loop grounded in log evidence. Load **salesforce-house-rules**
first — it governs connections, grants, and every write this skill's fix loop ends in.

**Environments.** In Claude Desktop chat there are no file tools: analyze log content
directly from tool output, and author any code fix inline via `validate_deploy`
`content`. In Claude Code, write authored fixes under Contrail's `staging/` directory
and pass `content_file`.

**Confidentiality (house rules §6).** Log bodies routinely contain record data —
names, emails, amounts, ids. Treat every log as client-confidential: quote the lines
that prove the diagnosis, never dump whole bodies into the conversation, and never
copy log content into external systems (tickets, emails) unless the user asks.

---

## 1. The retrieval surface — what Contrail actually gives you

One tool, `get_debug_logs`, two modes. It requires the `diagnostics_read` grant —
check with `get_permissions` first, never discover by probing (house rules §2).

| Argument | Meaning |
|---|---|
| `connection` | Connection alias (or id) — required, name it explicitly |
| `log_id` | Optional 15/18-char ApexLog id — fetch that log's body |
| `limit` | Listing mode only: max logs to list, 1–50, default 10 |

**Listing mode** (no `log_id`): most recent logs, newest first, each with `Id`,
`LogUser.Name`, `Operation`, `Request`, `Status`, `LogLength`, `StartTime`,
`DurationMilliseconds`. Pick candidates by matching `StartTime` to the failure
window, `Operation` to the entry point, and `Status` (a truncated error message)
to the symptom. Large `LogLength` on a "simple" operation is itself a signal.

**Body mode** (`log_id`): a body of **60,000 characters or less comes back whole**.
Anything larger returns `length` plus **head and tail slices of 30,000 characters
each — the middle of a large log is unreachable through the tool.** That is usually
survivable: the head carries the debug-level header and entry point; the tail
carries the exception, `CUMULATIVE_LIMIT_USAGE`, and the transaction close. When
the evidence you need is in the missing middle, don't guess — ask the human to
lower the debug levels (§2) and reproduce, so the whole story fits in one small log.

**Filtered listing.** `get_debug_logs` has no by-user/by-time/by-status filters.
Narrow with `soql_query` on ApexLog instead — it needs `data_read` **plus**
`diagnostics_read` (ApexLog is grant-gated):

```sql
SELECT Id, LogUser.Name, Operation, Status, LogLength, StartTime,
       DurationMilliseconds
FROM ApexLog
WHERE LogUser.Name = 'Jane Admin' AND StartTime > 2026-08-26T14:00:00Z
ORDER BY StartTime DESC LIMIT 20
```

### Hard boundaries — state them plainly, don't improvise around them

- **No live tailing.** Nothing in Contrail streams logs. The loop is: human
  reproduces → you list logs again → fetch the new log id.
- **No trace-flag or debug-level management.** TraceFlag/DebugLevel are Tooling
  objects and are **neither readable nor writable** through Contrail —
  `soql_query` speaks the data API only, not Tooling, so `SELECT … FROM
  TraceFlag` fails with INVALID_TYPE. **The human enables debug logging in
  Setup** (§2); you tell them exactly what to set.
- **No anonymous Apex** — no benchmark harness, no ad-hoc repro snippets, no
  ad-hoc `Limits.get*()` probes run outside a real transaction (instrumenting a
  deployed class with `Limits.get*()` guards is fine — see
  `assets/cpu-heap-optimization.cls`). Evidence comes from logs of real
  transactions (or test runs inside `validate_deploy`).
- **No query-plan tool.** Selectivity is argued from row counts in the log plus
  schema knowledge (`describe_schema` for field/relationship shape). If a definitive
  plan is needed, the human runs Query Plan in Developer Console and pastes the result.
- **Log cleanup is not agent work.** Old ApexLog rows are deleted by the human in
  Setup → Debug Logs. If the user insists on doing it through Contrail, it is
  ordinary approval-gated destructive DML (`dml_propose` delete → human approves) —
  impractical at volume and never something you initiate.

If a needed capability is missing, attempt the check, then record it fail-closed —
e.g. `log-retrieval=unavailable: diagnostics_read not granted on uat` — and offer
`manage_connection` so the human can set the grant.

---

## 2. Getting logs to exist (the human's part, in Setup)

No rows in listing mode usually means logging is off, the trace flag expired, or
the logs aged out — ApexLog rows are retained about 24 hours by default, so old
failures must be reproduced fresh.
Direct the human: **Setup → Debug Logs → New Trace Flag** on the affected user,
with an expiration in the future, attached to a debug level. The traced user
also needs the **API Enabled** and **Author Apex** permissions, or no logs are
written. Suggest levels by goal:

| Goal | Debug level to set |
|---|---|
| Performance / limits | ApexCode FINE, ApexProfiling FINEST, Database FINE, System DEBUG |
| Exception debugging | ApexCode DEBUG, ApexProfiling FINE, Database INFO, System DEBUG |
| Callout issues | ApexCode DEBUG, Callout FINEST, System DEBUG |
| Keep logs small | drop ApexCode to INFO, System to WARN, Workflow/Validation to INFO |

Level order: NONE < ERROR < WARN < INFO < DEBUG < FINE < FINER < FINEST.
Categories: Database, Workflow, Validation, Callout, Apex Code, Apex Profiling,
Visualforce, System. Two truncation layers to manage: Salesforce itself truncates
oversized log bodies, and Contrail slices anything over 60,000 chars to head+tail —
noisier levels mean less usable evidence, not more.

---

## 3. Workflow

1. **Context**: target org by alias (`list_connections` first — never guess an
   org), failing transaction or user flow, approximate time window, user/record
   ids if known, and whether the goal is diagnosis only or diagnosis + fix.
2. **Grants**: `get_permissions` → need `diagnostics_read` (plus `data_read` for
   SOQL narrowing; `metadata_read` to read the implicated Apex source).
3. **Capture**: ask the human to confirm an active trace flag in Setup (§2) —
   you cannot query TraceFlag; the only agent-visible evidence is a new row
   appearing in `get_debug_logs` listing mode. Then have the human reproduce,
   list logs, fetch the candidate body.
4. **Analyze in this order** — earlier findings explain later ones:
   1. entry point and transaction type (`EXECUTION_STARTED`, first `CODE_UNIT_STARTED`)
   2. exceptions / fatal errors (`EXCEPTION_THROWN`, `FATAL_ERROR` — usually in the tail)
   3. governor limits (`LIMIT_USAGE`, `CUMULATIVE_LIMIT_USAGE`)
   4. repeated SOQL / DML patterns (loops)
   5. CPU / heap hotspots
   6. callout timing and external failures
5. **Read the implicated code**: `retrieve_metadata` the class/trigger named in the
   stack trace (whole artifact — house rules §5); `get_dependencies` for blast radius.
6. **Classify severity**: **Critical** (runtime failure, hard limit, corruption
   risk) / **Warning** (near-limit, non-selective query, slow path) / **Info**
   (optimization or hygiene).
7. **Recommend the smallest correct fix** — root-cause oriented, bulk-safe,
   testable. Author it per **platform-apex-generate**, with a regression test per
   **platform-apex-test-generate**.
8. **Fix loop**: one consolidated `validate_deploy` carrying the fixed class(es) and
   test class, with `test_level: "RunSpecifiedTests"` and `run_tests` naming the
   relevant test classes (prefer `RunLocalTests` for production targets).
   Verification = the validation's test results. Then the approval ritual: the
   human reads the code from the approval page and you pass it to
   `execute_deploy`, then `refresh_snapshot` — see **salesforce-house-rules §3**.
   After the fix lands, re-run the relevant tests standalone with
   `run_apex_tests` (rolls back, no approval) instead of spending another
   validate cycle — and if a trace flag is active, that run also produces fresh
   debug logs to confirm against. Final confirmation is a fresh log from a human
   reproduction showing the pattern gone.
   If the fix introduces a **new** Apex class, ship a permission set granting
   `classAccesses` in the same package (see **building-salesforce-metadata**).

---

## 4. Log line grammar

```text
TIMESTAMP (elapsed-ns)|EVENT_IDENTIFIER|[PARAMS]|DETAILS
14:32:54.123 (123456789)|SOQL_EXECUTE_BEGIN|[45]|SELECT Id FROM Account
```

`[45]` is the source line number. The parenthesized value is elapsed nanoseconds
since transaction start — subtract between events to get durations.

### Event catalog

| Category | Events | What to read from them |
|---|---|---|
| Execution | `EXECUTION_STARTED/FINISHED`, `CODE_UNIT_STARTED/FINISHED` | transaction type, total time, call stack |
| SOQL | `SOQL_EXECUTE_BEGIN` (line, query text), `SOQL_EXECUTE_END` (`[N rows]`) | repetition → loop; huge N → non-selective |
| DML | `DML_BEGIN` (line, `Op:`, `Type:`), `DML_END` (rows) | repetition → loop; DML after each SOQL → unbulkified |
| Limits | `LIMIT_USAGE` (`NAME\|used\|max`), `LIMIT_USAGE_FOR_NS`, `CUMULATIVE_LIMIT_USAGE` | consumption per namespace; end-of-transaction totals |
| Exceptions | `EXCEPTION_THROWN` (`[line]\|Type\|Message`), `FATAL_ERROR` (full stack) | root frame, exception type |
| Methods | `METHOD_ENTRY/EXIT`, `CONSTRUCTOR_ENTRY/EXIT` | call hierarchy, hot methods (needs Profiling FINER+) |
| Loops | `LOOP_BEGIN/END`, `ITERATION_BEGIN/END` | operations nested inside iterations |
| Callouts | `CALLOUT_EXTERNAL_ENTRY` (URL), `CALLOUT_EXTERNAL_EXIT` (status, ms) | slow/failed external calls |
| Heap | `HEAP_ALLOCATE`, `HEAP_DEALLOCATE` | large allocations |

**Never assume limits are safe without reading `LIMIT_USAGE` events** — limits may
be consumed by earlier operations (other triggers, flows, managed packages in the
same transaction) invisible at the failure point. `LIMIT_USAGE_FOR_NS` splits usage
by namespace: a managed package can burn the budget your code gets blamed for.

### Governor limits reference

| Limit | Sync | Async | Log name |
|---|---|---|---|
| SOQL queries | 100 | 200 | `SOQL_QUERIES` |
| SOQL rows | 50,000 | 50,000 | `SOQL_ROWS` |
| DML statements | 150 | 150 | `DML_STATEMENTS` |
| DML rows | 10,000 | 10,000 | `DML_ROWS` |
| CPU time | 10,000 ms | 60,000 ms | `CPU_TIME` |
| Heap size | 6 MB | 12 MB | `HEAP_SIZE` |
| Callouts | 100 | 100 | `CALLOUTS` |
| Future calls | 50 | 0 in async | `FUTURE_CALLS` |

Flag **Warning at ~80%** and **Critical at ~95%** of the applicable limit — and
check the transaction type first: 9,500 ms CPU is Critical in a sync trigger and
comfortable in a batch `execute`.

---

## 5. Diagnostic log patterns

**SOQL in loop** — same line number repeating, one small result per query:
```text
|LOOP_BEGIN| … |ITERATION_BEGIN|
|SOQL_EXECUTE_BEGIN|[45]|SELECT Id FROM Contact WHERE AccountId = '001xxx'
|SOQL_EXECUTE_END|[1 rows]
|ITERATION_END| |ITERATION_BEGIN|
|SOQL_EXECUTE_BEGIN|[45]|SELECT …   ← same line 45 again
…
|LIMIT_USAGE|SOQL_QUERIES|100|100
|FATAL_ERROR|System.LimitException: Too many SOQL queries: 101
```

**DML in loop** — `DML_BEGIN` repeating with `[1 rows]` each:
```text
|DML_BEGIN|[78]|Op:Insert|Type:Contact| … repeats …
|LIMIT_USAGE|DML_STATEMENTS|150|150
|FATAL_ERROR|System.LimitException: Too many DML statements: 151
```

**Non-selective query** — huge result set, or a WHERE-less query:
```text
|SOQL_EXECUTE_BEGIN|[23]|SELECT Id FROM Lead WHERE Status = 'Open'
|SOQL_EXECUTE_END|[250000 rows]
```

**CPU pressure** — `CUMULATIVE_LIMIT_USAGE` showing `CPU_TIME|9500|10000`.

**Null pointer from an empty query** — `[0 rows]` then the throw two lines later:
```text
|SOQL_EXECUTE_BEGIN|[45]|SELECT Id FROM Account WHERE Id = '001xxx'
|SOQL_EXECUTE_END|[0 rows]
|EXCEPTION_THROWN|[47]|System.NullPointerException|Attempt to de-reference a null object
```

**Stack traces**: `FATAL_ERROR` prints innermost frame first. Walk **up** past
trigger-framework/handler frames to the originating user code — the fix belongs at
the first frame you own, not at the framework line:
```text
Class.ContactService.processContacts: line 67   ← fix here
Class.AccountTriggerHandler.afterUpdate: line 34
Trigger.AccountTrigger: line 5
```

---

## 6. Root-cause playbooks

| Issue | Primary signal | Fix direction |
|---|---|---|
| SOQL in loop | repeating `SOQL_EXECUTE_BEGIN`, same line | query once before the loop into `Map<Id, SObject>`; relationship subqueries for parent→child |
| DML in loop | repeated `DML_BEGIN` | collect into lists, one bulk DML per object/operation after the loop |
| Non-selective query | huge `[N rows]`, slow query | filter on indexed fields (Id, Name, lookups, External ID, unique), reduce scope |
| CPU pressure | `CPU_TIME` near limit | kill O(n²) nested loops with map lookups; `String.join` over `+=` in loops; cache repeated work; async only when the workload genuinely belongs there |
| Heap pressure | `HEAP_SIZE` near limit | SOQL for-loops (streaming); query only needed fields; `clear()`/null out large collections; Batch Apex for very large sets |
| Null pointer | `EXCEPTION_THROWN` after `[0 rows]` or map miss | list-assignment for queries, `?.` safe navigation, guard map gets |
| Slow/failed callout | `CALLOUT_EXTERNAL_EXIT` slow or non-2xx | timeouts, retry policy, move callouts off the synchronous user path |
| Unbulkified trigger | limits scale with record count | fix at 200-record scale, not per-record |

Condensed canonical fixes (full before/after classes in `assets/` — readable in
Claude Code; in Desktop chat these condensed forms are the reference):

**SOQL-in-loop → map pattern**
```apex
Map<Id, Contact> primaryByAcct = new Map<Id, Contact>();
for (Contact c : [SELECT Id, Email, AccountId FROM Contact
                  WHERE AccountId IN :accountIds AND IsPrimary__c = true]) {
    primaryByAcct.put(c.AccountId, c);
}
for (Account acc : accounts) {
    Contact pc = primaryByAcct.get(acc.Id);           // no SOQL in loop
    if (pc != null) acc.Primary_Contact_Email__c = pc.Email;
}
```

**DML-in-loop → collection pattern**
```apex
List<Contact> toInsert = new List<Contact>();
for (Account acc : accounts) { toInsert.add(buildContact(acc)); }
if (!toInsert.isEmpty()) insert toInsert;             // one DML statement
```
Mixed operations: three lists (insert/update/delete), one DML each after the loop.
Partial-failure tolerance: `Database.insert(records, false)` and inspect
`SaveResult.getErrors()`.

**Null safety**
```apex
List<Account> accts = [SELECT Name FROM Account WHERE Id = :accountId LIMIT 1];
return accts.isEmpty() ? null : accts[0].Name;        // never single-row assign
return c?.Account?.Owner?.Email;                      // safe navigation (API 50.0+)
```
Also: guard `Map.get()` results; `String.isBlank()` before string methods; in
triggers `Trigger.old` is null on insert and `Trigger.new` is null on delete —
but don't over-guard what the platform guarantees non-null.

**CPU: O(n²) → O(n)**
```apex
Map<String, Contact> byEmail = new Map<String, Contact>();
for (Contact c : contacts) {
    if (c.Email == null) continue;
    String key = c.Email.toLowerCase();
    if (byEmail.containsKey(key)) duplicates.add(c); else byEmail.put(key, c);
}
```
String building: collect into `List<String>`, then `String.join(lines, '\n')`.
Repeated expensive lookups: static `Map` cache per transaction; Platform Cache
across transactions.

**Heap: stream instead of loading**
```apex
for (Account acc : [SELECT Id, Name FROM Account WHERE …]) { process(acc); }
```
The SOQL for-loop iterates in chunks instead of materializing the whole list.
Beyond that: Batch Apex (`Database.executeBatch(new Job(), 200)`), and `transient`
for large Visualforce controller state.

---

## 7. Output format

Report every finding with all six fields, Critical first:

```text
Issue: <summary>
Location: <class / method / line / transaction stage>
Root cause: <explanation traceable to quoted log lines>
Severity: Critical | Warning | Info
Fix: <specific, smallest correct action>
Verify: <validate_deploy test expectation + what a clean re-captured log will show>
```

| Rule | Rationale |
|---|---|
| Base every fix on quoted log evidence | root cause must be traceable, not speculative |
| Report all six fields per issue | complete, actionable findings |
| Classify every finding | lets the user prioritize |
| Diagnosis here; code authoring per platform-apex-generate | separation of concerns |
| New/edited code executes only via `validate_deploy` | already-deployed tests re-run standalone via `run_apex_tests` (rolls back; also regenerates logs under an active trace flag) |
| Read `LIMIT_USAGE` before declaring limits safe | earlier consumers may own the budget |

---

## 8. Gotchas

| Pitfall | Resolution |
|---|---|
| Body over 60,000 chars → head/tail slices only | say so explicitly; tail has the error + cumulative limits; if the middle matters, lower debug levels (§2) and re-capture smaller |
| Salesforce truncated the log itself | body contains `*** Skipped … MAX_DEBUG_LOG_SIZE` — that is Salesforce's own truncation, distinct from Contrail's head/tail slicing; reduce levels (ApexCode INFO, ApexProfiling FINE) — more verbosity is less evidence |
| Same issue reads as both SOQL and CPU | fix SOQL-in-loop first; the CPU spike is usually secondary |
| No logs appear | trace flag expired, wrong user traced, or the transaction predates ApexLog retention (default ~24 h) — logs age out, so old failures must be reproduced fresh; human re-checks in Setup |
| Async vs sync limit confusion | check transaction type before flagging (60,000 ms / 12 MB async) |
| Stack trace points at framework code | walk up to the first frame you own |
| Managed-package namespace burns limits | read `LIMIT_USAGE_FOR_NS` before blaming user code |
| `Status` in listing looks clean but transaction failed | `Status` is truncated; trust the body's `FATAL_ERROR`, not the listing row |

---

## 9. Scoring rubric (self-check before delivering)

| Category | Points | What good looks like |
|---|---:|---|
| Root-cause accuracy | 25 | the actual cause, not the symptom |
| Fix quality | 25 | directly addresses the cause, bulk-safe |
| Performance impact | 20 | improves limits without regressions |
| Completeness | 15 | secondary issues and risks captured |
| Clarity | 15 | the user can act on it immediately |

90+ expert · 80–89 good · 70–79 acceptable · 60–69 partial · <60 incomplete —
below 80, re-read the log before delivering.

## Cross-skill integration

| Need | Go to |
|---|---|
| Author the Apex fix | platform-apex-generate |
| Author the regression test | platform-apex-test-generate |
| Package fix + permissions, `content` vs `content_file` | building-salesforce-metadata |
| Approval ritual, grants, org targeting, confidentiality | salesforce-house-rules |
| Flow-side failures | `get_flow_errors` (then back here — full detail lives in debug logs) |
| Repro data | `dml_propose` plan → human approval (house rules §3) |

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; workflow restructured for Contrail's human-approval write contract.*
