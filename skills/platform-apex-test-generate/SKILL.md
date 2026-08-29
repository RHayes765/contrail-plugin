---
name: platform-apex-test-generate
description: "Generate Apex test classes with TestDataFactory patterns, bulk testing (251+ records), mocking strategies, and meaningful assertions — authored TOGETHER with the class under test and verified in a single validate_deploy run (test_level RunSpecifiedTests). Use this skill when creating new Apex test classes, improving test coverage, fixing Apex test failures or coverage warnings reported by validate_deploy, or implementing testing patterns for triggers, services, controllers, batch jobs, queueables, and integrations. Triggers on *Test.cls / *_Test.cls naming, coverage requirements for an Apex deploy, and test_level / run_tests planning. Do NOT trigger for production Apex code design (use platform-apex-generate) or for Jest/LWC tests."
metadata:
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.1"
    adapted: "2026-08-26"
  domains: ["Platform"]
  minApiVersion: "66.0"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-apex-generate"
    - "platform-apex-logs-debug"
    - "platform-permission-set-generate"
---

# Generating Apex Tests

Generate production-ready Apex test classes and verify them through the right one of
Contrail's TWO test paths: the validated deploy (for code that is not in the org yet)
or the standalone `run_apex_tests` runner (for tests already deployed).

## How tests run in Contrail — read this first

Apex tests execute on two paths — pick by where the code lives. (Anonymous Apex
exists in Contrail, but ONLY behind the full `apex_propose` → human code →
`apex_execute` ritual, and its DML **commits** — it is never a test runner or a
free execution loop. Tests are the rollback-safe way to exercise code.)

- **Code you are authoring or changing** runs only inside `validate_deploy`
  (checkOnly), driven by `test_level` and `run_tests` — the org compiles the new
  code and runs its tests in one gate. Every PASSING validation opens a human
  approval page, and every run is a full checkOnly round-trip, not a free loop.
- **Tests already deployed** run standalone via `run_apex_tests` — Tooling API,
  test transactions always roll back, NO approval needed, gated on the
  `diagnostics_read` grant. Submit with `class_names` (or `tests` for
  method-level targeting) to get a `test_run_id`; poll with that id until
  `Completed`, then read per-method outcomes and per-class **aggregate** coverage
  — the org-wide union of ALL tests touching those classes, not this run alone. Use it to re-run suites, iterate on failures after a deploy
  landed, impact-check before proposing changes, or answer coverage questions —
  each run spends the org's daily async-test allowance.

For the authoring path, that reshapes the classic author → run → fix cycle into:

**Author the class under test and its test class TOGETHER, put them in ONE package, and
validate ONCE.** Read compile errors, test failures, and coverage warnings from that one
validate result. Re-validate only after a deliberate fix, and say what changed each round.

What `validate_deploy` returns — this is everything you can honestly claim about a run:

| Result field | Appears on | Meaning |
|---|---|---|
| `component_failures` | Failed runs | Compile/package errors (first 25) — the org compiler's verdict. Pre-screen locally with `check_apex` first (free, offline; syntax definitive, org-specific symbols invisible) so validate rounds are spent on real problems |
| `tests_run` / `test_failures` | Both | Counts of test methods executed and failed |
| `test_failure_detail` | Both | Failing class/method names, assertion messages, stack traces (first 25) — **grant-gated**, see below |
| `code_coverage_warnings` | Passed runs only | The org's coverage warning strings, capped at 10 — if 10 come back, assume there may be more and re-validate after fixing |
| `permission_warning` | Passed runs only | New components deploying without permissions — lead your summary with it |

Plainly stated limits — do not promise around them:

- **`validate_deploy` has no per-class coverage percentages.** It surfaces only the
  `code_coverage_warnings` strings the org returns. For real percentages, run
  `run_apex_tests` after the deploy lands — its result carries per-class aggregate
  coverage for the classes the tests exercise (the org-wide union of all tests
  touching them, so say "aggregate", never "coverage from these tests"). Treat any
  coverage warning as a blocker to fix, not a number to negotiate.
- **`validate_deploy`'s `run_tests` is class-granular** (Metadata API `runTests`,
  max 50 class names). Method-level targeting exists only on the standalone path:
  `run_apex_tests` with `tests: [{class_name, methods}]` — already-deployed tests
  only.
- **`test_failure_detail` requires the `diagnostics_read` grant.** Without it the
  result carries a withheld marker and a failure count only. Check `get_permissions`
  up front; if the grant is missing and tests fail, report
  `test_failure_detail=unavailable: diagnostics_read not granted on this connection`
  and offer `manage_connection` so the human can enable it. Never probe for grants.

