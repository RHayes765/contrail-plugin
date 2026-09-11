---
name: platform-prompt-template-generate
description: "Use this skill when users need to create, modify, or validate Salesforce prompt template (GenAiPromptTemplate) metadata through the Contrail engine. Trigger when users mention prompt templates, Prompt Builder, GenAiPromptTemplate, flex / sales-email / field-completion / record-summary / case-email templates, template versions or activeVersionIdentifier, a prompt template deploy failure, or wiring a template into a flow or agent action. DO NOT TRIGGER for the agent-side metadata that invokes a template — topics, actions, planner bundles are agentforce-metadata-generate — or for Einstein setup, licensing, or model enablement, which is org-UI admin work."
metadata:
  domains: ["Platform"]
  minApiVersion: "64.0"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "agentforce-metadata-generate"
---

# Prompt templates through Contrail

Use this skill to:

- Author GenAiPromptTemplate metadata — flex, sales email, field completion,
  record summary, case email draft
- Add a new version to an existing template and repoint the active version
- Wire template inputs, grounding data providers, and merge fields correctly
- Troubleshoot template deploy failures — above all the version-identifier one

Follow **salesforce-house-rules** for connections, grants, and the write
ritual; **building-salesforce-metadata** for packaging. The grammar below is
the Metadata API catalog for GenAiPromptTemplate cross-checked against a live
Agentforce org — where they disagree, the live retrieve won.

## 1. How a template deploys through Contrail

GenAiPromptTemplate is a **top-level, single-file** component: one flat
`.genAiPromptTemplate` file per template, every version inline. `content` is
the full document — XML declaration and
`<GenAiPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata">` root
(Contrail generates the manifest and meta files):

```jsonc
{
  "connection": "uat",
  "components": [
    { "type": "GenAiPromptTemplate", "api_name": "Case_Summary",
      "content_file": "<staging>/Case_Summary.genAiPromptTemplate.xml" }
  ]
}
```

- **Environments, once:** in Claude Desktop chat (no file tools) author
  inline and pass `content`. In Claude Code, write the document under
  Contrail's `staging/` directory and pass `content_file` — template bodies
  are long prose; prefer the file route.
- **Modify = whole-document replace.** An omitted version is a deleted
  version. Always `retrieve_metadata` the current template, edit that
  document, redeploy it whole (§3).
- **Snapshot note:** GenAiPromptTemplate is **explicit-refresh-only** — after
  any deploy, `refresh_snapshot` with `types: ["GenAiPromptTemplate"]`; the
  default sweep won't pick it up.

## 2. Grammar

Top level (catalog fields, 9 total):

| Element | Required | Notes |
|---|---|---|
| `masterLabel` | yes | UI name |
| `type` | yes | `einstein_gpt__flex` / `einstein_gpt__salesEmail` / `einstein_gpt__fieldCompletion` / `einstein_gpt__recordSummary` / `einstein_gpt__caseEmailDraft` |
| `templateVersions` | yes | Repeatable — one block per version, all versions in the file |
| `activeVersionIdentifier` | see §3 | Org-generated token naming the active version |
| `activeVersion` | NEVER | Deprecated int — dies at API 64.0+. Its presence in retrieved legacy XML is a signal the source predates the cutover |
| `description` | no | Always write one |
| `visibility` | no | `API` or `Global` — `Global` required for agent use (§5) |
| `relatedEntity` / `relatedField` | conditional | fieldCompletion targeting (§5) |

Each `<templateVersions>` block:

| Element | Required | Notes |
|---|---|---|
| `content` | yes | The prompt text, merge fields included (§4). CDATA-wrap when it contains `&`, `<`, `>` |
| `status` | yes | `Published` or `Draft`. The active version must be `Published` |
| `versionIdentifier` | org-minted | Same token doctrine as §3 |
| `versionNumber` | NEVER | Deprecated int — dies at 64.0+, same as activeVersion |
| `inputs` | per template | Repeatable: `apiName`, `definition` (URI, e.g. `SOBJECT://Account`), `referenceName` (e.g. `Input:Recipient`), `required` |
| `templateDataProviders` | per template | Repeatable: `definition` (`flow://<FlowApiName>`), `referenceName`, and `parameters` (`definition`, `isRequired`, `parameterName`, `valueExpression` like `{!$Input:Recipient}`) |
| `primaryModel` | no | **Org-specific — retrieve, don't guess** (below) |
| `description`, `generationTemplateConfigs` | no | Version description; policy references |

