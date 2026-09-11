---
name: agentforce-metadata-generate
description: "Use this skill when users need to create or modify Agentforce agent metadata through the Contrail engine — agent topics (GenAiPlugin), Bot and BotVersion metadata, planner bundles, or an agent metadata deploy that failed. Trigger on requests like 'add a topic to my agent', 'add an instruction to my agent', editing topic instructions or action wiring, changing bot versions or channel surfaces, or promoting agent metadata between orgs. DO NOT TRIGGER for Agent Script / .agent / AiAuthoringBundle authoring (no Contrail path exists — say so and stop), for running, previewing, publishing, or activating agents (human-only lifecycle operations), for prompt templates (platform-prompt-template-generate), for agent evals (agentforce-eval-generate), or for documenting an existing agent (agentforce-architecture-analyze)."
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
  reads and diffs it, never deploys it (§3 says why that is permanent).
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

## 2. The lifecycle boundary — five operations only a human performs

Contrail deploys metadata. It does not operate agents. These five operations
have **no Contrail path** and are handed to the human, every time:

| Operation | Where the human does it |
|---|---|
| Publish an Agent Script agent | Agentforce Studio |
| Activate / deactivate a version | Setup → Agent Builder (or Agentforce Studio) |
| Preview a conversation | Agent Builder preview panel |
| Run evaluations | Testing Center |
| Create a new draft version | Agentforce Studio, on a published version |

What Contrail **can** verify from outside: activation state via `soql_query`
— `SELECT Id, DeveloperName, Status FROM BotVersion WHERE
BotDefinition.DeveloperName = 'Support_Agent'` (`Status` is the activation
check; Data API, no tooling flag) — and what the org actually holds, via
`retrieve_metadata` after any handoff.

