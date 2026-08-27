---
name: platform-custom-object-generate
description: "Use this skill when users need to create, generate, or validate Salesforce Custom Object metadata through the Contrail engine. Trigger when users mention custom objects, creating objects, object metadata, sharing models, name fields, record types, list views, or validation rules on objects. Also use when users say things like \"create a custom object\", \"generate object metadata\", \"set up an object for...\", or when troubleshooting validate_deploy failures on objects — especially sharing-model and Master-Detail errors. Always use this skill for any custom object metadata work, including enriching and keeping the object's description current whenever its fields or validation rules change. Do NOT use this skill for non-Custom-Object metadata (Apex, Flows, Custom Metadata Types, or standalone Permission Set authoring — this skill still bundles the PermissionSet that makes a new object usable) or for standard Salesforce objects."
metadata:
  version: "1.1"
  domains: ["Platform"]
  minApiVersion: "60.0"
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.1"
    adapted: "2026-08-26"
  relatedSkills:
    - salesforce-house-rules
    - building-salesforce-metadata
    - platform-custom-field-generate
    - platform-validation-rule-generate
    - platform-permission-set-generate
---

# Custom Object generation (Contrail)

Use this skill to:
- Create new custom objects and generate CustomObject metadata XML
- Configure object sharing, name field, and feature settings
- Troubleshoot object deploy failures surfaced by `validate_deploy`
- **Add, update, or delete a field OR a validation rule on an existing object** — any of these may make the object's `<description>` stale; refresh it (propose wording → confirm → include in the deploy package). See "Object description".

**Operating contract:** every deploy in this skill is proposal-only. You author and validate; the write happens only after the human reads the confirmation code from the approval page — `validate_deploy` (checkOnly) → human reads the code back → `execute_deploy` → `refresh_snapshot`. See **salesforce-house-rules §3**. Never restate "done" as "deployed" — your deliverable is a validated, approvable package.

**Environments, once:** in Claude Desktop chat there are no file tools — author metadata inline via `validate_deploy` `content`. In Claude Code, write sources into Contrail's `staging/` directory and pass `content_file` (absolute path). For large existing objects, `content_file` is the only safe modify path; in Desktop chat prefer surgical child-block components and say plainly when a root-level edit on a huge object is not safely re-emittable inline.

---

## 1. Identity and packaging (Contrail specifics)

There is no local project and no filename-as-identity. A CustomObject deploys as one component, inside `validate_deploy {connection: "<alias>", components: [...]}`:

```jsonc
{ "type": "CustomObject", "api_name": "Vehicle__c", "content": "<CustomObject xmlns=...>...</CustomObject>" }
```

- **`api_name` is the identity.** Do NOT put `<fullName>` at the root of the CustomObject document — the API name comes from the component's `api_name`, and a root `<fullName>` fails deployment.
- Contrail generates any `-meta.xml` it needs from the configured apiVersion (existing snapshot meta wins on modify) — never author meta files.
- **Child components** deploy standalone with dotted names; `content` is the bare XML block exactly as `retrieve_metadata` returns it. Child blocks DO carry their own inner `<fullName>` (short name, not dotted):

| Child type | Tag | Component shape |
|---|---|---|
| CustomField | `<fields>` | `{type: "CustomField", api_name: "Vehicle__c.VIN__c", content: "<fields>...</fields>"}` |
| ValidationRule | `<validationRules>` | `{type: "ValidationRule", api_name: "Vehicle__c.Require_VIN", content: "<validationRules>...</validationRules>"}` |
| ListView | `<listViews>` | `{type: "ListView", api_name: "Vehicle__c.All_Vehicles", content: "<listViews>...</listViews>"}` |
| RecordType | `<recordTypes>` | `{type: "RecordType", api_name: "Vehicle__c.Fleet", content: "<recordTypes>...</recordTypes>"}` |

- **Never mix** the full object document and individual children of the same object in one package — Contrail refuses it. Pick one form per object per deploy.
- A full-object deploy is **additive for children** (it does not delete unlisted fields; deletions need `destructive` entries) but root properties present in the document replace org values — so always edit from a freshly retrieved complete definition.
- Choosing the form: root-level changes (`<description>`, `sharingModel`, name field, feature flags) require the **full document**; a change touching only one field/rule/view can ship as a **child block**. Precedence: a field/ValidationRule change on an existing object ships as a child block **only when the wording confirmation returned "keep current"** (or the change is a ListView/RecordType, which never triggers a refresh); in every other case the description refresh forces the full document, so author it that way from the start. When a child change and a description refresh land together, fold both into one full-document deploy so the human approves one coherent change.

