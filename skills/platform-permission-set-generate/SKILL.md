---
name: platform-permission-set-generate
description: "Generates correct, deployable Salesforce PermissionSet XML — objectPermissions, fieldPermissions (FLS), userPermissions, classAccesses/pageAccesses, applicationVisibilities/tabSettings, recordTypeVisibilities, license settings — for deployment through the Contrail engine (validate_deploy → execute_deploy). TRIGGER: creating or editing a permission set; granting object, field, Apex, Visualforce, app, or tab access; resolving a validate_deploy permission_warning; or pairing any newly generated component with its permissions (every generator skill delegates its permission-set step here). DO NOT TRIGGER: for the write-approval ritual itself (salesforce-house-rules) or general packaging policy (building-salesforce-metadata) — this skill covers what goes INSIDE the PermissionSet XML."
metadata:
  version: "1.0"
  domains: ["Platform"]
  minApiVersion: "60.0"
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
    - platform-apex-generate
---

# Generating permission set metadata

Use when generating or editing PermissionSet XML, or when granting object, field,
user, app, tab, Apex, or Visualforce access. This is the pack's permission
companion: per **building-salesforce-metadata**, components and permissions travel
together — when another skill generates a field, object, class, page, tab, or app,
the same package includes a permission set built with this skill.

**Environments (once, applies throughout):** in Claude Desktop chat there are no
file tools — author the XML inline and pass it as `content` to `validate_deploy`.
In Claude Code, write it to Contrail's staging directory (`<data dir>/staging/`,
e.g. `%USERPROFILE%\.contrail\staging\My_Perm_Set.permissionset` on Windows) and
pass `content_file` with the absolute path. Permission sets are usually small
enough for inline `content`; use `content_file` when editing a large retrieved one.

## Step 0: Ground every API name in the org

A permission set is nothing but references — one wrong API name fails the deploy.
Resolve names against the org before authoring, and read the current XML before
editing an existing set (`retrieve_metadata` type `PermissionSet` returns the
whole artifact; `refresh_snapshot` first if the snapshot is stale or missing).
When you retrieve an existing set (or Profile) to edit, check `truncated` in the
result; if true, raise `max_bytes` or read `snapshot_path` (Claude Code) — never
author an edit from a partial copy. See salesforce-house-rules §5.

| You are granting | Verify with |
|---|---|
| Object CRUD | `describe_schema` (object exists, custom vs standard) |
| Field FLS | `describe_schema` (field exists, `required`, `formula_field`) or `retrieve_metadata` type `CustomField`, `names: ["Object.Field__c"]` (array, up to 10 per call). If `fields_truncated` is true and your field is not in the list, that is not evidence it doesn't exist — fall back to `retrieve_metadata` and read `<required>` from the XML |
| Apex class access | `list_metadata` type `ApexClass` (index; `live: true` for freshness) |
| Visualforce page access | `list_metadata` type `ApexPage` |
| App visibility | `list_metadata` type `CustomApplication` |
| Tab visibility | `list_metadata` type `CustomTab` |
| Record type visibility | `describe_schema` (`record_types` list) |

Names that exist only in the same deploy package (a field you are shipping
alongside) obviously can't be verified in the org — the package itself is the
referent, and validation checks it.

## Step 1: Define core properties

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Display Name for Administrators</label>
    <description>Clear description of purpose and intended audience</description>
</PermissionSet>
```

**Naming conventions:**
- Descriptive API name, named for the feature (e.g. `Invoice_Management_Access`,
  `Sales_Manager_Access`). Pass it as the component's `api_name` in the deploy
  call — Contrail places the file from it, and the platform takes the fullName
  from the file name (an inline `<fullName>` is optional but must match exactly).
- `label` and `description` always; a permission set with no description is a
  future audit question.
- Default to a permission set, not profile edits (building-salesforce-metadata) —
  additive, reviewable, assignable. `Profile` is deployable through Contrail if
  the human explicitly wants profile-level access; the same grant-block grammar
  below applies (profiles use `tabVisibilities` instead of `tabSettings`).

## Step 2: Object permissions

```xml
<objectPermissions>
    <allowCreate>true</allowCreate>
    <allowRead>true</allowRead>
    <allowEdit>true</allowEdit>
    <allowDelete>false</allowDelete>
    <modifyAllRecords>false</modifyAllRecords>
    <viewAllRecords>false</viewAllRecords>
    <viewAllFields>false</viewAllFields>
    <object>Account</object>
