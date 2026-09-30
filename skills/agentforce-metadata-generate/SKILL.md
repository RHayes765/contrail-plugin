---
name: agentforce-metadata-generate
description: "Use this skill when users need to create or modify Agentforce agent metadata through the Contrail engine — agent topics (GenAiPlugin), Bot and BotVersion metadata, planner bundles, Agent Script draft staging (AiAuthoringBundle), or activating/deactivating agent versions, or when an agent metadata deploy failed. Trigger on requests like 'add a topic to my agent', 'stage this agent script', 'deactivate the agent so we can deploy', editing topic instructions or action wiring, changing bot versions or channel surfaces, or promoting agent metadata between orgs. DO NOT TRIGGER for running, previewing, or PUBLISHING agents (human-only lifecycle operations — Contrail stages drafts and flips activation, it never compiles or publishes), for prompt templates (platform-prompt-template-generate), for agent evals (agentforce-eval-generate), or for documenting an existing agent (agentforce-architecture-analyze)."
metadata:
  domains: ["Agentforce"]
  minApiVersion: "66.0"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-permission-set-generate"
    - "agentforce-architecture-analyze"
    - "platform-prompt-template-generate"
    - "agentforce-eval-generate"
---

# Agentforce agent metadata through Contrail

Use this skill to:

- Add or modify agent topics (`GenAiPlugin`) on classic Builder agents
- Edit `Bot` / `BotVersion` metadata — versions, planner wiring, surfaces
- Stage Agent Script as a DRAFT (`AiAuthoringBundle` — §3a; compiling stays human)
- Activate/deactivate agent versions (`agent_activation_propose/execute` — §2, §5)
- Apply the two documented runtime patches (`plannerSurfaces`, `surfacesEnabled`)
- Promote retrieved agent metadata between orgs
- Troubleshoot agent metadata deploy failures

Follow **salesforce-house-rules** for connections, grants, and the write ritual
(§3 is the deploy ritual — cited throughout, never restated);
**building-salesforce-metadata** for packaging. Agent metadata needs the
connection's `salesforce.apiVersion` at **v66.0 or higher** (§12 on why the
cutover is hard). Everything here assumes v66+.

## 1. Two domains — and when direct authoring is legitimate

Agentforce metadata splits into two domains:

- **Authoring domain** — `AiAuthoringBundle` (`.agent` Agent Script source),
  compiled by Salesforce's publish pipeline into the runtime graph. Contrail
  reads, diffs, and deploys it as a DRAFT STAGE (§3a) — compiling and
  publishing stay with Agentforce Studio or Salesforce's Agentforce DX
  publish command, always.
- **Runtime domain** — `Bot` → `BotVersion` → `GenAiPlannerBundle` →
  `GenAiPlugin` → `GenAiFunction`. What the org actually executes.

Direct runtime authoring is **legitimate** for exactly three things:

1. **Classic Builder agents' topics** — no Agent Script source exists; their
   `GenAiPlugin` components are the real editing surface.
2. **The documented patches** — `plannerSurfaces` (§8) and `surfacesEnabled`
   (§7), which no authoring path generates for you.
3. **Cross-org promotion** — deploying retrieved bytes unchanged.

Everything else is **fighting the platform**: hand-edits to the compiled
bundles of an Agent-Script agent are silently overwritten by the next
publish. Detect which kind of agent you have before editing — retrieve its
`GenAiPlannerBundle` and look for `agentScript/` content in the
`bundle_files` listing; present means Agent-Script-maintained, a compiled
artifact rather than a source file. When you can't tell, **ask the human how
the agent is maintained** before proposing any edit.

## 2. The lifecycle boundary — what stays human, what Contrail now does

Contrail deploys metadata and (since S34) flips activation behind its own
ritual. These operations remain **human-only**, handed off every time:

| Operation | Where the human does it |
|---|---|
| Publish/compile an Agent Script agent | Agentforce Studio, or Salesforce's Agentforce DX publish command |
| Preview a conversation | Agent Builder preview panel (one-shot utterance checks: the `generateAiAgentResponse` anonymous-Apex pattern — agentforce-eval-generate §7) |
| Create a new draft version | Agentforce Studio, on a published version |