**Environments (once, applies throughout):** in Claude Desktop chat there are no file
tools — author the classes inline and pass them as `content` strings. In Claude Code,
write sources into Contrail's staging directory (`<data dir>/staging`, e.g.
`%USERPROFILE%\.contrail\staging` on Windows) and pass `content_file` with the absolute
path — required for anything large.

**Never author `-meta.xml` files.** Contrail generates class metadata itself from the
configured API version; when modifying an existing class, the snapshot's existing meta
wins. Your deliverables are `.cls` bodies only.

## Core Principles

1. **One behavior per method** — separate positive, negative, and bulk tests. NEVER
   combine related-but-distinct inputs (e.g., null and empty) in one method — create
   `_NullInput_` and `_EmptyInput_` as separate test methods
2. **Bulkify tests** — 251+ records to cross the 200-record trigger batch boundary.
   Batch Apex exception: set `batchSize >= testRecordCount` (see Async patterns)
3. **Isolate test data** — every `@TestSetup` delegates creation to a `TestDataFactory`
   class (author one in the same package if the org has none). Never inline record lists
   in `@TestSetup`, never rely on org data (`SeeAllData=false`) or hardcoded IDs
4. **Assert meaningfully** — exact expected values computed from setup; never range
   assertions when the value is deterministic; always include failure messages
5. **Use the `Assert` class only** — never legacy `System.assert` /
   `System.assertEquals` / `System.assertNotEquals`
6. **Mock external boundaries** — `HttpCalloutMock` for callouts,
   `Test.setFixedSearchResults` for SOSL, DML mocks via constructor injection
7. **Test negative paths** — error handling and exceptions, not just happy paths
8. **Wrap with start/stop** — `Test.startTest()`/`Test.stopTest()` resets governor
   limits, runs async work synchronously, and fires scheduled jobs immediately

## Test Code Anti-Patterns

| Anti-Pattern | Fix |
|---|---|
| SOQL/DML inside loops | Query once before the loop; use `Map<Id, SObject>` for lookups |
| Magic numbers in assertions | Derive expected values from setup constants |
| God test class (>500 lines) | Split into multiple test classes by behavior area |
| Long test methods (>30 lines) | Extract Given/When/Then into helper methods |
| Generic `Exception` catch | Catch the specific expected type (e.g., `DmlException`) |

## Workflow

### Step 1 — Gather context (org-first)

- `list_connections` — name the target org unmissably; ask if ambiguous.
- `get_permissions` — `metadata_read` to read the class under test and the schema;
  `metadata_write` to validate; `diagnostics_read` for test failure detail. Surface a
  missing grant now, not after a failed run.
- `search_metadata` (query `"TestDataFactory"`, types `["ApexClass"]`) — does the org
  already have a factory? There is no local project; the org snapshot is the referent.
- `retrieve_metadata` (type `ApexClass`) — the class under test and existing test
  classes; Apex bodies come live from the Tooling API. Read the whole class first.
- `describe_schema` for each object the factory creates — required fields, record types.
- Confirm scope and whether the eventual real target is production (decides the final
  `test_level`, Step 3).

### Step 2 — Author the test class (and factory) alongside the class under test

Skeletons: `assets/test-class-template.cls`, `assets/test-data-factory-template.cls`
(readable in Claude Code; in Desktop chat the inlined patterns below carry the same
content).

**Test method structure — Given/When/Then** (with `@TestSetup` delegating to the
factory: `List<Account> accounts = TestDataFactory.createAccounts(251, true);`):

```apex
@isTest
static void shouldUpdateStatus_WhenValidInput() {
    // Given
    List<Account> accounts = [SELECT Id FROM Account];
    // When
    Test.startTest();
    MyService.processAccounts(accounts);
    Test.stopTest();
    // Then
    List<Account> updated = [SELECT Id, Status__c FROM Account];
    Assert.areEqual(251, updated.size(), 'All accounts should be processed');
}
```

**Negative test — exception pattern:**

```apex
@isTest
static void shouldThrowException_WhenInvalidInput() {
    Test.startTest();
    try {
        MyService.processAccounts(new List<Account>());
        Assert.fail('Expected MyCustomException to be thrown');
    } catch (MyCustomException e) {
        Assert.isTrue(e.getMessage().contains('cannot be empty'),
            'Exception message should indicate empty input');
    }
    Test.stopTest();
}
```

