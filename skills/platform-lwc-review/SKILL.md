---
name: platform-lwc-review
description: "Static security (Lightning Web Security) and accessibility (WCAG 2.2) review of Lightning Web Component bundles read from a connected org through the Contrail engine. TRIGGER when: the user asks to review, audit, or check an LWC for security or LWS compliance, dangerous DOM APIs or blocked sinks (eval, innerHTML, document.write, script creation, unsafe URL schemes, global-scope assignment); asks whether an LWC is accessible, WCAG compliant, keyboard operable, or screen-reader friendly; asks for ARIA, label, focus, or contrast checks on an LWC; or wants a pre-ship SECURITY/ACCESSIBILITY review of a component bundle retrieved via retrieve_metadata. DO NOT TRIGGER for: authoring, modifying, or general code-quality review of LWC bundles (platform-lwc-generate), Apex or @AuraEnabled controller review (platform-apex-generate), Aura components, flows, or generic non-LWC security review."
metadata:
  domains: ["Experience"]
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "experience-lwc-security-validate 1.0 + experience-lwc-accessibility-validate 1.1 (merged)"
    adapted: "2026-10-31"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-apex-generate"
---

# Reviewing LWC bundles — security and accessibility

One structured static-review pass over a Lightning Web Component bundle, with two
lenses applied to the same source: the Lightning Web Security (LWS) rule catalog
(`lws-001`…`lws-023b`) and a WCAG 2.2 accessibility checklist. Output is a
severity-ranked findings list in plain markdown — no machine-readable report
format, no scoring, no external tooling.

## What this is, and is not

This is **source review**: you read the bundle's files and judge them against the
catalogs below. Be honest about the boundary in every report:

- **It is not a scanner.** Detection is by reading and reasoning, not pattern
  automation. Deliberately obfuscated code can evade any reviewer.
- **It is not a runtime test.** There is no test runner in this environment — no
  Jest, no component harness, no browser automation. Correctness arguments come
  from three places only: the org-side compile when a deploy validates, this code
  review, and runtime checks a human performs (keyboard pass, screen reader,
  real browser). Never claim a component "passes accessibility testing" or "is
  LWS-verified at runtime" from this review alone.
- **What it cannot catch**: actual rendered contrast and reflow; screen-reader
  behavior; LWS sandbox enforcement differences at runtime; data flowing in from
  parent components or Apex at runtime; server-side (Apex) vulnerabilities —
  review those with `platform-apex-generate`.

## Operating context (Contrail)

- **Target connection by alias** — start with `list_connections`; never guess an
  org (salesforce-house-rules §1). Reading needs no write grant.
- **Get the source with `retrieve_metadata`**, type `LightningComponentBundle`,
  the component's name in `names`. The result carries the main `.js` inline plus
  a `bundle_files` listing with a snapshot path per file. Review the **whole
  bundle**: `.js`, every `.html` template (including `templates/` subdirs),
  `.css`, `.svg`, and `<name>.js-meta.xml`. In Claude Code, read each file from
  its snapshot path; in Desktop chat, retrieve what the result carries and say
  plainly which files you could not read. Never review a fragment — a truncated
  or partial read is recorded in the report, not silently skipped
  (salesforce-house-rules §5).
- **Review is read-only by default.** Report findings; apply fixes only when the
  human asks. Every fix deploys through the full approval ritual (below).

## Workflow

1. **Scope** — component name, connection, and which lenses (security,
   accessibility, or both — both is the default). Note any feature-flag gating
   you see in the source; fixes must respect it.
2. **Retrieve and read every file** in the bundle, as above.
3. **Security pass** — walk the LWS catalog below rule-by-rule against the JS,
   then the template checks, then the meta checks. Evaluate every rule, not a
   hand-picked subset.
4. **Accessibility pass** — walk the WCAG checklist below against the templates
   and JS together (resolve bindings across files before judging).
5. **Report** using the findings format at the bottom. Every finding cites its
   rule id or SC number — no freeform "looks suspicious" entries.
6. **Fix (only on request)** — see Applying fixes.

### Obfuscation rule (applies to the whole security catalog)

For every rule, "usage" includes indirect forms: bracket notation
(`document['write']`), destructuring (`const { write } = document`), aliasing,
`Reflect.apply`/`Reflect.set`/`Reflect.construct`, string concatenation and
template literals building names (`'insert' + 'HTML'`), unicode escape
sequences, and occurrences inside loops, conditionals, callbacks, and async
code. Judge the resolved intent, not the literal spelling.

