---
name: agentforce-eval-generate
description: "Use this skill when users need to author, RUN, or interpret Agentforce agent tests through the Contrail engine — AiEvaluationDefinition metadata, Testing Center test authoring, run_agent_eval runs and their results, or one-off utterance smoke tests against an active agent. Trigger on 'write tests for my agent', 'run the agent evals', 'why did this test case fail', 'hit the agent with an utterance', or asserting which topic/actions an utterance should route to. DO NOT TRIGGER for Apex tests (platform-apex-test-generate) or for debugging agent metadata itself (agentforce-metadata-generate / agentforce-architecture-analyze)."
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

Running is Contrail's too now: **`run_agent_eval`** (§6) executes the
deployed definition and fetches results. Two prerequisites survive: the
agent needs an **active** version (activate through
`agent_activation_propose/execute` or Agent Builder), and — said plainly on
every run — **the agent under test executes its REAL actions with no
rollback**, so prefer sandboxes/dev orgs for agents whose actions write. End
every eval deploy summary: "deployed to **dev-org**; run it with
`run_agent_eval` once v2 is active."

## 6. Running and reading results (run_agent_eval)

- **Grants**: polling and results need `diagnostics_read`; **starting** a run
  additionally needs `data_write` (it triggers real agent-action execution).
  No confirmation code — the definition itself already passed the deploy
  ritual, and it is the run's only input.
- **Cadence**: submit with `eval` (the definition DeveloperName) → `run_id`;
  poll with `run_id` **sparingly** — runs take MINUTES. Orgs allow ~10
  concurrent runs and ≤1,000 cases per definition; an org refusal is relayed
  verbatim.
- **Reading results**: each case carries `generatedData` — `topic` and
  `actions_sequence` are the ROUTING TRUTH to compare against your
  `topic_sequence_match`/`action_sequence_match` expectations. Each
  expectation row has `passed`: `true`/`false` when the org emitted a
  verdict, **`null` when it emitted a label instead** (notably
  `instruction_adherence`, which yields HIGH/LOW/UNCERTAIN — read
  `metric_label`, don't treat null as a fail). `explainability` quotes the
  judge's reasoning — quote it when explaining a failure. (The org's
  pass-field schema varies by release — the tool tolerates both; the raw
  rows are available via `include_details`.)
- **Live-confirmed facts (personal-dev run, 2026-10-01, ~2 min for 2
  cases):** the org emitted the `result: PASS|FAILURE` + numeric `score`
  schema (no `metricScore` field); it RENAMES expectations in results —
  `topic_sequence_match` reports as `topic_assertion`,
  `action_sequence_match` as `actions_assertion` (match on either when
  cross-referencing); **topic names are the CLEAN base names**
  (`Case_Categorization_Summarization`, `off_topic`), not the ID-suffixed
  local developer names the Tooling API lists; the initial submit status is
  `PENDING`; judge metrics (coherence/completeness) DO emit PASS/FAILURE
  verdicts with 0–4-ish scores; `actionsSequence` arrives as a string
  literal like `['Action_Name']`; case-level `status` is `COMPLETED`
  (completion, not a verdict) — judge each case by its expectations, and
  read the tool's `totals.other` accordingly.
- **Deploy-availability gate (live-confirmed 2026-10-01):** an org without
  Testing Center provisioned refuses the AiEvaluationDefinition deploy with
  "Not available for deploy for this organization" — a provisioning gap,
  not a grammar error; the human enables Testing Center in that org's Setup
  (one fresh Agentforce DE showed the gate while an older DE deployed fine).
- **An ERROR run is the RUN failing** (commonly: no active agent version) —
  no case results exist; it is not a test failure. TERMINATED is partial at
  best, never a pass.
- **After a run against a writing agent, check what the actions did** — the
  side effects are real records; `soql_query` them and say so in the summary.
- The newer Agentforce Studio "AI testing" runner (`AiTestingDefinition`) is
  an undocumented beta — not available through Contrail; say so if asked.

## 7. One-off utterance smoke tests (anonymous Apex, no new machinery)

For "just ask the agent something and show me the reply" — the documented
`generateAiAgentResponse` invocable action, through the EXISTING anonymous
Apex ritual. The reply comes back via the debug log, so `set_trace_flag`
FIRST, then `apex_propose` this (human reads the code, `apex_execute`), then
`get_debug_logs` and grep `CONTRAIL_SMOKE`:

```apex
// One utterance against an ACTIVE agent. REAL actions execute — sandbox first.
Invocable.Action action = Invocable.Action.createCustomAction(
    'generateAiAgentResponse', null, 'Order_Agent', '1.0.0');
action.setInvocationParameter('userMessage', 'Where is my order 00001234?');
// Multi-turn: pass the sessionId a previous call returned.
// action.setInvocationParameter('sessionId', '<prior-session-id>');
List<Invocable.Action.Result> results = action.invoke();
Invocable.Action.Result r = results[0];
if (r.isSuccess()) {
    System.debug('CONTRAIL_SMOKE agentResponse: ' + r.getOutputParameters().get('agentResponse'));
    System.debug('CONTRAIL_SMOKE sessionId: ' + r.getOutputParameters().get('sessionId'));
} else {
    System.debug('CONTRAIL_SMOKE errors: ' + r.getErrors());
}
```

Honest limits: reply TEXT only — no topic/action trace (routing assertions
belong to evals, §6); active agents only; not available to the Platform
Integration User; cannot be wrapped in an Apex test; version `'1.1.0'` adds a
`structuredAgentResponse` output. Multi-turn conversations keep passing the
returned `sessionId`. **Live-confirmed from anonymous Apex (2026-10-01,
~5s round trip, zero Apex limits consumed):** the invocable works in the
executeAnonymous context — no wrapper class needed — and `agentResponse`
comes back as a **JSON envelope** `{"type":"Text","value":"…"}`, so read the
`value` field, not the raw string. **One caution stands:** the utterance
lands inside an Apex string literal — escape `'` and `\` per Apex string
rules before embedding it, and never paste untrusted text verbatim into the
script (the human reads the script on the approval page; keep it readable
and inert). (The Agent API proper — `api.salesforce.com` sessions —
needs a JWT from a specially configured External Client App; that setup is a
documented alternative Contrail deliberately does not automate.)

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (the AiEvaluationDefinition Metadata API catalog entry, with test-design judgment drawn from the agentforce-test skill references; Apache-2.0, © Salesforce, Inc.). Modified: retargeted from the Salesforce CLI test-spec workflow to direct XML authoring through the Contrail engine tools and the human-approval write contract.*