**Naming:** `should[ExpectedResult]_When[Scenario]`
(`shouldSendNotification_WhenOpportunityClosedWon`) or
`[SubjectOrAction]_[Scenario]_[ExpectedResult]` (`AccountUpdate_ChangeName_Success`).

### Step 3 — Validate once, with tests

One package: class under test (if new/changed) + test class + factory (if new) + the
permission-set pairing (see Deliverables). Claude Code example (Desktop chat: same
shape, `content` strings instead of `content_file`):

```jsonc
{
  "connection": "uat",
  "components": [
    { "type": "ApexClass", "api_name": "InvoiceService",     "content_file": "<staging>/InvoiceService.cls" },
    { "type": "ApexClass", "api_name": "InvoiceServiceTest", "content_file": "<staging>/InvoiceServiceTest.cls" },
    { "type": "ApexClass", "api_name": "TestDataFactory",    "content_file": "<staging>/TestDataFactory.cls" },
    { "type": "PermissionSet", "api_name": "Invoice_Management_Access", "content": "<PermissionSet>…</PermissionSet>" }
  ],
  "test_level": "RunSpecifiedTests",
  "run_tests": ["InvoiceServiceTest"]
}
```

| Situation | `test_level` |
|---|---|
| Authoring/fixing specific classes + their tests (default here) | `RunSpecifiedTests` + `run_tests` listing every test class touching the package |
| Final validation before a production deploy | `RunLocalTests` — the org enforces 75% aggregate coverage there |
| Metadata-only package with no Apex | `NoTestRun` (the tool default) |
| Whole-org regression the human asked for | `RunAllTestsInOrg` — slow on real orgs; confirm with the human first |

An `in_progress` result means call `validate_deploy` again to check on it.

### Step 4 — Read the one result

- **Validation failed** → no confirmation code was issued; fix and re-validate. The
  failure payload carries `component_failures`, the test counts, and
  `test_failure_detail` only — when validation fails on coverage, the warning strings
  are NOT returned; infer the gap from the component/test failures and cover more paths.
- `component_failures` → compile errors. Fix the source; this is the only compile
  feedback loop that exists.
- `test_failures` + `test_failure_detail` → decide test-side vs production-side: bad
  test data or brittle assertions get fixed in the test; broken production logic gets
  fixed in the class under test (platform-apex-generate doctrine), in the same package.
  Never bend an assertion to make a real bug pass.
- **Validation passed** with `code_coverage_warnings` → add tests for the uncovered
  paths (usually negative and bulk); coverage data beyond these strings does not exist
  in Contrail.
- Deeper runtime detail than the failure detail carries: if a trace flag is already
  active for the deploying user in that org, recent `get_debug_logs` entries may cover
  the test run (see platform-apex-logs-debug) — Contrail cannot create or manage trace
  flags, so if no logs exist for the run, say so rather than implying one can be
  enabled. Log bodies are client-confidential.
- **API version boundary:** when class metadata crosses from ≤66.0 to ≥67.0, recheck
  explicit sharing, decide user/system mode per operation, and grant required CRUD/FLS
  to test users or permission sets — then re-validate the affected tests.

### Step 5 — Fix and re-validate (bounded)

Each re-validation is a full checkOnly round-trip that supersedes the previous approval
code, so iterate deliberately, not reflexively:

1. Diagnose from `component_failures` / `test_failure_detail` — read the failing test
   and the class under test before changing either.
2. Apply the fix to the right side (test vs production code).
3. Re-validate the whole package and tell the human what changed since the last round.
4. **Maximum 3 iterations.** Still failing → stop, surface the root cause and what you
   tried, and ask how the human wants to proceed. No silent retry loops.

### Step 6 — Ship it

Follow **salesforce-house-rules §3**: present the validate summary (target org named
first; destructive changes and any `permission_warning` leading), the human reads the
confirmation code from the approval page in their browser, then `execute_deploy` with
the code they give you, then `refresh_snapshot`.

## Coverage expectations

| Level | Coverage | Purpose |
|-------|----------|---------|
| Production deploy | 75% minimum | Enforced by Salesforce at deploy time |
| Recommended | 90%+ | Best practice target |
| Critical paths | 100% | Business-critical code |

Contrail cannot show you percentages, so hit these **by construction**: cover every path
— positive, negative/exception, bulk (251+ records), callout/async — and treat any
`code_coverage_warnings` on a validate as a blocker. The org itself enforces the 75%
floor when the real production deploy runs.

## What to Test by Component

