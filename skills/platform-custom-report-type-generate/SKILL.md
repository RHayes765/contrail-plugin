---
name: platform-custom-report-type-generate
description: "Use this skill when users need to create, generate, or validate Salesforce Custom Report Type metadata through Contrail. Trigger when users mention custom report types, report types, CRTs, reporting frameworks, cross-object reports, report builder data sources, or ask to expose fields for reporting across related objects. Also use when users mention primary and related objects for reports, inner vs outer joins in reports, report type categories, or when a validate_deploy of ReportType metadata fails. DO NOT TRIGGER for: authoring the reports themselves — columns, filters, charts, folders, or Report metadata (that is platform-report-generate); dashboards or list views; or running, editing, or filtering existing reports in the org UI."
metadata:
  domains: ["Platform"]
  minApiVersion: "51.0"
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.0"
    adapted: "2026-09-08"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-report-generate"
---

# Salesforce Custom Report Type Generator and Validator

Custom Report Types (CRTs) define the **data framework** for Salesforce reports.
They specify a primary object, up to 3 related objects, the relationship (join)
between them, and which fields are available in the report builder. This skill
generates and validates ReportType metadata for deployment through the Contrail
engine.

**Environments, once:** in Claude Desktop chat (no file tools) author metadata
INLINE and pass it as `validate_deploy` `content`. In Claude Code, write files
under Contrail's `staging/` directory (under the data dir) and pass
`content_file` with the absolute path — mandatory for anything large.

## Purpose

- Enable reporting across custom objects and custom relationships not covered by standard report types
- Curate a focused set of fields for report builders (including fields reached via lookup)
- Control inner/outer join behavior to include or exclude primary records without related records

## 1. How a CRT deploys through Contrail

ReportType is a **flat, top-level component** — fully supported, zero caveats:

```jsonc
{ "type": "ReportType", "api_name": "AccountsWithProjects",
  "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ReportType xmlns=\"http://soap.sforce.com/2006/04/metadata\">…</ReportType>" }
```

- **`content` is the full document** — XML declaration plus the
  `<ReportType xmlns="http://soap.sforce.com/2006/04/metadata">` root. The
  packager generates `package.xml` and file placement itself; never author
  manifests or prescribe file-tree paths.
- **`api_name` is the CRT's developer name, flat** — no folder qualifier, no
  dots. (Reports are folder-qualified; report *types* are not.)
- **`<fullName>` must equal `api_name` exactly** — Rule 1 below.
- In the org snapshot the artifact sits at
  `<data dir>/snapshots/<connection-id>/current/reportTypes/<Name>.reportType`,
  and `retrieve_metadata` type `ReportType` reads it by the same flat name.
- **Source-format translation:** source-format repos store the identical
  document as `<Name>.reportType-meta.xml` — the body is unchanged; only the
  extension and packaging differ. Deploy the document itself and drop any
  project-layout framing.

## 2. Ground before you author

House rules first: `list_connections`, `get_permissions` — see
salesforce-house-rules. Then, before generating XML:

| Check | Tool |
|---|---|
| Base object exists; exact field API names on every object in the chain | `describe_schema` on each object (API names, not labels; custom fields end `__c`) |
| Child relationship name for each `<join>` (`__r` for custom relationships) | `describe_schema` on the parent object — child relationships are listed with their relationship names |
| An existing CRT as a structural template | `retrieve_metadata` type `ReportType` — the retrieved document shows working join chains and `<table>` paths; `refresh_snapshot` first if absent or stale |
| What CRTs already exist (naming, duplicates) | `list_metadata` type `ReportType` |

If `get_permissions` shows the needed grant is missing, do **not** probe by
calling the tool anyway — record `<check>=unavailable: metadata_read not
granted`, offer `manage_connection`, and say so in the deploy summary. If the
snapshot is merely stale or missing, `refresh_snapshot` and retry. Never
silently skip a check.

## 3. Key Elements

Top-level `<ReportType>` children:

| Element | Required | Notes |
|---------|----------|-------|
| `<fullName>` | Yes | API identifier; must match the component `api_name`. Letters, numbers, underscores; must begin with a letter; no spaces; no trailing underscore; no consecutive underscores |
| `<label>` | Yes | Human-friendly name shown in the report type picker |
| `<description>` | Recommended | State the business "why" — who uses this and what they learn |
| `<baseObject>` | Yes | API name of the primary object (e.g. `Account`, `Project__c`). Cannot be changed after initial creation. All objects, including custom and external, are supported (external objects from API 38.0+) |
| `<category>` | Recommended | Report builder category — see `references/category-values.md` |
| `<deployed>` | Yes | `true` to expose to users; `false` while building/iterating |
| `<join>` | Conditional | Adds a related object and its join behavior. Nest further `<join>` blocks for deeper relationships |
| `<sections>` | Recommended | Groups of columns available to the report type. Though not strictly required, a report without columns isn't useful |

`<sections>` (group of columns) sub-elements:

| Element | Required | Notes |
|---------|----------|-------|
| `<masterLabel>` | Yes | Section heading shown in the report builder |
| `<columns>` | Conditional | One per field exposed in the section |

`<columns>` (single field) sub-elements:

| Element | Required | Notes |
|---------|----------|-------|
| `<field>` | Yes | Field API name (or dotted lookup-traversal path) |
| `<table>` | Yes | The object the field belongs to — base object name or dotted relationship path |
| `<checkedByDefault>` | Yes | `true` if the column is selected by default in the report builder |
| `<displayNameOverride>` | No | Custom column label shown in the report builder, overriding the field's default label |

## Critical Rules (Read First)

### Rule 1: `<fullName>` Must Match the Component `api_name`

The `<fullName>` element must equal the `api_name` you pass to
`validate_deploy` exactly — same characters, same casing, same underscores.
A mismatch either fails the deploy or creates a component under a name you did
not intend.

**Wrong** — api_name and `<fullName>` differ:
- `api_name`: `account_projects`
- `<fullName>AccountProjects</fullName>`
  (Mismatch: api_name uses `account_projects`, fullName uses `AccountProjects`)

**Right** — api_name and `<fullName>` are identical:
- `api_name`: `AccountProjects`
- `<fullName>AccountProjects</fullName>`

### Rule 2: Join Semantics — `outerJoin` Controls Inclusion

Each `<join>` block has an `<outerJoin>` element that determines which primary records appear in the report:

| `<outerJoin>` value | Behavior | Report Builder Label |
|---------------------|----------|----------------------|
| `false` | Inner join — only primary records that HAVE at least one related record | "Each 'A' record must have at least one related 'B' record" |
| `true` | Outer join — all primary records, with or without related records | "'A' records may or may not have related 'B' records" |

**Default when unspecified:** Use `true` (outer join) when the user wants to see all primary records regardless of children. Use `false` when the report only makes sense if children exist.

### Rule 3: Each Object Needs Its Own `<sections>` Block

Every object in the CRT (primary + each joined object) must have a corresponding `<sections>` block that lists the fields exposed for reporting. Without a section for an object, none of its fields appear in the report builder.

- `<masterLabel>` on each section is the section heading in the report builder
- `<columns>` entries list the fields — each with a `<field>` (API name) and `<table>` (object API name)
- For fields reached via lookup, use the relationship path in `<field>` (e.g. `Owner.Name` with `<table>` set to the owning object)

### Rule 4: Field API Names, Not Labels

Use exact API names for fields: standard fields use their defined names (`Name`, `CreatedDate`, `OwnerId`), custom fields use `Field__c`. Custom objects must include `__c`. Verify against `describe_schema` (§2).

**Wrong:**
- `<field>Account Name</field>`

**Right:**
- `<field>Name</field>` with `<table>Account</table>`

### Rule 5: Relationship Path for Joined Objects

When adding a `<join>`, the `<relationship>` element must use the **child relationship name** as defined on the lookup/master-detail field pointing from the child object to the parent. For custom relationships, this typically ends in `__r`.

**Wrong:**
- `<relationship>Project</relationship>` (for a custom child relationship)

**Right:**
- `<relationship>Projects__r</relationship>` (child relationship name)
- `<relationship>Contacts</relationship>` (standard, non-custom child relationship)

### Rule 6: Maximum 4 Objects Total in a Join Chain

A single CRT can join a maximum of **four objects total** (the base object + up to 3 additional objects via nested `<join>` blocks).

### Rule 7: No Inner Join After an Outer Join

