---
name: platform-validation-rule-generate
description: "Create, modify, or troubleshoot Salesforce Validation Rules through the Contrail engine (retrieve_metadata, describe_schema, validate_deploy). Trigger when users mention validation rules, field validation, data-quality rules, formula validation, save error messages, or enforcing business rules at the data layer — and when a save fails with FIELD_CUSTOM_VALIDATION_EXCEPTION or a deploy fails on a validation rule. Do NOT trigger for validation implemented in Flows or Apex triggers (use platform-apex-generate for trigger-based validation; Flow-based validation is out of scope for this skill), or for duplicate/matching rules, which are different metadata types."
metadata:
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.0"
    adapted: "2026-08-26"
  relatedSkills:
    - salesforce-house-rules
    - building-salesforce-metadata
    - platform-custom-object-generate
    - platform-custom-field-generate
    - platform-permission-set-generate
---

# Validation rules through Contrail

Use this skill to:

- Create validation rules that enforce data quality and block invalid saves
- Generate ValidationRule metadata with correct formulas
- Modify an existing rule's formula, message, or active state
- Troubleshoot validation-rule deploy failures and save-time
  `FIELD_CUSTOM_VALIDATION_EXCEPTION` errors

Follow **salesforce-house-rules** for connections, grants, and the write ritual;
**building-salesforce-metadata** for packaging. This skill covers what is specific
to validation rules.

## How a ValidationRule deploys through Contrail

A ValidationRule is a **child of CustomObject**. There is no standalone file, no
`-meta.xml` at all for this path — validation rules merge into an
`objects/<Object>.object` document Contrail builds for you — and no manifest to
write. You deploy one `<validationRules>` XML block as a component:

```jsonc
{
  "connection": "uat",
  "components": [
    {
      "type": "ValidationRule",
      "api_name": "Opportunity.Close_Date_Not_Past",   // Object.RuleName — dotted
      "content": "<validationRules>…</validationRules>" // the block, nothing more
    }
  ]
}
```

- `api_name` is dotted `Object.RuleName`; the `<fullName>` **inside** the block is
  the rule name only (no object prefix) — exactly the shape `retrieve_metadata`
  returns.
- Contrail merges child blocks into a partial object file at package time. The
  Metadata API upserts children **additively**: deploying one rule never touches
  the object's other rules or fields.