## Security catalog (LWS + product security)

Severity: catalog `error` → **High**, `warning` → **Medium**, unless noted.
Promote to **Critical** when untrusted input demonstrably reaches the sink.

| Rule | Flag | Why / Fix |
|---|---|---|
| lws-001 | Any `document.createProcessingInstruction` | XML injection → XSS. Remove; for stylesheet loading use `document.createElement('link')` appended to `document.head` in JS (not in markup). |
| lws-002 | Handlers for exactly `rejectionhandled`, `securitypolicyviolation`, `unhandledrejection` (case-sensitive) on `document` | Leaks sensitive information. Handle errors/rejections locally in the component. |
| lws-003 | `document.open` with 0–2 args (3+ args is allowed) | Clears the document / navigation hijack. Use `window.open(url, "_blank", "noopener,noreferrer")` or DOM APIs. |
| lws-004 | All `document.write` / `document.writeln` | HTML injection XSS; no safe use. Use templates, `createElement`/`appendChild`, `textContent`. |
| lws-005 | Any `eval`, `Function`, `new Function`; `setTimeout`/`setInterval` **only** with a string argument | Arbitrary code execution. Pass real function references; remove string timers. |
| lws-006 | `event.originalTarget` / `event.explicitOriginalTarget` (incl. `Event.prototype`) | Bypasses shadow-DOM isolation. Use `event.target` / `event.currentTarget`. |
| lws-007 | `requestFullscreen` and vendor variants (`webkitRequestFullscreen`, `mozRequestFullScreen` — capital S, `msRequestFullscreen`) | Phishing by hiding browser chrome. Remove; do not implement fullscreen. |
| lws-008 | Property **assignment** to `globalThis`, `window`(`.top`/`.parent`/`.frames`), `document.defaultView`, `self`/`this` at global scope. Prerequisite: only in files that import from `'lwc'` — skip files without that import. Reads, method calls, and `document.*`/`localStorage` assignments are NOT flagged | Global namespace pollution crosses the security boundary. Keep state on the component or in module-local constants. |
| lws-009 | `document.body.addEventListener(...)` or `document.body.on* =` (incl. destructured `body`) | Leaks rejections, storage events, navigation state. Listen inside `this.template` instead. |
| lws-010 | Any nonce access: `element.nonce`, `getAttribute('nonce')`, `querySelector('[nonce]')`, setting or storing nonce values | CSP bypass. Never read, set, store, or transmit nonces; load libraries via `loadScript`/`loadStyle` from `lightning/platformResourceLoader`. |
| lws-011 | Any access to `rangeParent` on event objects | Forbidden property. Use `event.target` / `event.currentTarget`. |
| lws-012 | `XSLTProcessor` in any form, `transformToFragment`/`transformToDocument` | Generates script/handlers, bypasses CSP; no safe use. Use template data binding, process XML server-side, or use JSON. |
| lws-013 | Context manipulation of **imported framework classes**: `.call`/`.apply`/`.bind`/`Reflect.apply` with external context; extending imported framework components; `__lookupSetter__`/`__lookupGetter__`/`Object.get/setPrototypeOf`; access to `.helper`/`.context`/`.owner`/`.navService`; `getOwner()`/`getContext()` traversal loops | Framework privilege escalation. Use public APIs only; query only `this.template.querySelector()`. Ignore standard lifecycle methods, same-component `this` binding, and code loaded via `loadScript` from static resources. |
| lws-014 | `document.execCommand` with `insertHTML` or `selectAll` only (copy/cut/paste/bold/etc. are safe) | HTML injection / clipboard exposure. Use `Range.insertNode` + `createElement`; `getSelection().selectAllChildren(el)`; `navigator.clipboard.writeText()`. |
| lws-015 | HTML-injection sinks with untrusted or dynamically built content: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `setHTML`, `setHTMLUnsafe` (on elements, shadowRoot, or document); strings containing `<script>` or iframe `srcdoc`; `textContent` fed HTML markup | XSS. Use `textContent` for plain text, `createElement`/`appendChild`, or template data binding. Ignore safe DOM methods and normal template rendering. |
| lws-016 | Map/Set misuse: bracket access (`map[key]`, `map[key] = v`); `JSON.stringify` on a Map/Set; Map/Set in `@wire`/`@track`, event payloads, or child-component props; additions to `Map.prototype`/`Set.prototype` | Bypasses internal structures; Map/Set do not serialize. Use `.get`/`.set`/`.add`/`.has`; convert with `Object.fromEntries(map)` / `Array.from(set)` before serializing. |
| lws-017 | Mutating objects the component does not own: `event.detail.*=`, parameter mutation, wire/API response mutation, `@api` value mutation, custom props on DOM elements, `Array.prototype.x =`, `document.foo =` | Shared-state corruption. Clone first (`{ ...x }`, `structuredClone`), return new objects, use the `dataset` API for DOM metadata. Mutating objects the component created, and cloned copies, is fine. |
| lws-018 | `trustedTypes.createPolicy` with name `'default'`, `''`, `'lwsInternal'`, or `'trusted'` (trace variables/concatenation to the resolved name; ignore the second argument) | Collides with reserved policies. Rename the policy. |
| lws-019a | `URL.createObjectURL` with MIME `text/javascript` or an empty/undefined type (trace the Blob/File `type`) | Blocked; executable object URLs. Use `loadScript` for libraries; safe types only. |
| lws-019b (Medium) | `URL.createObjectURL` with `text/html`, `image/svg+xml`, or `text/xml` | Can carry embedded script — content must be trusted/sanitized. `image/*`, `video/*`, `audio/*`, `application/pdf` are safe: don't flag. |
| lws-020 | Any URL scheme other than `http`, `https`, or the exact literal `about:blank` — in `href`/`src`/`action`, JS strings, `setAttribute`, URL constructors, `window.location`/`open`, fetch/XHR. Case-insensitive; watch concatenated schemes (`'java' + 'script:'`) | `javascript:`/`vbscript:` execute code; `data:`/`blob:` bypass CSP; `file:`, `ftp:`, `ws:`, `tel:`, `mailto:`, custom schemes all disallowed. Replace with https URLs or remove. |
| lws-021 (Medium, informational) | SVG `<animate>` (created via `createElementNS(..., 'animate')`) with `to`/`from`/`values` containing `url(...)` | LWS auto-sanitizes these — note it so behavior changes don't surprise anyone. |
| lws-022 | Script element creation/manipulation: `createElement('script')`, script injection via HTML sinks, `script.src` = dynamic/blob/data URL, `script.textContent`/`.text` = code | XSS / CSP bypass. Use `loadScript` from `lightning/platformResourceLoader` with a static resource. |
| lws-023a | Any iframe `srcdoc` — direct, via `setAttribute`, inside sink strings, or mXSS constructions (MathML/SVG/CDATA wrapping an iframe) | Bypasses CSP. Remove `srcdoc`; use `src` with https. |
| lws-023b | iframe `src` with any protocol other than http/https (`javascript:`, `data:`, `blob:`, `vbscript:`, `file:`, incl. obfuscated) | Frame-level code execution. https only. |

