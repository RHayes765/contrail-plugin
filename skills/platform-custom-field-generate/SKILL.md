---
name: platform-custom-field-generate
description: "Use this skill when users need to create, generate, or validate Salesforce Custom Field metadata through Contrail. Trigger when users mention custom fields, field types, Roll-up Summary fields, Master-Detail relationships, Lookup relationships, formula fields, picklists, dependent (controlling) picklists, referencing a Global or Standard value set from a field, or scoping/limiting picklist values for a specific record type. Also use when a validate_deploy of field metadata fails, especially around Roll-up Summary format, Master-Detail constraints, formula issues, or a record type that won't deploy without a business process. DO NOT TRIGGER for modifying a StandardValueSet catalog like Industry or Lead Source (org-UI work, not deployable field metadata), or for object-level design (sharingModel, nameField, new objects) — that is platform-custom-object-generate. Creating a GlobalValueSet that a new field references IS in scope: it ships as its own component in the same package."
metadata:
  domains: ["Platform"]
  minApiVersion: "60.0"
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.0"
    adapted: "2026-08-26"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-custom-object-generate"
    - "platform-validation-rule-generate"
    - "platform-permission-set-generate"
---

# Salesforce Custom Field Generator and Validator

Generates and validates CustomField metadata XML for deployment through the
Contrail engine, with special handling for the **highest-failure-rate types** —
Roll-Up Summary and Master-Detail. Verify the constraints below before emitting
XML; every violation listed here is a real Metadata API deployment error.

**Environments, once:** in Claude Desktop chat (no file tools) author metadata
INLINE and pass it as `validate_deploy` `content`. In Claude Code, write files
under Contrail's `staging/` directory (under the data dir) and pass
`content_file` with the absolute path — mandatory for anything large.

---

## 1. How a field deploys through Contrail

A field is a **child component of CustomObject**. One component per field:

```jsonc
{ "type": "CustomField", "api_name": "Account.Total_Contract_Value__c",
  "content": "<fields>\n    <fullName>Total_Contract_Value__c</fullName>\n    …\n</fields>" }
```

Get the shape right or the deploy is malformed before it reaches the org:

- **`content` is a single `<fields>…</fields>` block** — the same shape
  `retrieve_metadata` returns for a CustomField. No XML declaration, no
  comments outside the block: the packager embeds it verbatim inside the
  `<CustomObject xmlns=…>` container document it builds, and generates
  `package.xml` and every `-meta.xml` itself (from the configured apiVersion;
  an existing snapshot meta wins on modify). Never author containers,
  manifests, or meta files, and never prescribe file-tree paths.
- **Source-format translation.** A decomposed source-format field file uses a
  standalone `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">`
  root. The child elements are identical — rename the root tag to `<fields>`
  and drop the xmlns to deploy it through Contrail. Every worked example below
  is already in the `<fields>` form Contrail consumes.
- **`api_name` is dotted (`Account.My_Field__c`); the inner `<fullName>` is
  bare (`My_Field__c`)** — the object half comes from the api_name.
- **Children of the same object merge** into one container in one call — a
  field plus the RecordType that filters it is one package, one approval.
- **Full object XOR children.** One package carries EITHER the full
  `CustomObject` document for X OR individual children of X — never both (the
  packager refuses the mix). Children are the default for field work: smaller
  diff, smaller blast radius.
- `RecordType`, `ValidationRule`, and `ListView` deploy the same way
  (`{type, api_name: "Object.Child", content: "<recordTypes>…</recordTypes>"}`).
  `GlobalValueSet` deploys as its own top-level component (full document, root
  `<GlobalValueSet xmlns=…>`). **BusinessProcess is NOT deployable as a
  Contrail component** — see §7 for the working routes.

## 2. Ground before you author

House rules first: `list_connections`, `get_permissions` — see
salesforce-house-rules. Then, before generating XML:

| Check | Tool |
|---|---|
| Duplicate / reserved field names, existing picklists | `describe_schema` on the object (300-field cap; `fields_truncated` tells you) |
| Master-Detail count (max 2), exact existing field XML | `retrieve_metadata` type `CustomObject` — count `<type>MasterDetail</type>` blocks; `refresh_snapshot` first if stale |
| Fields a formula references exist | `describe_schema` |
| A referenced GlobalValueSet exists | `list_metadata` type `GlobalValueSet` (in the default snapshot manifest), or `live=true` |
| Existing BusinessProcesses on Opportunity/Lead/Case/Solution | `retrieve_metadata` type `CustomObject` — read the `<businessProcesses>` blocks |