Once the join chain contains an outer join (`<outerJoin>true</outerJoin>`), every subsequent nested join must also be an outer join. An inner join that follows an outer join earlier in the sequence is not allowed.

**Wrong:**
```xml
<join>
    <outerJoin>true</outerJoin>        <!-- outer join first -->
    <relationship>Contacts</relationship>
    <join>
        <outerJoin>false</outerJoin>   <!-- WRONG: inner join after outer -->
        <relationship>Assets</relationship>
    </join>
</join>
```

**Right:**
```xml
<join>
    <outerJoin>true</outerJoin>
    <relationship>Contacts</relationship>
    <join>
        <outerJoin>true</outerJoin>    <!-- outer stays outer -->
        <relationship>Assets</relationship>
    </join>
</join>
```

### Rule 8: `<table>` for Joined Objects Uses Dotted Path

In `<sections>`, the `<table>` element identifies which object in the join chain each column belongs to. For the base object, use the object name directly (e.g. `Account`). For joined objects, use the **dotted relationship path** from the base object.

| Object in chain | `<table>` value |
|-----------------|-----------------|
| Base (Account) | `Account` |
| First join (Account → Contacts) | `Account.Contacts` |
| Nested join (Account → Contacts → Assets) | `Account.Contacts.Assets` |

### Rule 9: Field Paths Can Traverse Lookups