### Template checks (findings use ids `lws-tpl-001`, `lws-tpl-002`, …)

Walk each `.html` in the bundle for:

- `lwc:inner-html` — verify the bound value's provenance in the JS; untrusted or
  concatenated-from-input sources are findings.
- Expressions bound to attributes LWS treats as sensitive: `href`, `src`,
  `srcdoc`, inline event handlers — check what feeds them.
- Inline `style="…"` with bound expressions — recommend CSS class swaps.
- `<iframe>`/`<object>` without a `sandbox` attribute (the srcdoc/protocol cases
  belong to lws-023a/b; this catches the missing sandbox).

### Meta and configuration checks (ids `lws-meta-001`, …)

Inspect `<name>.js-meta.xml`:

- **Exposure is the LWC usability surface.** An LWC has **no permission-set
  grant** — nothing in a permission set exposes or restricts it. Visibility is
  governed entirely by `isExposed` and the `targets` (+ target configs) in its
  meta. So review both directions: targets the component does not need are
  over-exposure (flag them); and if a fix or review outcome is "this component
  should appear in App Builder / a record page / a flow screen", the matching
  target in the meta IS the usability step (building-salesforce-metadata's
  cardinal rule, applied to LWC) — not a permission set. Say so in the report.
- `@api` properties that expose sensitive data to containers.
- Missing target-config restrictions for the surface it ships to.