If `get_permissions` shows the needed grant is missing, do **not** probe by
calling the tool anyway — record `<check>=unavailable: metadata_read not
granted`, offer `manage_connection`, and say so in the deploy summary. If the
snapshot is merely stale or missing, `refresh_snapshot` and retry. Never
silently skip a check.

---

## 3. Universal Mandatory Attributes

Every generated field must include:

| Attribute | Requirement | Notes |
|-----------|-------------|-------|
| `<fullName>` | Required | **Field** name only, bare (no object prefix — that lives in `api_name`): derive from `<label>` — capitalize each word, spaces → `_`, append `__c`; must start with a letter. Label `Total Contract Value` → `Total_Contract_Value__c`. **Picklist VALUE `<fullName>` is different — keep it exactly as the user spelled it, spaces and all, no `__c`** (`Closed Won`, NOT `Closed_Won`). See §6.3. |
| `<label>` | Required | The UI name (Title Case) |
| `<description>` | Always include | The business reason *why* this field exists |
| `<inlineHelpText>` | Always include | Actionable end-user guidance beyond the label ("Enter the value in USD including tax", not "The amount") |

`<description>` and `<inlineHelpText>` are mandatory outputs even though the
Metadata API does not enforce them — omitting them produces low-quality metadata.

**External ID:** if the user mentions "integration," "importing data,"
"external system ID," or "unique key from [System]" → set
`<externalId>true</externalId>`. Applicable types: Text, Number, Email.

---

## 4. Precision, Scale, and Length Rules

- `precision` = total digits; `scale` = decimal digits. **Rule:**
  `precision ≤ 18` AND `scale ≤ precision`; digits left of the decimal =
  `precision - scale`.