## 2. Reading before writing

- `list_connections` first; check `metadata_write` via `get_permissions` — never probe by trying. If a needed grant is missing after checking, record `write=unavailable: metadata_write not granted on <alias>`, offer `manage_connection`, and stop.
- **Quick schema:** `describe_schema` (live) gives field names/labels/types/references, a picklist sample, formula flag, required, record types. It does **not** expose the object `<description>`, `unique`, `externalId`, or restricted-picklist flags.
- **Authoritative source (and all enrichment inputs):** `retrieve_metadata {connection: "<alias>", type: "CustomObject", names: ["Vehicle__c"]}` — the complete document, up to 250 KB by default (`max_bytes` up to 2,000,000; check `truncated`, and in Claude Code read `snapshot_path` when cut). Children read individually: `{connection: "<alias>", type: "CustomField", names: ["Vehicle__c.VIN__c"]}`.
- `refresh_snapshot` first if the snapshot is missing or stale; re-check freshness before editing anything you are about to change.
- `get_dependencies` (`used_by`) before renames or deletions — blast radius belongs in the approval summary.

---

## 3. Syntactic essentials (Tier 1)

### Required elements

| Element | Requirement | Notes |
|---------|-------------|-------|
| `<label>` | Required | Singular UI name |
| `<pluralLabel>` | Required | Plural UI name |
| `<sharingModel>` | Required | See Sharing Model Rules |
| `<deploymentStatus>` | Required | Always `Deployed` |
| `<nameField>` | Required | Needs `<label>` and `<type>` |
| `<visibility>` | Required | Always `Public` |

### Sharing model rules (reconciled)

There is **no flat default**. Choose deliberately:

- Object **has a Master-Detail field** → `ControlledByParent`, mandatory. `ControlledByParent` is *only* valid under a Master-Detail — using it elsewhere fails.
- Object has **no Master-Detail field** → choose `ReadWrite` or `Private` from the data's sharing needs: `Private` when records are ownership-scoped or sensitive (financials, HR, per-rep data); `ReadWrite` when the data is genuinely org-collaborative (shared reference/tracking data). If sensitivity is unclear from the request, ask — don't silently default to `ReadWrite`.
- Adding a Master-Detail field **to an existing object** → that object's `<sharingModel>` must also change to `ControlledByParent`. Since `sharingModel` is a root property, this means one full-document deploy: retrieve the whole object, set the sharing model, add the field inline, ship as a single CustomObject component.

**Error you are preventing:** `Cannot set sharingModel to ReadWrite on a CustomObject with a MasterDetail relationship field`

```xml
<!-- Object with a M-D field -->
<sharingModel>ControlledByParent</sharingModel>  <!-- ReadWrite here fails -->
```

## 4. Smart defaults and decision logic (Tier 2)

### A. Name field

| Type | When to use | Additional requirements |
|------|-------------|------------------------|
| **Text** | Default for human-named entities (Projects, Locations, Teams) | None |
| **AutoNumber** | Transactions, logs, IDs (Invoices, Requests, Tickets) | Must include `<displayFormat>` (e.g. `INV-{0000}`) and `<startingNumber>1</startingNumber>` |

```xml
<nameField><label>Project Name</label><type>Text</type></nameField>

<nameField>
  <label>Invoice Number</label>
  <type>AutoNumber</type>
  <displayFormat>INV-{0000}</displayFormat>
  <startingNumber>1</startingNumber>
</nameField>
```

### B. Object description (enrichment)

`<description>` is **mandatory** — every Custom Object gets one, composed fresh on create and re-proposed on **any** field or validation-rule change (add, update, delete — a validation-rule edit counts exactly like a field edit). Never ask *whether* to write a description; the only thing to confirm is the **wording**.

Two distinct confirmations — do not conflate them:

1. **Wording confirmation (this skill).** If the object already has a description, never replace it silently — it may be hand-authored by an admin. Show the proposal and **STOP — wait for the reply before packaging**:
   > Proposed description for `{Object}`:
   > `<the enriched description>`
   > Current: `<the existing description>`
   > Use this? (yes / keep current / edit)

   *yes* → use the proposed text · *keep current* → leave the existing text untouched (applies to **this change only** — re-propose on the next change; a prior "keep current" is never standing permission) · *edit* → use the user's wording. For a **brand-new object** there is nothing to overwrite: compose and include it without a wording prompt.
