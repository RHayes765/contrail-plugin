---
name: platform-lwc-generate
description: "Author, modify, and review Lightning Web Components (LWC) through the Contrail engine — bundle anatomy (.js/.html/.css/.js-meta.xml), lightning-* base component selection and wiring, wire adapters vs imperative Apex, js-meta exposure/targets (record pages, app/home pages, Flow screens, quick actions, Experience Cloud), events and composition, and SLDS styling. TRIGGER when: the user creates or edits an LWC bundle or any file in one, asks which lightning-* base component fits a UI need ('I need a Lightning modal / datatable / combobox / record form'), wires an LWC to Apex or Lightning Data Service, builds a Flow screen component or an LWC quick action, or asks about js-meta targets, SLDS styling hooks, shadow DOM/CSS scoping, or LWC events. DO NOT TRIGGER when: the ask is a security (LWS) or accessibility (WCAG) review of an existing bundle (platform-lwc-review owns those), authoring the Apex controller itself (platform-apex-generate — this skill only states the wiring contract), Aura components or Visualforce pages, flow XML (the LWC half of a Flow screen lives here; the flow does not), or permission set XML (platform-permission-set-generate)."
metadata:
  version: "1.0"
  domains: ["Experience"]
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.1 (experience-lwc-generate) + 1.0 (experience-lwc-base-components-integrate), merged"
    adapted: "2026-10-31"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-apex-generate"
    - "platform-permission-set-generate"
    - "platform-custom-field-generate"
---

# Generating Lightning Web Components

Use this skill for production-grade LWC: new component bundles, modifications to
org-existing bundles, base-component selection and wiring, Flow screen components,
quick-action components, and evidence-based review of bundles retrieved from a
connected org.

## Operating context (Contrail)

- **Org-first, no local toolchain.** There is no local LWC compiler, linter,
  preview server, or test runner in this environment. The **org compiles the
  bundle at `validate_deploy`** (checkOnly) — template errors, bad imports,
  malformed meta XML, and missing references surface there as
  `component_failures`. Never describe a component as valid, compiling, or
  deploy-ready before that gate has run and passed.
- **No unit-test runner — and no substitute.** Jest does not exist here; do not
  author `__tests__/`, mock files, or test configs, and do not invent a stand-in.
  Correctness arguments come from exactly three places: the org-side compile at
  validation, code review of the authored source against the Rules below, and
  runtime checks a human performs in the org (place the component on a page and
  exercise it). Say which of those actually happened. `run_apex_tests` exercises
  the Apex controller only — it proves nothing about the LWC itself.
- **One bundle = one component**, deployed via the Contrail bundle ENVELOPE:
  the component's `content` is a JSON document
  `{"contrail_bundle":1,"files":{"<name>.js":"…","<name>.js-meta.xml":"…",…}}`
  whose keys are bundle-relative paths. `<name>.js` + `<name>.js-meta.xml` are
  REQUIRED; `.html`/`.css`/`.svg` and subdirectories (e.g. `templates/` for
  secondary templates) are allowed; `__tests__/` and dot-files (`.eslintrc`)
  are refused locally — local tooling never deploys.
