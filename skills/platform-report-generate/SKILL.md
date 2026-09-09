---
name: platform-report-generate
description: "Use this skill when users need to create, generate, or validate Salesforce Lightning Report metadata through Contrail. Trigger when users mention reports, creating reports, report metadata, tabular reports, summary reports, matrix reports, joined reports, report columns, report groupings, report filters, report charts, cross-filters, bucket fields, report formulas, report time frame filters, or report folders and folder sharing. Also use when users say things like 'create a report', 'generate a report', 'build a report on Accounts', 'add a chart to my report', or when a validate_deploy of Report or ReportFolder metadata fails. DO NOT TRIGGER for: Custom Report Type metadata (platform-custom-report-type-generate), dashboards (platform-dashboard-generate), list views, running or viewing existing reports in the org UI, or SOQL queries."
metadata:
  domains: ["Platform"]
  minApiVersion: "60.0"
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.0"
    adapted: "2026-09-08"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-custom-report-type-generate"
    - "platform-dashboard-generate"
---

# Salesforce Lightning Report Generator and Validator

Lightning Reports define how Salesforce data is queried, grouped, filtered, and
displayed. This skill generates and validates Report metadata for deployment
through the Contrail engine.

## How a report deploys through Contrail

A report is one component; a NEW folder is a second component in the same package:

```jsonc
{ "type": "Report", "api_name": "Ops_Reports/Weekly_Pipeline",
  "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Report xmlns=\"http://soap.sforce.com/2006/04/metadata\">…</Report>" }
```

- **`content` is metadata format** — the full document: XML declaration plus
  the `<Report xmlns="http://soap.sforce.com/2006/04/metadata">` root. The
  packager generates `package.xml` and file placement itself; never author
  manifests or prescribe file-tree paths. (Source-format repos store the
  identical body as `<Name>.report-meta.xml` under a project directory — the
  body transfers unchanged; only the extension and packaging differ.)
- **`api_name` is folder-qualified**: `FolderDevName/ReportDevName`, e.g.
  `Ops_Reports/Weekly_Pipeline`. Unfiled reports use `unfiled$public/Name`.
  That single `/` is part of the api_name — the one place a path separator is
  legal in a Contrail component name (Rule 9).
- **A NEW folder ships as its own `ReportFolder` component** in the same
  package, and its `folderShares` ARE the access mechanism (Rule 14).
- **Snapshot reads:** an org's current report sits at
  `<data dir>/snapshots/<connection-id>/current/reports/<Folder>/<Name>.report`;
  `retrieve_metadata` type `Report` reads by the same `Folder/Name` api_name.
  Reports and dashboards are NOT in the default snapshot —
  `refresh_snapshot types:["Report"]` pulls them (ReportFolder rides along
  automatically).
- **Modifies are whole-document replaces** — start from the retrieved current
  document, never from memory.

**Environments, once:** in Claude Desktop chat (no file tools) author metadata
INLINE and pass it as `validate_deploy` `content`. In Claude Code, write files
under Contrail's `staging/` directory (under the data dir) and pass
`content_file` with the absolute path — mandatory for anything large.

## Ground before you author

House rules first: `list_connections`, `get_permissions` — see
salesforce-house-rules. Then:

| Check | Tool |
|---|---|
| Real platform column names for the report type | `retrieve_metadata` an EXISTING report of the same report type — its `<columns>` show them (Rule 2); `refresh_snapshot types:["Report"]` first if none are in the snapshot |
| Underlying fields exist (and exact custom-field API names) | `describe_schema` on the object |
| The report type exists and is deployed | `list_metadata` type `ReportType`, or `retrieve_metadata` it (platform-custom-report-type-generate to create one) |
| Existing folders (reuse before creating) | `refresh_snapshot types:["Report"]`, then read the snapshot's `reports/` folder names, or `list_metadata` type `ReportFolder` |

If `get_permissions` shows a needed grant missing, do **not** probe by calling
the tool anyway — record `<check>=unavailable: <grant> not granted`, offer
`manage_connection`, and say so in the deploy summary.

## Critical Rules (Read First)

**TOP DEPLOYMENT KILLERS — check these BEFORE generating any report:**
1. **Grouping fields in columns** — Fields in `<groupingsDown>` or `<groupingsAcross>` must NEVER also appear in `<columns>`
2. **Wrong column names** — Column names are report-type-specific. ALWAYS ground them against an existing report of the same type (Rule 2, `references/column-names.md`)
3. **Wrong scope** — LeadList uses `org`, not `organization`
4. **Filter column dot notation** — Filter `<column>` values use FLAT names (`INDUSTRY`, `TYPE`) NOT dot notation (`ACCOUNT.INDUSTRY` is INVALID)
5. **Multi-value picklist filters** — Use ONE `<criteriaItems>` with comma-separated `<value>` (e.g., `Technology,Financial Services`). Do NOT split into multiple criteriaItems with booleanFilter

