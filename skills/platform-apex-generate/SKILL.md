---
name: platform-apex-generate
description: "Primary Apex authoring skill for class generation, refactoring, and review through the Contrail engine. ALWAYS ACTIVATE when the user mentions Apex, .cls, triggers, or asks to create/refactor a class (service, selector, domain, batch, queueable, schedulable, invocable, DTO, utility, interface, abstract, exception, REST resource). Use for SObject CRUD, mapping collections, fetching related records, scheduled jobs, batch jobs, trigger design, @AuraEnabled controllers, @RestResource endpoints, custom REST APIs, or evidence-based review of existing Apex read via retrieve_metadata. All org verification and deployment goes through validate_deploy/execute_deploy. Do NOT use for authoring Apex test classes (platform-apex-test-generate), runtime debug-log analysis (platform-apex-logs-debug), or non-Apex metadata."
metadata:
  domains: ["Platform"]
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.1"
    adapted: "2026-08-26"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-apex-test-generate"
    - "platform-permission-set-generate"
    - "platform-apex-logs-debug"
    - "platform-custom-object-generate"
    - "platform-custom-field-generate"
    - "platform-validation-rule-generate"
---

# Generating Apex

Use this skill for production-grade Apex: new classes, selectors, services, async jobs,
invocable methods, and triggers; and for evidence-based review of existing `.cls` or
`.trigger` sources retrieved from a connected org.

## Operating context (Contrail)

- **Org-first.** There is no local project, no local compiler, no LSP, and no static
  analyzer. The first — and only — compile feedback on authored Apex is the **org's
  compiler**, reached through `validate_deploy` (checkOnly). Never describe Apex as
  valid, compiling, or deploy-ready before that gate has run and passed.
- **Anonymous Apex exists ONLY behind the full ritual.** `apex_propose` stages a
  script (max 32k chars) and puts it — verbatim — on the human's approval page;
  `apex_execute` runs it only after the human reads the code back. DML it performs
  **COMMITS** (an uncaught exception rolls the whole script back), and there is no
  dry-run: the org compiles at execute, and a compile error spends the code. Prefer
  Apex tests for exercising generated code — inside `validate_deploy` (`test_level` +
  `run_tests`) while it lands, or via `run_apex_tests` once deployed (test
  transactions roll back, no approval) — and reserve anonymous Apex for what tests
  cannot do: one-off data fixes, kicking off batches, diagnostics with committed
  side effects the human has approved line-by-line.
- **Never author `-meta.xml` files or a manifest.** Contrail generates the meta XML
  from its configured apiVersion; when modifying an existing class, the snapshot's
  existing meta wins. You do not choose the API version — when a rule below depends
  on it (e.g. USER_MODE defaults at 67.0+), check the class's existing meta in the
  snapshot or ask rather than assuming.