2. **Deploy approval (house rules).** Whatever wording wins goes **into the proposed package** — it reaches the org only through `validate_deploy` and the human's confirmation code. There is no auto-deploy trigger: "description refreshed" means *included in the validated package the human approves*, never "already written."

**Composing** (use the existing description as a strong signal — preserve its business context, fold the new field/rule in):

1. **Classify each field** by how it appears:
   - **Constrained** (required, unique, externalId, restricted picklist) → selective parenthetical: `VIN (required, external ID)`, `Color (Red/Green only)`
   - **Behavioral** (formula, roll-up) → behavior, never syntax: "the Age Years field auto-calculates vehicle age"
   - **Relationship** (master-detail, lookup) → woven context: "as a child of Account" — never "(Master-Detail to Account)"
   - **Standard** → label only

   When choosing which fields to surface, prioritize constrained > behavioral > relationship > standard.
2. **Compose in order**, field **labels not API names**:
   > Purpose → key fields → computed fields → validation rules (as business rules) → "Commonly used for {use cases}."
   Sentences 1–2 always; computed only if formula/roll-up fields exist; rules only if validation rules exist; use cases always unless over budget. Purpose comes from the user's words or is inferred from object name + key fields; infer 2–3 use cases from purpose, fields, relationships, and helpText.
3. **Count and trim (required):** aim ~45 words, hard ceiling 50. Tighten wording first, then drop whole sentences in priority order (use cases → rules → computed; never sentences 1–2). Do not finalize until ≤ 50.

**Writing rules:** open in third person ("The X object..."), never "Object used to track..." or "Tracks X"; no "Contains N fields including"; validations as business rules ("require VIN", not `ISBLANK(...)`); no markdown/backticks; must read as human-written documentation, comprehensible without the schema.

**Prioritization for big objects:** surface only the top 5–6 fields "along with additional tracking fields" — Tier 1: relationships, roll-ups, formulas, picklists; Tier 2: helpText, PII, externalId, trackHistory; Tier 3: everything else. Many validation rules: reference active rules only; if >20, summarize the 1–3 most important business-logic rules, never enumerate.

**Junction/child phrasing:** junction → "The {Label} object connects {ParentA} and {ParentB}, enabling many-to-many tracking between them." Child → "The {Label} object tracks {purpose} as a child of {Parent}."

**Edge cases:** bare object, no fields → "The Vehicle object tracks vehicle information." Only computed fields → each formula/roll-up gets a behavioral clause; no empty field list.

**Example (Car, 46 words):**
```xml
<description>The Car object tracks vehicle inventory and maintenance. It captures Year, VIN (required, external ID), Color (Red/Green only), and Location; the Age Years field auto-calculates vehicle age. VIN is required and Black cars cannot be sold. Commonly used for fleet management, inventory tracking, and service scheduling.</description>
```

**Enrichment inputs under Contrail:** `describe_schema` alone cannot classify (no unique/externalId/restricted-picklist, no current description) — retrieve the full CustomObject XML and read the attributes from the field blocks.

### C. Junction object naming

Name a many-to-many link object by combining the two parents: `Position_Candidate__c` (Position ↔ Candidate), `Job_Application__c` (Job ↔ Application).

### D. Feature enablement (clean XML)

Include optional tags only when deviating from the platform default of `false`:

- **User-facing objects** (apps, trackers, business entities): set `<enableSearch>`, `<enableReports>`, `<enableActivities>`, `<enableHistory>` to `true`.
- **System-facing objects** (junctions, background logs): omit these tags — keep the UI clean and the XML lean.

---

## 5. Critical constraints and common failures

### Reserved words — never use as API names

| Category | Reserved words |
|----------|----------------|
| SOQL/SQL | `Select`, `From`, `Where`, `Limit`, `Order`, `Group` |
| System | `User`, `External`, `View`, `Type` |
| Temporal | `Date`, `Number` |

### Relationship cap

At most **2 Master-Detail relationships** per object. A third relationship must be a Lookup.

### Validation rule naming

Validation rule names follow a different convention than fields:
- Alphanumeric + underscores only; must begin with a letter; cannot end with an underscore; no consecutive underscores
- **Must NOT end with `__c`** (unlike custom fields)