- **The "Fixed 255" rule — TextArea: do NOT include `<length>`.** The API fixes
  it at 255 implicitly and **rejects an explicit value** ("Can not specify
  'length' for a CustomField of type TextArea"). A TextArea needs only
  `<fullName>`, `<label>`, `<type>TextArea</type>` (plus description/help).
- **Visible lines** are mandatory for Long/Rich text and Multi-select
  picklists to control UI height.

---

## 5. Field Data Types

### 5.1 Simple Attribute Types

| Type | `<type>` Value | Required Attributes |
|------|----------------|---------------------|
| Auto Number | `AutoNumber` | `displayFormat` (must include `{0}`), `startingNumber` |
| Checkbox | `Checkbox` | Default `defaultValue` to `false` |
| Date | `Date` | No precision/length |
| Date/Time | `DateTime` | No precision/length |
| Email | `Email` | Built-in format validation |
| Lookup Relationship | `Lookup` | `referenceTo`, `relationshipName`, `deleteConstraint` |
| Master-Detail Relationship | `MasterDetail` | `referenceTo`, `relationshipName`, `relationshipOrder` |
| Number | `Number` | `precision`, `scale` |
| Currency | `Currency` | Default precision 18, scale 2 |
| Percent | `Percent` | Default precision 5, scale 2 |
| Phone | `Phone` | Standardizes phone formatting |
| Picklist | `Picklist` | `valueSet` containing EITHER `valueSetDefinition` (inline) OR `valueSetName` (reference); `restricted` (default below; advanced in §6) |
| Text | `Text` | `length` (max 255) |
| Text Area | `TextArea` | None — do NOT include `<length>` (§4) |
| Text (Long) | `LongTextArea` | `length`, `visibleLines` (default 3) |
| Text (Rich) | `Html` | `length`, `visibleLines` (default 25) |
| Time | `Time` | Time only, no date |
| URL | `Url` | Protocol/format validation |

### 5.2 Computed, Multi-Value & Specialized Types

| Type | `<type>` Value | Required Attributes |
|------|----------------|---------------------|
| Formula | Result type (e.g. `Number`) | `formula`, `formulaTreatBlanksAs` — see §10 |
| Roll-Up Summary | `Summary` | See §9 |
| Multi-Select Picklist | `MultiselectPicklist` | `valueSet`, `visibleLines` (default 4) |
| Geolocation | `Location` | `scale`, `displayLocationInDecimal` |

### Picklist `restricted` default

**Always set `<restricted>true</restricted>`** inside `<valueSet>` unless the
user explicitly says values outside the admin-defined list are allowed
("unrestricted"/"open"). Restricted sets cap at 1,000 total values
(active + inactive). Minimal inline shape:

```xml
<fields>
    <fullName>Status__c</fullName><label>Status</label>
    <description>Lifecycle status of the record</description>
    <inlineHelpText>Select the current lifecycle stage</inlineHelpText>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>Option A</fullName><default>false</default><label>Option A</label></value>
        </valueSetDefinition>
    </valueSet>
</fields>
```

`<value>` also accepts `<color>`, `<isActive>`, and a value-level
`<description>` — §6.3.

---

## 6. Advanced Picklists

### 6.1 Value-set references (`<valueSetName>`)

**HARD RULE: a `<valueSet>` holds EITHER `<valueSetName>` (reference) OR
`<valueSetDefinition>` (inline) — never both.** Both at once fails:
`Value set must reference a value set name or define a value set, but not both.`

The SAME `<valueSetName>` element references both kinds of shared set:

| Referenced set | `<valueSetName>` value |
|----------------|------------------------|
| **StandardValueSet** (platform catalog: Industry, LeadSource, …) | Bare enum name — NO `__c`, NO `__gvs` → `Industry` |
| **GlobalValueSet** | Bare developer name — NO `__c`, **NO `__gvs`** → `Priority_Levels` |

> **Always the bare developer name — never `__gvs`.** API 57.0+ orgs
> store/display a GlobalValueSet name with an internal `__gvs` suffix, but the
> Metadata API (deploy AND retrieve) uses the bare name — a retrieve showing
> `__gvs` is org-storage display only. Never append `__c` either.

A value-set-backed field is `<restricted>true</restricted>` by design — its
values can only change by editing the set. The whole `<valueSet>` is just:

```xml
    <valueSet>
        <restricted>true</restricted>
        <valueSetName>Priority_Levels</valueSetName>
    </valueSet>
```

**Creating the set itself:** `GlobalValueSet` is a deployable Contrail type. If
the referenced set does not exist yet, author it as its own component **in the
same package** as the field — the API resolves in-package references. Note the
value element is `<customValue>`, not `<value>`:

```jsonc
{ "type": "GlobalValueSet", "api_name": "Priority_Levels", "content":
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<GlobalValueSet xmlns=\"http://soap.sforce.com/2006/04/metadata\">\n    <masterLabel>Priority Levels</masterLabel>\n    <sorted>false</sorted>\n    <customValue><fullName>High</fullName><default>false</default><label>High</label></customValue>\n    <customValue><fullName>Low</fullName><default>false</default><label>Low</label></customValue>\n</GlobalValueSet>" }
```

(Top-level file types DO carry the XML declaration and xmlns root — only child
blocks omit them.) **StandardValueSet catalogs are not deployable through
Contrail** — a field may reference one, but editing the catalog is org-UI work.

### 6.2 Controlling / dependent picklists

The dependency lives on the **dependent** field. Use the **modern API 38.0+
form ONLY** — never the legacy `<picklist>` / `<picklistValues>` /
`<controllingFieldValues>` tags (they fail: `Element …picklist is not allowed`).

**HARD RULE: BOTH the controlling and the dependent field must be
`<restricted>true</restricted>`**, even when the request doesn't say so.

Inside the dependent field's `<valueSet>`, in order:
1. `<controllingField>` — API name of the controlling field;
2. `<valueSetDefinition>` — the dependent field's own values (the mapping does
   **NOT** go in here);
3. one `<valueSettings>` block per (controlling value, dependent value) pair —
   **siblings** of `<valueSetDefinition>`. Four pairs = four blocks.

> **⛔ THE #1 MISTAKE: `<controllingFieldValue>` inside a `<value>`.** The
> mapping lives in separate `<valueSettings>` siblings, never nested inside
> `<valueSetDefinition>` — nesting fails with
> `Element controllingFieldValue invalid at this location in type CustomValue`.