- **Two authoring environments, one contract:** in *Claude Desktop chat*, author
  the envelope inline as `content` (JSON-escape each file body carefully). In
  *Claude Code*, write the envelope JSON to Contrail's staging directory
  (`%USERPROFILE%\.contrail\staging\<project>\<name>.json` on Windows; take the
  exact root from `list_connections`' `staging_dir`) and pass an absolute
  `content_file` path — mandatory for anything large or edited from a retrieved
  copy (building-salesforce-metadata).
- **Retrieval**: `retrieve_metadata` type `LightningComponentBundle` returns the
  main `.js` plus a `bundle_files` listing with snapshot paths for the rest of
  the bundle — read every file you will carry forward. A modify **replaces the
  whole directory**: `refresh_snapshot` before modifying an org-existing bundle,
  and include every file `bundle_files` shows in the new envelope. A file you
  omit is a file you deleted.
- **Every write is human-approved** via a confirmation code you never see. The
  full ritual is salesforce-house-rules §3; this skill only points at it.
- **Deleting a bundle is destructive**: propose it as a `destructive` entry in
  `validate_deploy`, lead your summary with it, and let the human decide.

## Required Inputs

Gather or infer before authoring:

- Component purpose and target surface(s) (record page, app/home page, Flow
  screen, quick action, tab, utility bar, Experience Cloud)
- Data source: Lightning Data Service, Apex, GraphQL, LMS, or none
- Bundle name (camelCase — naming rules below); net-new vs modify
- Objects/fields the component reads or writes
- **Target connection, by alias** — start with `list_connections`; never guess an
  org (salesforce-house-rules §1)

If the request is clear and complete, generate immediately without unnecessary
back-and-forth.

---

## Workflow

Steps are sequential. Do not skip, merge, or reorder. If blocked, stop and ask.
If a step is not applicable, mark `N/A` with a one-line justification.

### Phase 1 — Discover & author

1. **Ground in the org** — `list_metadata` type `LightningComponentBundle` for
   the inventory and naming conventions; `retrieve_metadata` any bundle you will
   imitate or change (whole bundle, per Operating context); `describe_schema`
   for every object/field the component touches; `get_dependencies`
   (`direction: "used_by"`) before modifying — a bundle used by record pages,
   quick actions, or other components has a blast radius.
2. **Choose the data access pattern** (table below) and, with it, whether an
   Apex controller is needed at all — Lightning Data Service and the record-form
   base components need none.
3. **Pick base components before writing custom UI** — scan the catalog below
   and prefer the most specialized `lightning-*` component that covers the
   feature end-to-end (a `lightning-record-form` over hand-rolled inputs, a
   `lightning-datatable` over a styled table). Hand-rolling a primitive a base
   component ships is the cardinal authoring mistake.
4. **Author the bundle** applying every rule below: `.js`, `.html`, `.css` (only
   if needed), and the `js-meta.xml`.
5. **Pair the deliverable with its usability step.** For an LWC that step lives
   *inside the bundle*: `isExposed=true` plus the right `targets` in
   `js-meta.xml`. A bundle with `isExposed=false` or no targets deploys green
   and appears NOWHERE — the LWC equivalent of a field without FLS
   (building-salesforce-metadata cardinal rule). It is **NOT a permission set**:
   there is no permission-set grant for an LWC — no `classAccesses` analog
   exists, so do not invent one. What *does* need grants, in the same package:
   the `@AuraEnabled` controller (`classAccesses`), any new fields the component
   reads (FLS), and a `CustomTab` hosting it (`tabSettings`) — structure those
   via `platform-permission-set-generate`.

### Phase 2 — Validate against the org (required before reporting)

6. **Compile gate (REQUIRED — one call).** `validate_deploy` with **all**
   authored components: the bundle envelope, the controller class + its test
   class (authored per `platform-apex-generate` / `platform-apex-test-generate`,
   with `test_level: "RunSpecifiedTests"` when Apex is in the package), and the
   permission set for the Apex/field grants. While the package is
   work-in-progress, validate with `dry_run: true` — full compile results, no
   approval request — and save the real validate for the final package.
   - **On failure**: read `component_failures` (the org reports LWC template and
     module errors with file and line). Fix and re-validate; each re-validation
     supersedes the previous pending approval.
   - **Bound the loop.** After ~3 failed cycles, stop, present the remaining
     failures and your best diagnosis, and let the human steer.
   - **Fail closed.** If the gate cannot run — no connection, or no
     `metadata_write` grant (check with `get_permissions`; never probe) — record
     `compile_check=unavailable: <reason>` and present the code as UNVERIFIED.
7. **Approval, deploy, refresh** — by reference. Present the validation summary
   (target org first; destructive changes and any `permission_warning` lead),
   the human reads the confirmation code from the approval page, you pass it to
   `execute_deploy`, then run `refresh_snapshot`. Full contract:
   **salesforce-house-rules §3**.
8. **Human runtime check.** After deploy, tell the human exactly where to see
   the component (which page/action/tab, per the targets) and what to exercise.
   That check is part of verification, not an afterthought — name it in the
   report.

### Phase 3 — Report

Use the output format at the bottom. A report missing the `Compile` line (actual
validate result or `compile_check=unavailable: <reason>`) is incomplete.

---

## Rules

### Bundle anatomy & naming

```text
<name>/                     component bundle (one Contrail component)
  <name>.js                 REQUIRED — class: export default class <Name> extends LightningElement
  <name>.js-meta.xml        REQUIRED — apiVersion, isExposed, targets (see below)
  <name>.html               template (omit for a JS-only service component)
  <name>.css                scoped styles (only when needed)
  <name>.svg                custom icon for App Builder (optional)
  templates/extra.html      secondary templates for render() switching (optional)
```

- Bundle name: **camelCase**, starts with a lowercase letter, alphanumerics and
  underscores only — no hyphens, no consecutive or trailing underscores
  (`invoiceSummary`). The JS class is the PascalCase twin (`InvoiceSummary`).
- In markup the component is its **kebab-case tag** under the `c` namespace:
  `invoiceSummary` → `<c-invoice-summary>`.
- JS property `camelCase` ↔ HTML attribute `kebab-case` (`maxRows` ↔
  `max-rows`). Dispatched event names: all-lowercase, no `on` prefix, no
  hyphens (`recordselect`); listeners are `on` + name (`onrecordselect`).
- `apiVersion`: on modify, keep the retrieved bundle's value. For new bundles,
  match the org's prevailing version (check a recently-edited bundle in the
  snapshot, or ask). Features gated at 66.0+ — `lwc:on`, complex template
  expressions, TypeScript — are only safe when that version is confirmed.