**primaryModel is org configuration, not grammar.** The catalog sample says
`sfdc_ai__DefaultOpenAIGPT4`; the live verification org returns
`sfdc_ai__DefaultOpenAIGPT4OmniMini`. Model developer names drift by org and
release — retrieve an existing template from the **target** org and reuse the
model name it shows, or omit the element and let the org default.

**Published versions are IMMUTABLE.** A `Published` version cannot be edited
via UI or Metadata API. "Change the prompt" therefore never means editing the
published block — it means: append a NEW `<templateVersions>` block with the
new content, and repoint `activeVersionIdentifier` at it once the org has
minted its token (§3). Keep the old versions in the document — they are
history the org still holds.

## 3. The activeVersionIdentifier doctrine

The identifiers are **org-generated opaque tokens**. Live shape:
`DnDwH0uG…=_1` — a base64-style blob ending `=` plus `_<n>`. Treat the whole
string as opaque. The rules:

1. **Retrieve-first on EVERY modify.** Before touching an existing template:
   `refresh_snapshot` types `["GenAiPromptTemplate"]`, then
   `retrieve_metadata` it. The tokens in that retrieve are the only valid
   tokens. (Live probing also showed retrieved content differing slightly
   across API versions — one more reason the current retrieve, not an old
   copy, is the base document.)
2. **Never hand-type, derive, or increment a token.** `…=_1` → `…=_2` is not
   a new version identifier; it is a corrupt one. There is no arithmetic on
   these values.
3. **Net-new template: OMIT both identifier elements entirely.** The org
   mints `versionIdentifier` on deploy and activates accordingly. (Catalog
   wording says a unique value "will be generated for you" when unspecified;
   omission on net-new is the doctrine here, flagged for live confirmation
   on first use.) Round-trip afterward to learn what was minted (§6).
4. **New version of an existing template:** keep every existing block's
   `versionIdentifier` byte-identical from the retrieve; add the new block
   WITHOUT a `versionIdentifier`; leave `activeVersionIdentifier` untouched
   in that deploy. Then retrieve again, read the minted token, and repoint
   `activeVersionIdentifier` in a second small deploy.
5. `validate_deploy` **warns automatically on hand-typed or altered
   identifiers** — treat that warning as a stop, not a formality: go back to
   the retrieve.

Failure signature to recognize: a template deploy rejected (or silently
mis-activated) with identifier-shaped complaints almost always traces to a
token that was typed, edited, or copied from another org. Tokens never travel
between orgs — each org mints its own.

## 4. The merge-field language

No documentation page teaches this end to end — the catalog's sample
template is the source of what follows.

**Two reference families in `content`:**

- `{!$Input:<ReferenceName>.<Field>}` — reads a field from a template
  **input** record: `{!$Input:Recipient.Name}`,
  `{!$Input:Sender.CompanyName}`. `Recipient`/`Sender` must match an
  `<inputs><referenceName>` (written there as `Input:Recipient` — the
  `Input:` prefix lives in the declaration, the `$Input:` form in the
  expression).
- `{!$Flow:<FlowApiName>.<OutputVar>}` — splices a data-provider flow's
  output into the prompt: `{!$Flow:Fetch_Products.Prompt}`. The flow must be
  declared as a `<templateDataProviders>` with `definition`
  `flow://Fetch_Products`.

**The plumbing between inputs and data providers:** inputs are the records
the caller hands in; data providers are flows the template runs at
generation time to fetch grounding data. A provider's `<parameters>` bind
its flow inputs to template inputs via `valueExpression` —
`{!$Input:Recipient}` passes the whole input record into the flow. Skeleton:

```xml
<templateVersions>
    <content>You are a financial advisor named {!$Input:Sender.Name}.
Client: {!$Input:Recipient.Name}

{!$Flow:Fetch_Products.Prompt}

Write a concise recommendation email.</content>
    <inputs>
        <apiName>Sender</apiName>
        <definition>SOBJECT://User</definition>
        <referenceName>Input:Sender</referenceName>
        <required>true</required>
    </inputs>
    <inputs>
        <apiName>Recipient</apiName>
        <definition>SOBJECT://Contact</definition>
        <referenceName>Input:Recipient</referenceName>
        <required>true</required>
    </inputs>
    <status>Published</status>
    <templateDataProviders>
        <definition>flow://Fetch_Products</definition>
        <parameters>
            <definition>SOBJECT://Contact</definition>
            <isRequired>true</isRequired>
            <parameterName>Recipient</parameterName>
            <valueExpression>{!$Input:Recipient}</valueExpression>
        </parameters>
        <referenceName>Flow:Fetch_Products</referenceName>
    </templateDataProviders>
</templateVersions>
```

**URI definitions:** `SOBJECT://<Object>` types an input as a record of that
object (`SOBJECT://Account/Description` narrows to a field);
`flow://<FlowApiName>` names a data-provider flow. These are the only two
schemes in the catalog — don't invent others.

**Consistency checks before deploy:** every `{!$Input:X.…}` in `content` has
a matching `<inputs>` declaration; every `{!$Flow:Y.…}` has a matching
`<templateDataProviders>`; every provider parameter's `valueExpression`
references a declared input. A dangling reference deploys into a template
that fails at generation time — the API does not cross-validate the prose.

## 5. Usable, not just deployed

A template that deploys green can still be invisible or broken where the
user needs it:

- **Agent actions require `visibility` `Global`.** A template targeted by an
  agent `generatePromptResponse` action must carry
  `<visibility>Global</visibility>` — the live agent-org templates all do.
  Default/API visibility keeps it out of the agent's reach. The agent-side
  wiring itself is agentforce-metadata-generate.
- **Data-provider flows must exist** — already in the target org, or as
  `Flow` components in the same package (the API resolves in-package
  references). A `flow://X` pointing at nothing is a broken template.
  Flows used as providers must be the prompt-flow shape (template-triggered)
  and active.
- **fieldCompletion needs targeting:** `relatedEntity` (e.g. `Account`) and
  `relatedField` name where the ✨ field-generation button appears. Without
  them a fieldCompletion template deploys but surfaces nowhere.
- **Grounding fields must exist.** Every `{!$Input:X.Field__c}` references a
  real field — `describe_schema` the object before authoring; a typo'd field
  survives deploy and dies at generation.
- **No FLS story of its own** beyond Prompt Builder/Einstein feature access —
  do not invent a PermissionSet for the template; do note that generation
  runs with the invoking user's data access, so grounding data the user
  cannot see comes back empty.

## 6. Workflow and verify

1. **Ground** (§2 of house rules): `list_connections`, `get_permissions`;
   `refresh_snapshot` types `["GenAiPromptTemplate"]`; for a modify,
   `retrieve_metadata` the current document — it is the base you edit. For a
   net-new, retrieve any existing template from the target org as the model
   for `primaryModel` and house style.
2. **Author**: full document per §2–§5; staging file + `content_file` in
   Claude Code, inline `content` in Desktop chat.
3. **Deploy**: one consolidated `validate_deploy` — template plus any new
   data-provider flows, one package, one approval. Template-only packages
   carry no Apex: **omit `test_level` entirely** (production refuses an
   explicit `NoTestRun`). Lead the summary with the target org and, on a
   modify, exactly which versions changed. Heed the identifier warning (§3).
   Human reads the confirmation code from the approval page;
   `execute_deploy`; full ritual is salesforce-house-rules §3.
4. **Refresh + round-trip**: `refresh_snapshot` types
   `["GenAiPromptTemplate"]`, then `retrieve_metadata` the template and read
   back what the org actually holds — above all **which
   `versionIdentifier` the org minted** for a new version, and that
   `activeVersionIdentifier` points where intended. `diff_artifact` against
   your authored document to see what the org normalized.
5. **Honest close**: Contrail cannot EXECUTE a prompt template — there is no
   generation tool. The human tests output quality in Prompt Builder's
   preview (and, for agent-wired templates, in the agent's test surface).
   Say so; a green deploy plus a clean round-trip is proof of shape, not of
   good prose.

---
*Grammar mined from the Metadata API catalog (`GenAiPromptTemplate.json`,
[forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7,
Apache-2.0, © Salesforce, Inc.). Token shapes, model name, visibility, and
version-immutability behavior live-verified against an Agentforce Developer
Edition org, 2026-09.*