```xml
<fields>
    <fullName>State__c</fullName><label>State</label>
    <description>State filtered by the selected Country</description>
    <inlineHelpText>Available states depend on the Country you picked</inlineHelpText>
    <type>Picklist</type>
    <valueSet>
        <controllingField>Country__c</controllingField>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>California</fullName><default>false</default><label>California</label></value>
            <value><fullName>Texas</fullName><default>false</default><label>Texas</label></value>
        </valueSetDefinition>
        <valueSettings><controllingFieldValue>USA</controllingFieldValue><valueName>California</valueName></valueSettings>
        <valueSettings><controllingFieldValue>USA</controllingFieldValue><valueName>Texas</valueName></valueSettings>
    </valueSet>
</fields>
```

The controlling field (`Country__c`) is a plain restricted picklist defining
`USA`, `Canada`, etc. A dependent value valid under a second controlling value
gets another `<valueSettings>` block for that pair. Ship both fields in the
same package when both are new.

### 6.3 Value-name fidelity and enhanced value attributes

**A picklist value's `<fullName>` is NOT a field API name — never transform
it.** Use the value text exactly as the user spelled it, spaces and all.
Underscoring a value changes its identity and breaks any RecordType
`<picklistValues>` / `<valueSettings>` that references it by real name.

| Element | Spaces? | `__c` suffix? | Example for "Closed Won" |
|---|---|---|---|
| **Field** `<fullName>` | ❌ replace with `_` | ✅ required | `Status__c` (the field) |
| **Picklist value** `<fullName>` | ✅ keep as written | ❌ never | `Closed Won` |
| **Picklist value** `<label>` | ✅ keep as written | ❌ never | `Closed Won` |

Inline `<value>` entries also accept `<color>` (hex, leading `#`),
`<isActive>` (`false` retires a value without deleting it, preserving history —
inactive values still count toward the 1,000-value cap), and a value-level
`<description>`. A value `<fullName>` must start with a
letter: no hyphens, no leading digit; **spaces ARE allowed** — `1st-Choice`
fails, fixed as `<fullName>First Choice</fullName><label>1st Choice</label>`.
The stricter "alphanumerics and single underscores" rule is for the *field*
`<fullName>` only. Duplicate value `<fullName>`s in one `<valueSetDefinition>`
are rejected (§11).

---

## 7. Scoping a Picklist to a Record Type

> **Scope note.** This covers ONLY the picklist seam between a CustomField and
> a RecordType — "expose a subset of *this field's* values for record type X."
> General record-type authoring (layouts, branding, page assignments) is out of
> scope; say so rather than guessing.

Per-record-type value visibility lives on the **RecordType**, not the field —
the field keeps its full value set; the record type filters what appears. In
Contrail, RecordType is a CustomObject child:

```jsonc
{ "type": "RecordType", "api_name": "Account.Internal",
  "content": "<recordTypes>\n    <fullName>Internal</fullName>\n    <label>Internal</label>\n    <active>true</active>\n    <picklistValues>\n        <picklist>Status__c</picklist>\n        <values><fullName>Qualified</fullName><default>true</default></values>\n        <values><fullName>Closed Won</fullName><default>false</default></values>\n    </picklistValues>\n</recordTypes>" }
```

| Element | Requirement | Notes |
|---|---|---|
| `<fullName>` | Required, **bare** developer name | The object comes from `api_name` |
| `<picklistValues>` | One per filtered picklist | `<picklist>` = field API name (`Status__c`, or `StageName` for standard) |
| `<values>` | One per **exposed** value | Omitted values are hidden (NOT deleted from the field) |
| `<values><fullName>` | The value's exact name | Must match the field's spelling exactly — `Closed Won`, with the space |
| `<values><default>` | Required | `true` on exactly one value, `false` on the rest |

### STEP 1 — decide if the object needs a BusinessProcess (BEFORE authoring)

A record type on **Opportunity, Lead, Case, or Solution will NOT deploy without
a `<businessProcess>` reference** — even when it only filters a *custom*
picklist (`Required field is missing: businessProcess`). **Every other object —
all custom objects (`*__c`), Account, Contact, the rest — needs NO
BusinessProcess; do not invent one.**

