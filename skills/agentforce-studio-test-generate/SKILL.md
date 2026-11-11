---
name: agentforce-studio-test-generate
description: "Use this skill when users need to author, convert, deploy, RUN, or interpret Agentforce Studio Tests-tab suites through the Contrail engine — AiTestingDefinition metadata (a Beta type with a Beta runner), its scorer catalog, custom scorers (AiAgentScorerDefinition), and Studio-runner results from run_agent_eval. TRIGGER on 'tests for my Agent Script agent', 'Studio Tests tab', 'scorers' or 'custom scorer', 'AiTestingDefinition', 'convert my Testing Center suite to Studio', or asserting topic/action routing for an agent built in the new builder. DO NOT TRIGGER for legacy Testing Center suites — AiEvaluationDefinition authoring and results (agentforce-eval-generate) — for Apex tests (platform-apex-test-generate), for prompt templates themselves (platform-prompt-template-generate), or for debugging agent metadata (agentforce-metadata-generate / agentforce-architecture-analyze)."
metadata:
  domains: ["Agentforce"]
  minApiVersion: "66.0"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "agentforce-eval-generate"
    - "agentforce-metadata-generate"
    - "platform-prompt-template-generate"
    - "agentforce-architecture-analyze"
---

# Agentforce Studio tests (Tests tab, Beta) through Contrail