### js-meta.xml: exposure and targets

```xml
<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>64.0</apiVersion>
    <isExposed>true</isExposed>
    <masterLabel>Invoice Summary</masterLabel>
    <description>Invoice rollups on the Account record page.</description>
    <targets>
        <target>lightning__RecordPage</target>
    </targets>
    <targetConfigs>
        <targetConfig targets="lightning__RecordPage">
            <objects><object>Account</object></objects>
            <property name="maxRows" type="Integer" label="Max rows" default="10"/>
        </targetConfig>
    </targetConfigs>
</LightningComponentBundle>
```

- `isExposed=false` keeps the component usable only inside other LWCs — correct
  for child components, wrong for anything a human should place.
- `targetConfig` `property` names must match `@api` properties exactly; App
  Builder / Flow set them through that contract. `masterLabel` and
  `description` always — they are what the human sees in the builder.

| Target | Surfaces | Notes |
|---|---|---|
| `lightning__RecordPage` | Record pages | Scope with `<objects>`; declare `@api recordId` / `@api objectApiName` and the platform fills them |
| `lightning__AppPage`, `lightning__HomePage` | App/Home pages | Properties via targetConfig |
| `lightning__FlowScreen` | Flow screens | Property `role="inputOnly"`/`"outputOnly"` — see Flow section |
| `lightning__RecordAction` | **Quick actions** | targetConfig `<actionType>ScreenAction</actionType>` (modal UI) or `Action` (headless — component must expose `@api invoke()`); `recordId` arrives via `@api`. The `QuickAction` metadata that points at the LWC (`<lightningWebComponent>`) is a separate component, and the action surfaces nowhere until a layout or dynamic-actions page includes it — building-salesforce-metadata has the live-confirmed details |
| `lightning__Tab` | Custom tab hosts the component | The `CustomTab` is a separate component; tab visibility needs `tabSettings` in a permission set |
| `lightning__UtilityBar` | Utility bar | |
| `lightningCommunity__Page` + `lightningCommunity__Default` | Experience Cloud | `__Default` carries the targetConfig properties |

### Decorators

| Decorator | Use | Rules |
|---|---|---|
| `@api` | Public property or method — set by parent markup, App Builder, Flow, or quick-action runtime | One decorator per field. Never mutate an `@api` value internally — copy to a private field. Getter/setter pairs: decorate the getter only, define both |
| `@wire` | Declarative, reactive data provisioning | Provision to a property (`{data, error}`) or a handler function (store the full result if you need `refreshApex`). Reactive params use `'$prop'` — a plain value is read once and never again |
| `@track` | ONLY for observing **nested mutation** of an object/array | Primitives and whole reassignments are reactive without it since Spring '20 — `@track` on a primitive is noise |

### Data access

| Need | Pattern |
|---|---|
| Single record read | `getRecord`/`getFieldValue` (`lightning/uiRecordApi`) + `@salesforce/schema` imports |
| Simple create/edit/view form | `lightning-record-form` family — no Apex, FLS handled |
| Complex or custom query | `@wire` to Apex `@AuraEnabled(cacheable=true)` |
| DML / user-triggered action | Imperative Apex call, or `createRecord`/`updateRecord`/`deleteRecord` from `lightning/uiRecordApi` |
| Related graph, cursor pagination | GraphQL wire adapter |
| Cross-DOM pub/sub | Lightning Message Service — see the caveat below |