**BusinessProcess is not a deployable Contrail component** (neither standalone
nor as a child). For the gated four, the working routes:

1. **Reference an existing one** (preferred). `retrieve_metadata` type
   `CustomObject` for the object, read its `<businessProcesses>` blocks, put
   that developer name in `<businessProcess>`, deploy just the RecordType child.
2. **None exists →** either create the process in the org UI first (Setup →
   Object Manager → [Object] → Sales/Lead/Support Processes), then deploy the
   RecordType child referencing it; **or** deploy the **full CustomObject
   document** (type `CustomObject`, content = the whole retrieved `.object`
   with the `<businessProcesses>` and `<recordTypes>` blocks added). The
   full-object route is a bigger blast radius — retrieve the object WHOLE
   first, edit, pass `content_file` (never retype a large object inline; in
   Desktop chat, with no file tools, prefer the org-UI route). And the full
   object cannot mix with individual children of it in one package.

**BusinessProcess gotchas (inside a full-object deploy):** the block added to
the full `.object` document looks like this —

```xml
<businessProcesses>
    <fullName>Enterprise_Sales_Process</fullName>
    <isActive>true</isActive>
    <values><fullName>Prospecting</fullName></values>
    <values><fullName>Closed Won</fullName></values>
</businessProcesses>
```

- The `<businessProcesses>` block's `<fullName>` is **bare**
  (`Enterprise_Sales_Process`, never `Opportunity.…`) and must be the
  identical string in the RecordType's `<businessProcess>` — a qualified name
  makes the reference unresolvable.
- Its `<values>` are the **standard stage/status picklist's** (Opportunity
  `StageName`), not your custom field's. **No `<default>` on Opportunity BP
  values** — `Cannot specify a default on: Opportunity` (Lead/Case/Solution
  allow one).
- **Element order:** `<businessProcess>` after `<active>` and **before**
  `<picklistValues>` inside `<recordTypes>` — out of order fails validation.
- Emitting the process but forgetting the `<businessProcess>` element in the
  RecordType (or vice versa) is the #1 failure — both, every time.

**Ordering:** GlobalValueSet (if referenced) → CustomField (full value set) +
BusinessProcess (pre-existing / org-UI / full-object route) → RecordType.
Field + RecordType children of one object in one `validate_deploy` merge into
one container and deploy atomically — one approval. Every value the record
type references must exist on the field in that same deploy or already in the
org, or: `Cannot find the picklist value: <X>`.

**UI-sync gotcha:** API-loaded `<picklistValues>` associate correctly but
**may not appear as "Selected Values" in the record-type edit screen** — a
platform UI-sync limitation, not a deploy error. Always tell the user they may
need: Setup → Object Manager → [Object] → Record Types → [Record Type] → Edit
next to the picklist → move values into Selected Values → Save.

---

## 8. Master-Detail Relationship Rules — CRITICAL

### Master-Detail vs Lookup

| Attribute | Master-Detail | Lookup |
|-----------|---------------|--------|
| `<required>` | FORBIDDEN — MD is always required by design | Optional |
| `<deleteConstraint>` | FORBIDDEN — MD always cascades | Required (`SetNull`, `Restrict`, `Cascade`) |
| `<lookupFilter>` | FORBIDDEN — Lookup-only | Optional |
| `<relationshipOrder>` | Required (0 or 1) | Not applicable |
| `<reparentableMasterDetail>` | Optional | Not applicable |
| `<writeRequiresMasterRead>` | Optional | Not applicable |

The three forbidden attributes fail deployment with, respectively:
`Master-Detail Relationship Fields Cannot be Optional or Required` ·
`Can not specify 'deleteConstraint' for a CustomField of type MasterDetail` ·
`Lookup filters are only supported on Lookup Relationship Fields`.

### INCORRECT — Master-Detail with forbidden attributes:

```xml
<fields>
    <fullName>Account__c</fullName><type>MasterDetail</type>
    <referenceTo>Account</referenceTo><relationshipName>ChildRecords</relationshipName><relationshipOrder>0</relationshipOrder>
    <required>true</required><deleteConstraint>Cascade</deleteConstraint><lookupFilter>…</lookupFilter>  <!-- WRONG: remove all three -->
</fields>
```