JS bindings worth a meta-adjacent look: `@wire` to Apex without
`cacheable=true` where caching is safe; imperative Apex calls that sidestep the
checks a wire adapter would apply. Apex-side fixes route to
`platform-apex-generate`.

## Accessibility checklist (WCAG 2.2)

Flag only clear violations of the cited SC. Minimum sufficient accessibility —
no beyond-WCAG enhancements, no general style feedback. Prefer semantic HTML;
recommend ARIA only where semantics can't do the job.

### LWC calibration rules (read these before flagging anything)

- **Base components are accessible by contract.** `lightning-input`,
  `lightning-combobox`, `lightning-button-icon`, navigation items, etc.
  self-label via their `label` / `alternative-text` attributes — including with
  `variant="label-hidden"` (visually hidden, still exposed to AT). When `label`
  is supplied, that IS the association: do not flag a wrapper `<label>` missing
  `for`/`id`, do not demand ARIA for an `icon-name` (it's decorative), and do
  not emit hedged "verify the label is associated" warnings. Flag a base
  component only when its usage clearly conflicts with WCAG.
- **Resolve template bindings before judging.** `{someValue}` refers to a
  property or getter in the component's JS (`@api` included) — check the
  controller before declaring a binding undefined, empty, or non-descriptive.
  Bound label values are assumed compliant for descriptiveness checks.
- **Actions: prefer a real `<button>`.** For links, `href="#"` plus
  `event.preventDefault()` is the canonical pattern — don't flag it, and never
  recommend `href="javascript:void(0)"` as a remediation (and don't flag it
  where it already exists).
- **Hyphen-split ARIA attributes**: on a plain HTML element,
  `aria-labelled-by`/`aria-described-by` is a real misspelling — flag it. On a
  component tag (`lightning-*` or custom `c-*`), it is the kebab-case binding of
  an `@api ariaLabelledBy` property and is valid — never flag it there.

### Perceivable

- **1.1.1 Images** — informative `<img>` needs meaningful `alt` (not "image"/
  "chart"); decorative images get `alt=""` (optionally `aria-hidden="true"`);
  a decorative image as a link needs an accessible name on the anchor
  (`aria-label`).
- **1.3.1 Lists** — content that looks like a list is `<ul>`/`<ol>`/`<dl>`
  (ordered content ⇒ `<ol>`); nested lists nest inside `<li>`. LWC-specific
  pattern for iterated description lists — wrap each pair and key the wrapper:

  ```html
  <dl>
    <template for:each={entries} for:item="entry">
      <div key={entry.id}><dt>{entry.term}</dt><dd>{entry.value}</dd></div>
    </template>
  </dl>
  ```

- **1.3.1 Tables** — data tables use `<tr>`/`<th>`/`<td>`; headers not in the
  first row/column need `scope`; complex tables use `id`+`headers`. A missing
  `<caption>`/`aria-label` is best practice, NOT a violation.
- **1.3.1 Form labels** — every control programmatically labeled: `<label
  for>`/`id`, `aria-label`/`aria-labelledby`, or the `label` attribute on base
  components. Placeholder/title text alone is not a label. No interactive
  elements nested inside `<label>`.
- **1.3.1 Regions** — page-level sections use landmarks (`<header>`, `<nav>`,
  `<main>` — at most one visible, `<aside>`, `<footer>`) or ARIA landmark roles,
  each labeled when repeated.
- **1.3.1 Groups** — related radios/checkboxes in `<fieldset>` + first-child
  `<legend>`, or `role="radiogroup"`/`role="group"` with an accessible name;
  `<optgroup>` for grouped select options; grouped navigation links in `<nav>`
  (distinguish repeats with `aria-label`).
- **1.3.5 Input purpose** — personal-data fields about the **primary user**
  carry exact standard `autocomplete` tokens (`given-name`, `family-name`,
  `email`, `tel`, `street-address`, `address-line1`, `address-level2`,
  `country`, `bday`, `username`, `current-password`, `new-password`). Single
  exact tokens only — `"email home"` and `"tel mobile"` are violations.
  Non-personal fields (search, quantity): omit or `off`. Security questions:
  `off` required. Fields about **other people** (spouse, emergency contact):
  missing `autocomplete` is fine — do not flag or suggest one.
- **1.4.3 Contrast — flag-for-human.** Source review cannot see rendered pixels,
  inherited tokens, gradients, or images behind text, so contrast is reported as
  a **flag-for-human** item, not a verified finding — except when both colors
  are hardcoded in the bundle and clearly fail. Grayscale-on-white anchors:
  `#767676` is the 4.5:1 boundary for standard text (darker passes — `#666666`
  and darker are fine, never flag them); `#959595` is the 3:1 boundary for
  large text (≥24px, or ≥18.66px bold); `#999999` and lighter fail both. For
  anything you cannot resolve to two concrete colors, do not guess — list it
  under "verify by hand" with the element and the colors involved.

### Operable

- **2.1.1 Keyboard** — click/pointer handlers on `div`/`span` need
  `tabindex="0"` AND an equivalent key handler; `<a>` with `onclick` but no
  `href` is not focusable — use `<button>`; any positive `tabindex` is a
  violation (remove it); parent `tabindex="0"` wrapping a child control with
  `tabindex="-1"` traps keyboard users; hover-only tooltips need focus/keyboard
  access. Unmodified semantic HTML already works — don't flag it.
- **2.4.4 Link purpose** — vague link text ("click here", "read more") without
  programmatic context; icon-only links without `aria-label`; identical link
  text leading to different destinations.
- **2.4.6 Headings and labels** — judge only labels/headings that EXIST and are
  hardcoded strings: flag only clearly vague ones (high confidence). A missing
  name is 4.1.2 or 3.3.2 territory, never a 2.4.6 finding; bound values are
  assumed compliant.
- **2.5.1 Pointer gestures** — path-based or multipoint gestures (swipe
  carousel, pinch zoom) need a single-pointer alternative (prev/next or +/−
  buttons), unless the gesture is essential.
- **2.5.2 Pointer cancellation** — flag only actions executed on a
  **down**-event (`pointerdown`/`mousedown`/`touchstart`) with no abort/undo/
  up-reversal. `onclick`/`onmouseup`/`onkeyup` fire on the up-event and comply —
  never flag an element merely for being interactive.
- **2.5.3 Label in name** — the accessible name must contain the visible label
  text; an `aria-label` that rewords the visible text ("this field is not
  standard" vs visible "nonstandard") fails speech-input users.
  `aria-describedby` is not part of the name — ignore it here.
- **2.5.7 Dragging** — drag-and-drop needs a non-drag single-pointer
  alternative (move buttons, menu, direct input). Keyboard support alone does
  not satisfy 2.5.7.

### Understandable

- **3.2.1 On focus** — `focus` handlers must not change context: no submit,
  no dialog/dropdown/window opening, no moving or stealing focus
  (`onfocus="this.blur()"`). Tooltips and styling on focus are fine.
- **3.2.2 On input** — changing a control's value (`onchange` on a select,
  checking a box) must not auto-submit or navigate unless the behavior is
  described beforehand; provide a submit button for context changes.
- **3.3.1 Error identification** — applies to USER-INPUT errors only (omitted
  required data, bad format) — background/system failures are out of scope. The
  errored field must be identified and described in TEXT (color/icon/console
  alone fails), surfaced to AT (`role="alert"`/`aria-live`, or
  `aria-invalid` + `aria-describedby` tied to the field — that is sufficient);
  the form must not reset on the error path (reset after success is fine). An
  empty optional field is never a violation. Generic "please correct" globals
  fail unless each errored field marks its own state.
- **3.3.2 Labels or instructions** — visible labels for inputs; format
  instructions for constrained fields; required-field indicators;
  placeholder-only labeling is a violation.
- **3.3.3 Error suggestion** — messages say how to fix ("Please enter numbers
  only"), not just "Invalid input"; suggestions programmatically associated
  with the field. Don't flag messages that are already clear, components in the
  `lightning-` namespace with built-in validation, or `aria-describedby`
  pointing at a conditionally rendered message.

### Robust

- **4.1.2 Name** — every interactive component has an accessible name by ANY
  valid means: text content, `<label>`, `aria-label`/`aria-labelledby`, `alt`,
  `title` (iframes need `title`). If one exists, it passes — flag only
  missing, empty, or broken names (`aria-labelledby` → nonexistent id). Range
  roles (`slider`, `spinbutton`, `progressbar`) need numeric
  `aria-valuemin`/`max`/`now`.
- **4.1.2 Role** — custom controls built on `div`/`span` need the correct
  `role` (and template loops rendering list-like structures may need
  `list`/`listitem`); semantic HTML passes implicitly; required ancestor/
  descendant role pairs must both exist (`listitem` ⇒ `list`, `tab` ⇒
  `tablist`, `row` ⇒ `table`/`grid`); no abstract roles; never decorate
  layout-only `div`/`span` with roles.
- **4.1.2 Value** — ARIA attribute values must be valid for their type: boolean
  attributes are present-or-absent (`"true"`/`"false"` strings on HTML boolean
  attributes are bugs), enumerated attributes use spec keywords, numeric
  attributes parse as numbers. For ID-reference attributes check syntax only.

## Findings format

Plain markdown, in the reply. Severity order: Critical → High → Medium → Low.

```markdown
## LWC review: <componentName> (<connection alias>)
Files reviewed: <list, with any files that could not be read called out>

### Findings
#### 1. [High] lws-015 — innerHTML assignment from wire data
- File: <componentName>.js (line ~42)
- Evidence: `this.template.querySelector('div').innerHTML = this.record.body;`
- Why: untrusted org data reaches an HTML sink — XSS.
- Fix: bind `{record.body}` in the template, or set `textContent`.

#### 2. [Medium] SC 1.3.1 (form labels) — input labeled by placeholder only
- File: <componentName>.html (line ~17)
- Evidence: `<input type="text" placeholder="Search accounts">`
- Why: placeholder disappears on input and is not a programmatic label.
- Fix: `<label for="search">Search accounts</label>` or a self-labeling base component.

### Verify by hand (out of static reach)
- Contrast of `.status-text` over the themed background (token-defined colors).
- Keyboard pass and screen-reader pass in a real browser.

### Summary
Security: N findings (ids …). Accessibility: M findings (SCs …).
Boundary: static source review only — no runtime, scanner, or test-runner verification.
```

A clean lens still gets a line ("Security: no catalog rule fired"), never
silence. If a finding is deferred (feature-flagged code, accepted risk), say so
with the reason.

## Applying fixes (only when asked)

1. Work from the complete retrieved bundle — every file from `bundle_files`,
   never a fragment. Preserve behavior and existing feature-flag gates; never
   weaken the security posture to simplify a fix.
2. Re-walk both catalogs over the edited files: every fixed finding must no
   longer fire, and no new sink may appear.
3. Deploy the bundle through `validate_deploy` as ONE component using the
   Contrail bundle envelope — `content` (or `content_file` from staging in
   Claude Code) is JSON:

   ```jsonc
   { "type": "LightningComponentBundle", "api_name": "myComponent",
     "content": "{\"contrail_bundle\":1, \"files\": {
       \"myComponent.js\": \"…\",            // required
       \"myComponent.js-meta.xml\": \"…\",   // required
       \"myComponent.html\": \"…\",
       \"myComponent.css\": \"…\",
       \"templates/alt.html\": \"…\"
     }}" }
   ```

   `<name>.js` and `<name>.js-meta.xml` are required; `.html`/`.css`/`.svg` and
   subdirectories (e.g. `templates/`) are allowed; `__tests__` and dot-files
   are refused locally — leave them out. The whole directory is replaced on
   deploy, so carry every file you retrieved and change only what you mean to
   change. The org compiles the component at validate — that compile is the
   only "does it build" verification that exists here.
4. Keep the usability pairing: if the fix changes where the component may
   appear, the change lands in the meta's `isExposed`/`targets` — not in a
   permission set (LWCs have no permission-set grant).
5. Then the write ritual — validation summary, human-read confirmation code,
   `execute_deploy`, `refresh_snapshot` — by reference:
   **salesforce-house-rules §3**. Never restate or shortcut it.

## Cross-skill integration

| Need | Delegate to |
|---|---|
| @AuraEnabled / Apex controller review or fixes | `platform-apex-generate` |
| Packaging, staging paths, content vs content_file | `building-salesforce-metadata` |
| Connections, grants, approval ritual, large-artifact reads | `salesforce-house-rules` |

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (experience-lwc-security-validate + experience-lwc-accessibility-validate), Apache-2.0, © Salesforce, Inc. Modified: merged two upstream validators into one review skill; retargeted from local-workspace tooling to Contrail engine reads/deploys; SARIF score mode, scripts, and vision reviewers stripped; rule catalogs condensed inline.*