**The wire/imperative contract with Apex** (`@salesforce/apex/Class.method`
imports):

- `@wire(apexMethod)` **requires** the method be `@AuraEnabled(cacheable=true)`
  — wiring a non-cacheable method fails at runtime. Cacheable methods cannot
  perform DML.
- Imperative calls (`await apexMethod({args})`) work with either; use them for
  clicks, submissions, and all DML. After DML, refresh stale wires with
  `refreshApex(storedWireResult)` or `notifyRecordUpdateAvailable`.
- Prefer `@wire` for read-only display that should react to parameter changes;
  imperative for explicit actions and runtime-determined parameters.
- **The Apex class is its own deliverable**: authored per
  `platform-apex-generate` (`with sharing`, `WITH USER_MODE`,
  `AuraHandledException` for user-facing errors), deployed as a separate
  `ApexClass` component in the same package (or already in the org), with
  `classAccesses` granted in the package's permission set.

**LMS caveat**: a `@salesforce/messageChannel/X__c` import references a
`LightningMessageChannel` component Contrail does not deploy yet. If the channel
does not already exist in the org, the bundle will not compile — say so plainly
and hand the channel creation to the human; never ship the import on hope. The
same boundary applies to `@salesforce/resourceUrl` (StaticResource) — and with
it `loadScript`/`loadStyle` third-party libraries.

### Events & composition

- **Data down, events up**: parents pass state via `@api`; children report via
  `CustomEvent`. Siblings communicate through their shared parent (event up
  from A, `@api` down to B). Keep hierarchies shallow (3–4 levels); one
  responsibility per component.
- Default `{bubbles: false, composed: false}` (maximum encapsulation) and widen
  only with justification; `bubbles+composed: true` is a last resort for
  grandparent+ listeners.
- Pass primitives directly in `detail`; pass **copies** of objects
  (`{...this.formData}`) — never a live reference the listener can mutate.
- Row/item context travels on `data-*` attributes read from
  `event.currentTarget.dataset` — not `bind()` in templates.
- Components "far apart" in the DOM or crossing frameworks → LMS (see caveat).

### Lifecycle hooks

| Hook | Use for | Never |
|---|---|---|
| `constructor()` | Initialize fields | DOM access (not rendered yet) |
| `connectedCallback()` | Subscriptions, imperative initial loads | Heavy sync work |
| `renderedCallback()` | DOM-dependent logic, guarded with a run-once flag | Unguarded property writes — the rerender loop |
| `disconnectedCallback()` | Unsubscribe, remove window listeners, clear timers | Skipping cleanup — the memory leak |

### Template rules

- `lwc:if` / `lwc:elseif` / `lwc:else` — the `if:true`/`if:false` directives
  are deprecated.
- `for:each` pairs with `for:item`; `key={item.Id}` uses a **stable unique id,
  never an index**; nested loops use distinct item names; `iterator:it` only
  when `.first`/`.last` are needed.
- No inline expressions, ternaries, or method calls in templates — compute in
  **getters**. (API 66.0+ adds complex template expressions; prefer getters for
  anything non-trivial regardless.)
- Multiple layouts: import several templates and return one from `render()`.
- `lwc:spread` spreads attribute objects; event handlers bind separately
  (`lwc:on` at API 66.0+).

### Lightning Web Security — authoring rules

LWS sandboxes every namespace. Write for it, don't fight it:

- `window`/`document` are per-namespace proxies — never stash cross-component
  state on globals or reach into another component's DOM.
  `this.template.querySelector` sees only your own shadow tree; that is the
  contract, not an obstacle.
- Objects crossing the sandbox boundary arrive as proxies — unbox with
  `JSON.parse(JSON.stringify(x))` before deep comparison or before handing to a
  library that type-checks.
- No `eval`, no `new Function`, no string-based timers, no `javascript:` URLs
  (CSP). The template auto-escapes interpolations — never bypass it by building
  HTML strings into `lwc:dom="manual"` nodes from user input.
- Browser storage and cookies are constrained — design around server state, not
  `localStorage`.

### SLDS & CSS scoping

- **Never target `.slds-*` classes in component CSS**, directly or in compound
  selectors — SLDS owns them and changes them. Add your own kebab-case class to
  the element in the template and style that instead.