### CORRECT — Master-Detail:

```xml
<fields>
    <fullName>Account__c</fullName><label>Account</label>
    <description>Links this record to its parent Account</description>
    <inlineHelpText>The parent Account this record belongs to</inlineHelpText>
    <type>MasterDetail</type><referenceTo>Account</referenceTo>
    <relationshipLabel>Child Records</relationshipLabel>
    <relationshipName>ChildRecords</relationshipName>
    <relationshipOrder>0</relationshipOrder>
    <reparentableMasterDetail>false</reparentableMasterDetail>
    <writeRequiresMasterRead>false</writeRequiresMasterRead>
</fields>
```

### CORRECT — Lookup (with optional attributes):

```xml
<fields>
    <fullName>Related_Account__c</fullName><label>Related Account</label>
    <description>Optional link to a related Account</description>
    <inlineHelpText>Choose the related customer Account, if any</inlineHelpText>
    <type>Lookup</type><referenceTo>Account</referenceTo>
    <relationshipLabel>Related Records</relationshipLabel>
    <relationshipName>RelatedRecords</relationshipName>
    <required>false</required>
    <deleteConstraint>SetNull</deleteConstraint>
    <lookupFilter>
        <active>true</active>
        <filterItems><field>Account.Type</field><operation>equals</operation><value>Customer</value></filterItems>
        <isOptional>false</isOptional>
    </lookupFilter>
</fields>
```

### Additional Master-Detail rules

- **Relationship order:** first MD on the object = `0`, second = `1`; max 2 MD
  per object (Lookup beyond that) — check the current count per §2.
- **Relationship name:** plural PascalCase (e.g. `Travel_Bookings`). Junction
  objects = two MD fields (standard many-to-many; enables roll-ups).
- The child object's `<sharingModel>` must be `ControlledByParent` — an
  object-level change (platform-custom-object-generate).

---

## 9. Roll-Up Summary Field Rules — CRITICAL

Highest deployment failure rate of any field type. Follow exactly.

| Element | Requirement | Format |
|---------|-------------|--------|
| `<type>` | Required | Always `Summary` |
| `<summaryOperation>` | Required | `count`, `sum`, `min`, or `max` |
| `<summaryForeignKey>` | Required | `ChildObject__c.MasterDetailField__c` |
| `<summarizedField>` | Conditional | Required for `sum`/`min`/`max`; ABSENT for `count` |

**Forbidden on Summary — NEVER include:** `<precision>` / `<scale>` (inherited
from the summarized field — `Can not specify 'precision' for a CustomField of
type Summary`) and `<required>` / `<length>` (not applicable).

**Format rule — BOTH keys are fully qualified `Object.Field`:**
`summaryForeignKey` = `ChildObject__c.MasterDetailFieldOnChild__c`;
`summarizedField` = `ChildObject__c.FieldToSummarize__c`. A bare name fails:
`Must specify the name in the CustomObject.CustomField format (e.g. Account.MyNewCustomField)`.

### INCORRECT — common errors:

```xml
<fields>
    <fullName>Total_Amount__c</fullName><label>Total Amount</label>
    <type>Summary</type>
    <precision>18</precision><scale>2</scale>                  <!-- WRONG: remove both -->
    <summaryOperation>sum</summaryOperation>
    <summaryForeignKey>Order_Line_Item__c</summaryForeignKey>  <!-- WRONG: missing field name -->
    <summarizedField>Amount__c</summarizedField>               <!-- WRONG: missing object name -->
</fields>
```

### CORRECT — Roll-Up Summary (SUM):

```xml
<fields>
    <fullName>Total_Amount__c</fullName><label>Total Amount</label>
    <description>Sum of all line item amounts</description>
    <inlineHelpText>Automatically calculated from child line items</inlineHelpText>
    <type>Summary</type>
    <summaryOperation>sum</summaryOperation>
    <summarizedField>Order_Line_Item__c.Amount__c</summarizedField>
    <summaryForeignKey>Order_Line_Item__c.Order__c</summaryForeignKey>
</fields>
```

