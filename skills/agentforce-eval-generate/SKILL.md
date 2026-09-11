---
name: agentforce-eval-generate
description: "Use this skill when users need to author Agentforce agent tests or evaluations through the Contrail engine — AiEvaluationDefinition metadata, Testing Center test authoring, or requests like 'write tests for my agent', 'add an eval case', or asserting which topic/actions an utterance should route to. DO NOT TRIGGER for Apex tests (platform-apex-test-generate), for RUNNING or interpreting eval results (no Contrail path — the human runs evals in Testing Center), or for debugging agent behavior (agentforce-metadata-generate / agentforce-architecture-analyze)."
metadata:
  domains: ["Agentforce"]
  minApiVersion: "66.0"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "agentforce-metadata-generate"
    - "agentforce-architecture-analyze"
---

# Agent evaluations (Testing Center) through Contrail

Use this skill to author `AiEvaluationDefinition` metadata — deployable
Testing Center evaluation definitions for Agentforce agents. Follow
**salesforce-house-rules** §3 for the deploy ritual and
**building-salesforce-metadata** for packaging.

## 1. What this is — and what it is not

An `AiEvaluationDefinition` is a **single-file, deployable** metadata
component (`aiEvaluationDefinitions/<Name>.aiEvaluationDefinition`): the
agent under test plus a list of test cases, each an utterance with
expectations. Deploying it makes the test exist in Testing Center; it does
not run anything.

Be explicit about one adjacent artifact: Salesforce's CLI has a test-spec
**YAML** format. That YAML is a proprietary `@salesforce/agents` input format
the CLI compiles into this metadata — it is **NOT Salesforce metadata** and
Contrail has no path for it. **Author the AiEvaluationDefinition XML
directly**; if the user hands you a test-spec YAML, treat it as requirements
and translate it into the XML below.

## 2. The grammar

From the Metadata API catalog for `AiEvaluationDefinition`: top-level fields
are `name` (the test's API name), `description`, `subjectType` (only
supported value: `AGENT`), `subjectName` (the **agent's** API name),
optional `subjectVersion` (`vN`; omitted = latest active version), and
repeating `testCase` blocks (`number`, `inputs`, `expectation[]`).

The expectation `name` values, with their semantics:

| Expectation | expectedValue | Asserts |
|---|---|---|
| `topic_sequence_match` | topic API name (string) | The agent routed to this topic |
| `action_sequence_match` | string[] literal, e.g. `['IdentifyRecordByName']` | The actions taken, in order (`[]` = none) |
| `bot_response_rating` | reference answer (string) | The response is judged against this expected answer |
| `coherence`, `completeness`, `conciseness`, `output_latency_milliseconds` | **none** | Quality checks — no expectedValue at all |
| `string_comparison`, `numeric_comparison` | **none** — use `parameter[]` instead | Custom criteria: `operator` / `actual` / `expected` params; `isReference` true makes a value a JSONPath into the run's `generatedData` |

Inputs rules: `utterance` is **required** on every test case. Optional
`contextVariable` pairs (`variableName`/`variableValue`) seed session state.
Optional `conversationHistory` entries carry `index`, `role`, `message`, and
`topic` — a conversation **must begin with a user message**, and `topic` is
**required on agent messages**.

A worked definition (two cases: a routed request, then a negative case):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Routing and response checks for the Support agent</description>
    <name>Support_Agent_Core_Tests</name>
    <subjectName>Support_Agent</subjectName>
    <subjectType>AGENT</subjectType>
    <subjectVersion>v2</subjectVersion>
    <testCase>
        <number>1</number>
        <inputs>
            <utterance>Summarize the Acme Industries account</utterance>
        </inputs>
        <expectation>
            <name>topic_sequence_match</name>
            <expectedValue>General_CRM</expectedValue>
        </expectation>
        <expectation>
            <name>action_sequence_match</name>
            <expectedValue>['IdentifyRecordByName', 'GetRecordDetails']</expectedValue>
        </expectation>
        <expectation>
            <name>bot_response_rating</name>
            <expectedValue>A summary of the Acme Industries account</expectedValue>
        </expectation>
        <expectation>
            <name>conciseness</name>
        </expectation>
    </testCase>
    <testCase>
        <number>2</number>
        <inputs>
            <utterance>give me a pizza recipe</utterance>
        </inputs>
        <expectation>
            <name>topic_sequence_match</name>
            <expectedValue>Off_Topic</expectedValue>
        </expectation>
        <expectation>
            <name>action_sequence_match</name>
            <expectedValue>[]</expectedValue>
        </expectation>
    </testCase>
</AiEvaluationDefinition>
```

## 3. Ground the test in the real agent

Every name in the definition must come from the org, not from imagination —
**a test asserting a nonexistent topic can only fail**:

| Value | Source |
|---|---|
| `subjectName` | `soql_query`: `SELECT DeveloperName FROM BotDefinition` — use the exact `DeveloperName` |
| `subjectVersion` | `soql_query`: `SELECT DeveloperName, Status FROM BotVersion WHERE BotDefinition.DeveloperName = 'Support_Agent'` — pin a version deliberately, or omit to track the active one |
| Expected topic names | The agent's real topics: `retrieve_metadata` its `GenAiPlugin` components, or hand off to **agentforce-architecture-analyze** for the full graph |
| Expected action names | The `functionName` refs inside the retrieved topics |

## 4. Test design judgment

- **Routing before behavior.** Assert `topic_sequence_match` first; only when
  routing is proven add `action_sequence_match` and response-quality checks.
  A wrong-topic failure invalidates every downstream expectation, so a suite
  that leads with response ratings debugs slowly.
- **Negative cases are load-bearing.** Off-topic utterances should assert the
  agent's fallback topic **plus** an empty action list
  (`<expectedValue>[]</expectedValue>`) — proving the agent declined to act,
  not merely that it chatted.
- **Latency budgets** ride along free: add `output_latency_milliseconds` to
  the cases users actually feel, and let the results show regressions.
- Keep `bot_response_rating` reference answers short and factual — the check
  judges against your text, and a florid reference punishes correct answers.

## 5. Deploy and verify — the boundary applies twice

Deploy the single component through the house-rules §3 ritual — one
`validate_deploy`, human reads the code, `execute_deploy`. No Apex in the
package, so **omit `test_level` entirely**. Then verify:

1. Round-trip `retrieve_metadata` — confirm the org kept the cases you sent.
2. `refresh_snapshot` with `types: ["AiEvaluationDefinition"]` — agent types
   are explicit-refresh-only.

The honest boundary: **RUNNING the eval is Testing Center** (Connect REST
under the hood) — the human runs it and reads results there; Contrail has no
path to execute or fetch eval runs. And evals run only against **activated,
published** agents — so the lifecycle boundary in
**agentforce-metadata-generate** §2 applies twice: the human must have
published and activated the agent before the test can run, and the run
itself is theirs too. End every eval deploy summary naming both: "deployed
to **dev-org**; runnable once v2 is active, from Testing Center."

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (the AiEvaluationDefinition Metadata API catalog entry, with test-design judgment drawn from the agentforce-test skill references; Apache-2.0, © Salesforce, Inc.). Modified: retargeted from the Salesforce CLI test-spec workflow to direct XML authoring through the Contrail engine tools and the human-approval write contract.*
