/**
 * S44: the built-in scorer catalog of Agentforce Studio's test runner — the
 * `<scorer><name>` values an AiTestingDefinition may use without naming a
 * custom AiAgentScorerDefinition. Shared by the dependency extractor (a
 * non-catalog scorer name is a custom-scorer edge) and run_agent_eval (which
 * only derives a pass/fail from actual-vs-expected for the PASS_FAIL grades).
 *
 * MIRROR FILE — byte-identical in the plugin (server/src/core/agentforceScorers.ts)
 * and the desktop engine (packages/engine/src/core/agentforceScorers.ts).
 *
 * Source: Salesforce's open-source @salesforce/agents library (2.3.x,
 * ngtScorerCatalog) cross-checked against the Agentforce dev blog of
 * 2026-08. Both the type and its runner are Beta per Salesforce — names are
 * exact-case identifiers; the org validates them at deploy. A custom scorer
 * may legitimately be named like a catalog entry in a different case, so
 * membership is exact-case on purpose.
 */

export type StudioScorerGrade =
  | 'PASS_FAIL'
  | 'LLM_PASS_FAIL'
  | 'LLM_0_100'
  | 'LLM_0_5'
  | 'NUMERIC';

export interface StudioScorerSpec {
  grade: StudioScorerGrade;
  /** Whether the scorer takes an <expectedValue>. */
  needsExpected: boolean;
  subjects: ReadonlyArray<'AGENT' | 'PROMPT'>;
  /** task_resolution only grades a conversation — single-turn cases cannot carry it. */
  requiresConversationHistory?: true;
}

export const STUDIO_SCORERS: Readonly<Record<string, StudioScorerSpec>> = {
  topic_sequence_match: { grade: 'PASS_FAIL', needsExpected: true, subjects: ['AGENT'] },
  action_sequence_match: { grade: 'PASS_FAIL', needsExpected: true, subjects: ['AGENT'] },
  agent_handoff_match: { grade: 'PASS_FAIL', needsExpected: true, subjects: ['AGENT'] },
  bot_response_rating: { grade: 'LLM_PASS_FAIL', needsExpected: true, subjects: ['AGENT'] },
  response_match: { grade: 'LLM_PASS_FAIL', needsExpected: true, subjects: ['AGENT', 'PROMPT'] },
  coherence: { grade: 'LLM_0_100', needsExpected: false, subjects: ['AGENT', 'PROMPT'] },
  conciseness: { grade: 'LLM_0_100', needsExpected: false, subjects: ['AGENT', 'PROMPT'] },
  factuality: { grade: 'LLM_0_100', needsExpected: false, subjects: ['AGENT', 'PROMPT'] },
  completeness: { grade: 'LLM_0_100', needsExpected: false, subjects: ['AGENT', 'PROMPT'] },
  task_resolution: {
    grade: 'LLM_0_5',
    needsExpected: false,
    subjects: ['AGENT'],
    requiresConversationHistory: true,
  },
  output_latency_milliseconds: { grade: 'NUMERIC', needsExpected: false, subjects: ['AGENT'] },
};

/** Exact-case membership: `Coherence` is NOT the catalog scorer `coherence`. */
export function isStudioCatalogScorer(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(STUDIO_SCORERS, name);
}

/**
 * S44: the Tests tab reports each scorer under its column LABEL, not its
 * catalog name (live-observed 2026-11-11). The labels seen so far; a label
 * not listed here (a custom scorer, or one not yet observed) maps to null.
 */
export const STUDIO_RESULT_LABELS: Readonly<Record<string, string>> = {
  'Subagent Evaluation': 'topic_sequence_match',
  'Action Evaluation': 'action_sequence_match',
  'Response Evaluation': 'bot_response_rating',
  'Coherence Evaluation': 'coherence',
  'Conciseness Evaluation': 'conciseness',
};

/** Catalog scorers whose verdict is a plain expected-vs-actual match. */
export const STUDIO_PASS_FAIL_SCORERS: ReadonlySet<string> = new Set(
  Object.entries(STUDIO_SCORERS)
    .filter(([, spec]) => spec.grade === 'PASS_FAIL')
    .map(([name]) => name),
);