**COUNT:** identical but **omit `<summarizedField>` entirely** (keep
`<summaryForeignKey>`). **MIN/MAX:** identical to SUM with
`<summaryOperation>min</summaryOperation>` / `max`, `<summarizedField>`
pointing at the field to rank.

**Prerequisites** (verify per §2 before authoring): roll-ups exist ONLY on the
**parent** of a Master-Detail relationship; the child MUST have a
Master-Detail field to this parent (that field is the `summaryForeignKey`);
the summarized field must exist on the child.

---

## 10. Formula Field Rules

Formula is **not a type**. The `<formula>` tag is added to a field whose
`<type>` is the **result data type**: `Checkbox`, `Currency`, `Date`,
`DateTime`, `Number`, `Percent`, `Text`.

- Wrap `<formula>` contents in `<![CDATA[ … ]]>` — prevents `&`, `<`, `>` from
  being parsed as markup. If the formula text itself contains `]]>`, split the
  CDATA block: `<![CDATA[Text_Field__c & "]]]]><![CDATA[>"]]>`
- **NEVER emit `returnType`** — it does not exist in the Metadata API; `<type>`
  defines the result type. `<type>Formula</type>` is equally invalid.
- `formulaTreatBlanksAs`: result `Number`/`Currency`/`Percent` →
  `BlankAsZero`; result `Text`/`Date`/`DateTime` → `BlankAsBlank`.

### CORRECT — Formula field:

```xml
<fields>
    <fullName>Calculated_Value__c</fullName><label>Calculated Value</label>
    <description>Sum of Field1 and Field2</description>
    <inlineHelpText>Auto-computed; no manual entry</inlineHelpText>
    <type>Number</type>  <!-- result type, NOT "Formula"; no returnType tag exists -->
    <precision>18</precision><scale>2</scale>
    <formula><![CDATA[Field1__c + Field2__c]]></formula>
    <formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>
</fields>
```

- A formula referencing a missing/undeployed field fails — referenced fields
  must exist in the org or in the same package.
- Use `ISPICKVAL()` (not `==`) for picklist comparisons.
- Full formula-function correctness (TEXT/VALUE/CASE/DATEVALUE/ISCHANGED type
  rules) is owned by the platform-validation-rule-generate skill.

---

## 11. Common Deployment Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Type "X" is not deployable through Contrail yet` | Wrong component type name | Field work = type `CustomField`, dotted `api_name` |
| Malformed container / parse error at deploy | XML declaration or stray comments inside child `content` | Content = exactly one `<fields>` (or `<recordTypes>`) block, nothing outside it |
| `Cannot deploy both the full objects/X.object file and individual children` | Mixed forms in one package | Pick one form (§1) |
| `Field [X] does not exist. Check spelling.` | Referenced field missing or not yet deployed | Include it in the package or deploy it first |
| `DUPLICATE_DEVELOPER_NAME` | Field fullName already on the object | Unique business-driven name (check via `describe_schema`) |
| `MAX_RELATIONSHIPS_EXCEEDED` | >2 Master-Detail or >15 Lookup on the object | Lookup for the 3rd+ MD; review lookup count |
| Reserved keyword error | `Order__c`, `Group__c`, etc. | Rename (`Status_Order__c`) |
| `Value set must reference a value set name or define a value set, but not both` | `<valueSetName>` AND `<valueSetDefinition>` | Keep exactly one (§6.1) |
| `duplicate value found: [X] is defined multiple times` | Two `<value>` entries share a `<fullName>` | Make each unique |
| `Invalid fullName` on a picklist value | Value starts with a digit or has hyphens | Letter-first, no hyphens; spaces are FINE — do not underscore (§6.3). `1st-Choice` → fullName `First Choice`, label `1st Choice` |
| `Element …picklist is not allowed` | Deprecated ≤37.0 dependent-picklist syntax | Modern `valueSettings` form (§6.2) |
| `Required field is missing: businessProcess` | Opportunity/Lead/Case/Solution record type without one | §7 routes |
| `Cannot find the picklist value: <X>` | RecordType references a value the field lacks | Deploy the field with that value first/together; match spelling and spaces exactly |

---

## 12. Verification Checklist

Run before calling `validate_deploy`:

- [ ] **Contrail shape:** each field `{type: "CustomField", api_name: "Object.Field__c"}`; content is a single `<fields>` block (no XML declaration, no container, no meta files); inner `<fullName>` bare, `api_name` dotted, halves match; no full-object document mixed with children of the same object.
- [ ] **Universal:** `<fullName>` valid, `__c`, letter-first; `<label>` Title Case; `<description>` and `<inlineHelpText>` populated and meaningful.
- [ ] **Master-Detail — CRITICAL:** `<required>`, `<deleteConstraint>`, `<lookupFilter>` all ABSENT; `<relationshipOrder>` 0 or 1; ≤2 MD on the object; child's `sharingModel` = `ControlledByParent`.
- [ ] **Lookup:** `<deleteConstraint>` = `SetNull`/`Restrict`/`Cascade`; `<relationshipName>` plural PascalCase; ≤15 lookups on the object.
- [ ] **Picklist:** each `<valueSet>` has EITHER `<valueSetName>` OR `<valueSetDefinition>` — never both; references are `<restricted>true</restricted>` with the bare set name (no `__gvs`, no `__c`) and the set exists or ships in this package; dependents have `<controllingField>` + one `<valueSettings>` per pair as siblings of `<valueSetDefinition>`, BOTH fields restricted, no legacy tags; value `<fullName>`s unique, letter-first, hyphen-free, spaces PRESERVED.
- [ ] **Roll-Up Summary — CRITICAL:** `<precision>`/`<scale>`/`<required>`/`<length>` ABSENT; `<summaryForeignKey>` (and `<summarizedField>` for sum/min/max) fully qualified `Child__c.Field__c`; for count, `<summarizedField>` ABSENT; child has a Master-Detail to this parent.
- [ ] **Formula:** `<type>` is the result type (NOT "Formula"); no `returnType`; `<formula>` in CDATA; `formulaTreatBlanksAs` matches the result type; every referenced field exists or ships in this package.
- [ ] **Numeric / text / naming:** `scale ≤ precision ≤ 18`; TextArea `<length>` OMITTED; LongTextArea/Html `<visibleLines>` set; no reserved words (`Order`, `Group`, `Select`, …); name unique on the object.

---

## 13. Deliverables and the deploy

Every field-generation deliverable ends with this list — nothing ships alone:

1. The `<fields>` block(s), one CustomField component each.
2. Any new `GlobalValueSet` the fields reference, same package.
3. Any `RecordType` child that scopes the values (§7), same package.
4. **A PermissionSet granting `fieldPermissions`** for every new field, same
   package — the cardinal rule of building-salesforce-metadata: components +
   permissions travel together, or the field deploys invisible. PermissionSet
   is a **top-level file type** — its `content` is a full document with the
   XML declaration and root, like §6.1's GlobalValueSet, NOT a child block
   (`{type: "PermissionSet", api_name: "Invoice_Management_Access", content:
   full document}`); the body shape beyond this is owned by
   platform-permission-set-generate.

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
       <label>Invoice Management Access</label>
       <fieldPermissions>
           <field>Account.Total_Contract_Value__c</field>
           <readable>true</readable><editable>true</editable>
       </fieldPermissions>
   </PermissionSet>
   ```

   Formula, Roll-Up Summary, and AutoNumber fields are system-written —
   `editable` must be `false` (true fails the deploy). Master-Detail and
   universally-required fields take **no** `fieldPermissions` entry at all —
   required fields are implicitly visible and the API rejects FLS rows for
   them. New parent object too? Add `objectPermissions`
   (platform-custom-object-generate + platform-permission-set-generate).

Then ONE consolidated `validate_deploy` with all components (`content` for
small hand-authored blocks; `content_file` from staging for anything large,
e.g. the full-object route in §7). Field-only packages need no `test_level`;
`validate_deploy` itself recommends `RunLocalTests` for production targets. Lead the summary
with the target org, any `permission_warning`, and anything destructive; the
human reads the confirmation code from the approval page, you pass it to
`execute_deploy`, then `refresh_snapshot` — the full ritual is
salesforce-house-rules §3. Validation results ARE the verification: there is
no separate analyzer or test runner. A suggested field *deletion* is a
destructive change — it goes in `destructive`, is flagged prominently, and the
human decides.

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; workflow restructured for Contrail's human-approval write contract.*