**Activate / deactivate moved to Contrail**: `agent_activation_propose` →
human reads the code from the approval page → `agent_activation_execute` —
one documented Connect REST call on a PUBLISHED version, each flip its own
ritual (the page warns it changes live behavior immediately). The org refuses
drafts and explains refusals in the result's `messages[]` — relay them
verbatim.

**Run evaluations moved to Contrail too** (S35): `run_agent_eval` executes a
deployed AiEvaluationDefinition and fetches per-case results — the agent
under test executes its REAL actions (no rollback), so sandbox-first;
authoring, running, and reading results are agentforce-eval-generate's
territory.

What Contrail verifies from outside: activation state via `soql_query`
— `SELECT Id, DeveloperName, Status FROM BotVersion WHERE
BotDefinition.DeveloperName = 'Support_Agent'` (`Status` is the activation
check; Data API, no tooling flag) — and what the org actually holds, via
`retrieve_metadata` after any handoff.

**The rule: never present a successful deploy as an activated, published, or
tested agent.** A green `execute_deploy` means the org accepted metadata —
nothing more (a staged Agent Script draft compiles NOTHING — §3a). End every
agent deploy summary by naming the remaining lifecycle steps and who — or
which ritual — performs them.

## 3. Type map and fullName shapes

What Contrail can deploy today, and the shapes live-verified in a real org:

| Type | Contrail today | fullName shape (live-confirmed) |
|---|---|---|
| `Bot` | **Deploy** (single file) | Flat: `Support_Agent` — one `.bot` document, versions inline |
| `BotVersion` | **Deploy** (child of Bot) | Dotted: `Support_Agent.v1` |
| `GenAiPlugin` | **Deploy** (single file) | Flat: `Order_Management`; instruction child names are org-generated (`instruction_0_<timestamp>` — see §6) |
| `GenAiPromptTemplate` (+`Actv`) | **Deploy** — author via platform-prompt-template-generate | Flat; carries live `activeVersionIdentifier` tokens |
| `AiEvaluationDefinition` | **Deploy** — author via agentforce-eval-generate | Flat |
| `BotTemplate`, `BotBlock` | **Deploy** (single file) | Flat |
| `GenAiFunction` | **Deploy** (bundle ENVELOPE — §8) | `Name` dir: `Name.genAiFunction-meta.xml` + `input/schema.json` + `output/schema.json` |
| `GenAiPlannerBundle` | **Deploy** (bundle ENVELOPE — §8; promotion of retrieved bytes, not hand-authoring) | Underscore-versioned: `Support_Agent_v2`, one component per published version |
| `AiAuthoringBundle` | **Deploy (DRAFT-stage envelope — §3a)** | Naked name = editable draft; `_1`, `_2`… = published snapshots (platform-owned) |