**Error you are preventing:** `The validation name can only contain alphanumeric characters, must begin with a letter, cannot end with an underscore...`

```xml
<validationRules>
  <fullName>Require_Start_Date</fullName>  <!-- NOT Require_Start_Date__c -->
  <active>true</active>
  <errorMessage>Start Date is required.</errorMessage>
  <formula>ISBLANK(Start_Date__c)</formula>
</validationRules>
```

| Metadata type | Naming pattern | Example |
|---------------|----------------|---------|
| Custom Fields | Ends with `__c` | `Start_Date__c` |
| Validation Rules | No suffix | `Require_Start_Date` |
| Custom Objects | Ends with `__c` | `Vehicle__c` |

### Deletions are destructive — the human decides

Deleting a field, validation rule, list view, record type, or the object itself goes into `validate_deploy`'s `destructive` array (`{type, api_name}`), never `components`. Destructive entries lead your approval summary (data loss risk stated plainly), per house rules. Never treat a delete as a routine step you initiate — surface it, with `get_dependencies` blast radius, and let the human decide on the approval page. A field/rule deletion the human approves still triggers a description re-proposal (Section 4.B).

---

## 6. Deliverables — components + permissions travel together

A Metadata API deploy grants no permissions: a deployed object is unreachable and its fields invisible until permissions exist. Per **building-salesforce-metadata**, a new-object package contains, in ONE `validate_deploy` call:

1. The **CustomObject** document (with inline `<fields>`, validation rules, and description)
2. Any standalone children for *other* existing objects (dotted child components)
3. A **PermissionSet** named for the feature (e.g. `Vehicle_Management_Access`) granting **`objectPermissions`** for the new object and **`fieldPermissions`** for every new custom field — so the human approves one coherent, usable change. If `validate_deploy` still returns `permission_warning`, lead your summary with it.

## 7. Deploy workflow

1. Author the package (Sections 1–6). In Claude Code: files under `staging/`, `content_file`; in Desktop chat: inline `content`.
2. One consolidated `validate_deploy` (checkOnly) with all components + any `destructive` entries. Objects alone need no tests; if the package also carries Apex to a production target, use `test_level: "RunLocalTests"` (or `RunSpecifiedTests` + `run_tests`).
3. Verification = the validation result. There is no local linter or analyzer; failures come back as component errors — fix the XML from the message and re-validate. If validation cannot run at all, record it fail-closed (e.g. `validate=unavailable: <reason>`) after attempting — never claim a package "should deploy."
4. Present the result — target org first and unmissable, destructive changes and `permission_warning` leading — then follow the approval ritual by reference: the human reads the confirmation code from the approval page, you pass it to `execute_deploy`, then `refresh_snapshot`. See **salesforce-house-rules §3**.

## 8. Verification checklist (before validate_deploy)

### Syntactic
- [ ] `<label>` and `<pluralLabel>` present; `<deploymentStatus>` = `Deployed`; `<visibility>` = `Public`
- [ ] `<nameField>` has `<label>` and `<type>`; AutoNumber has `<displayFormat>` + `<startingNumber>`

### Sharing model (critical)
- [ ] Master-Detail field present → `ControlledByParent` (and an existing child gaining an M-D gets a full-document sharingModel update)
- [ ] No Master-Detail → `ReadWrite` or `Private` chosen deliberately from data sensitivity (asked if unclear)

### Constraints
- [ ] API name free of reserved words; ≤ 2 Master-Detail relationships
- [ ] No `<fullName>` at the document root — identity is the component `api_name`
- [ ] Package does not mix the full object document with children of the same object

### Validation rules (if any)
- [ ] Names do NOT end with `__c`; alphanumeric + underscore pattern holds

### Description quality
- [ ] Opens "The {Object} object..." + business purpose; labels not API names; no field-count dump
- [ ] Formulas/rollups as behavior; validations as business rules; relationships as context
- [ ] "Commonly used for..." present; under 50 words; existing business context folded in, not discarded
- [ ] Existing description: wording proposed and the user's reply received before packaging — showing the diff is not approval

### Architectural
- [ ] `<description>` included in the package (Section 4.B)
- [ ] `<enableSearch>`/`<enableReports>` true if user-facing
- [ ] PermissionSet in the same package: `objectPermissions` + `fieldPermissions` (Section 6)
- [ ] Destructive entries (if any) lead the summary; blast radius checked with `get_dependencies`

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; workflow restructured for Contrail's human-approval write contract.*