### Rule 1: Format Determines Required Elements

| Format | `<groupingsDown>` | `<groupingsAcross>` | `<block>` |
|--------|-------------------|---------------------|-----------|
| `Tabular` | Not allowed | Not allowed | No |
| `Summary` | At least 1 (max 3) | Not allowed | No |
| `Matrix` | At least 1 (max 3) | At least 1 (max 3) | No |
| `Joined` | Not at top level | Not at top level | At least 2 (max 5) |

### Rule 2: Use Platform Column Names

Report metadata uses **platform report column names**, NOT raw API field names.
Contrail's column-name oracle is the org itself: **`retrieve_metadata` an
EXISTING report built on the same report type** — its `<columns>` show the real
platform column names — plus **`describe_schema`** to confirm the underlying
fields exist. `references/column-names.md` is the static mapping for common
standard report types; custom fields use `ObjectApiName.FieldApiName__c`.

### Rule 3: Valid Report Type Required

`<reportType>` must be a standard API name (e.g., `Opportunity`, `AccountList`, `CaseList`, `LeadList`, `AccountContactRole`) or a deployed custom report type developer name.

### Rule 4–5: Chart & Aggregates Require Summary/Matrix

Charts and `<aggregateTypes>` (Sum, Average, etc.) only work in Summary and Matrix reports.

### Rule 6–8: Limits

- Max **3 cross-filters** per report, each with up to **5 criteria items**
- `<booleanFilter>` must reference all filters sequentially (e.g., `1 AND (2 OR 3)`)
- Joined reports: 2–5 blocks, each block format must be Summary or Matrix (not Tabular)

### Rule 9: Folder-Qualified Names; New Folders Are Components

The folder is part of the report's identity: `api_name` is
`FolderDevName/ReportDevName` (`Ops_Reports/Weekly_Pipeline`;
`unfiled$public/Name` for unfiled). The folder must already exist in the org
**or** ship as its own component in the same package:

```jsonc
{ "type": "ReportFolder", "api_name": "Ops_Reports",
  "content": "<ReportFolder xmlns=…><name>Ops Reports</name><folderShares>…</folderShares></ReportFolder>" }
```

Never invent a folder silently — reuse an existing folder when one fits (see
"Ground before you author"), and give a new one deliberate `folderShares`
(Rule 14).

### Rule 10–11: Date Columns & Scope

- Date columns use platform names (`CLOSE_DATE`, not `CloseDate`)
- LeadList scope is `org`; Opportunity/AccountList/CaseList use `organization`

### Rule 12–13: Description & Groupings

- `<description>` max **255 characters**
- Grouping fields must NOT appear in `<columns>` — automatic deployment failure

### Rule 14: Folder Sharing IS the Access Mechanism

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ReportFolder xmlns="http://soap.sforce.com/2006/04/metadata">
    <folderShares>
        <accessLevel>Manage</accessLevel>
        <sharedTo>AllInternalUsers</sharedTo>
        <sharedToType>Group</sharedToType>
    </folderShares>
    <name>Ops Reports</name>
</ReportFolder>
```

Reports have **no FLS and no permission-set grant** — who can see and run a
report is decided by the folder's `folderShares`, full stop. That is why
`validate_deploy`'s `permission_warning` stays **silent for reports by
design** — it warns about folder sharing on the approval page instead. A report
deployed into an unshared folder is exactly as useless as a field without FLS
(the cardinal-rule exception in building-salesforce-metadata): ship the
`ReportFolder` with deliberate `folderShares` alongside any report headed for a
new folder.

### Rule 15: Valid Date Intervals Only

Use `INTERVAL_CURRENT` for "this quarter", `INTERVAL_CURY` for "this year", `INTERVAL_LAST30` for last 30 days. Do NOT use `INTERVAL_CURQ` — it is not valid. See `references/date-intervals.md` for the full list.

## Top-Level Elements

| Element | Required | Notes |
|---------|----------|-------|
| `<name>` | Yes | Report name (max 40 chars) |
| `<reportType>` | Yes | Report type API name |
| `<format>` | Yes | `Tabular`, `Summary`, `Matrix`, or `Joined` |
| `<scope>` | Recommended | `organization` (or `org` for LeadList) |
| `<columns>` | Yes | Field columns — each has `<field>` and optional `<aggregateTypes>` |
| `<filter>` | No | Contains `<criteriaItems>` with `<column>`, `<operator>`, `<value>` |
| `<groupingsDown>` | Conditional | Row groupings: `<field>`, `<dateGranularity>`, `<sortOrder>` |
| `<groupingsAcross>` | Conditional | Column groupings (Matrix only) |
| `<timeFrameFilter>` | Recommended | `<dateColumn>`, `<interval>`, optional `<startDate>`/`<endDate>` |
| `<chart>` | No | See `references/chart-types.md` |
| `<buckets>` | No | Bucket field definitions |
| `<crossFilters>` | No | Cross-object filters (`with`/`without`) |
| `<showDetails>` | Recommended | `true`/`false` |
| `<showGrandTotal>` | Recommended | `true`/`false` |
| `<showSubTotals>` | Recommended | `true`/`false` |
| `<description>` | Recommended | Business purpose (max 255 chars) |
| `<block>` | Conditional | Joined format blocks |

## Filter Syntax

```xml
<filter>
    <criteriaItems>
        <column>STAGE_NAME</column>
        <operator>equals</operator>
        <value>Closed Won</value>
    </criteriaItems>