- A Metadata API deploy of Agent Script **never compiles it** — at any API
  version. Without `<target>` it lands as a documented DRAFT in Agentforce
  Studio (what Contrail's deploy does); pretending a deploy publishes an
  agent was the lie S30 guarded against, and the approval page now carries
  that honesty on every draft deploy instead.
- Salesforce's CLI has an `Agent:` convenience pseudo-type; **Contrail has no
  pseudo-type** — address each real type by name (`Bot` and its `GenAiPlugin`s
  are separate retrieves).
- Apex, Flows, and Named Credentials backing agent actions are ordinary
  metadata — they deploy separately, before the agent metadata (§10).

## 3a. Agent Script draft staging (AiAuthoringBundle)

The one Contrail path for Agent Script: deploy the source as a **draft**.
The envelope is exactly two files — live-confirmed:

```jsonc
{ "type": "AiAuthoringBundle", "api_name": "Support_Agent", "content": "{\"contrail_bundle\":1, \"files\": {
    \"Support_Agent.agent\": \"<plaintext Agent Script — system:/config:/topic blocks>\",
    \"Support_Agent.bundle-meta.xml\": \"<AiAuthoringBundle…><bundleType>AGENT</bundleType></AiAuthoringBundle>\" } }" }
```

- The `.agent` body is **plaintext Agent Script**, not base64 (the base64
  `.agent` you may see inside a planner bundle's `agentScript/` dir is the
  COMPILED artifact — a different animal; never deploy that here).
- **Author against the NAKED bundle name only** — `_1`, `_2`… suffixed names
  are published snapshots the platform owns (the approval page warns if you
  target one). Retrieve-first for any modify: the deploy replaces the whole
  bundle.
- `.bundle-meta.xml` carries `bundleType` (always `AGENT`) and optionally
  `versionDescription`/`versionTag`. **Omit `<target>`** unless deliberately
  linking already-deployed runtime metadata — a `<target>` deploy fails when
  that Bot/BotVersion doesn't exist, and it still compiles nothing.
- **What the green deploy means**: the draft exists in Agentforce Studio.
  The RUNNING AGENT IS UNCHANGED — topics, actions, and behavior go live
  only when a human publishes the draft (Studio, or Salesforce's Agentforce
  DX publish command). Say this in every summary; the approval page says it
  too. Also warn: the next Studio publish can overwrite a staged draft —
  coordinate with whoever owns the agent in Studio.
- Naked drafts carry **no fileProperties dates** in listMetadata, so the
  local index can't detect staleness for them (suffixed snapshots DO carry
  dates). Re-retrieve before editing rather than trusting the snapshot's age.
- Verify a staged draft: `refresh_snapshot types:["AiAuthoringBundle"]` →
  `retrieve_metadata` round-trip, and have the human eyeball the draft in
  Studio. `soql_query` on BotVersion proves the runtime is untouched (no new
  version rows).

## 4. Ground before you author

House rules first (`list_connections`, `get_permissions`). Then:

| Need | Tool |
|---|---|
| Agent inventory | `list_metadata` type `Bot`, or `soql_query` on `BotDefinition` |
| **Activation state** (gates every modify — §5) | `soql_query`: `SELECT Id, DeveloperName, Status FROM BotVersion WHERE BotDefinition.DeveloperName = 'Support_Agent'` |
| Current XML — **retrieve-first on EVERY modify** | `retrieve_metadata` — the org's document is ground truth; never author agent XML from memory |
| A valid Einstein-Agent-license user exists (§12) | `soql_query`: `SELECT Id, Username, IsActive FROM User WHERE Profile.UserLicense.Name = 'Einstein Agent' AND IsActive = true` |
| Action targets exist (Apex / Flow / prompt template) | `list_metadata` / `search_metadata` for each `invocationTarget` before wiring a `functionName` |
| Agent-graph internals | `soql_query` with `tooling: true` — the agent-graph sObjects (`GenAiPluginDefinition` and kin) are **Tooling-only**; the flag needs both `metadata_read` and `data_read` grants. `BotDefinition`/`BotVersion` are ordinary Data-API objects — no flag |

## 5. The deactivate gate — now a three-ritual workflow

The platform refuses modifies to an active agent's topics and planner. Since
S34 every step runs through Contrail, each behind its OWN approval:

1. **Query status** (§4 SOQL). No `Active` version → deploy normally.
2. A version is **Active** → **ritual 1**: `agent_activation_propose`
   `status: "Inactive"` — the human approves the flip on its own page.
   Never queue the deploy speculatively; the agent goes offline the moment
   this executes, so say when.
