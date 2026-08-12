---
name: building-salesforce-metadata
description: How to author Salesforce metadata for deployment through the Contrail Engine — custom objects and fields, flows, Apex, permission sets — so it deploys cleanly AND is usable (permissions included) on the first try. Use whenever building or editing metadata to deploy with validate_deploy/execute_deploy: creating objects/fields, writing a flow, adding Apex, or preparing any deploy package. Complements the salesforce-house-rules skill (which governs the approval/deploy ritual).
---

# Building Salesforce metadata for deployment

The engine will happily deploy exactly what you give it. The failure mode is not
a broken deploy — it's a deploy that *succeeds* and then does nothing useful
because permissions were left out, or because a metadata detail was subtly wrong.
Build for "works and is usable," not just "validates."

## The cardinal rule: components + permissions travel together

**Metadata API deploys do not grant permissions.** A new custom field deploys but
is invisible (no FLS); a new object is unreachable without object permissions; new
Apex has no class access; a new tab has no visibility. `validate_deploy` will warn
you (`permission_warning`), but the right habit is to not need the warning:

- **When you add custom fields**, include a **permission set** in the same package
  granting `fieldPermissions` (and `objectPermissions` for any new object).
- **When you add an object**, grant `objectPermissions` and the FLS for its fields.
- **When you add an Apex class** meant to be called from UI/flows, grant
  `classAccesses`.
- Default to a **permission set**, not profile edits — permission sets are additive,
  reviewable, and don't risk clobbering a profile. Name it for the feature
  (`Invoice_Management_Access`), assign it to whoever needs it.
- If the human explicitly wants profile-level access, either deploy the `Profile`
  with `fieldPermissions`/`objectPermissions` (include the objects/fields in the
  same package, or the profile's permissions for them are ignored), or grant it via
  `FieldPermissions` / object-permission records against the profile's owning
  permission set (`PermissionSet` where `IsOwnedByProfile = true`).

Present the permission set alongside the components when you propose the deploy, so
the human approves one coherent, usable change.

## Editing existing metadata: read the whole thing first

When you modify an existing flow or object rather than authoring a new one, work
from the **complete** current definition. `retrieve_metadata` truncates at 60,000
characters (`… [truncated N of M chars]`), and real flows and objects routinely
exceed that — editing from a half-read definition is how you drop an element or
overwrite a branch you never saw. If the result is truncated, read the full file
from the snapshot on disk (see **salesforce-house-rules → Large artifacts**), or
narrow the retrieve to the specific child component you're changing.

## Metadata details that actually bite (from real deploys)

- **Objects need** `deploymentStatus`, `label`, `pluralLabel`, `nameField` (with a
  `type` — `Text` if the flow/UI will set the Name, `AutoNumber` if not), and
  `sharingModel`. Use `ReadWrite`/`Private` for lookup children; `ControlledByParent`
  is only valid under a master-detail.
- **Deploying a full `.object`** with inline `<fields>` deploys those fields. It is
  additive — it does not delete unlisted existing fields (deletions require a
  destructive change). Don't mix a full object file and individual child-field
  components for the same object in one package.
- **Flows**: record-triggered flows need `<start>` with `object`,
  `recordTriggerType`, and `triggerType` (`RecordAfterSave` when you need the saved
  record's Id, e.g. to create children). `<status>Active</status>` is required for
  it to run on trigger; dev orgs don't enforce flow test coverage, production does.
  Every element needs `locationX`/`locationY`. `interviewLabel` is required.
- **Deactivating a flow**: use `deactivate_flow` (turns off the active version via a
  `FlowDefinition` deploy, through the normal two-step approval). This works
  reliably — use it to switch off automation.
- **Deleting a flow is unreliable via the Metadata API.** An active flow can't be
  deleted; and even after `deactivate_flow`, a destructive `Flow` delete often fails
  validation with "insufficient access rights on cross-reference id" (a Salesforce
  quirk — object/permission-set destructive deletes work fine, flows specifically
  do not). When you need a flow gone, deactivate it with `deactivate_flow` and
  delete it in **Setup → Flows**; don't loop on destructive `Flow` deploys.
  An object a flow references can't be deleted until the flow itself is gone, so the
  object teardown waits on the UI deletion.
- **Namespaces** can contain single underscores (`sales_channel__Foo`), so split a
  qualified API name at the **first** `__`, never with a greedy pattern.
- **Names**: components deploy under `type/Name.ext`; the tools reject names with
  path separators or `..`. Child components are dotted (`Account.MyField__c`).

## Deploy discipline

Follow the **salesforce-house-rules** skill for the approval ritual. In short:
`validate_deploy` first (checkOnly), lead the summary with destructive changes and
any `permission_warning`, and only `execute_deploy` with a code the human reads back
from the approval page. After a successful deploy, `refresh_snapshot` so the local
index and dependency graph reflect the org's new state.