| Component | Key Test Scenarios |
|-----------|-------------------|
| Trigger | Bulk insert/update/delete, recursion guard, field change detection |
| Service | Valid/invalid inputs, bulk operations, exception handling |
| Controller | Page load, action methods, view state |
| Batch | start/execute/finish, scope matching (batch size >= record count), `Database.Stateful` tracking, error handling, chaining (separate methods — `finish()` calling `Database.executeBatch()` throws `UnexpectedException`) |
| Queueable | Chaining (only first job runs in tests), bulkification, error handling, callout mocks before `Test.startTest()` |
| Callout | Success response, error response, timeout |
| Selector | Valid/null/empty inputs, bulk (251+), field population, sort order, `WITH USER_MODE` via `System.runAs` |
| Scheduled | Direct execution via `execute(null)`, CRON registration via `CronTrigger` query |
| Platform Event | `Test.enableChangeDataCapture()`, `Test.getEventBus().deliver()`, verify subscriber side effects |

## Apex test data vs real org data

Data created inside test methods and `@TestSetup` exists only in the test transaction —
the platform rolls it back, it never touches real org records, and it needs **no
Contrail approval**. `SeeAllData=false`, always. Contrail's `dml_propose`/`dml_execute`
(human-approved) write REAL org records — for seeding actual org data such as manual-UAT
scenarios, never for Apex test setup. Do not conflate the two.

## TestDataFactory patterns

1. **Always accept a `doInsert` flag** — lets callers modify records before insert
2. **Append the loop index to fields that participate in matching rules** — prevents
   `DUPLICATES_DETECTED` from active Duplicate Rules
3. **Single-record methods delegate to bulk** — `createAccount(doInsert)` calls
   `createAccounts(1, doInsert)[0]`
4. **Return created records** — enables chaining and further manipulation
5. **Set all required fields** — including fields enforced by validation rules, not
   just schema-required ones (what `describe_schema` in Step 1 is for)

Field override pattern — callers override defaults without new factory methods:

```apex
public static Account createAccount(Map<String, Object> fieldOverrides, Boolean doInsert) {
    Account acc = new Account(Name = 'Test Account', Industry = 'Technology');
    for (String fieldName : fieldOverrides.keySet()) {
        acc.put(fieldName, fieldOverrides.get(fieldName));
    }
    if (doInsert) insert acc;
    return acc;
}
```

Record types: resolve via
`Schema.SObjectType.Account.getRecordTypeInfosByDeveloperName().get(name).getRecordTypeId()`
— never hardcode record type ids. Duplicate rules — when unique values alone are not
enough, allow saves explicitly:

```apex
Database.DMLOptions dml = new Database.DMLOptions();
dml.DuplicateRuleHeader.allowSave = true;
Database.insert(accounts, dml);
```

## Assertion patterns

| Method | Use case |
|--------|----------|
| `Assert.areEqual(expected, actual, msg)` | Exact equality |
| `Assert.areNotEqual(expected, actual, msg)` | Value should differ |
| `Assert.isTrue(cond, msg)` / `Assert.isFalse(cond, msg)` | Boolean conditions |
| `Assert.fail(msg)` | Force failure (expected exception not thrown) |
| `Assert.isNotNull(v, msg)` / `Assert.isNull(v, msg)` | Null checks |

**Always include the message parameter** — it is what makes a failure actionable in
`test_failure_detail`.

```apex
// Bad: no message; tests coverage, not behavior
Assert.isTrue(accounts.size() > 0);
// Good: exact count derived from setup, descriptive message
Assert.areEqual(251, accounts.size(), 'All 251 accounts should be processed');
// Partial-success DML:
Database.SaveResult sr = Database.insert(invalidAccount, false);
Assert.isFalse(sr.isSuccess(), 'Insert should fail for invalid data');
Assert.isTrue(sr.getErrors()[0].getMessage().contains('REQUIRED_FIELD_MISSING'),
    'Error should indicate missing required field');
```

Collections: `Assert.isTrue(list.isEmpty(), msg)` / `Assert.isFalse(list.isEmpty(), msg)`
for emptiness; exact size otherwise. Date/DateTime: compare against values computed from
setup (e.g. `Date.today().addDays(30)`), never hardcoded date literals.

| Anti-pattern | Fix |
|---|---|
| `Assert.isTrue(results.size() > 0)` | `Assert.areEqual(expectedCount, results.size(), ...)` |
| `Assert.isTrue(results.size() >= expected)` | Compute the exact expected count |
| `Assert.isTrue(count != 0)` | `Assert.areEqual(expectedCount, count, ...)` |
| Testing implementation not behavior | Assert on observable outcomes (field values, record counts) |
| Missing negative-test assertions | Verify the actual outcome, not just "no exception" |