</objectPermissions>
```

- Least privilege: `allowDelete`, `modifyAllRecords`, `viewAllRecords` default to
  false unless the requirement names them.
- `modifyAllRecords` implies read/edit/delete on all records of the object;
  `viewAllRecords` implies read on all. Both bypass sharing — call them out to
  the human in your deploy summary.
- `viewAllFields` makes every field readable without individual FLS entries.

## Step 3: Field-level security

```xml
<fieldPermissions>
    <editable>true</editable>
    <readable>true</readable>
    <field>Account.SSN__c</field>
</fieldPermissions>
```

**The rules that break deploys — check each field before adding it:**
- **Required fields must NEVER appear in `fieldPermissions`.** The platform
  forbids FLS on required fields and fails the whole deploy. A field is required
  when its metadata has `<required>true</required>`, or in `describe_schema`
  output when `required: true`. Never assume — check.
- **Master-detail fields are required** on the child (detail) object — omit them.
- **Formula fields cannot be `editable`** — grant `readable` only.
- Use `ObjectName.FieldName` format (`Account.SSN__c`, `Invoice__c.Amount__c`).
- Set both `readable` and `editable` true for edit access; editable implies
  readable, but write both explicitly.
- If every field should be visible, `viewAllFields` on the object permission is
  the alternative to enumerating FLS.

## Step 4: User permissions

```xml
<userPermissions>
    <enabled>true</enabled>
    <name>ApiEnabled</name>
</userPermissions>
<userPermissions>
    <enabled>true</enabled>
    <name>RunReports</name>
</userPermissions>
```

**Common:** `ApiEnabled` (API access), `ViewSetup` (Setup menu), `RunReports`,
`ExportReport`.

**Flag for human security review before including:** `ViewAllData`,
`ModifyAllData`, `ManageUsers`, `AuthorApex` — org-wide powers that dwarf any
object grant. Lead your deploy summary with them if the requirement demands them.

No tool enumerates the valid `userPermissions` names (a platform gap, not a
Contrail one). Use well-known names; an unknown or license-unavailable name fails
`validate_deploy` with a clear error naming it — fix the name or drop the grant,
and note some user permissions also require prerequisite permissions or licenses.

## Step 5: App and tab visibility

```xml
<applicationVisibilities>
    <application>Sales_Console</application>
    <visible>true</visible>
</applicationVisibilities>
<tabSettings>
    <tab>CustomTab__c</tab>
    <visibility>Visible</visibility>
</tabSettings>
```

**Tab visibility values (permission set `tabSettings`):**
- `Visible` — on the All Tabs page and in the visible tabs of its app; customizable.
- `Available` — on the All Tabs page; users can add it to any app themselves.
- `None` — not visible (this is a non-grant; see the coverage table below).

(Profiles use `tabVisibilities` with `DefaultOn` / `DefaultOff` / `Hidden` instead.)

**CRITICAL — tab naming:**
- Custom object tabs: MUST include the `__c` suffix (`MyCustomObject__c`) — the
  tab name matches the object's API name exactly.
- Standard object tabs: `standard-` prefix (`standard-Account`, `standard-Contact`).
- Other custom tabs (web/VF/Lightning): the CustomTab's own API name.

## Step 6: Apex and Visualforce access

```xml
<classAccesses>
    <apexClass>CustomController</apexClass>
    <enabled>true</enabled>
</classAccesses>
<pageAccesses>
    <apexPage>CustomPage</apexPage>
    <enabled>true</enabled>
</pageAccesses>
```

Grant `classAccesses` for any class called from UI, flows, or as a controller;
`pageAccesses` for Visualforce pages users open. Namespaced components keep the
namespace prefix (`ns__ClassName`).

## Step 7: License and record type settings (optional)

```xml
<license>Salesforce</license>
<hasActivationRequired>false</hasActivationRequired>
<recordTypeVisibilities>
    <recordType>Account.Business</recordType>
    <visible>true</visible>
    <default>true</default>
</recordTypeVisibilities>
```

- Omit `<license>` unless the set must be restricted to one user license; once
  set it cannot be broadened without recreating the set.
- Exactly one `recordTypeVisibilities` per object may be `default` true.

## Agentforce agent access (XML knowledge only)

```xml
<agentAccesses>
    <agentName>Sales_Assistant_Agent</agentName>
    <enabled>true</enabled>