Use this skill to author `AiTestingDefinition` metadata — the suites that
appear in Agentforce Studio's **Tests** tab — and the custom scorers
(`AiAgentScorerDefinition`) they can reference. Follow
**salesforce-house-rules** §3 for the deploy ritual and
**building-salesforce-metadata** for packaging. **Both the type and its
runner are Beta** (Salesforce's own word): say "Beta" the first time you
mention Studio tests in any answer, and in every run summary.

## 1. What the Tests tab holds — and what reaches the Metadata API

The Tests tab (Beta) offers three suite kinds. Two have a metadata type:

| Tests-tab suite kind | Metadata | Through Contrail |
|---|---|---|
| **Agent Turn** — one utterance per case; scorers judge that turn | `AiTestingDefinition`, `subjectType AGENT` | Author, deploy, run (§2–§8) |
| **Prompt Template** — inputs to a template; scorers judge its output | `AiTestingDefinition`, `subjectType PROMPT` | Author, deploy, run (§2, §8) |
| **Agent Conversation** — a persona drives a multi-turn conversation that is judged against criteria | **None.** No persona or conversation-criteria metadata type exists as of API v68 (live-confirmed 2026-11-08) | **Nothing.** Contrail cannot author, deploy, or run it — say so plainly and point the human to the Tests tab |

One observed fact shapes everything else: **suites authored in the Tests
tab UI did not surface as metadata.** With one UI-authored suite of each
kind in an Agentforce dev org — one of them holding a saved test case that
had already been run — `AiTestingDefinition` listed zero components at v66
and at v68, and a wildcard retrieve returned nothing (observed 2026-11-08).
So a Contrail-authored suite is deployed metadata — listable, retrievable,
diffable — while a UI-authored one was, on that org, not retrievable at
all. Do not promise to "pull the suite the admin built in Studio": retrieve
first in case the org exposes one, and otherwise offer to author its
equivalent. And a Contrail-deployed suite is invisible there at first: on
the org probed it appeared in neither the Tests tab nor the legacy Testing
Center after deploy (list refreshed), then showed up in the Tests tab — with
its results under Test Cases — once `run_agent_eval` had run it (2026-11-09,
§9). So the first run is Contrail's (§8); after that the Tests tab can run
it too.

### Testing Center or Studio? — pick deliberately

| | Legacy Testing Center | Agentforce Studio Tests tab |
|---|---|---|
| Metadata type | `AiEvaluationDefinition` (`aiEvaluationDefinitions/`, v63+) | `AiTestingDefinition` (`aiTestingDefinitions/`; present at v66 and v68; **Beta**, server-gated) |
| Case grammar | `<expectation><name/><expectedValue/></expectation>` | `<scorer><name/><expectedValue/></scorer>`, plus custom scorers by name |
| Which agents | Salesforce's own guidance tests **legacy-builder** agents here | Salesforce's own guidance tests **new-builder (Agent Script)** agents here, and prompt templates (`subjectType PROMPT`). Prefer that split; which agent kinds each runner technically accepts is not yet live-confirmed (§9) |
| Runner | Documented Connect REST (`einstein/ai-evaluations`) | **Beta** runner that Salesforce's Agentforce DX test commands call; absent from the Connect REST reference |
| Through Contrail | Deploy + `run_agent_eval` since S30/S35 | Deploy + `run_agent_eval` since S44 — same tool; the runner is detected from the org's metadata (needs `metadata_read`) or named with `runner` (§8) |
| Skill | agentforce-eval-generate | this skill |

Rules of thumb:

- **Follow Salesforce's split for new work.** An Agent Script agent gets a
  Studio suite; a legacy-builder agent whose suites already live in Testing
  Center stays there. Do not move a working suite because a newer type
  exists.
- **One agent, one system.** Never maintain both kinds of suite for the same
  agent — the names drift apart and the human has to reconcile two result
  formats. Converting (§5) is cheap; running both is not.
- **Beta means the grammar can move.** Retrieve-first before any modify, and
  copy the org's spelling (§9).

## 2. The grammar

Top level: `name` (the suite's API name), optional `description` (it is
the suite's LABEL in the Tests tab — max 80 characters; the org refuses
longer ones, live-confirmed), `subjectName` (the **agent's** `BotDefinition.DeveloperName`, or the prompt
template's API name), `subjectType` (`AGENT` | `PROMPT`), optional
`subjectVersion` (a `BotVersion` DeveloperName such as `v4` — the documented
meaning on the legacy type; when omitted on a PROMPT suite the org wrote
back the template's active version as `v4` — live-confirmed — so omission
resolves to the active version at deploy time, assumed the same for AGENT
subjects, §9. The Tests tab shows the new builder's own
version number — the `AiAuthoringBundle` suffix, "Version 7" for
`<Agent>_7` — which is NOT a `BotVersion` name; what the Studio type
accepts here is not live-confirmed), then repeating `testCase` blocks — `number` (global,
1..N across the suite), `inputs`, `scorer[]`.

Inputs for an `AGENT` subject: `utterance` (**required**), optional
`contextVariable` pairs (`variableName`/`variableValue`), optional
`conversationHistory` turns (`role` `user|agent`, `message`, `topic` on
agent turns, `index` — **0-based**, as Salesforce's library writes it).
**Only user turns are replayed** — agent turns are context the judge reads,
not behaviour under test. Inputs for a `PROMPT` subject are `promptInput`
pairs (`referenceName`/`value`) instead of an utterance.

Salesforce's Agentforce DX test commands also accept a test-spec **YAML**;
as with Testing Center, that YAML is an input format, **not metadata** —
when a user hands you one, treat it as requirements and author the XML
below. One YAML case with several utterances fans out to one `<testCase>`
per utterance sharing the same scorers.

The grammar here is the serializer in Salesforce's open-source agents
library; no official field reference exists yet. The first Contrail-deployed
`AGENT` suite was accepted by the org at API v66 and retrieved back
(2026-11-09, §9): the org keeps every element but writes children
alphabetically — `inputs` before `number` before `scorer`, `contextVariable`
before `utterance`, `expectedValue` before `name` — escapes apostrophes as
`&apos;`, and echoes `subjectVersion`. Author in the order below or the
org's (both deploy); retrieve-first before a modify and copy the org's
spelling. Where the org's retrieve disagrees with a sample below, the org
wins.

A single-turn `AGENT` suite:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Routing and response checks for the Support agent (single-turn)</description>
    <name>Support_Agent_Studio_Core</name>
    <subjectName>Support_Agent</subjectName>
    <subjectType>AGENT</subjectType>
    <subjectVersion>v2</subjectVersion>
    <testCase>
        <number>1</number>
        <inputs>
            <utterance>Where is my order 00001234?</utterance>
            <contextVariable>
                <variableName>EndUserLanguage</variableName>
                <variableValue>en_US</variableValue>
            </contextVariable>
        </inputs>
        <scorer>
            <name>topic_sequence_match</name>
            <expectedValue>Order_Status</expectedValue>
        </scorer>
        <scorer>
            <name>action_sequence_match</name>
            <expectedValue>['Get_Order_Status']</expectedValue>
        </scorer>
        <scorer>
            <name>bot_response_rating</name>
            <expectedValue>The agent reports the shipping status of order 00001234.</expectedValue>
        </scorer>
        <scorer>
            <name>conciseness</name>
        </scorer>
    </testCase>
    <testCase>
        <number>2</number>
        <inputs>
            <utterance>give me a pizza recipe</utterance>
        </inputs>
        <scorer>
            <name>topic_sequence_match</name>
            <expectedValue>Off_Topic</expectedValue>
        </scorer>
        <scorer>
            <name>action_sequence_match</name>
            <expectedValue>[]</expectedValue>
        </scorer>
    </testCase>
</AiTestingDefinition>
```

A multi-turn case — it lives in a **separate** suite (§4), and `index`
counts from 0:

```xml
    <testCase>
        <number>1</number>
        <inputs>
            <utterance>Yes, that one - where is it now?</utterance>
            <conversationHistory>
                <role>user</role>
                <message>I need help with an order</message>
                <index>0</index>
            </conversationHistory>
            <conversationHistory>
                <role>agent</role>
                <message>Sure - is it order 00001234 from last week?</message>
                <topic>Order_Status</topic>
                <index>1</index>
            </conversationHistory>
        </inputs>
        <scorer>
            <name>topic_sequence_match</name>
            <expectedValue>Order_Status</expectedValue>
        </scorer>
        <scorer>
            <name>task_resolution</name>
        </scorer>
    </testCase>
```

A `PROMPT` subject:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Case_Summary_Prompt_Checks</name>
    <subjectName>Case_Summary</subjectName>
    <subjectType>PROMPT</subjectType>
    <testCase>
        <number>1</number>
        <inputs>
            <promptInput>
                <referenceName>Input:Case</referenceName>
                <value>500000000000001AAA</value>
            </promptInput>
        </inputs>
        <scorer>
            <name>response_match</name>
            <expectedValue>A two-sentence summary naming the case subject and its current status.</expectedValue>
        </scorer>
        <scorer>
            <name>completeness</name>
        </scorer>
    </testCase>
</AiTestingDefinition>
```

> `referenceName` is the template's input as the template declares it
> (retrieve the `GenAiPromptTemplate` — platform-prompt-template-generate);
> `Input:Case` is the spelling a `GenAiPromptTemplate` declares in its
> `<inputs><referenceName>` — live-confirmed: a PROMPT suite with it deployed
> and retrieved back unchanged (2026-11-09, §9). **A PROMPT suite is refused
> at API v66** — `Property 'promptInput' not valid in version 66.0` — and
> accepted at **v68** (both live-confirmed); v67 is untested. Set the
> connection's `salesforce.apiVersion` accordingly. With `subjectVersion`
> omitted, the org wrote back `v4` — the template's active version at deploy
> time — so a PROMPT suite pins the version it was deployed against.

The scorer catalog:

| Scorer | Grade | `expectedValue` | Subjects | Notes |
|---|---|---|---|---|
| `topic_sequence_match` | pass/fail | topic API name | AGENT | Routing truth — lead with it (§4) |
| `action_sequence_match` | pass/fail | Python-list string `['A', 'B']`; `[]` = no action | AGENT | Same string shape as Testing Center |
| `agent_handoff_match` | pass/fail | target agent API name | AGENT | **Required for multi-agent subjects** (§3 — per Salesforce's library; the `IsMultiAgent` field it reads was absent on the org probed 2026-11-08) |
| `bot_response_rating` | LLM pass/fail | short reference answer | AGENT | Keep the reference factual |
| `response_match` | LLM pass/fail | short reference answer | AGENT + PROMPT | The PROMPT-subject counterpart |
| `coherence`, `conciseness`, `factuality`, `completeness` | LLM Pass/Fail + score (0–5 observed live; the library says 0–100) | **none** | AGENT + PROMPT | The judge returns a `status` and a `score` with its reasoning — the Tests tab shows both |
| `task_resolution` | LLM 0–5 | **none** | AGENT | **Requires `conversationHistory`** — multi-turn suites only |
| `output_latency_milliseconds` | numeric | **none** | AGENT | Latency rides along free |
| *custom* (an `AiAgentScorerDefinition` name) | per definition | per definition | AGENT | §6 — per Salesforce's library the org validates the name at deploy; not yet live-confirmed (§9). A green deploy never proves a scorer ran |

Scorer names are **exact-case identifiers**: `Coherence` is not the catalog
scorer `coherence`. Contrail reads any non-catalog spelling as a reference
to a custom scorer (§6) in its dependency graph; whether such a scorer
exists is the org's call, not Contrail's.

## 3. Ground the test in the real agent

Every name in the suite comes from the org — **a scorer asserting a
nonexistent topic can only fail**:

| Value | Source |
|---|---|
| `subjectName` | `soql_query`: `SELECT DeveloperName, AgentType, BotSource FROM BotDefinition` — exact `DeveloperName` |
| `subjectVersion` | `soql_query`: `SELECT DeveloperName, Status FROM BotVersion WHERE BotDefinition.DeveloperName = 'Support_Agent'` — pin the active version's `DeveloperName` (e.g. `v4`) deliberately, or omit (§2 caveat). The Tests tab's "Version N" is the authoring-bundle number (`list_metadata` type `AiAuthoringBundle` lists `<Agent>_N`), not this name |
| Topic and action names (Agent Script agent) | `retrieve_metadata` the naked `AiAuthoringBundle` draft or the published `GenAiPlannerBundle` (`agentScript/` holds the compiled script; topic and action names are the identifiers in it) — agentforce-metadata-generate §3a/§8 |
| Topic and action names (legacy-builder agent) | `retrieve_metadata` its `GenAiPlugin`s and their `functionName` refs — or hand off to **agentforce-architecture-analyze** |
| Multi-agent? | Salesforce's library reads `BotDefinition.IsMultiAgent`, but that field was absent on the org probed 2026-11-08 (v66 and v68) — ask the human whether the agent hands off to other agents; if it does, every routed case needs `agent_handoff_match` |
| Prompt template inputs (`PROMPT`) | `retrieve_metadata` the `GenAiPromptTemplate`; input names are its declared `inputs` |

Testing Center reports topic names as **clean base names** (live-confirmed
there); assume the same here until a Studio run says otherwise (§9) — assert
the base name, not an ID-suffixed local developer name from the Tooling API.

## 4. Test design judgment

- **Routing before behaviour.** `topic_sequence_match` first; add
  `action_sequence_match`, then response scorers, only once routing passes.
  A wrong-topic failure invalidates every downstream scorer.
- **Every case carries the SAME scorer set.** The Tests tab treats scorers
  as suite-wide columns: a scorer present on one case and absent on another
  shows as an Error column on the others, the run reports `FAILED` ("One or
  more evaluation columns failed or were skipped"), and the API then returns
  NO case results even though the Tests tab shows them (live-confirmed
  2026-11-09). Give every case the same scorers, each with an
  `expectedValue` wherever the scorer needs one.
- **Negatives are load-bearing.** Off-topic utterances assert the fallback
  topic **plus** `action_sequence_match` `[]` — proving the agent declined
  to act, not merely that it chatted.
- **Single-turn and multi-turn cases go in SEPARATE suites.** Salesforce's
  own walkthrough reports a mixed suite stalling in the runner; a stalled
  Beta run has no cancel endpoint and keeps one of the org's ~10 in-progress
  slots — the docs do not say when it is released. Name the suites for it:
  `<Agent>_Studio_Core` and `<Agent>_Studio_Conversations`.
- **`task_resolution` only where there is a conversation** — it requires
  `conversationHistory`; on a single-turn case it is an error at deploy or at
  run (which one is not live-confirmed), never a useful score.
- **Quality scorers carry a score AND a Pass/Fail status** (live:
  `coherence` came back `status: Fail, score: 0.0` on a correct refusal,
  because the judge graded the answer against the off-topic request). Treat
  the status as the judge's gate and the score as the trend signal, and
  expect quality judges to punish deliberate refusals — put them on the
  cases users feel, not on negatives.
- Keep `bot_response_rating` / `response_match` references short and
  factual — a florid reference punishes correct answers.

## 5. Converting an AiEvaluationDefinition to a Studio suite

Retrieve the legacy definition, then translate **expectation → scorer,
name for name**:

| Testing Center expectation | Studio scorer | Carry `expectedValue`? |
|---|---|---|
| `topic_sequence_match` | `topic_sequence_match` | yes |
| `action_sequence_match` | `action_sequence_match` | yes — keep the Python-list string exactly |
| `bot_response_rating` | `bot_response_rating` | yes |
| `coherence` / `completeness` / `conciseness` | same name | no (none on either side) |
| `output_latency_milliseconds` | `output_latency_milliseconds` | no |
| `string_comparison` / `numeric_comparison` (`parameter[]`) | **no Studio equivalent** | a custom scorer (§6) is a different mechanism — a prompt-template judge, not a comparison — so build one or drop the check, and say which |
| `instruction_adherence` (label-only) | **no known equivalent** | drop, and say so |

Mechanics: root element and directory change
(`AiEvaluationDefinition`/`aiEvaluationDefinitions` →
`AiTestingDefinition`/`aiTestingDefinitions`); `expectation` → `scorer`;
**drop any `label`**; `subjectName`/`subjectType`/`subjectVersion`/`inputs`
carry over unchanged (re-check `index` values against the 0-based
convention); renumber `number` 1..N; split multi-turn cases into their own
suite (§4). Deploy the new suite, run it once, and only then propose
deleting the legacy definition (`destructive`, its own ritual) — never
delete first.

## 6. Custom scorers (AiAgentScorerDefinition)

A custom scorer is its own flat component
(`aiAgentScorerDefinitions/<Name>.aiAgentScorerDefinition`; dir and suffix
live-confirmed via describeMetadata at v66 and v68, 2026-11-08). The field
list below is Salesforce's Agentforce Developer Guide ("Create Custom
Scorers"); the **element order is the one the org writes — alphabetical**,
live-confirmed from retrieved scorers.

Top level: `dataType` (`Text` | `Number` | `LightningType`), `inputScope`
(`Session`), optional `lightningType`, `scorerType` (`Predefined` =
enumerated outcomes | `OpenEnded` = a numeric `specification`), repeating
`scorerVersion`, optional `semanticType` (`Dimension` | `Measurement`).
Each version: `agentAssociation` (`agentApiName`, optional `inputScope`
`Session|Intent`, `isActive`, optional `samplingRate` — documented as > 0
and ≤ 1.0; the org's own scorers carry `1.0`), `description`, `engine`
(`engineRef` = the `GenAiPromptTemplate` API name, `engineType`
`PromptTemplate` | `Manual`), `label`, `outputEnumValue[]` (`description`,
`isFallback`, `outcomeType` `Pass|Fail|NotApplicable`, `value`) for
`Predefined`, or `specification[]` with `valueSpecification{min, max, step,
threshold}` for `OpenEnded` (absent on `Predefined` scorers —
live-confirmed), then `status` (`Draft` | `Available` | `Archived`) and
`versionNumber` (sequential from 1, max 100).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<AiAgentScorerDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <dataType>Text</dataType>
    <inputScope>Session</inputScope>
    <scorerType>Predefined</scorerType>
    <scorerVersion>
        <agentAssociation>
            <agentApiName>Support_Agent</agentApiName>
            <inputScope>Session</inputScope>
            <isActive>true</isActive>
            <samplingRate>1.0</samplingRate>
        </agentAssociation>
        <description>Grades whether the agent stayed polite under pressure.</description>
        <engine>
            <engineRef>Tone_Check_Judge</engineRef>
            <engineType>PromptTemplate</engineType>
        </engine>
        <label>Tone check v1</label>
        <outputEnumValue>
            <description>The agent stayed courteous throughout.</description>
            <isFallback>false</isFallback>
            <outcomeType>Pass</outcomeType>
            <value>Polite</value>
        </outputEnumValue>
        <outputEnumValue>
            <description>The agent was short or dismissive.</description>
            <isFallback>false</isFallback>
            <outcomeType>Fail</outcomeType>
            <value>Curt</value>
        </outputEnumValue>
        <outputEnumValue>
            <description>The judge could not tell.</description>
            <isFallback>true</isFallback>
            <outcomeType>NotApplicable</outcomeType>
            <value>Unclear</value>
        </outputEnumValue>
        <status>Draft</status>
        <versionNumber>1</versionNumber>
    </scorerVersion>
    <semanticType>Dimension</semanticType>
</AiAgentScorerDefinition>
```

The org writes one more flag on its own scorers — `isSystemFallback` inside
`outputEnumValue` — whose use on a custom scorer is unverified; leave it
out of yours.

**System-provisioned scorers — never edit, author your own.** Every agent
carries four `std_*` scorers Salesforce creates (last modified by
"Automated Process"; live-confirmed): `std_Quality_Score_<Agent>`,
`std_Deflection_Score_<Agent>`, `std_Abandonment_Score_<Agent>`,
`std_Session_Notes_<Agent>`. At least one of them engines on a managed,
namespaced prompt template (live-observed). They are the org's, not yours: an edit may be
overwritten or refused (the approval page says so when a `std_` name is
deployed). Custom logic gets its own name.

Lifecycle rules, as Salesforce documents them — carry them into every
modify, and treat the org as the authority where it disagrees:

- **Versions are append-only (documented).** A retrieved version block you
  omit is NOT a delete — the org keeps it; add a new `versionNumber`
  instead. Only `Draft` is editable; `Draft → Available` is one-way;
  `Available → Archived` is the only exit. Modify = retrieve-first, carry
  every version, append or edit the Draft only. Contrail's approval page
  flags a modify that omits a retrieved version or regresses a status; it
  still deploys what you sent, so read the page.
- **One active association per scorer** (`isActive` true on exactly one
  version). `Manual` engines keep `isActive` false. Whether a `Draft`
  version may carry an active association, or must be `Available` first, is
  unverified (§9) — relay a refusal verbatim.
- **The engine must be a scorer-typed template, and it exists first.** The
  `engineRef` must name a `GenAiPromptTemplate` whose `<type>` is one of
  `agentforce_session_tracing__scorerOpenEnded`,
  `agentforce_session_tracing__scorerMultilabel` or
  `agentforce_session_tracing__scorerMeasurement` — an ordinary
  `einstein_gpt__flex` template is refused ("Prompt template has invalid
  type", live-confirmed 2026-11-09). Such a template requires input
  definitions named `AllowedLabels`, `FallbackLabel` and `Session`, and
  their input types are NOT `primitive://String` (both refusals
  live-confirmed); the exact definitions are undocumented, so authoring a
  scorer-typed template through Contrail is **not yet live-confirmed** —
  the custom-scorer flow in Agentforce Studio creates one with the right
  shape; retrieve that template (and its scorer) and copy the org's
  spelling. Contrail lists a `GenAiPromptTemplate` before the
  `AiAgentScorerDefinition` that engines on it in `package.xml` (S44), the
  documented order for this pair; in the one live attempt the template
  itself was refused and the scorer then failed with "No prompt template
  found for engineRef", so until a same-package deploy has succeeded,
  deploy the template first (its own ritual), then the scorer. Whatever the
  `std_*` scorers engine on is provisioned by the org — nothing for you to
  deploy.
- **Reference it from a suite by name**: `<scorer><name>Tone_Check</name>
  </scorer>` (plus an `expectedValue` only if the scorer's design wants
  one). Salesforce's tooling describes deployed custom scorers as carrying a
  `scorerType="Custom"` marker; whether that is an attribute or an element
  is **unconfirmed** (§9) — retrieve a deployed suite and copy the org's
  spelling.

## 7. Deploy and verify

House-rules §3, exactly as for any component — one `validate_deploy`, the
human reads the page, `execute_deploy`; no Apex in the package, so **omit
`test_level`**. A green deploy **stores** the suite and runs nothing — the
approval page says so on every `AiTestingDefinition` deploy, and so should
your summary. Then:

1. Round-trip `retrieve_metadata` — the org normalizes; keep its spelling as
   the new baseline (and send the differences back into this skill's §9).
2. `refresh_snapshot` with `types: ["AiTestingDefinition"]` (and/or
   `"AiAgentScorerDefinition"`) — both are explicit-refresh-only, like the
   rest of the Agentforce family.
3. Do not expect the suite in the **Tests** tab yet: on the org probed a
   deployed suite was listed in neither the Tests tab nor Testing Center
   until `run_agent_eval` had run it once (§8, §9); after that first run it
   appeared in the Tests tab with its results under Test Cases.

A refusal naming the type as invalid, or "not available for deploy", is a
**provisioning gate**, not a grammar error — the Beta is not enabled for
that org, or the connection's apiVersion is one where the org does not know
the type (confirmed at v66 and v68; nothing below was probed). Relay it
verbatim and stop. The exact wording is Testing Center's (live-confirmed
for `AiEvaluationDefinition`); expect the same family of message here.

## 8. Running and reading results (run_agent_eval)

- **Same tool, two runners.** `run_agent_eval` runs both kinds of suite.
  With `eval` set to a bare definition name it looks the name up in the
  org's metadata — only an `AiTestingDefinition` → the Studio runner; only
  an `AiEvaluationDefinition` → Testing Center; both → it refuses and asks
  you to choose; neither → it refuses and names which types the org does
  not know. That lookup is a Metadata API read, so it needs the
  connection's **`metadata_read`** grant; without it, pass the runner
  yourself: `runner: "testing_center"` or `runner: "agentforce_studio"`
  (the override also skips the lookup). A lookup that **fails** (transport
  error, fault) refuses rather than defaulting — a real-actions run never
  starts on a guess. Polling by `run_id` needs no hint: the tool routes ids
  starting `4KB` to Testing Center and `3A2` to Studio (both live-confirmed,
  §9). Every result names the runner it used — repeat it, with "Beta", in your summary.
- **Grants and side effects are unchanged**: polling needs
  `diagnostics_read`, starting needs `data_write`, and **the agent executes
  its REAL actions with no rollback** — sandbox-first for writing agents.
- **Cadence**: runs take minutes; Salesforce documents the same ~10
  in-progress ceiling for both runners (whether they share one pool is
  unconfirmed); Einstein Requests are consumed; **no cancel endpoint** — a
  stalled run keeps its slot, and the docs do not say when it is released.
  If the submit returns no run id, Salesforce's own library treats that as
  "a run of this definition is already in progress" — Contrail relays the
  raw response and says so; wait rather than resubmit.
- **Statuses** (per Salesforce's library): `CREATED → IN_PROGRESS →
  SUCCESS | FAILED | TERMINATED`. `SUCCESS` means the run completed, not
  that cases passed; `FAILED` is the RUN failing — the tool shows the org's
  `error_message` (nested under `errorRepresentation` on this runner) and
  any case rows it got; the one observed cause was an errored scorer column
  (§4), after which the API returned no case rows at all; `TERMINATED` is
  partial at best, never a pass.
  An unrecognised status is reported raw as still in progress.
- **Reading results** (shape live-confirmed 2026-11-11): each case carries
  `subject_response` (the agent's reply, lifted out of the org's
  HTML-encoded session blob), `routed_topics` (that blob's
  `runs[].topicName` — the routing truth, like Testing Center's
  `generatedData.topic`), `session_id`, and one row per scorer. Scorer rows
  are named by the Tests tab's column LABEL (`Subagent Evaluation` =
  `topic_sequence_match`, `Action Evaluation` = `action_sequence_match`,
  `Response Evaluation` = `bot_response_rating`, `Coherence Evaluation` =
  `coherence`, …) with the catalog name under `scorer` when known.
  LLM-judged scorers return `status` `Pass`/`Fail`, a `score` (0–5
  observed) and a `reasoning` (surfaced as `explanation`); match scorers
  return only `actualValue`/`expectedValue`, which the tool compares.
  `passed` is derived from exactly those two shapes; anything else is
  `null` with `raw` kept. Case `verdict` and `totals` follow the S40 rules
  (`failed` if any scorer failed; `passed` only when every scorer passed
  and ≥1 existed; else `indeterminate`). `include_details` returns the raw
  payload (still HTML-encoded).
- **After a run against a writing agent, `soql_query` what the actions
  did** and name the records in the summary.

## 9. What is confirmed, what is not

- **Beta.** Type and runner are Beta per Salesforce; the runner is absent
  from the Connect REST reference and is what Salesforce's own Agentforce
  DX test commands call. Expect change between releases; say "Beta" in
  every summary.
- **Live-confirmed from the org's type catalogue (2026-11-08, an Agentforce
  dev org, API v66 and v68):** `AiTestingDefinition` lives at
  `aiTestingDefinitions/*.aiTestingDefinition` and
  `AiAgentScorerDefinition` at
  `aiAgentScorerDefinitions/*.aiAgentScorerDefinition`; neither is
  folder-based, neither has a meta sidecar, neither has child types. Suites
  authored in the Tests tab UI produced no `AiTestingDefinition` — not even
  one holding a saved and run test case (§1) — and no metadata type backs
  the Agent Conversation kind.
- **Live-confirmed from retrieved scorers (2026-11-08, same org):** the org
  writes `AiAgentScorerDefinition` elements alphabetically (§6 order);
  `samplingRate` is `1.0`; `engineRef` may be a namespaced managed template;
  `specification` is absent on `Predefined` scorers; every agent carries the
  four `std_*` scorers, owned by Automated Process.
- **Live-confirmed from the first Contrail-deployed suite (2026-11-09,
  same org, API v66):** an `AGENT` suite with `subjectVersion` (a
  `BotVersion` DeveloperName), `contextVariable`, and the scorers
  `topic_sequence_match`, `action_sequence_match`, `bot_response_rating`,
  `conciseness` and `coherence` validated and deployed; the retrieve kept
  every element, wrote children alphabetically (§2), escaped apostrophes as
  `&apos;`, and carried no marker on catalog scorers; it appeared in neither
  the Studio Tests tab nor the legacy Testing Center after deploy (list
  refreshed), then in the Tests tab after its first `run_agent_eval` run —
  under the agent's builder version label ("Version 6" for `subjectVersion`
  `v4`), with per-scorer results in Test Cases and an empty Run History. A
  `PROMPT` suite was
  refused at v66 (`promptInput` "not valid in version 66.0") and accepted at
  v68: `promptInput` with `referenceName` `Input:Case` round-tripped
  unchanged, and the org added `<subjectVersion>v4</subjectVersion>` (the
  template's active version) to a suite that omitted it. A custom scorer's
  engine must be a scorer-typed template
  (`agentforce_session_tracing__scorerOpenEnded | scorerMultilabel |
  scorerMeasurement`) with inputs `AllowedLabels`, `FallbackLabel`,
  `Session` whose types are not `primitive://String` (§6).
- **Live-confirmed from two runs (2026-11-09 and 2026-11-11):**
  `run_agent_eval` auto-detected the Studio runner for a deployed suite; run
  ids begin `3A2`; the first status is `IN_PROGRESS` (`CREATED` never
  seen); a run takes ~10–15 minutes for two single-turn cases. Run 1 ended
  `FAILED` with `errorRepresentation.errorMessage` "One or more evaluation
  columns failed or were skipped" because one case lacked a scorer the
  other had, and the results endpoint returned `testCases: []` while the
  Tests tab showed every case. Run 2 (same scorers on every case) ended
  `SUCCESS` with the shapes §8 describes: HTML-entity-encoded JSON strings,
  label-named scorers, `status` Pass/Fail + `score` + `reasoning` on
  LLM-judged scorers, `actualValue`/`expectedValue` on match scorers, and a
  `subjectResponse` session blob carrying the reply and the routed topic.
  Both runs appear in the Tests tab's Run History as Complete, with the
  suite's aggregate ("50% subagent, 100% action, 100% response").
- **Not yet confirmed:** whether API v67 accepts a PROMPT suite (v66 refuses,
  v68 accepts); the custom-scorer marker in deployed suite XML (attribute vs
  element); the input definitions a scorer-typed template needs; whether a
  template and its scorer deploy in one package once both are valid; whether
  an AGENT suite that omits `subjectVersion` resolves like the PROMPT one
  did; whether a `Draft`
  scorer version may carry an active association; whether unknown scorer
  names fail at deploy or at run; which agent kinds each runner accepts;
  whether the Tests tab's Run History fills after a second run (empty after
  the first);
  whether the two runners share one in-progress pool; whether a
  `GenAiPromptTemplate` and its scorer ever fail when listed alphabetically;
  what `subjectVersion` accepts for a new-builder agent (a
  `BotVersion` name, or the Tests tab's own version number); whether
  `BotDefinition.IsMultiAgent` exists on a given org (absent on the one
  probed).
- When the org's retrieved XML disagrees with this skill, **the org wins** —
  copy its spelling and tell the human the skill needs the update.

---
*An original Contrail skill (S44). Grammar cross-checked against Salesforce's Agentforce Developer Guide ("Create Custom Scorers") and the Metadata API behaviour of Salesforce's open-source agents library (2.3.x); no upstream text is reproduced.*