- **Never restyle base-component internals** (`lightning-button {}`,
  `.slds-button {}`) — the markup is behind a shadow root. Use the component's
  documented styling hooks (`--slds-c-button-*` etc. on `:host`). If no hook or
  slot exposes what you need, that is a platform gap, not a restyling job.
- No hardcoded colors — SLDS global hooks with fallbacks:
  `background: var(--slds-g-color-surface-container-1, #ffffff);`. That is also
  the dark-mode story: components styled through hooks inherit it free.
- `:host` for component-root styles; never `#id` selectors (LWC rewrites ids),
  never `c-component-name` selectors, never compiler scope tokens, `!important`
  only under duress.

---

## Base component catalog (pick before you build)

Prefer the most specialized component that covers the feature end-to-end. The
most-used, by job:

| Component | Use for |
|---|---|
| `lightning-button` | Labeled action trigger (variants: brand, neutral, destructive) |
| `lightning-button-icon` | Icon-only action; `alternative-text` required |
| `lightning-button-menu` + `lightning-menu-item` | Dropdown action/overflow menu |
| `lightning-card` | Titled container with `actions` and `footer` slots |
| `lightning-icon` | SLDS icon; `alternative-text` required |
| `lightning-badge` / `lightning-pill` | Status label / removable tag |
| `lightning-avatar` | Image, initials, or fallback icon |
| `lightning-formatted-number` / `-date-time` / `-email` / `-url` | Locale-aware read-only display |
| `lightning-helptext` | Inline help popover on an info icon |
| `lightning-spinner` | Loading state; `alternative-text` required |
| `lightning-input` | Text/number/date/email/checkbox/toggle…; built-in validation (`reportValidity`) |
| `lightning-combobox` | **Single-select** dropdown from fixed options |
| `lightning-select` | Native HTML select behavior |
| `lightning-radio-group` / `lightning-checkbox-group` | Exclusive / multi choice from options |
| `lightning-textarea` | Multi-line text |
| `lightning-input-rich-text` | WYSIWYG editor |
| `lightning-dual-listbox` | The documented multi-select (+ reorder) |
| `lightning-file-upload` | Files attached to a record |
| `lightning-record-picker` | Record lookup with search (GraphQL-backed) |
| `lightning-record-form` | All-in-one view/edit/create with default layout — zero Apex |
| `lightning-record-edit-form` + `lightning-input-field` | Custom-layout record editing; FLS handled |
| `lightning-record-view-form` + `lightning-output-field` | Read-only record display; FLS handled |
| `lightning-datatable` | Sortable/editable/selectable table; `key-field` required |
| `lightning-tree-grid` | Hierarchical datatable |
| `lightning-layout` + `lightning-layout-item` | 12-column responsive grid |
| `lightning-tabset` + `lightning-tab` | Switchable panels (tab content lazy-loads) |
| `lightning-accordion` + `lightning-accordion-section` | Progressive disclosure |
| `lightning-modal` family | Modal dialogs — see gotcha below |

Modules you import rather than place: `lightning/navigation` (NavigationMixin,
CurrentPageReference), `lightning/platformShowToastEvent` (ShowToastEvent —
dispatched, not a tag), `lightning/uiRecordApi`, `lightning/uiObjectInfoApi`
(getObjectInfo, getPicklistValues), `lightning/refresh` (RefreshEvent),
`lightning/flowSupport`, and `lightning/confirm` / `alert` / `prompt`
(Promise-based replacements for the blocked `window.*` dialogs).

**The gotchas that cost real time:**

1. **`lightning-combobox` is single-select only.** No `type="multi"` exists.
   Multi-select is `lightning-dual-listbox` (or `lightning-checkbox-group`);
   `lightning-record-picker` only fits when the values are records.
2. **`lightning-modal` is a class you extend, not a tag.** Create a separate
   component extending `LightningModal` (from `lightning/modal`), compose
   `lightning-modal-header/body/footer` in its template, and open it with the
   static `MyModal.open({...})` promise. Do not hand-roll a dialog.
3. **`lightning-input-field` works only inside `lightning-record-edit-form`**
   (and `lightning-output-field` only inside `lightning-record-view-form`) —
   they read field metadata and FLS from the enclosing form context.
4. **When a base component resists restyling, stop.** The internals are shadow
   DOM; the supported surface is its documented attributes, slots, and
   `--slds-c-*` hooks. Trust the component's real API over memory — base
   components evolve, and a prop you remember may not exist.