</filter>
```

**Multi-value picklist:** Use ONE criteriaItem with comma-separated values:
```xml
<criteriaItems>
    <column>INDUSTRY</column>
    <operator>equals</operator>
    <value>Technology,Financial Services</value>
</criteriaItems>
```

Common operators: `equals`, `notEqual`, `lessThan`, `greaterThan`, `contains`, `startsWith`, `includes`, `excludes`, `isBlank`, `notBlank`. Full list in `references/filter-operations.md`.

## Generation Workflow

1. **Gather Requirements** — object, fields, groupings, filters, chart needs
2. **Determine Format** — no groupings → Tabular; row groupings → Summary; row + column → Matrix; multiple objects → Joined
3. **Identify Column Names** — `retrieve_metadata` an existing report of the same report type (its `<columns>` are the real platform names) + `describe_schema` for field existence; static mapping in `references/column-names.md`
4. **Author Metadata** — start from closest example in `examples/` and adapt
5. **Resolve the Folder** — reuse an existing folder in the api_name, or add a `ReportFolder` component with deliberate `<folderShares>` to the same package (Rules 9/14)
6. **Validate** — run through `references/verification-checklist.md`
7. **Deploy and Verify** — the salesforce-house-rules §3 ritual, then the post-deploy check below

## Post-deploy verification

After `execute_deploy` succeeds and `refresh_snapshot types:["Report"]` has run,
**run the report**: `get_report_data` executes the deployed report through the
synchronous Analytics API (needs the `data_read` grant — check
`get_permissions`). Confirm the columns are the ones you meant and the row
counts and values look sane — a report that deploys clean can still be empty or
mis-filtered, and this is the check that catches it. (Dashboards have no
equivalent — they cannot be executed this way; visual inspection in the org is
the only check there.)

## Reference File Index

| File | When to read |
|------|--------------|
| `references/column-names.md` | Step 3 — column name mappings per report type |
| `references/date-intervals.md` | When setting timeFrameFilter intervals |
| `references/chart-types.md` | When adding a chart — all 17 types + legendPosition rules |
| `references/filter-operations.md` | When building filters — complete operator reference |
| `references/verification-checklist.md` | Step 6 — pre-deploy validation |
| `references/errors-and-troubleshooting.md` | When fields are missing or deployment fails |
| `examples/TabularOpportunitiesReport.report` | Tabular report template |
| `examples/OpportunitiesByStageReport.report` | Summary report with chart |
| `examples/OpportunitiesByStageAndQuarter.report` | Matrix report template |
| `examples/AccountsCreatedThisYear.report` | Filtered report with time frame |

## Deliverables and the deploy

Everything the report needs travels in ONE package:

1. A new `ReportType`, if the report needs one (platform-custom-report-type-generate).
2. A new `ReportFolder` with deliberate `<folderShares>`, if the folder is new (Rules 9/14).
3. The `Report` component(s), folder-qualified api_name.

No permission set — folder sharing is the access mechanism (Rule 14). Then ONE
consolidated `validate_deploy` (`content` for hand-authored documents;
`content_file` from staging for anything large or edited from a retrieved
copy). No-Apex packages OMIT `test_level` entirely — the org's default handles
them in every environment, and production REFUSES an explicit `NoTestRun`.
Lead the summary with the target org and the folder-sharing consequences; the
human reads the confirmation code from the approval page, you pass it to
`execute_deploy`, then `refresh_snapshot types:["Report"]` — the full ritual is
salesforce-house-rules §3. Close the loop with `get_report_data`
(post-deploy verification above). A report or folder *deletion* is a
destructive change — it goes in `destructive`, is flagged prominently, and the
human decides.

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; workflow restructured for Contrail's human-approval write contract.*