</agentAccesses>
```

`agentName` is the employee agent's developer name; `enabled` true grants access.
No Contrail tool enumerates agent developer names — take the exact name from the
human and let validation be the arbiter; if the deploy target has no Agentforce,
omit this block entirely.

## What Contrail's coverage checker counts as a grant

`validate_deploy` cross-checks new components against any PermissionSet/Profile
in the same package and returns a `permission_warning` listing what is not
granted. A component counts as covered only when it is **named in the right block
AND the enabling flag is on** — a mention with the flag off is NOT coverage:

| Component in package | Block checked | Name element | Must be |
|---|---|---|---|
| CustomField (incl. fields inline in a `.object`) | `fieldPermissions` | `<field>` | `<readable>true</readable>` |
| CustomObject (custom entities: `__c`/`__b`/`__e`/`__x`) | `objectPermissions` | `<object>` | `<allowRead>true</allowRead>` |
| ApexClass | `classAccesses` | `<apexClass>` | `<enabled>true</enabled>` |
| ApexPage | `pageAccesses` | `<apexPage>` | `<enabled>true</enabled>` |
| CustomApplication | `applicationVisibilities` | `<application>` | `<visible>true</visible>` |
| CustomTab | `tabSettings` (or profile `tabVisibilities`) | `<tab>` | `<visibility>` anything except `Hidden`/`None` |

Notes that matter in practice:
- Standard objects need no `objectPermissions` entry to silence the checker —
  only custom entities are flagged.
- The checker enumerates fields authored inline inside a full `.object` file
  too, so shipping an object does not exempt its fields from FLS.
- **A required inline field will still be listed in `permission_warning`** — the
  checker enumerates all fields, but the platform forbids FLS on required ones.
  Do NOT add a forbidden `fieldPermissions` entry to silence it; say in your
  summary that required fields are accessible to anyone with object access and
  need no FLS.
- The warning is advisory — it never blocks a deploy. Treat it as a checklist,
  and per salesforce-house-rules lead your summary with it when it fires.

## Pre-validation self-review

A quick pass before `validate_deploy` — the org's validation, not this list, is
the actual gate:

- [ ] `label` and `description` set; API name is feature-descriptive
- [ ] Grants follow least privilege; `ViewAllData`/`ModifyAllData`/`ManageUsers` flagged to the human
- [ ] No required fields in `fieldPermissions`; no `editable` formula fields
- [ ] No duplicate blocks for the same object/field/class/page/app/tab; no lengthy XML comments
- [ ] Every referenced API name verified in the org (Step 0) or present in this package
- [ ] Correct suffixes: `__c` on custom objects/fields/tabs, `standard-` on standard tabs

**Common deployment failures:** FLS on a required field; wrong or missing suffix
(`__c` on custom objects, fields, tabs); a name that exists in neither the org
nor the package; a `userPermissions` name the org's licenses don't include; two
`recordTypeVisibilities` defaults for one object.

## Deploy

One consolidated `validate_deploy` carries the permission set with the components
it grants (never a separate permissions-only follow-up for new components):

```jsonc
{
  "connection": "uat",
  "components": [
    { "type": "CustomField", "api_name": "Invoice__c.Amount__c", "content": "<fields>…</fields>" },
    { "type": "PermissionSet", "api_name": "Invoice_Management_Access", "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<PermissionSet xmlns=…>…</PermissionSet>" }
  ]
}
```

- Before validating, confirm the target connection has `metadata_write` with
  `get_permissions` — grants are checked, not probed (salesforce-house-rules §2).
- Contrail generates the `-meta.xml` and package manifest itself — never author
  them.
- Add `test_level: "RunLocalTests"` when the package includes Apex bound for
  production; name specific classes with `run_tests` + `RunSpecifiedTests`.
- Then the standard write contract: present the validation summary (target org
  first, `permission_warning` and anything destructive leading), the human reads
  the confirmation code from the approval page, `execute_deploy` with that code,
  `refresh_snapshot` after success — see **salesforce-house-rules §3**.

**Assigning the set** is data, not metadata: propose an insert of
`PermissionSetAssignment` (`AssigneeId`, `PermissionSetId` — query the id with
`soql_query` after deploy) via `dml_propose`, and it takes the same human
approval through `dml_execute`.

**Diagnosing access ("why can't this user see X?") starts with `explain_access`**
`{user, object, field?}` — it rolls up effective CRUD/FLS across the user's
profile and permission sets, names which assignment grants each bit, and counts
who else holds each granting set. CRUD/FLS only: record-level sharing is not
evaluated, so a granted read plus an invisible record points at sharing, not
permissions. Fix gaps with a permission set authored per this skill, never by
editing profiles.

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; workflow restructured for Contrail's human-approval write contract.*