- **Two authoring environments, one contract:**
  - *Claude Desktop chat* (no file tools): author the source inline and pass it as
    `content` in `validate_deploy` components. The `assets/` templates are not
    readable here — the Type-Specific Guidance below is self-sufficient.
  - *Claude Code* (file tools): write each source to Contrail's staging directory
    (`<data dir>/staging/`, e.g. `%USERPROFILE%\.contrail\staging\`) and pass an
    absolute `content_file` path. Prefer `content_file` for anything large or edited
    from a retrieved copy (see building-salesforce-metadata).
- **Every write is human-approved** via a confirmation code you never see. The full
  ritual is salesforce-house-rules §3; this skill only points at it.
- **Deleting a class is destructive**: propose it as a `destructive` entry in
  `validate_deploy`, lead your summary with it, and let the human decide on the
  approval page. Never fold a deletion quietly into a larger change.

## Required Inputs

Gather or infer before authoring:

- Class type (service, selector, domain, batch, queueable, schedulable, invocable,
  trigger, trigger action, DTO, utility, interface, abstract, exception, REST resource)
- Target object(s) and business goal
- Class name (derive using the naming table below)
- Net-new vs refactor/fix; any org constraints
- **Target connection, by alias** — start with `list_connections`; never guess an org
  (salesforce-house-rules §1)

Defaults unless specified:
- Sharing: `with sharing` (see sharing rules per type below)
- Access: `public` (use `global` only when required by managed packages or `@RestResource`)
- ApexDoc comments: yes
- Validation: `test_level: "RunSpecifiedTests"` with the generated test class

If the user provides a clear, complete request, generate immediately without
unnecessary back-and-forth.

---

## Workflow

Steps are sequential. Do not skip, merge, or reorder. If blocked, stop and ask for
missing context. If a step is not applicable, mark `N/A` with a one-line
justification in the report.

### Phase 1 — Discover & author

1. **Discover org conventions**
   - `search_metadata` for existing layering and frameworks: `Service`, `Selector`,
     `TriggerHandler`, `MetadataTriggerHandler` / `TriggerAction` (Trigger Actions
     Framework), logging utilities
   - `list_metadata` (type `ApexClass` / `ApexTrigger`) for the inventory;
     `retrieve_metadata` to read any class you will imitate or change — Apex bodies
     normally come live from the org (source `tooling_api_live`); if `source` comes
     back `snapshot`, the live read failed or the class is managed — treat that copy
     as possibly stale
   - `describe_schema` for the target objects' fields, types, and relationships
   - When refactoring, `get_dependencies` (`direction: "used_by"`) on the class
     first — that is the blast radius of your change

2. **Choose the smallest correct pattern** (see Type-Specific Guidance below)

3. **Review templates** *(Claude Code only)* — read the matching skeleton from this
   skill's `assets/` before authoring (file mapping under each type below). In
   Desktop chat, work from the guidance sections directly.

4. **Author with guardrails** — apply every rule in the Rules section. Generate
   `{ClassName}.cls` source with ApexDoc — source only, no meta file. For refactors,
   work from the complete retrieved definition, never a fragment.

5. **Generate the test class** — load `platform-apex-test-generate` to author
   `{ClassName}Test.cls`. No test file creation or edits without that skill. Tests
   are not optional: production deploys of Apex require them, and the validation
   gate below runs them.

### Phase 2 — Validate against the org (required before reporting)

Writing the source is the midpoint, not the finish line.

6. **Compile-and-test gate (REQUIRED — one call).** In Contrail the org compiler is
   the compile check, and the same call runs the tests: invoke `validate_deploy`
   with **all** authored components (class + test class + permission set) and
   `test_level: "RunSpecifiedTests"`, `run_tests: ["{ClassName}Test"]`. checkOnly —
   nothing is committed.
   - **On failure**: no confirmation code is issued. Read `component_failures`
     (compile errors with line number, up to 25) and `tests_run` /
     `test_failures` / `test_failure_detail`. Fix and re-validate. Each
     re-validation supersedes the previous pending approval — that is normal.
   - **Route the failure correctly**: compile errors in your class are yours to fix
     here; test assertion failures and coverage problems are delegated to
     `platform-apex-test-generate`.
   - `test_failure_detail` is diagnostics-classified: without the `diagnostics_read`
     grant it comes back withheld. Say so plainly; the only remedies are for the
     human to grant `diagnostics_read` on the connection via `manage_connection`
     (then re-validate), or to read the failure in the org's own Apex test
     results — never guess at hidden assertion messages.
   - **Coverage honesty**: the validate result carries `code_coverage_warnings` (up
     to 10 org-side threshold warnings) and no percentages — never invent one. For
     real per-class numbers, `run_apex_tests` after the deploy lands returns
     aggregate coverage for the classes the tests exercise — the org-wide union
     of all tests touching them, not this run's contribution alone.
   - **Bound the loop.** Each cycle is a real org round-trip. After ~3 failed
     validation cycles, stop, present the remaining failures and your best
     diagnosis, and let the human steer.
   - **Fail closed.** If this gate cannot run — no connection, or the
     `metadata_write` grant is missing (check with `get_permissions`; never probe) —
     record `compile_check=unavailable: <reason>` in the report and present the
     code explicitly as UNVERIFIED. Do not substitute self-review for the gate.

7. **Approval, deploy, refresh** — by reference. Present the validation summary
   (target org first; destructive changes and any `permission_warning` lead), the
   human reads the confirmation code from the approval page, you pass it to
   `execute_deploy`, then run `refresh_snapshot`. Full contract:
   **salesforce-house-rules §3**.

### Phase 3 — Report

8. **Report** using the output format at the bottom of this file. The
   `Compile+Tests` line must contain the actual step 6 result (or
   `compile_check=unavailable: <reason>` after attempting it). A report missing
   that line is incomplete.

---

## Rules

### Hard-Stop Constraints (Must Enforce)

If any constraint would be violated in generated code, **stop and explain the
problem** before proceeding:

| Constraint | Rationale |
|---|---|
| Place all SOQL outside loops | Avoid query governor limits (100 queries) |
| Place all DML outside loops | Avoid DML governor limits (150 statements) |
| Declare a sharing keyword on every class | Prevent unintended `without sharing` defaults and data exposure |
| Use Custom Metadata/Labels/describe calls instead of hardcoded IDs | Ensure portability across orgs |
| Always handle exceptions (log, rethrow, or recover) | Prevent silent failures |
| Use bind variables for all dynamic SOQL with user input | Prevent SOQL injection |
| Use Apex-native collections (`List`, `Map`, `Set`) rather than Java types | Prevent compile errors |
| Verify methods exist in Apex before use | Prevent reliance on non-existent APIs |
| Avoid `System.debug()` in main code paths | Debug statements evaluate even when logging is not active and consume CPU; use a logging framework if needed |
| Never use `@future` methods | Use Queueable with `System.Finalizer`; `@future` cannot chain, cannot be called from Batch, and cannot accept non-primitive types |

### Bulkification & Governor Limits

- All public APIs accept and process collections; single-record overloads delegate to the bulk method
- In batch/bulk flows, prefer partial-success DML (`Database.update(records, false)`) and process `SaveResult` for errors
- Use `Map<Id, SObject>` constructor for efficient ID-based lookups from query results
- Use `Map<Id, List<SObject>>` to group child records by parent; build the map in a single loop before processing
- Use `Set<Id>` for deduplication and membership checks; prefer `Set.contains()` over `List.contains()`
- Use relationship subqueries to fetch parent + child records in a single SOQL when both are needed
- Use `AggregateResult` with `GROUP BY` for rollup calculations instead of querying and counting in Apex
- Only DML records that actually changed — compare against `Trigger.oldMap` or prior state before adding to the update list
- Use `Limits.getQueries()`, `Limits.getDmlStatements()`, `Limits.getCpuTime()` to monitor consumption in complex transactions

### SOQL Optimization

- Use selective queries with proper `WHERE` clauses; use indexed fields (`Id`, `Name`, `OwnerId`, lookup/master-detail fields, `ExternalId` fields, custom indexes) in filters when possible
- `SELECT *` does not exist in SOQL — always specify the exact fields needed
- Apply `LIMIT` clauses to bound result sets; use `ORDER BY` for deterministic results
- When querying Custom Metadata Types (`__mdt`), do NOT use SOQL — use the built-in methods (`{CustomMdt__mdt}.getAll().values()`, `getInstance()`, etc.)
- At API version 67.0+, queries in `without sharing` classes throw when the running user lacks field or object-level security. The effective version comes from Contrail's config (new classes — no tool exposes it, so ask, per Operating context) or the existing snapshot meta (modified classes) — check it before relying on either behavior, keep the tests updated accordingly, and allow `SYSTEM_MODE` query variants only with explicit justification

### Caching

- Use Platform Cache (`Cache.Org` / `Cache.Session`) for frequently accessed, rarely changed data; set a TTL and always handle cache misses — cache can be evicted at any time
- Use `private static Map` fields as transaction-scoped caches to prevent duplicate queries within the same execution context; lazy-initialize on first access

### Security

- Default to `with sharing`; document justification for `without sharing` or `inherited sharing`
- `WITH USER_MODE` in SOQL and `AccessLevel.USER_MODE` for `Database` DML for CRUD/FLS enforcement — the platform default for classes at API 67.0+
- Validate dynamic field/operator names via allowlist or `Schema.describe`
- Named Credentials for all external credentials/API keys — never a literal secret in source
- `AuraHandledException` for `@AuraEnabled` user-facing errors (no internal details)
- `without sharing` requires a Custom Permission check; isolate `without sharing` logic in dedicated helper classes called from `with sharing` entry points
- Encrypt PII/sensitive data at rest via Platform Encryption; never expose PII in debug statements, error messages, or API responses

**Security verification before finalizing**: CRUD/FLS enforced (SOQL + DML) ·
explicit sharing keyword on every class · no hardcoded secrets or record IDs · PII
excluded from logs and error messages · error messages sanitized for end users.

### Error Handling

- Catch specific exceptions before generic `Exception`; include context in messages
- Use `try/catch` only around code that can throw (DML, callouts, JSON parsing, casts); avoid defensive wrapping of simple assignments/collection ops/arithmetic
- Preserve exception cause chains: `new CustomException('message', cause)` — do not replace the stack trace with concatenated messages
- Provide a custom exception class per service domain when meaningful
- In `@AuraEnabled` methods, catch exceptions and rethrow as `AuraHandledException`
- Fallback: when no meaningful domain exception exists, catch generic `Exception` and rethrow or wrap it in a minimal custom exception that preserves the original cause

### Null Safety

- Guard clauses for null/empty inputs at the top of every public method; match style to context: `return` early in private/trigger-handler methods, `throw` in public APIs, `record.addError()` in validation services
- Return empty collections instead of `null`
- Use safe navigation (`?.`) for chained property access
- Never dereference `map.get(key)` inline unless presence is guaranteed; use `containsKey`, assignment + null check, or safe navigation first
- Use null coalescing (`??`) for default values
- Prefer `String.isBlank(value)` over manual `value == null || value.trim().isEmpty()`

### Constants & Literals

- Use enums over string constants whenever possible; enum values in `UPPER_SNAKE_CASE`
- Extract repeated literals into `private static final` constants or a constants class
- Use `Label.` custom labels for user-facing strings
- Use Custom Metadata for configurable values (thresholds, mappings, feature flags)
- Never output HTML-escaped entities in code (e.g. `&#39;`); use literal single quotes `'` in Apex string literals

### Naming Conventions

| Type | Pattern | Example |
|---|---|---|
| Service | `{SObject}Service` | `AccountService` |
| Selector | `{SObject}Selector` | `AccountSelector` |
| Domain | `{SObject}Domain` | `OpportunityDomain` |
| Batch | `{Descriptive}Batch` | `AccountDeduplicationBatch` |
| Queueable | `{Descriptive}Queueable` | `ExternalSyncQueueable` |
| Schedulable | `{Descriptive}Schedulable` | `DailyCleanupSchedulable` |
| DTO | `{Descriptive}DTO` | `AccountMergeRequestDTO` |
| Wrapper | `{Descriptive}Wrapper` | `OpportunityLineWrapper` |
| Utility | `{Descriptive}Util` | `StringUtil` |
| Interface | `I{Descriptive}` | `INotificationService` |
| Abstract | `Abstract{Descriptive}` | `AbstractIntegrationService` |
| Exception | `{Descriptive}Exception` | `AccountServiceException` |
| REST Resource | `{SObject}RestResource` | `AccountRestResource` |
| Trigger | `{SObject}Trigger` | `AccountTrigger` |
| Trigger Action | `TA_{SObject}_{Action}` | `TA_Account_SetDefaults` |

Additional naming rules:
- Classes: `PascalCase` · Methods: `camelCase`, start with a verb (`get`, `create`, `process`, `validate`, `is`, `has`, `can`)
- Variables: `camelCase`, descriptive nouns; Lists plural (`accounts`); Maps `{value}By{key}` (`accountsById`); Sets `{noun}Ids`
- Constants: `UPPER_SNAKE_CASE`; full descriptive names, no abbreviations (`acc`, `tks`, `rec`)

### ApexDoc

Required on the class header and every `public`/`global` method: brief description,
`@param`, `@return`, `@throws`, `@example` where helpful.

```apex
/**
 * Provides services for geolocation and address conversion.
 */
public with sharing class GeolocationService {
    /**
     * @param accountIds Ids of the accounts to deduplicate
     * @return The surviving master records
     * @example
     * List<Account> results = AccountService.deduplicateAccounts(accountIds);
     */
}
```

### Code Structure & Architecture

- Single responsibility per class; max 500 lines — split when exceeded
- Return early: validate preconditions at method top, return/throw immediately
- Extract private helpers for methods over ~40 lines
- Use Dependency Injection (constructor/method params) for testability
- Prefer composition and narrow interfaces over deep inheritance; extend via new implementations, not modifications
- Enforce single-level abstraction per method across layer boundaries:

| Layer | Owns | Must NOT contain |
|---|---|---|
| Trigger | Event routing only | Business logic, orchestration |
| Handler/Service | Flow control, coordination | Inline SOQL/DML/HTTP/parsing |
| Domain | Business rules, validation | Queries, callouts, persistence details |
| Data/Integration | SOQL, DML, HTTP | Business decisions |

- Disallowed: methods mixing orchestration with inline SOQL/DML/HTTP; business rules mixed with parsing internals; validation + persistence + cross-system plumbing in one method

---

## Async Decision Matrix

| Scenario | Default | Key Traits |
|---|---|---|
| Standard async work | **Queueable** | Job ID, chaining, non-primitive types, configurable delay (up to 10 min via `AsyncOptions`), dedup signatures |
| Very large datasets | **Batch Apex** | Chunked processing, max 5 concurrent; use `QueryLocator` for large scopes |
| Modern batch alternative | **CursorStep** (`Database.Cursor`) | 2000-record chunks, higher throughput, no 5-job limit |
| Recurring schedule | **Scheduled Flow** (preferred) or **Schedulable** | Schedulable has 100-job limit; use only when chaining to Batch or needing complex Apex logic |
| Post-job cleanup | **Finalizer** (`System.Finalizer`) | Runs regardless of Queueable success/failure |
| Long-running callouts | **Continuation** | Up to 3 per transaction, 3 parallel |
| Delays > 10 minutes | `System.scheduleBatch()` | Schedule a Batch job at a specific future time |
| Legacy fire-and-forget | `@future` | **Do not use in new code** — see Hard-Stop Constraints; replace with Queueable + Finalizer |

---

## Type-Specific Guidance

Template files (readable in Claude Code): `assets/{type}.cls`. Where a template
and the Rules differ, the Rules win — specifically, the DTO/Wrapper, Utility, and
Custom Exception skeletons carry a sharing keyword these entries say to omit.

- **Service** (`assets/service.cls`) — `with sharing`; stateless (no public fields or mutable instance state); public APIs focused and `static` where reasonable; delegate SOQL to Selectors and SObject behavior to Domains; wrap business errors in a custom exception
- **Selector** (`assets/selector.cls`) — `inherited sharing`; one per SObject or query domain; return `List<SObject>` / `Map<Id, SObject>`; shared base field-list constant (no inline duplication); accept filter parameters; always `WITH USER_MODE`
- **Domain** (`assets/domain.cls`) — `with sharing`; field defaults, derivations, validations; in-memory lists only — no SOQL/DML
- **Batch** (`assets/batch.cls`) — `with sharing`; `Database.Batchable<SObject>` (+ `Database.Stateful` when tracking across chunks); `start()` = query, `execute()` = logic, `finish()` = logging/notification; `QueryLocator` for large datasets; partial failures via `Database.SaveResult`; filter parameters via constructor
- **Queueable** (`assets/queueable.cls`) — `with sharing`; `Queueable` (+ `Database.AllowsCallouts` when needed); data via constructor; chain-depth guards; optional `Finalizer`; `AsyncOptions` for delay/dedup
- **Schedulable** (`assets/schedulable.cls`) — `with sharing`; `execute()` delegates to Queueable or Batch; CRON constants and a `scheduleDaily()` helper
- **DTO / Wrapper** (`assets/dto.cls`) — no sharing keyword (pure data); simple public properties; no-arg + parameterized constructors; `Comparable` when ordering matters; `@JsonAccess` on serialized private/protected inner DTOs
- **Utility** (`assets/utility.cls`) — no sharing keyword; all methods `public static`; `private` constructor; pure and side-effect-free — no SOQL/DML
- **Interface** (`assets/interface.cls`) — clear contracts with ApexDoc per method signature
- **Abstract** (`assets/abstract.cls`) — `with sharing`; default behavior via `virtual`; extension points `protected virtual`/`protected abstract`; ApexDoc shows a concrete extension example
- **Custom Exception** (`assets/exception.cls`) — no sharing keyword; extend `Exception`; support `()`, `('msg')`, `(cause)`, `('msg', cause)`
- **Trigger** (`assets/trigger.cls`) — one trigger per object; all relevant DML contexts; zero logic in the trigger body — delegate to a handler or TAF (`new MetadataTriggerHandler().run();`). Skeleton:

```apex
trigger AccountTrigger on Account (
    before insert, before update, before delete,
    after insert, after update, after delete, after undelete
) {
    // TAF org:      new MetadataTriggerHandler().run();
    // Handler org:  route Trigger.isBefore/isAfter × isInsert/isUpdate/isDelete/isUndelete
    //               to AccountTriggerHandler methods (pass Trigger.new/old/newMap/oldMap)
}
```

- **Trigger Action (TAF)** — one class per concern per context; implement `TriggerAction.{Context}`; register via `Trigger_Action__mdt` (actions are inactive without registration — those are custom-metadata records, and Contrail cannot write custom-metadata records today: the human creates them in Setup → Custom Metadata Types, and you say so plainly); name `TA_{SObject}_{ActionName}`; prefer field-value comparison over static booleans for recursion control
- **Invocable Method** (`assets/invocable.cls`) — `with sharing`; inner `Request`/`Response` with `@InvocableVariable`; method `public static`, takes `List<Request>`, returns `List<Response>` (non-static or single-object signatures will not compile); bulkify; decorator params: `label` (required), `description`, `category`, `callout=true` when making callouts; `@InvocableVariable` params: `label` (required), `description`, `required=true/false`; `@InvocableVariable` supports primitives, `Id`, `SObject`, `List<T>` only (no `Map`/`Set`/`Blob`) — use `List<Id>`/`List<SObject>` fields for Flow collection I/O; always include `isSuccess`, `errorMessage`, `errorType` (`e.getTypeName()`) in Response; return errors in the Response — throwing triggers the Flow fault path, reserve it for unrecoverable failures
- **REST Resource** (`assets/rest-resource.cls`) — `global with sharing`; class and methods `global`; versioned URL `@RestResource(urlMapping='/{resource}/v1/*')`; proper HTTP status codes per branch (`200`/`201`/`400`/`404`/`422`/`500`), never all-errors-500; validate inputs (Id format `Pattern.matches('[a-zA-Z0-9]{15,18}', value)`); bind all user input in SOQL; `LIMIT`/`ORDER BY` + pagination (`pageSize`/`offset`); standardized `ApiResponse` wrapper (`success`, `message`, `data`/`records`) with inner request/response DTOs; thin controller delegating to Services
- **`@AuraEnabled` Controller** — `with sharing`; `WITH USER_MODE` in all SOQL; `@AuraEnabled(cacheable=true)` only for read-only queries (leave unset for DML); catch and rethrow as `AuraHandledException` with user-friendly messages

---

## Deliverables & Packaging

Per class, the deploy package contains — always together, in one `validate_deploy`:

1. `{ClassName}.cls` source — `content` inline (Desktop chat) or `content_file`
   from staging (Claude Code). Never a `-meta.xml`; Contrail generates it.
2. `{ClassName}Test.cls` — authored via `platform-apex-test-generate`.
3. **A permission set granting `classAccesses`** for every new or newly-exposed
   class meant to be called from UI, Flow, or REST — components + permissions
   travel together (building-salesforce-metadata cardinal rule). If the work also
   introduces fields or objects, the same set carries `fieldPermissions` /
   `objectPermissions`. Structure via `platform-permission-set-generate`.

Per trigger: `{TriggerName}.trigger` plus its handler class, tests, and the
permission set as applicable (triggers themselves need no access grant; the
handler classes they call do when invoked from other entry points).

Example gate call (Claude Code shape; in Desktop chat use inline `content`):

```jsonc
{
  "connection": "uat",
  "components": [
    { "type": "ApexClass", "api_name": "InvoiceService", "content_file": "<data dir>/staging/InvoiceService.cls" },
    { "type": "ApexClass", "api_name": "InvoiceServiceTest", "content_file": "<data dir>/staging/InvoiceServiceTest.cls" },
    { "type": "PermissionSet", "api_name": "Invoice_Management_Access", "content": "<PermissionSet>…</PermissionSet>" }
  ],
  "test_level": "RunSpecifiedTests",
  "run_tests": ["InvoiceServiceTest"]
}
```

Report in this order:

```text
Apex work: <summary>
Components: <class / trigger / test / permission set API names>
Design: <pattern and framework choices>
Workflow: all steps completed (1-8); any N/A justified
Risks: <security, bulkification, async, dependency notes — include your own findings from self-review against the Rules>
Compile+Tests: <REQUIRED — actual validate_deploy result: component errors, tests run/failed, coverage warnings; or "compile_check=unavailable: <reason>" after attempting>
Permissions: <which permission set grants classAccesses; any permission_warning verbatim>
Deploy: <validated, awaiting human approval | executed + refresh_snapshot run | not attempted>
```

---

## Cross-Skill Integration

| Need | Delegate to |
|---|---|
| Apex tests / fix test failures or coverage | `platform-apex-test-generate` |
| Permission set structure (`classAccesses` etc.) | `platform-permission-set-generate` |
| New objects / fields the class depends on | `platform-custom-object-generate` / `platform-custom-field-generate` |
| Declarative validation instead of Apex | `platform-validation-rule-generate` |
| Runtime failures, governor limits, debug logs | `platform-apex-logs-debug` |
| Packaging, staging paths, content vs content_file | `building-salesforce-metadata` |
| Approval ritual, grants, connections | `salesforce-house-rules` |

---

## Troubleshooting Boundary

This skill handles authoring and the failures `validate_deploy` surfaces for
`.cls`/`.trigger` sources: compile/parse errors and deployment dependency errors.
For test assertions, coverage, or test-fix iteration, delegate to
`platform-apex-test-generate`. For runtime behavior — governor-limit failures,
exception analysis from debug logs — delegate to `platform-apex-logs-debug`.

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; workflow restructured for Contrail's human-approval write contract.*