## Mocking patterns

**HTTP callouts** — real callouts are forbidden in tests; implement `HttpCalloutMock`:

```apex
@isTest
public class MockHttpResponse implements HttpCalloutMock {
    private Integer statusCode; private String body;
    public MockHttpResponse(Integer statusCode, String body) {
        this.statusCode = statusCode; this.body = body;
    }
    public HTTPResponse respond(HTTPRequest req) {
        HttpResponse res = new HttpResponse();
        res.setStatusCode(statusCode);
        res.setBody(body);
        res.setHeader('Content-Type', 'application/json');
        return res;
    }
}
// In the test — mock BEFORE Test.startTest():
Test.setMock(HttpCalloutMock.class, new MockHttpResponse(200, '{"status":"ok"}'));
```

Multi-request variant — for services making several callouts, key responses by
endpoint with a 404 fallback for anything unmatched:

```apex
public class MultiRequestMock implements HttpCalloutMock {
    private Map<String, HttpResponse> responses; // endpoint → response
    public MultiRequestMock(Map<String, HttpResponse> responses) { this.responses = responses; }
    public HttpResponse respond(HttpRequest req) {
        HttpResponse res = responses.get(req.getEndpoint());
        if (res == null) { res = new HttpResponse(); res.setStatusCode(404); }
        return res;
    }
}
```

Use `StaticResourceCalloutMock` when the response JSON is large.

**SOSL** — returns empty in tests by default; call
`Test.setFixedSearchResults(new List<Id>{ acc.Id })` before the search.

**DML isolation** — constructor injection: public constructor wires the real handler, a
`@TestVisible private` constructor accepts a mock implementing the DML interface.

**Apex dependencies** — `System.StubProvider` +
`Test.createStub(IMyService.class, mockProvider)`; branch on `stubbedMethodName` inside
`handleMethodCall`.

**Email** — tests never send mail; assert on `Limits.getEmailInvocations()`
before/after the call.

**Platform events** — `Test.enableChangeDataCapture()`, publish, then
`Test.getEventBus().deliver()` inside start/stop; assert subscriber side effects.

## Async testing patterns

`Test.stopTest()` forces queued async work to execute synchronously — assert after it.

**Batch:** in test context only ONE `execute()` runs — set
`batchSize >= testRecordCount` (e.g. `Database.executeBatch(batch, 300)` with 251
records) and never create more records than the batch size. Test chaining in a separate
method: `finish()` calling `Database.executeBatch()` during a test can throw
`UnexpectedException` — verify the first batch independently, then that `finish()`
enqueues the next. **Batch with failures:** insert deliberately invalid records
alongside valid ones, then assert on the error-log records (e.g. `Error_Log__c` rows)
the batch's error handling produced — that is what proves partial-failure behavior.

**Queueable:** only the FIRST chained job executes in tests. Verify the first job's
effects, then that the chain was enqueued (query `AsyncApexJob` by `ApexClass.Name`),
and test each job independently. Callout mocks must be set **before** `Test.startTest()`.

**Future:** call inside start/stop; assert on the re-queried record after `stopTest`.

**Scheduled:** two methods — direct execution (`scheduled.execute(null)` inside
start/stop, assert effects) and CRON registration (`System.schedule(...)`, then query
`CronTrigger` for `CronExpression` and `State = 'WAITING'`).

| Pitfall | Impact |
|---|---|
| Missing `Test.stopTest()` | Async never executes; assertions fail silently |
| Expecting all chained queueables to run | Only the first runs; test each independently |
| Mock set after `Test.startTest()` | Callout mock must be set before it |
| Batch size < record count in tests | Only `batchSize` records processed |

## Deliverables

Per test-generation request, ONE `validate_deploy` package containing:

- `{ClassName}Test.cls` — the test class (source body only; Contrail generates the
  class metadata — never author `-meta.xml`)
- `TestDataFactory.cls` — only if the org does not already have one
- The class under test, when it is new or changed in the same effort
- **The permission-set pairing** (building-salesforce-metadata cardinal rule): if the
  package introduces new production Apex meant to be called from UI or flows, include a
  `PermissionSet` with a `classAccesses` grant block for it in the same package. Test
  classes and the TestDataFactory themselves need no `classAccesses` — users never
  invoke them.

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; workflow restructured for Contrail's human-approval write contract.*