- **Never mix a full `CustomObject` component and child components of the same
  object in one package** — Contrail refuses it ("Cannot deploy both the full
  objects/X.object file and individual children"). Pick one form.
- Several rules (or rules + new `CustomField` children) for the same object can
  ship as separate components in one package; they merge into one document.

**Environments.** In Claude Desktop chat (no file tools) author the block inline
via `validate_deploy` `content`. In Claude Code, you may instead write the file
under Contrail's staging directory and pass `content_file` (absolute path) —
worthwhile for big blocks, though most validation rules are small enough that
inline `content` is fine everywhere.

## The XML block

```xml
<validationRules>
    <fullName>Close_Date_Not_Past</fullName>
    <active>true</active>
    <description>Blocks closing an Opportunity with a past close date.</description>
    <errorConditionFormula><![CDATA[
AND(
    OR( ISNEW() , ISCHANGED( StageName ) ),
    ISPICKVAL( StageName , "Closed Won" ),
    CloseDate < TODAY()
)
]]></errorConditionFormula>
    <errorDisplayField>CloseDate</errorDisplayField>
    <errorMessage>Close Date cannot be in the past when marking the Opportunity Closed Won.</errorMessage>
</validationRules>
```

| Element | Required | Rules |
|---|---|---|
| `fullName` | yes | Rule API name: starts with a letter; letters, numbers, underscores only; no trailing underscore; no consecutive underscores; max 40 chars |
| `active` | yes | `true` = enforced on save; `false` = present but dormant |
| `errorConditionFormula` | yes | Boolean formula; **TRUE blocks the save**. Max 3,900 characters, 5,000 bytes compiled |
| `errorMessage` | yes | Shown to the user on failure; max 255 characters; escape `&` / `<` as `&amp;` / `&lt;` |
| `errorDisplayField` | no | Field API name on the object to anchor the error to; omit to show it at the top of the page |
| `description` | no | Always write one — say what the rule blocks and why |

## Writing the error condition formula

**The formula describes the BAD state.** It returns TRUE when the record must be
rejected — write the condition that should never be allowed to save, not the
condition of a valid record.

### Function rules (the classic mistakes)

| Function | Rule |
|---|---|
| `TEXT()` | For numbers, dates, and picklists only. **Never wrap a Text field in TEXT()** — remove it |
| `CASE()` | The last parameter is the default and is required; a correct CASE() always has an **even** argument count. Admins routinely omit the default |
| `VALUE()` | Text → Number only. Never wrap something already numeric — remove it |
| `DAY()` / `MONTH()` / `YEAR()` | Date fields only. For a Datetime field, convert first: `DAY( DATEVALUE( Datetime_Field__c ) )` |
| `DATEVALUE()` | Converts Datetime (or date-literal Text) → Date. Never wrap a field that is already a Date — remove it |
| `ISPICKVAL()` | Picklist equality MUST use `ISPICKVAL(Field, "Value")` — a bare `Field = "Value"` comparison does not compile for picklists. Use `TEXT(Field)` when you need the picklist's value as a string |
| `ISCHANGED()` | Detects that a field's value changed in this save (the function is ISCHANGED, not "ISCHANGE"). Update context only |
| `PRIORVALUE()` | The field's value before this edit; pair with `ISCHANGED()`/`ISNEW()` |
| `ISNEW()` | TRUE when the record is being created — use it to scope a rule to inserts or (negated) to updates |
| `ISBLANK()` | Required-field checks use `ISBLANK(Field)`. `ISNULL()` is legacy and is always FALSE for Text fields |
| `REGEX()` | Format enforcement (postal codes, phone patterns): `NOT( REGEX( Field , "pattern" ) )` as the error condition. Backslashes are escape characters inside formula string literals — double them: `REGEX( Postal__c , "\\d{5}(-\\d{4})?" )`. CDATA does not change this; it only suppresses XML escaping |

Cross-object fields are legal and common: traverse lookups with relationship
syntax (`Account.Owner.IsActive` from Contact; `My_Lookup__r.Status__c` for
custom lookups).

### When rules fire

- On **create and update** — every path: UI, API integrations, data loads, and
  Contrail's own `dml_execute`. Never on delete.
- Lead conversion skips validation unless the org enables *Require Validation
  for Converted Leads*.
- An `active=true` rule is live the moment the deploy lands. For a risky rule in
  production, offer to deploy `<active>false</active>` first and flip it on in a
  follow-up deploy once the human has reviewed impact.

### Bypass patterns that deploy through Contrail

Give admins and integrations an escape hatch — wrap the rule body:

- **User-field bypass (fully deployable here):** a checkbox on User, e.g.
  `AND( NOT( $User.Bypass_Validation__c ) , <rule body> )`. The
  `CustomField` `User.Bypass_Validation__c` and a `PermissionSet` granting its
  `fieldPermissions` ship in the same package as the rule.
- **Profile check (no new metadata):** `$Profile.Name <> "System Administrator"`.
- **`$Permission.X` (custom permission):** the cleanest pattern on-platform, but
  `CustomPermission` is **not a Contrail-deployable type** — if the human wants
  it, they create the custom permission in Setup first; the rule referencing it
  deploys fine afterwards. Say this rather than attempting the type.

## XML escaping — the most common deploy error

Formulas full of `<`, `>`, `&` are the norm, and raw they break the XML. **Wrap
every `errorConditionFormula` in `<![CDATA[ … ]]>`** (as in the example above) —
it is always safe, even for formulas that don't strictly need it. Entity-escaping
(`&lt;` `&amp;`) also works but is easy to get half-right; prefer CDATA.
`errorMessage` is plain text — entity-escape any `&` or `<` there.

## "Update the formula" — replace vs append

When asked to modify a formula, distinguish:

- **"Update the formula to [X]"** → replace the existing logic entirely with X.
- **"Update the formula to *also* [X]"** → keep the existing logic and append,
  usually by wrapping: `AND( <existing> , <new> )` or `OR( … )`.

When genuinely ambiguous, show both readings and ask.

## Workflow

**1. Ground in the org.** Name the target connection explicitly
(`list_connections` first — house-rules §1). Then:

- `describe_schema` on the object: confirm every field the formula references
  exists, and get its type — type drives the function choice above (picklist →
  `ISPICKVAL`, Datetime → `DATEVALUE` first, etc.).
- Modifying an existing rule: `retrieve_metadata` `{type: "ValidationRule",
  names: ["Object.Rule_Name"]}` returns the current block from the snapshot —
  edit from the **whole** block, never from memory. If it's not in the snapshot,
  `refresh_snapshot` (validation rules ride in `CustomObject`, which is in the
  default manifest); for anything you're about to change, confirm freshness
  first (`refresh_snapshot` with `check_only: true`).
- Finding rules: `search_metadata` finds rules by name fragment or by a field
  they mention; `list_metadata` inventories.
- If the connection or a grant is missing, follow house-rules §2 — and record
  `schema-check=unavailable: <reason>` only after actually attempting the call,
  then say which formula assumptions (field names, types) are unverified.

**2. Author the block** per the spec above: CDATA formula, ≤255-char message,
`description` filled in, `errorDisplayField` when one field is clearly at fault.

**3. Deploy.** One consolidated `validate_deploy` with every component of the
change (rules + any new fields + the permission set). Default `test_level`
`NoTestRun` is fine for pure declarative packages; for production targets prefer
`RunLocalTests` — and note that an org's *existing* Apex tests can fail a
validation deploy when test data now trips the new rule; read those failures as
real impact evidence, not noise. Then the approval ritual: present the result
with the target org unmissable, the human reads the confirmation code from the
approval page, and only then `execute_deploy` — see **salesforce-house-rules §3**.

**4. After success**, `refresh_snapshot` so the snapshot and dependency graph
include the new rule.

## Modifying and deleting

- **Modify** = re-deploy the complete edited block under the same
  `Object.RuleName`; the child upserts in place. Deactivate by re-deploying with
  `<active>false</active>`.
- **Delete** = a `destructive` entry in `validate_deploy`:
  `{type: "ValidationRule", api_name: "Object.Rule_Name"}`. Deletions are
  destructive: lead your summary with them, and the human decides on the
  approval page (house-rules §3). Suggest deactivation over deletion when the
  intent might be temporary.

## Troubleshooting deploy failures

| Symptom | Likely cause → fix |
|---|---|
| XML parse error / "element invalid at this location" | Raw `<` `>` `&` in the formula → wrap in CDATA |
| "Field X does not exist" | Typo or wrong object → re-check with `describe_schema`; custom fields need `__c`, lookups `__r` for traversal |
| "Incorrect parameter type for function" | A function-table violation: `TEXT()` on Text, `VALUE()` on Number, `DAY()` on Datetime, picklist compared without `ISPICKVAL()` |
| "Incorrect number of parameters for CASE()" | Missing default (odd argument count) → add the final default parameter |
| "Formula is too long" | Over 3,900 chars / 5,000 bytes compiled → simplify, or move shared logic into a formula field the rule references |
| "Cannot deploy both the full objects/X.object file and individual children" | Full object + child in one package → deploy children only, or fold the rule into the full object file |
| Existing Apex tests fail during validation | Test data violates the new rule → real blast radius; report it, don't lower the test level to dodge it |

Verification IS the `validate_deploy` result — there is no local linter or
analyzer in Contrail, and that's fine: the org's formula compiler is the
authority, and checkOnly costs nothing.

**Optional live proof** (only if the human opts in, `data_write` granted): after
deploying, `dml_propose` a deliberately violating record — the approved execute
should FAIL with your exact `errorMessage` (`FIELD_CUSTOM_VALIDATION_EXCEPTION`),
writing nothing. Propose a compliant record too, to prove the rule doesn't
over-block. Both writes go through the normal human-approval ritual. Say in your
summary that the violating insert is expected to be REJECTED by the new rule —
the approval page shows a normal insert. The confirmation code is spent either
way; a second proof needs a fresh `dml_propose`. A failure with
`FIELD_CUSTOM_VALIDATION_EXCEPTION` is the pass condition, not a write to retry.

## Deliverables

A finished validation-rule change presents:

1. The `<validationRules>` block(s), formula explained in one plain-English
   sentence each ("blocks X when Y")
2. Firing scope: create/update/both, and any bypass path
3. The consolidated `validate_deploy` package contents and target connection
4. **Permission-set pairing** (building-salesforce-metadata cardinal rule): a
   validation rule itself needs no grant block — but any **new field** shipped
   with it (a bypass checkbox, a status field the formula reads) ships with a
   `PermissionSet` granting `fieldPermissions` in the **same package**, and any
   new object adds `objectPermissions`. If `validate_deploy` returns a
   `permission_warning`, lead with it.

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; workflow restructured for Contrail's human-approval write contract.*