3. **Re-query** — trust the org (`confirmed_status` in the execute result IS
   the org's answer, but re-query before the deploy anyway).
4. Deploy the topic/planner change (**ritual 2** — house-rules §3).
5. **Ritual 3**: `agent_activation_propose` `status: "Active"` to restore.
6. **Re-query** to confirm the end state, and report all three outcomes.

Three separate codes, deliberately: never ask the human to pre-approve the
reactivation before the deploy's outcome exists. If the deploy fails, the
human decides whether to reactivate the OLD state (usually yes — propose it)
or hold. `validate_deploy` flags the gate automatically on `GenAiPlugin` /
`GenAiPlannerBundle` modifies — treat that warning as step 2 arriving late,
not as noise.

## 6. Authoring GenAiPlugin topics

The grammar (catalog and WSDL agree for this type): required
`developerName`, `masterLabel`, `language`, `pluginType`
(`Topic` | `APICustomTopic`); plus `description`, `scope` (the topic's job
description — the planner routes on it), `canEscalate`, `genAiFunctions`
(repeating `functionName` refs to existing actions), and
`genAiPluginInstructions`.

The root element, exactly — retrieved topics carry
`<language xsi:nil="true"/>` on instructions, which fails the deploy unless
the `xsi` namespace is declared on the root:

```xml
<GenAiPlugin xmlns="http://soap.sforce.com/2006/04/metadata"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
```

A representative instruction, as the org writes it:

```xml
<genAiPluginInstructions>
    <description>Do not declare your intent - just fetch the data.</description>
    <developerName>donotdecla1</developerName>
    <language xsi:nil="true"/>
    <masterLabel>donotdecla</masterLabel>
</genAiPluginInstructions>
```

- **Instruction names are org-generated, and the convention CHANGED.**
  Current orgs mint `instruction_<sortOrder>_<epochMillis>` for both
  `developerName` and `masterLabel` (live-confirmed:
  `instruction_0_1789147477653`), with a `<sortOrder>` element; older agents
  carry the legacy text-prefix mangle (`therearemu0`, `donotdecla1`). On
  **modify, preserve retrieved names exactly** — they are identity, not
  decoration.
- For **new** instructions, mirror the current `instruction_<n>_<timestamp>`
  pattern (any epoch-millis value works as a uniquifier); whether arbitrary
  well-formed names also survive is **not live-confirmed** — verify with the
  §11 round-trip retrieve.
- `pluginType`: Builder topics are `Topic`; `APICustomTopic` is the
  API-defined variant. Preserve whatever was retrieved.

## 7. Bot and BotVersion

Live-confirmed layout: a `Bot` is **one flat document** — `bots/<Name>.bot`,
no directory, no separate meta file — with every version inline:

```xml
<Bot xmlns="http://soap.sforce.com/2006/04/metadata">
    <botVersions>
        <fullName>v1</fullName>
        <conversationDefinitionPlanners>
            <genAiPlannerName>Support_Agent_v1</genAiPlannerName>
        </conversationDefinitionPlanners>
        <surfacesEnabled>true</surfacesEnabled>
        <!-- … -->
    </botVersions>
    <!-- v2, v3 … follow inline -->
</Bot>
```

- **BotVersion deploys as a child type** with dotted names
  (`Support_Agent.v1`) — the `CustomObject`/`CustomField` pattern. Prefer
  deploying the one version you changed over the whole Bot document.
- **The VERSION DELETE trap:** deploying the full Bot document is a
  whole-document replace — **a version block you omit is a version you
  deleted**. Always start from the complete retrieved document.
  `validate_deploy` warns automatically on whole-document replaces; a Bot
  package that drops a version leads your summary as a destructive change.
- **`surfacesEnabled` — a worked catalog-is-wrong example.** The catalog says
  "reserved for internal use"; in reality `true` on the BotVersion is
  **required for Agent Runtime API access** — without it, session creation
  500s. Trust the live org over the catalog's fields table.
- **`conversationDefinitionPlanners` / `genAiPlannerName`** is the real
  (WSDL- and live-confirmed) pair linking a version to its planner bundle;
  the docs' fields table says `conversationPlanner`, which is wrong. The
  **active** planner version is referenced right here in the Bot XML — planner
  and Bot edits travel together.

## 8. GenAiFunction and GenAiPlannerBundle — bundle deploys via the envelope

These two types are **directories of files**, and they deploy through a
**Contrail bundle envelope**: `content` (or better, `content_file`) is JSON —

```jsonc
{ "contrail_bundle": 1, "files": {
    "Get_Order_Status.genAiFunction-meta.xml": "<GenAiFunction>…</GenAiFunction>",
    "input/schema.json":  "{ …JSON Schema… }",
    "output/schema.json": "{ …JSON Schema… }"
} }
```

- Paths are relative to the bundle's directory; the **main file is required**
  and its name is `<api_name>.genAiFunction-meta.xml` for functions
  (live-confirmed: the main XML keeps a `-meta.xml` suffix even in metadata
  format) and bare `<api_name>.genAiPlannerBundle` for planner bundles.
- Build the file set from `retrieve_metadata`'s `bundle_files` listing —
  retrieve-first, carry every file, change only what you mean to change. The
  approval page classifies **file-by-file** (added/removed/changed named) and
  the whole directory is replaced on deploy.
- A standalone `GenAiFunction` is genuinely authorable (main XML +
  `input/schema.json` + `output/schema.json` — grammar below). A
  `GenAiPlannerBundle` is **promotion-of-retrieved-bytes, never
  hand-authoring**: its live layout is deep compiled output —

```
genAiPlannerBundles/Support_Agent_v2/
    Support_Agent_v2.genAiPlannerBundle
    agentGraph/Support_Agent_v2_graph.json
    agentScript/Support_Agent_v2_definition.agent
    localActions/<Topic_ID>/<Action_ID>/input/schema.json  (+ output/)
```

  — path segments carry **org-specific IDs**. Version-suffixed bundles are
  **published snapshots**: modified deploys fail ("content cannot be changed
  on a locked version"); unmodified deploys "succeed" as misleading no-ops;
  the approval page repeats this on every planner-bundle modify.
  (One `AiAuthoringBundle` quirk: NAKED draft names return no fileProperties
  rows — the local index has no last-modified dates for drafts, so staleness
  detection is limited exactly there; suffixed published snapshots DO carry
  dates.)

GenAiFunction grammar (live-confirmed against a platform-generated action):

- Main XML root `<GenAiFunction>` with `developerName`, `localDeveloperName`
  (a WSDL-only field the catalog omits), `masterLabel`, `invocationTarget` +
  `invocationTargetType` (e.g. `generatePromptResponse` targeting a prompt
  template, `apex`, `flow`), `isConfirmationRequired`, and the
  progress-indicator pair (`isIncludeInProgressIndicator`,
  `progressIndicatorMessage`) the catalog also omits.
- Schemas use `lightning:type` annotations (`lightning__textType`,
  `lightning__booleanType`, root `lightning__objectType`) plus
  `copilotAction:isUserInput` on inputs and
  `copilotAction:isDisplayable`/`isUsedByPlanner` on outputs.
- **The one-output rule** — the catalog on `copilotAction:isUsedByPlanner`
  in a function's output schema: "At least one output property must have this
  value as true or else the planner returns random responses." (The
  platform's own generated schemas set it true on every output property.)
  Diagnostic gold when an agent answers nonsense after an action runs.
- **The `plannerSurfaces` patch** — verbatim from the deployment guide, added
  inside the `GenAiPlannerBundle` main XML:

  ```xml
  <plannerSurfaces>
      <adaptiveResponseAllowed>false</adaptiveResponseAllowed>
      <callRecordingAllowed>false</callRecordingAllowed>
      <surface>SurfaceAction__CustomerWebClient</surface>
      <surfaceType>CustomerWebClient</surfaceType>
  </plannerSurfaces>
  ```

  Without it, Agent Builder Preview shows "Something went wrong" and the
  Agent Runtime API returns `500 UNKNOWN_EXCEPTION` on session creation.
  **Check before patching (fix landed upstream 2026-07-23):** current
  publishes compile a `connection customer_web_client:` block in the Agent
  Script into this surface automatically — retrieve the freshly published
  bundle and look; only pre-fix orgs (or scripts without the connection
  block) still need the patch, re-applied after every publish. Apply it
  through the envelope: retrieve the bundle, add the block to the main XML,
  carry every other file unchanged, deploy through the ritual (the
  deactivate gate applies — §5).

## 9. Permissions

Agent access rides **real permission sets** — the `agentAccesses` block pairs
an agent's developer name with `enabled`. Delegate the XML to
**platform-permission-set-generate** (its "Agentforce agent access" section)
and ship the set in the same package, per the building-salesforce-metadata
cardinal rule. This is the **opposite** of the Reports/Dashboards
folder-sharing exception: agents are on the permission-set path, so silence
from `permission_warning` is not cover here.

## 10. Dependency order

Dependencies deploy **before** the agent metadata that references them:

```
Custom Objects/Fields → Apex classes → Flows → Named Credentials → agent metadata
```

Backing pieces go first, in their own packages (each with its specialist
skill and permission set), then the agent components. An agent package whose
`functionName` targets don't resolve fails validation at best — at worst it
validates green and breaks in conversation.

## 11. Verify after deploy

1. **Round-trip retrieve.** `retrieve_metadata` the deployed component and
   diff against what you sent — the org **normalizes agent XML** (element
   reordering, generated names), so a byte-diff is expected; verify the
   semantic change survived and treat the org's spelling as the new baseline.
2. **Refresh the snapshot** — agent types are explicit-refresh-only:
   `refresh_snapshot` with `types: ["Bot", "GenAiPlugin"]` (whatever you
   touched). Needs the v66+ apiVersion; unsupported types degrade per-type
   with a warning rather than failing the refresh — read the warnings.
3. **Re-check activation state** (§2 SOQL) and report it.
4. For the full picture, hand off to **agentforce-architecture-analyze**.

The honest close: Contrail can prove the org holds the metadata and which
version is active. Whether the agent **converses correctly** only a human in
Agent Builder preview can check — say so in every summary.

## 12. Details that actually bite

- **The license trap.** Publish fails with "Internal Error, try again later" —
  which **masks** a missing Einstein Agent license on the agent's
  `default_agent_user`; the error text never mentions licensing. Diagnostic:
  `soql_query` — `SELECT Id, Username, IsActive FROM User WHERE
  Profile.UserLicense.Name = 'Einstein Agent' AND IsActive = true`. No rows →
  that is the problem, whatever the error says.
- **Catalog-vs-WSDL discrepancies.** For Bot, BotVersion, and
  GenAiPlannerBundle the catalog's fields tables are doc-scraped and wrong in
  places — the WSDL segment is authoritative. Known errors:
  `conversationPlanner` (§7), `surfacesEnabled` "reserved for internal use"
  (§7), and the `GenAiPlannerBundle` table omitting `plannerSurfaces`,
  `localTopics`, `localTopicLinks`, `agentScript` — all real, WSDL-listed,
  live-confirmed elements.
- **`activeVersionIdentifier` is a machine token.** Live values are opaque
  (`DnDwH0uG…=_1`). Never hand-type or "fix" one — `validate_deploy` warns
  automatically on hand-typed or altered tokens. Carry retrieved tokens
  through unchanged.
- **The v66 floor is a hard cutover, not a preference.** At v63 the legacy
  `GenAiPlanner` type is valid and the bundle types are `INVALID_TYPE`; at
  v64+ that inverts. Mixed-version reasoning about planner metadata produces
  confident nonsense — Contrail defaults to v67 since S34; never go below
  v66 for agent work. (Winter '27's v68 `AiAgentDefinition` model is not yet
  supported — say so if asked.)

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (agent-deployment-guide.md, agent-metadata-and-lifecycle.md, and the Metadata API catalog entries for Bot, BotVersion, GenAiPlugin, GenAiFunction, and GenAiPlannerBundle; Apache-2.0, © Salesforce, Inc.). Modified: mechanism retargeted from the Salesforce CLI to the Contrail engine tools and the human-approval write contract; fullName shapes and file layouts live-verified against an Agentforce Developer Edition org (2026-09); S34 (2026-09-30): Agent Script draft staging and the activation ritual added, lifecycle boundary updated.*