---

## Flow screen components

- Declare the `lightning__FlowScreen` target; every exchanged value is an
  `@api` property with an explicit `role` in the targetConfig — `inputOnly`
  (Flow → component) or `outputOnly` (component → Flow). Avoid role-less
  bidirectional properties.
- Setting an output property is not enough — dispatch
  `FlowAttributeChangeEvent('propName', value)` (from `lightning/flowSupport`)
  or the Flow never sees it.
- Programmatic navigation: `FlowNavigationNextEvent` / `FlowNavigationFinishEvent`
  etc., but only after checking `@api availableActions` includes the action.
- Optional `@api validate()` returning `{isValid, errorMessage}` blocks Next
  until the component is satisfied.

---

## Deliverables & Packaging

Per component, the deploy package contains — together, in one `validate_deploy`:

1. The **bundle envelope** (`type: LightningComponentBundle`, `api_name` = the
   camelCase bundle name) with usable `js-meta.xml` exposure/targets baked in.
2. The **Apex controller + its test class**, when the component calls Apex
   (`platform-apex-generate` / `platform-apex-test-generate`).
3. A **permission set** for what actually takes grants: `classAccesses` for the
   controller, FLS for new fields, `tabSettings` for a new tab — never a grant
   for the LWC itself, which has none (`platform-permission-set-generate`).
4. The **`QuickAction` component** (and a layout note for the human) when the
   target is `lightning__RecordAction`.

```jsonc
{
  "connection": "uat",
  "components": [
    { "type": "LightningComponentBundle", "api_name": "invoiceSummary",
      "content_file": "<staging>/invoiceSummary.json" },   // the envelope JSON; inline `content` in Desktop chat
    { "type": "ApexClass", "api_name": "InvoiceSummaryController", "content_file": "<staging>/InvoiceSummaryController.cls" },
    { "type": "ApexClass", "api_name": "InvoiceSummaryControllerTest", "content_file": "<staging>/InvoiceSummaryControllerTest.cls" },
    { "type": "PermissionSet", "api_name": "Invoice_Summary_Access", "content": "<PermissionSet>…</PermissionSet>" }
  ],
  "test_level": "RunSpecifiedTests",
  "run_tests": ["InvoiceSummaryControllerTest"]
}
```

Report in this order:

```text
LWC work: <summary>
Components: <bundle / controller / test / permission set / quick action api names>
Pattern: <LDS | wire-to-Apex | imperative | GraphQL | record-form | LMS>
Usability: <isExposed/targets set; where the human will see it; grants that shipped>
Workflow: all steps completed (1-8); any N/A justified
Compile: <REQUIRED — actual validate_deploy result (incl. dry_run iterations), or "compile_check=unavailable: <reason>" after attempting>
Verification honesty: <no test runner exists for LWC — org compile + code review done; name the runtime check the human still owes>
Deploy: <validated, awaiting approval | executed + refresh_snapshot run | not attempted>
```

---

## Cross-Skill Integration

| Need | Delegate to |
|---|---|
| Apex controller or service | `platform-apex-generate` |
| Apex test class for the controller | `platform-apex-test-generate` |
| Permission set (`classAccesses`, FLS, `tabSettings`) | `platform-permission-set-generate` |
| New objects/fields the component reads | `platform-custom-object-generate` / `platform-custom-field-generate` |
| Packaging, staging paths, content vs content_file | `building-salesforce-metadata` |
| Approval ritual, grants, connections | `salesforce-house-rules` |

---

## Troubleshooting Boundary

This skill handles authoring and the failures `validate_deploy` surfaces for the
bundle: template compile errors, module resolution, meta-XML problems, and
missing org references. Apex compile/test failures route to
`platform-apex-generate` / `platform-apex-test-generate`; runtime Apex behavior
(governor limits, exceptions in debug logs) to `platform-apex-logs-debug`.
Runtime behavior of the LWC itself (browser console, rendering) has no
Contrail-side telemetry — that is the human runtime check, named in the report.

---
*Adapted from forcedotcom/sf-skills@49064f7 (experience-lwc-generate, merged with experience-lwc-base-components-integrate), Apache-2.0. Modified: retargeted from Salesforce's CLI/DX tooling and Jest workflows to the Contrail engine's bundle envelope and human-approval write contract.*