**The rule: never present a successful deploy as an activated, published, or
tested agent.** A green `execute_deploy` means the org accepted metadata —
nothing more. End every agent deploy summary by naming the remaining
lifecycle steps and who performs them ("deployed to **dev-org**; the topic is
live only after you re-activate v3 in Agent Builder").

## 3. Type map and fullName shapes

What Contrail can deploy today, and the shapes live-verified in a real org:

| Type | Contrail today | fullName shape (live-confirmed) |
|---|---|---|
| `Bot` | **Deploy** (single file) | Flat: `Support_Agent` — one `.bot` document, versions inline |
| `BotVersion` | **Deploy** (child of Bot) | Dotted: `Support_Agent.v1` |
| `GenAiPlugin` | **Deploy** (single file) | Flat: `Order_Management`; instruction child names are machine-mangled (`therearemu0`) |
| `GenAiPromptTemplate` (+`Actv`) | **Deploy** — author via platform-prompt-template-generate | Flat; carries live `activeVersionIdentifier` tokens |
| `AiEvaluationDefinition` | **Deploy** — author via agentforce-eval-generate | Flat |
| `BotTemplate`, `BotBlock` | **Deploy** (single file) | Flat |
| `GenAiFunction` | **Read / index / diff only** — deploy pending bundle machinery | `Name` dir with schema files (§8) |
| `GenAiPlannerBundle` | **Read / index / diff only** — deploy pending bundle machinery | Underscore-versioned: `Support_Agent_v2`, one component per published version |
| `AiAuthoringBundle` | **Read only, permanently** | Naked name = highest draft; `_1`, `_2`… = published snapshots |

- `AiAuthoringBundle` stays read-only **by design, permanently**: Metadata API
  deploys of Agent Script **silently skip reasoning actions** — the deploy
  "succeeds" and produces an agent missing its reasoning wiring. There is no
  Contrail path for Agent Script authoring; say so and stop.
- Salesforce's CLI has an `Agent:` convenience pseudo-type; **Contrail has no
  pseudo-type** — address each real type by name (`Bot` and its `GenAiPlugin`s
  are separate retrieves).
- Apex, Flows, and Named Credentials backing agent actions are ordinary
  metadata — they deploy separately, before the agent metadata (§10).

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

## 5. The deactivate gate

The platform refuses modifies to an active agent's topics and planner. The
workflow, every step:

1. **Query status** (§4 SOQL). No `Active` version → deploy normally.
2. A version is **Active** → stop and hand off: "deactivate the agent in
   Agent Builder and tell me when done." Never queue the deploy speculatively.
3. **Re-query** when the human says done — trust the org, not the chat.
4. Deploy (house-rules §3 ritual).
5. Hand back — "re-activate in Agent Builder."
6. **Re-query** to confirm the end state, and report it.

`validate_deploy` flags the gate automatically on `GenAiPlugin` /
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

- **Instruction names are machine-mangled** — the org generates
  `developerName`/`masterLabel` from the instruction text (`therearemu0`,
  `donotdecla1`: lowercased text prefix plus an ordinal). On **modify,
  preserve retrieved names exactly** — they are identity, not decoration.
- For **new** instructions, whether the org accepts arbitrary well-formed
  names or normalizes them is **not live-confirmed** — mirror the observed
  pattern and verify with the §11 round-trip retrieve.
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

## 8. GenAiFunction and GenAiPlannerBundle — read today, deploy pending

Contrail can **retrieve, index, and diff** these two types but **cannot
deploy them yet** — the multi-file bundle machinery is pending. Say exactly
that; do not improvise a workaround through another type.

`retrieve_metadata` returns the bundle's main XML plus a `bundle_files`
listing with `snapshot_paths` for every member file. The live layout is a
deep compiled artifact:

```
genAiPlannerBundles/Support_Agent_v2/
    Support_Agent_v2.genAiPlannerBundle
    agentGraph/Support_Agent_v2_graph.json
    agentScript/Support_Agent_v2_definition.agent
    localActions/<Topic_ID>/<Action_ID>/input/schema.json  (+ output/)
```

Path segments carry **org-specific IDs** — proof this is compiled output.
When bundle deploys land, they will be promotion-of-retrieved-bytes, never
hand-authoring. Version-suffixed bundles are **published snapshots**: modified
deploys fail ("content cannot be changed on a locked version"); unmodified
deploys "succeed" as misleading no-ops. Read them for history and diffs only.
(One `AiAuthoringBundle` quirk: retrieve returns no fileProperties rows, so
the local index has no last-modified dates for it — staleness detection is
limited there.)

Grammar worth knowing **now**, because it explains live failures:

- **The one-output rule** — the catalog on `copilotAction:isUsedByPlanner`
  in a function's output schema: "At least one output property must have this
  value as true or else the planner returns random responses." Diagnostic
  gold when an agent answers nonsense after an action runs.
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
  Agent Runtime API returns `500 UNKNOWN_EXCEPTION` on session creation. On
  Agent-Script agents the publish pipeline only generates a `Messaging`
  surface — the patch must be **re-applied after every publish**. Until
  bundle deploys land, Contrail's role is to detect the missing block in
  retrieved XML and hand the human the exact patch.

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
  confident nonsense — pin v66 and stay there.
- **Staged-capability honesty.** When a request needs a `GenAiFunction` or
  `GenAiPlannerBundle` deploy, say plainly that Contrail reads and diffs
  these today and cannot deploy them yet. Offer what is real — retrieved XML,
  the diff, the patch text for the human — never a pretend deploy path.

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (agent-deployment-guide.md, agent-metadata-and-lifecycle.md, and the Metadata API catalog entries for Bot, BotVersion, GenAiPlugin, GenAiFunction, and GenAiPlannerBundle; Apache-2.0, © Salesforce, Inc.). Modified: mechanism retargeted from the Salesforce CLI to the Contrail engine tools and the human-approval write contract; fullName shapes and file layouts live-verified against an Agentforce Developer Edition org (2026-09).*