`<field>` values may reference fields reached via lookup relationships using dot notation — for example `Owner.Email` (owner User's email) or `ReportsTo.CreatedBy.Contact.Owner.MobilePhone`. The `<table>` must still be the object that owns the starting field.

### Rule 10: Historical Trending Fields Use `_hst` Suffix

For a field with `trackTrending=true`, the API name in `<field>` and `<table>` uses the `_hst` suffix:

```xml
<columns>
    <checkedByDefault>false</checkedByDefault>
    <field>Field2__c_hst</field>
    <table>CustomTrendedObject__c.CustomTrendedObject__c_hst</table>
</columns>
```

### Rule 11: Primary Object Cannot Be Changed After Deployment

Once deployed, the `<baseObject>` of a CRT is locked. To change the primary object, create a new CRT and retire the old one.

### Rule 12: `autogenerated` Is Reserved for Historical Trending

The `<autogenerated>` element (API 29.0+) marks CRTs that Salesforce created automatically when historical trending was enabled on an object. Do not set this manually on hand-authored CRTs.

## Generation Workflow

### Step 1: Gather Requirements
- Primary object API name (e.g. `Account`, `Project__c`)
- Related objects and the relationship between each (which has the lookup/master-detail to which)
- For each relationship: inner join (children required) or outer join (children optional)?
- Which fields to expose per object — aim for task-relevant, not the full field list
- Audience and category — where should this appear in the report builder picker?
- Whether this ships as `deployed=true` now or stays `deployed=false` during iteration

### Step 2: Ground Against the Org
- Run the §2 checks: `describe_schema` for objects, fields, and relationship
  names; `retrieve_metadata` an existing CRT as a working template
- Compare against the retrieved structure rather than authoring from memory

### Step 3: Write the Specification
Document before authoring:
- `fullName` (= the component `api_name`) and `label`
- `baseObject`
- Category and `deployed` state
- Join chain: for each related object — relationship name, outer vs inner join
- Section layout: one section per object, ordered list of fields
- Acceptance criteria: which records should appear when the report runs, which fields are available in the builder

### Step 4: Author the Metadata

Start from the closest example in `examples/` and adapt it to the user's scenario:

- Primary object only (no joins) → `examples/AccountsWithIndustry.reportType`
- Outer join (primary records included even without children) → `examples/AccountsWithProjects.reportType`
- Nested inner join (every level requires children) → `examples/AccountProjectsWithTasks.reportType`

The component is `{type: "ReportType", api_name: "<DeveloperName>", content: full document}` (§1).

### Step 5: Validate and Deploy
- Well-formed XML with correct namespace (`xmlns="http://soap.sforce.com/2006/04/metadata"`)
- `api_name` matches `<fullName>` exactly
- `<baseObject>` is a valid API name and the object is deployed
- Every `<relationship>` uses the correct child relationship name (`__r` suffix for custom)
- Each object referenced in `<sections>` is part of the CRT (primary or joined)
- All `<field>` references exist on the parent `<table>` and use API names (not labels)
- `<category>` is a valid Salesforce category value
- `<deployed>` is `true` if users need to access the CRT immediately

Then deploy per **Deliverables and the deploy** below.

## Reference File Index

| File | When to read |
|------|--------------|
| `examples/AccountsWithIndustry.reportType` | Step 4 — primary-object-only template |
| `examples/AccountsWithProjects.reportType` | Step 4 — outer-join template (primary included even without children) |
| `examples/AccountProjectsWithTasks.reportType` | Step 4 — nested inner-join template (every level requires children) |
| `references/category-values.md` | Step 3 — to choose a valid `<category>` value from the `ReportTypeCategory` enum |
| `references/errors-and-troubleshooting.md` | When fields don't appear in the report builder or join requirements conflict |

## Verification Checklist

### Universal Checks
- [ ] Component shape: `{type: "ReportType", api_name: "<DeveloperName>", content: full document}` — XML declaration + `<ReportType xmlns="http://soap.sforce.com/2006/04/metadata">` root
- [ ] `api_name` satisfies the developer-name rules (begins with a letter, only letters/numbers/underscores, no spaces, no trailing underscore, no consecutive underscores)
- [ ] `<fullName>` matches `api_name` exactly (same characters, casing, and underscores)
- [ ] `<label>` is human-readable and under 40 characters
- [ ] `<description>` explains the business purpose
- [ ] `<baseObject>` uses a valid API name and that object is deployed
- [ ] `<category>` is a valid `ReportTypeCategory` enum value
- [ ] `<deployed>` is set appropriately (`true` for user access, `false` for in-progress iteration)
- [ ] `<autogenerated>` is NOT set manually (reserved for historical-trending CRTs)

### Join Checks
- [ ] Each `<join>` uses the correct child **relationship name** (not the lookup field API name)
- [ ] Custom relationships use `__r` suffix
- [ ] `<outerJoin>` is set intentionally: `true` = optional children, `false` = required children
- [ ] No inner join (`<outerJoin>false</outerJoin>`) appears after an outer join earlier in the sequence
- [ ] Total object count (base + joins, including nested) is 4 or fewer

### Section Checks
- [ ] Every object in the CRT has a corresponding `<sections>` block
- [ ] `<masterLabel>` on each section is descriptive
- [ ] Every `<columns>` has both `<field>` (API name) and `<table>` (object API name or dotted path)
- [ ] `<checkedByDefault>` is set for each column
- [ ] `<table>` for base object is the object API name (e.g. `Account`)
- [ ] `<table>` for joined objects uses the dotted relationship path (e.g. `Account.Projects__r`, `Account.Projects__r.Tasks__r`)
- [ ] Field references use API names (not labels); custom fields use `__c`
- [ ] Lookup traversal fields use dot notation (e.g. `Owner.Email`) with `<table>` set to the object owning the starting field
- [ ] Historical trending fields use `_hst` suffix in both `<field>` and `<table>` when applicable
- [ ] No duplicate fields within a section

## Deliverables and the deploy

1. Any new custom object or field the CRT exposes must already exist in the org
   or ship in the same package (platform-custom-object-generate /
   platform-custom-field-generate) — the API resolves in-package references.
2. The `ReportType` component itself.
3. Reports built on the CRT may ship in the same package
   (platform-report-generate); their `<reportType>` cites this CRT's developer
   name.

**No permission set pairs with a CRT** — no FLS-style grant exists for report
types. A `<deployed>true</deployed>` CRT is available in the report builder,
and users' existing field-level security governs the data they see at run time.

Then ONE consolidated `validate_deploy` (`content` inline for a hand-authored
CRT; `content_file` from staging when large). No-Apex packages OMIT
`test_level` entirely — the org's default handles them in every environment,
and production REFUSES an explicit `NoTestRun`. Lead the summary with the
target org; the human reads the confirmation code from the approval page, you
pass it to `execute_deploy`, then `refresh_snapshot` — the full ritual is
salesforce-house-rules §3. A CRT *deletion* is a destructive change — it goes
in `destructive`, is flagged prominently, and the human decides.

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; workflow restructured for Contrail's human-approval write contract.*
