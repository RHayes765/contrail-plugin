import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVIDENCE_DETAIL_KEYS,
  buildEvidence,
  codeFreePageView,
  evidencePayload,
  evidenceRequestOf,
  exportChangeEvidence,
  justificationRecord,
  mdBlock,
  mdCode,
  redactRowLabel,
  reduceAuditDetail,
  type EvidenceAuditRow,
  type EvidenceIdentity,
  type EvidenceInput,
  type EvidenceIo,
  type EvidenceRequestRecord,
  type EvidenceRow,
} from '../deploy/evidence.js';
import type { ApprovalPageOptions } from '../connect/pages.js';
import type { StoredJustification } from '../core/policy.js';

/**
 * S46 (B): the change-evidence unit. codeFreePageView is what every mint
 * stores as summary_json.page_view: what the approval page showed, copied
 * key by key — never the confirmation code, never a diff body, never a
 * data-change row's field values or an Apex script. buildEvidence and
 * exportChangeEvidence turn the stored rows into the dossier: every value
 * read by name, record values and messages left out, older copies of
 * Contrail disclosed, and nothing stored or supplied able to forge the
 * Markdown's structure.
 */

const CODE = 'ABCD-2345';
const ORG = {
  alias: 'acme-uat',
  orgName: 'Acme UAT',
  orgType: 'sandbox',
  instanceUrl: 'https://acme-uat.example.invalid',
};

function deployView(): ApprovalPageOptions {
  return {
    kind: 'deploy',
    code: CODE,
    expiresAt: '2026-11-17T15:00:00.000Z',
    org: {
      alias: 'acme-uat',
      orgName: 'Acme UAT',
      orgType: 'sandbox',
      instanceUrl: 'https://acme-uat.example.invalid',
    },
    changes: [
      {
        label: 'MODIFY  ApexClass:Invoice_Service',
        warnings: ['CHANGED IN TARGET since your snapshot'],
        detail: 'from staging/classes/Invoice_Service.cls  ·  sha256 0123456789abcdef…',
        diff: {
          format: 'text',
          identical: false,
          baseline_label: 'diff vs live org (retrieved 14:02)',
          summary: 'diff vs live org (retrieved 14:02) · 1 change',
          text_hunks: [
            {
              a_line: 1,
              b_line: 1,
              removed: ['public class Invoice_Service { // OLD-BODY-LINE }'],
              added: ['public class Invoice_Service { // NEW-BODY-LINE }'],
            },
          ],
          counts: { changes: 1, lines_added: 1, lines_removed: 1 },
          truncated: false,
          note: 'a note about the diff body',
        },
      },
      {
        label: 'ADD  CustomObject:Invoice__c',
        warnings: [],
        diff: {
          format: 'xml',
          identical: false,
          baseline_label: 'diff vs your snapshot (2026-11-16)',
          summary: 'diff vs your snapshot (2026-11-16) · 2 changes',
          xml_changes: [
            { kind: 'scalar', path: 'label', a: 'OLD-XML-VALUE', b: 'NEW-XML-VALUE' },
            { kind: 'added', path: 'fields', key: 'Amount__c' },
          ],
          truncated: true,
        },
      },
    ],
    destructive: [
      {
        label: 'DELETE  ApexClass:Old_Invoice_Service',
        warnings: ['deleting this breaks dependents: ApexClass:Invoice_Batch'],
      },
    ],
    results: [
      { label: 'Validation', value: 'passed (checkOnly)' },
      { label: 'Tests', value: '3 run, 1 failed', bad: true },
    ],
    blast: ['ApexClass:Invoice_Service ← used by ApexClass:Invoice_Batch'],
    warnings: ['Live last-modified stamps were unavailable for ApexClass.'],
  };
}

describe('codeFreePageView', () => {
  it('stores the page key by key, with no code and no diff body', () => {
    const stored = codeFreePageView(deployView());
    const json = JSON.stringify(stored);
    expect(json).not.toContain(CODE);
    expect(json).not.toContain('text_hunks');
    expect(json).not.toContain('xml_changes');
    expect(json).not.toContain('BODY-LINE');
    expect(json).not.toContain('XML-VALUE');
    expect(json).not.toContain('a note about the diff body');
    expect(stored).toEqual({
      v: 1,
      kind: 'deploy',
      org: {
        alias: 'acme-uat',
        org_name: 'Acme UAT',
        org_type: 'sandbox',
        instance_url: 'https://acme-uat.example.invalid',
      },
      expires_at: '2026-11-17T15:00:00.000Z',
      warnings: ['Live last-modified stamps were unavailable for ApexClass.'],
      destructive: [
        {
          label: 'DELETE  ApexClass:Old_Invoice_Service',
          warnings: ['deleting this breaks dependents: ApexClass:Invoice_Batch'],
        },
      ],
      changes: [
        {
          label: 'MODIFY  ApexClass:Invoice_Service',
          warnings: ['CHANGED IN TARGET since your snapshot'],
          detail: 'from staging/classes/Invoice_Service.cls  ·  sha256 0123456789abcdef…',
          diff: {
            summary: 'diff vs live org (retrieved 14:02) · 1 change',
            baseline_label: 'diff vs live org (retrieved 14:02)',
            identical: false,
            counts: { changes: 1, lines_added: 1, lines_removed: 1 },
            truncated: false,
          },
        },
        {
          label: 'ADD  CustomObject:Invoice__c',
          warnings: [],
          diff: {
            summary: 'diff vs your snapshot (2026-11-16) · 2 changes',
            baseline_label: 'diff vs your snapshot (2026-11-16)',
            identical: false,
            counts: null,
            truncated: true,
          },
        },
      ],
      automation: [],
      automation_not_covered: [],
      results: [
        { label: 'Validation', value: 'passed (checkOnly)' },
        { label: 'Tests', value: '3 run, 1 failed', bad: true },
      ],
      blast: ['ApexClass:Invoice_Service ← used by ApexClass:Invoice_Batch'],
    });
  });

  it('never reads the code, and copies nothing it does not name', () => {
    const view = deployView() as ApprovalPageOptions & Record<string, unknown>;
    Object.defineProperty(view, 'code', {
      enumerable: true,
      get() {
        throw new Error('the page view read the confirmation code');
      },
    });
    // A governance key of any shape: the page view names none, so copies none.
    (view as Record<string, unknown>).governance = { justification: { text: 'GOVERNANCE-TEXT' } };
    view.extra = 'EXTRA-KEY';
    const stored = codeFreePageView(view);
    const json = JSON.stringify(stored);
    expect(json).not.toContain('GOVERNANCE-TEXT');
    expect(json).not.toContain('EXTRA-KEY');
    expect(Object.keys(stored).sort()).toEqual(
      [
        'automation',
        'automation_not_covered',
        'blast',
        'changes',
        'destructive',
        'expires_at',
        'kind',
        'org',
        'results',
        'v',
        'warnings',
      ].sort(),
    );
  });

  it('is a copy: changing the view afterwards does not change what was stored', () => {
    const view = deployView();
    const stored = codeFreePageView(view);
    view.changes[0]!.warnings.push('added later');
    view.warnings!.push('added later');
    view.blast.push('added later');
    expect(JSON.stringify(stored)).not.toContain('added later');
  });

  it('replaces an Apex script with its fingerprint', () => {
    const script = "Account a = [SELECT Id FROM Account LIMIT 1];\ndelete a; // APEX-SCRIPT-BODY";
    const stored = codeFreePageView({
      kind: 'apex',
      code: CODE,
      expiresAt: '2026-11-17T15:00:00.000Z',
      org: { ...ORG, orgName: null },
      changes: [
        { label: 'Execute anonymous Apex (2 lines, 73 chars)', warnings: [], detail: script },
      ],
      destructive: [],
      automation: [],
      automationNotCovered: ['Apex called from this script'],
      results: [{ label: 'Runs as', value: 'admin@acme-uat.example.invalid' }],
      blast: [],
      warnings: ['ANONYMOUS APEX — read every line below before approving.'],
    });
    const json = JSON.stringify(stored);
    expect(json).not.toContain('APEX-SCRIPT-BODY');
    expect(json).not.toContain(CODE);
    expect(stored.changes).toEqual([
      {
        label: 'Execute anonymous Apex (2 lines, 73 chars)',
        warnings: [],
        detail_sha256: crypto.createHash('sha256').update(script).digest('hex'),
        detail_chars: script.length,
      },
    ]);
    expect(stored.changes[0]).not.toHaveProperty('detail');
    expect(stored.automation_not_covered).toEqual(['Apex called from this script']);
    expect(stored.org.org_name).toBeNull();
  });

  it('reduces data-change rows to operation, object and record id, with no detail', () => {
    const stored = codeFreePageView({
      kind: 'dml',
      code: CODE,
      expiresAt: '2026-11-17T15:00:00.000Z',
      org: ORG,
      changes: [
        { label: 'UPDATE Invoice__c a01000000000001AAA: Amount__c: 100 → 250', warnings: [] },
        {
          label: 'Step 2 · INSERT Invoice__c (ref "inv"): Name = "Secret Value"',
          warnings: [],
          detail: 'references: Account__c ← @{acct.id}',
        },
      ],
      destructive: [
        {
          label: 'DELETE Invoice__c a01000000000002AAA',
          warnings: ['record not found in pre-check — it may already be gone or the id is wrong'],
        },
      ],
      automation: [
        {
          object: 'Invoice__c',
          snapshot_at: '2026-11-16T09:00:00.000Z',
          summary_lines: ['1 record-triggered flow: Invoice_Reminder'],
          notes: ['a note'],
          not_covered: ['managed-package triggers'],
        },
      ],
      results: [{ label: 'Operation', value: 'UPDATE Invoice__c' }],
      blast: [],
    });
    const json = JSON.stringify(stored);
    expect(json).not.toContain('Secret Value');
    expect(json).not.toContain('250');
    expect(json).not.toContain('@{acct.id}');
    expect(stored.changes).toEqual([
      { label: 'UPDATE Invoice__c a01000000000001AAA', warnings: [] },
      { label: 'Step 2 · INSERT Invoice__c (ref "inv")', warnings: [] },
    ]);
    expect(stored.destructive).toEqual([
      {
        label: 'DELETE Invoice__c a01000000000002AAA',
        warnings: ['record not found in pre-check — it may already be gone or the id is wrong'],
      },
    ]);
    expect(stored.automation).toEqual([
      {
        object: 'Invoice__c',
        snapshot_at: '2026-11-16T09:00:00.000Z',
        summary_lines: ['1 record-triggered flow: Invoice_Reminder'],
        notes: ['a note'],
        not_covered: ['managed-package triggers'],
      },
    ]);
  });

  it('keeps the detail of bulk and activation rows (file names, fingerprints, version ids)', () => {
    for (const kind of ['bulk', 'activation'] as const) {
      const stored = codeFreePageView({
        kind,
        code: CODE,
        expiresAt: '2026-11-17T15:00:00.000Z',
        org: ORG,
        changes: [
          {
            label: 'STEP 1  INSERT Invoice__c — 2 rows',
            warnings: [],
            detail: 'from invoices.csv',
          },
        ],
        destructive: [],
        results: [],
        blast: [],
      });
      expect(stored.changes[0]).toEqual({
        label: 'STEP 1  INSERT Invoice__c — 2 rows',
        warnings: [],
        detail: 'from invoices.csv',
      });
      expect(JSON.stringify(stored)).not.toContain(CODE);
    }
  });
});

describe('redactRowLabel', () => {
  it('keeps what precedes the first colon of a data-change label', () => {
    expect(redactRowLabel('dml', 'UPDATE Account 001…: Name: "Old" → "New"')).toBe(
      'UPDATE Account 001…',
    );
    expect(redactRowLabel('dml', 'INSERT Contact: Email = "someone@example.invalid"')).toBe(
      'INSERT Contact',
    );
    expect(redactRowLabel('dml', 'DELETE Account 001000000000001AAA')).toBe(
      'DELETE Account 001000000000001AAA',
    );
    expect(redactRowLabel('dml', '… and 3 more rows')).toBe('… and 3 more rows');
  });

  it('leaves every other kind unchanged — a metadata label carries Type:name', () => {
    expect(redactRowLabel('deploy', 'MODIFY  ApexClass:Invoice_Service')).toBe(
      'MODIFY  ApexClass:Invoice_Service',
    );
    expect(redactRowLabel('apex', 'Execute anonymous Apex (1 line, 9 chars)')).toBe(
      'Execute anonymous Apex (1 line, 9 chars)',
    );
    expect(redactRowLabel('bulk', 'STEP 1  INSERT Account — 2 rows (match on Id: update)')).toBe(
      'STEP 1  INSERT Account — 2 rows (match on Id: update)',
    );
    expect(redactRowLabel('activation', 'ACTIVATE Invoice_Agent v2 (currently Inactive)')).toBe(
      'ACTIVATE Invoice_Agent v2 (currently Inactive)',
    );
  });
});

// ── the dossier ──────────────────────────────────────────────────────────

const OPENING =
  'What this is: a record of what Contrail validated, proposed and executed, as Contrail ' +
  "recorded it on this machine at the time. What it is not: a statement of the org's current " +
  'state, or of changes made outside Contrail. "Acting user" is the Salesforce user the ' +
  'connection was logged in as when the request was proposed, and when it executed where that ' +
  'was recorded — Contrail does not know which person was at the keyboard. Confirmation codes ' +
  'are never included. Record field values are not included: data-change rows are reduced to ' +
  'operation, object and record id, scripts and CSV files to fingerprints, and failure messages ' +
  "to their status codes; the full text stays in Contrail's local database.";

const AUDIT_LISTED =
  'Listed: audit rows that name this request. Supersession by a newer validation is recorded ' +
  'per connection with a count only, not per request, and is not listed — the status above is ' +
  'what Contrail stored.';

const NOW_LABEL =
  'Org and acting user as the connection is now — not recorded when this request was made';

const PAGE_VIEW_OLDER =
  'Approval-page summary: not recorded (this request was created by a Contrail older than 0.40.0).';
const PAGE_VIEW_MISSING = 'Approval-page summary: not recorded.';
const POLICY_OLDER =
  'Policies at proposal: not checked — this request was created by a Contrail older than ' +
  '0.40.0, which does not evaluate policies or freeze windows.';
const EXECUTE_CHECK_OLDER =
  'Policy re-check at execution: not recorded — Contrail 0.40.0 and later record it before ' +
  'executing, so this request was executed by an older Contrail on this machine, which does not ' +
  'check policies or freeze windows.';
const EXECUTE_CHECK_NOT_RUN = 'Policy re-check at execution: not applicable (not executed).';
const EXECUTE_CHECK_REFUSED = 'Policy re-check at execution: refused — not executed.';
const ORG_RESULT_EXECUTING =
  'Not recorded — the request was claimed for execution (status executing) and Contrail has ' +
  'stored no outcome: the write may still be running, or may have committed if the Contrail ' +
  'process running it stopped. Check the org.';

const RULE = 'acme needs a reason';
const WHY = 'The client asked for the invoice fix to reach their org before month end.';

const PROD: EvidenceIdentity = {
  alias: 'acme-prod',
  org_id: '00D000000000001AAA',
  org_name: 'Acme',
  org_type: 'production',
  username: 'admin@acme.example.invalid',
};

const EXECUTE_CHECK = {
  at: '2026-11-17T14:09:59.000Z',
  rules: [RULE],
  freeze_active: false,
  overridden: false,
  org_id: PROD.org_id,
  username: PROD.username,
};

function governance(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    surface: 'page',
    target: { ...PROD },
    ticket: 'INV-42',
    justification: { text: WHY, source: 'agent' },
    inputs: { destructive: false, test_level: null },
    policy: {
      evaluated_at: '2026-11-17T13:59:00.000Z',
      source: 'config',
      sha256: 'a'.repeat(64),
      rules: [RULE],
      requirements: { justification: true },
      lines: [`A justification is required (rule "${RULE}").`],
    },
    freeze: null,
    freeze_override: null,
    execute_check: null,
    ...extra,
  };
}

function pageView(kind: ApprovalPageOptions['kind'], changes: ApprovalPageOptions['changes']) {
  return codeFreePageView({
    kind,
    code: CODE,
    expiresAt: '2026-11-17T15:00:00.000Z',
    org: { alias: 'acme-prod', orgName: 'Acme', orgType: 'production', instanceUrl: 'https://acme.example.invalid' },
    changes,
    destructive: [],
    results: [{ label: 'Validation', value: 'passed (checkOnly)' }],
    blast: [],
  });
}

function row(over: Partial<EvidenceRow> & Pick<EvidenceRow, 'kind'>): EvidenceRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'validated',
    created_at: '2026-11-17T14:00:00.000Z',
    expires_at: '2026-11-17T15:00:00.000Z',
    executed_at: null,
    validation_id: null,
    target_at_proposal: { ...PROD },
    target_at_execution: null,
    connection_now: { ...PROD },
    summary: { governance: governance(), page_view: pageView('apex', []) },
    result: null,
    payload: null,
    events: [],
    events_truncated: false,
    ...over,
  };
}

function input(requests: EvidenceRow[], over: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    generated_at: '2026-11-17T16:00:00.000Z',
    engine_version: '0.40.0',
    surface: 'plugin',
    filters: { connection: 'acme-prod', ticket: null, request_id: null, since: null, until: null },
    requests,
    refusals: [],
    refusals_truncated: false,
    policies: { status: 'ok', source: 'config' },
    truncated: false,
    scan_cut: false,
    ...over,
  };
}

/** One request of each kind, as the five proposing paths store them. */
function fiveKinds(): EvidenceRow[] {
  return [
    row({
      id: '10000000-0000-4000-8000-000000000001',
      kind: 'deploy',
      status: 'executed',
      executed_at: '2026-11-17T14:10:00.000Z',
      validation_id: '0Af000000000001AAA',
      target_at_execution: { org_id: PROD.org_id, username: PROD.username },
      summary: {
        changes: [
          {
            type: 'ApexClass',
            api_name: 'Invoice_Service',
            change: 'modify',
            warnings: [],
            pre_image: {
              present: true,
              source: 'retrieve',
              stamp_source: 'listMetadata',
              sha256: 'b'.repeat(64),
              last_modified_date: '2026-11-16T10:00:00.000Z',
              last_modified_by: 'Ana Admin',
              comparable: true,
              restorable: true,
            },
          },
          {
            type: 'CustomField',
            api_name: 'Invoice__c.Amount__c',
            change: 'add',
            warnings: [],
            pre_image: {
              present: false,
              source: 'retrieve',
              stamp_source: 'tooling:CustomField',
              last_modified_date: null,
              last_modified_by: null,
              comparable: false,
              restorable: false,
            },
          },
        ],
        destructive: [],
        blast: [],
        live_check: {
          status: 'ok',
          started_at: '2026-11-17T13:59:20.000Z',
          at: '2026-11-17T13:59:30.000Z',
          dates_unavailable_types: ['CustomLabel'],
          stamp_scheme: 2,
          probe_failures: { CustomLabel: 'the stamp query failed: Secret Value in the org error' },
          probe_unmatched: [],
          retrieve_note: 'The org said: Secret Value retrieve message',
          members: 2,
        },
        governance: governance({ execute_check: EXECUTE_CHECK }),
        page_view: pageView('deploy', [
          {
            label: 'MODIFY  ApexClass:Invoice_Service',
            warnings: ['CHANGED IN TARGET since your snapshot'],
            detail: 'from staging/classes/Invoice_Service.cls',
            diff: {
              format: 'text',
              identical: false,
              baseline_label: 'diff vs live org (retrieved 13:59)',
              summary: 'diff vs live org (retrieved 13:59) · 1 change',
              text_hunks: [{ a_line: 1, b_line: 1, removed: ['OLD-BODY'], added: ['NEW-BODY'] }],
              truncated: false,
            },
          },
        ]),
      },
      payload: { test_level: 'RunLocalTests', run_tests: [] },
      result: {
        connection: 'acme-prod',
        deployed: true,
        status: 'Succeeded',
        quick_deploy: true,
        components_deployed: 2,
        component_errors: 0,
        component_failures: [],
        tests_run: 3,
        test_failures: 0,
        test_failure_detail: null,
        target_check: {
          status: 'ok',
          checked_at: '2026-11-17T14:09:58.000Z',
          checked: [
            { type: 'ApexClass', api_name: 'Invoice_Service' },
            { type: 'CustomField', api_name: 'Invoice__c.Amount__c', absent: true },
          ],
          unchecked: [{ type: 'CustomLabel', api_name: 'Invoice_Label', reason: 'stamp_query_failed_at_execute' }],
        },
        revert_package: {
          dir: '/contrail-data/staging/_reverts/10000000-0000-4000-8000-000000000001',
          plan: '/contrail-data/staging/_reverts/10000000-0000-4000-8000-000000000001/revert-plan.json',
          restores: [{ type: 'ApexClass', api_name: 'Invoice_Service' }],
          deletes: [{ type: 'CustomField', api_name: 'Invoice__c.Amount__c' }],
          not_restorable: [],
          note: 'README-TEXT-NOT-FOR-THE-DOSSIER',
        },
        snapshot: { status: 'partial', skipped: [{ reason: 'Secret Value snapshot note' }] },
        note: 'Deployed.',
      },
      events: [
        {
          ts: '2026-11-17T14:00:01.000Z',
          event_type: 'deploy.validated',
          tool: 'validate_deploy',
          outcome: 'success',
          detail: {
            requestId: '10000000-0000-4000-8000-000000000001',
            components: 2,
            governance: { ticket: 'INV-42', justification_chars: 72 },
          },
        },
        {
          ts: '2026-11-17T14:10:00.000Z',
          event_type: 'deploy.executed',
          tool: 'execute_deploy',
          outcome: 'success',
          detail: {
            requestId: '10000000-0000-4000-8000-000000000001',
            deployId: '0Af000000000002AAA',
            componentsDeployed: 2,
            status: 'Succeeded',
          },
        },
      ],
    }),
    row({
      id: '10000000-0000-4000-8000-000000000002',
      kind: 'dml',
      status: 'execution_failed',
      executed_at: '2026-11-17T14:20:00.000Z',
      target_at_execution: { org_id: PROD.org_id, username: PROD.username },
      summary: {
        rows: [{ label: 'UPDATE Invoice__c a01000000000001AAA: Amount__c: 100 → Secret Value', warnings: [] }],
        before: { a01000000000001AAA: { Amount__c: 'Secret Value' } },
        found: { a01000000000001AAA: { Name: 'Secret Value' } },
        governance: governance({ execute_check: EXECUTE_CHECK }),
        // A page view stored by another writer, unredacted: the builder redacts it again.
        page_view: {
          v: 1,
          kind: 'dml',
          org: { alias: 'acme-prod', org_name: 'Acme', org_type: 'production', instance_url: 'https://acme.example.invalid' },
          expires_at: '2026-11-17T15:00:00.000Z',
          warnings: [],
          destructive: [],
          changes: [
            {
              label: 'UPDATE Invoice__c a01000000000001AAA: Amount__c: 100 → Secret Value',
              warnings: [],
              detail: 'Secret Value detail',
            },
          ],
          automation: [],
          automation_not_covered: [],
          results: [],
          blast: [],
        },
      },
      payload: { operations: [{ operation: 'update', object: 'Invoice__c', rows: 1 }] },
      result: {
        connection: 'acme-prod',
        operation: 'update',
        object: 'Invoice__c',
        executed: false,
        rows: 1,
        failures: [
          {
            id: 'a01000000000001AAA',
            success: false,
            errors: [
              {
                statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
                message: 'Secret Value is not allowed here',
                fields: ['Amount__c'],
              },
            ],
          },
        ],
        error_message: 'Secret Value',
        // As probeDmlTarget stores them: records by object and id.
        target_check: {
          status: 'ok',
          checked_at: '2026-11-17T14:19:59.000Z',
          checked: [{ object: 'Invoice__c', id: 'a01000000000001AAA' }],
          unchecked: [{ object: 'Invoice__c', id: 'a01000000000002AAA', reason: 'not_found_at_propose' }],
        },
      },
    }),
    row({
      id: '10000000-0000-4000-8000-000000000003',
      kind: 'apex',
      status: 'executed',
      executed_at: '2026-11-17T14:30:00.000Z',
      target_at_execution: { org_id: PROD.org_id, username: PROD.username },
      summary: {
        governance: governance({ execute_check: EXECUTE_CHECK }),
        page_view: pageView('apex', [
          { label: 'Execute anonymous Apex (1 line, 31 chars)', warnings: [], detail: "System.debug('Secret Value');" },
        ]),
      },
      payload: { sha256: 'd'.repeat(64), lines: 1, chars: 31 },
      result: {
        connection: 'acme-prod',
        executed: true,
        status: 'executed',
        target_check: { status: 'not_applicable', note: 'no fixed org target to re-check' },
        compile_error: { problem: 'Secret Value compile problem' },
      },
    }),
    row({
      id: '10000000-0000-4000-8000-000000000004',
      kind: 'bulk',
      summary: {
        governance: governance(),
        page_view: pageView('bulk', [
          { label: 'STEP 1  INSERT Account — 2 rows', warnings: [], detail: 'from invoices.csv' },
        ]),
      },
      payload: {
        steps: [{ n: 1, object: 'Account', operation: 'insert', row_count: 2, sha256: 'e'.repeat(64) }],
        stop_on_failure: true,
      },
    }),
    row({
      id: '10000000-0000-4000-8000-000000000005',
      kind: 'activation',
      status: 'executed',
      executed_at: '2026-11-17T14:40:00.000Z',
      target_at_execution: { org_id: PROD.org_id, username: PROD.username },
      summary: {
        governance: governance({ execute_check: EXECUTE_CHECK }),
        page_view: pageView('activation', [
          { label: 'ACTIVATE Invoice_Agent v2 (currently Inactive)', warnings: [] },
        ]),
      },
      payload: { agent: 'Invoice_Agent', version: 'v2', from: 'Inactive', to: 'Active' },
      result: {
        connection: 'acme-prod',
        executed: true,
        agent: 'Invoice_Agent',
        version: 'v2',
        requested_status: 'Active',
        confirmed_status: 'Active',
        messages: ['Secret Value platform message'],
      },
    }),
  ];
}

/** The Markdown with every fenced block and code span removed. */
function stripCode(md: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    if (fence !== null) {
      if (line === fence) fence = null;
      continue;
    }
    if (/^`{3,}$/.test(line)) {
      fence = line;
      continue;
    }
    kept.push(line);
  }
  const text = kept.join('\n');
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      out += text[i];
      i++;
      continue;
    }
    let n = 0;
    while (text[i + n] === '`') n++;
    let j = i + n;
    let close = -1;
    while (j < text.length) {
      if (text[j] !== '`') {
        j++;
        continue;
      }
      let m = 0;
      while (text[j + m] === '`') m++;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    if (close === -1) {
      out += text.slice(i, i + n);
      i += n;
      continue;
    }
    i = close + n;
  }
  return out;
}

/** The cells of a GFM table row, counted as a table parser splits it (`\x` pairs never split). */
function cellCount(line: string): number {
  let pipes = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === '|') pipes++;
  }
  return pipes - 1;
}

describe('justificationRecord', () => {
  const j = (x: StoredJustification) => justificationRecord(x);
  it('says who wrote the justification, in the words the dossier prints', () => {
    expect(justificationRecord(null)).toBe('None given.');
    expect(j({ text: WHY, source: 'agent' })).toBe(
      'Drafted by the agent and not edited by the human. Contrail does not record whether the approver read it.',
    );
    expect(j({ text: WHY, source: 'agent', confirmed_at: '2026-11-17T14:05:00.000Z' })).toBe(
      'Drafted by the agent; shown prefilled in Deploy Review and approved unchanged at 2026-11-17T14:05:00.000Z.',
    );
    expect(
      j({ text: 'Typed by the human.', source: 'page', surface: 'approval_page', edited_at: '2026-11-17T14:03:00.000Z' }),
    ).toBe('Typed on the approval page at 2026-11-17T14:03:00.000Z.');
    expect(
      j({
        text: 'Typed by the human.',
        source: 'page',
        surface: 'deploy_review',
        edited_at: '2026-11-17T14:03:00.000Z',
        agent_draft: WHY,
      }),
    ).toBe("Typed in Deploy Review at 2026-11-17T14:03:00.000Z. It replaced the agent's draft, which follows.");
    expect(
      j({ text: '', source: 'page', surface: 'approval_page', edited_at: '2026-11-17T14:03:00.000Z', agent_draft: WHY }),
    ).toBe("Cleared on the approval page at 2026-11-17T14:03:00.000Z; the agent's draft that was removed follows.");
    // Cleared after the human had typed it themselves: there is no draft to follow.
    expect(j({ text: '', source: 'page', surface: 'deploy_review', edited_at: '2026-11-17T14:03:00.000Z' })).toBe(
      'Cleared in Deploy Review at 2026-11-17T14:03:00.000Z.',
    );
  });
});

describe('buildEvidence', () => {
  it('opens with the fixed header and covers all five kinds, each with its sections', () => {
    const { markdown: md, json, counts } = buildEvidence(input(fiveKinds()));
    const lines = md.split('\n');
    expect(lines[0]).toBe('# Contrail change evidence');
    expect(lines[2]).toBe(
      'Generated 2026-11-17T16:00:00.000Z by Contrail 0.40.0 (plugin). Filters: connection `acme-prod` · ' +
        'ticket any · request any · from the beginning to now.',
    );
    expect(lines[4]).toBe(OPENING);
    expect(json.about).toBe(OPENING);
    expect(md).toContain('## Summary');
    expect(md).toContain('## Policy refusals in this window (no request was created)');
    for (const kind of ['deploy', 'dml', 'apex', 'bulk', 'activation']) {
      expect(md).toMatch(new RegExp(`^## Request \`[0-9a-f-]+\` — ${kind} on \`acme-prod\`$`, 'm'));
    }
    for (const h of [
      '### What the approval page showed',
      '### Pre-images',
      '### Target check at execution',
      '### Org result',
      '### Revert package',
      '### Audit events',
    ]) {
      expect(md.split('\n').filter((l) => l === h)).toHaveLength(5);
    }
    expect(md.split('\n').filter((l) => l === AUDIT_LISTED)).toHaveLength(5);
    expect(counts).toEqual({
      requests: 5,
      by_status: { executed: 3, execution_failed: 1, validated: 1 },
      audit_events: 2,
      policy_refusals: 0,
    });
    // Deploy: the pre-image stamps, where they were read, the target check and the revert location.
    expect(md).toContain(
      '| `ApexClass` | `Invoice_Service` | `modify` | yes | `' + 'b'.repeat(64) + '` | 2026-11-16T10:00:00.000Z | `Ana Admin` | `retrieve` | `listMetadata` |',
    );
    expect(md).toContain('`tooling:CustomField`');
    const deploy = json.requests[0]!;
    expect(deploy.pre_images[1]).toEqual({
      type: 'CustomField',
      api_name: 'Invoice__c.Amount__c',
      change: 'add',
      present: false,
      sha256: null,
      last_modified_date: null,
      last_modified_by: null,
      source: 'retrieve',
      stamp_source: 'tooling:CustomField',
    });
    expect(deploy.live_check).toEqual({
      status: 'ok',
      at: '2026-11-17T13:59:30.000Z',
      dates_unavailable_types: ['CustomLabel'],
      stamp_scheme: 2,
      probe_unmatched: [],
      probe_failure_types: ['CustomLabel'],
    });
    expect(deploy.target_check).toEqual({
      status: 'ok',
      checked_at: '2026-11-17T14:09:58.000Z',
      checked: [
        { type: 'ApexClass', api_name: 'Invoice_Service' },
        { type: 'CustomField', api_name: 'Invoice__c.Amount__c', absent: true },
      ],
      unchecked: [{ type: 'CustomLabel', api_name: 'Invoice_Label', reason: 'stamp_query_failed_at_execute' }],
    });
    expect(deploy.revert).toEqual({
      package: {
        dir: '/contrail-data/staging/_reverts/10000000-0000-4000-8000-000000000001',
        plan: '/contrail-data/staging/_reverts/10000000-0000-4000-8000-000000000001/revert-plan.json',
        outcome: null,
        restores: 1,
        deletes: 1,
        not_restorable: 0,
      },
      note: null,
    });
    expect(deploy.org_result).toEqual({
      deployed: true,
      // Not in the stored result: taken from the execute's own audit row.
      deploy_id: '0Af000000000002AAA',
      status: 'Succeeded',
      quick_deploy: true,
      components_deployed: 2,
      component_errors: 0,
      tests_run: 3,
      test_failures: 0,
    });
    expect(deploy.inputs).toEqual({ test_level: 'RunLocalTests', run_tests: [] });
    // The dossier points at the revert package and quotes nothing from its README.
    expect(md).not.toContain('README-TEXT-NOT-FOR-THE-DOSSIER');
    expect(JSON.stringify(json)).not.toContain('README-TEXT-NOT-FOR-THE-DOSSIER');
    // No diff body reaches the dossier.
    expect(JSON.stringify(json)).not.toContain('OLD-BODY');
    // DML: status codes, never messages; the label reduced to operation, object and record id.
    const dml = json.requests[1]!;
    expect(dml.org_result).toEqual({
      executed: false,
      operation: 'update',
      object: 'Invoice__c',
      rows: 1,
      failures: 1,
      failure_status_codes: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'],
    });
    expect(dml.page_view!.changes).toEqual([{ label: 'UPDATE Invoice__c a01000000000001AAA', warnings: [] }]);
    // DML: the re-checked records by object and id, as the guard stored them.
    expect(dml.target_check).toEqual({
      status: 'ok',
      checked_at: '2026-11-17T14:19:59.000Z',
      checked: [{ object: 'Invoice__c', id: 'a01000000000001AAA' }],
      unchecked: [{ object: 'Invoice__c', id: 'a01000000000002AAA', reason: 'not_found_at_propose' }],
    });
    expect(md).toContain('Compared:\n\n```\nInvoice__c:a01000000000001AAA\n```');
    expect(md).toContain('Not compared:\n\n```\nInvoice__c:a01000000000002AAA — not_found_at_propose\n```');
    // Apex: the fingerprint; bulk: steps with file fingerprints; activation: agent, version, statuses.
    expect(json.requests[2]!.inputs).toEqual({ sha256: 'd'.repeat(64), lines: 1, chars: 31 });
    expect(json.requests[2]!.page_view!.changes[0]).toEqual({
      label: 'Execute anonymous Apex (1 line, 31 chars)',
      warnings: [],
      detail_sha256: crypto.createHash('sha256').update("System.debug('Secret Value');").digest('hex'),
      detail_chars: 29,
    });
    expect(json.requests[3]!.inputs).toEqual({
      steps: [{ n: 1, object: 'Account', operation: 'insert', row_count: 2, sha256: 'e'.repeat(64) }],
      stop_on_failure: true,
    });
    expect(json.requests[4]!.org_result).toEqual({
      executed: true,
      agent: 'Invoice_Agent',
      version: 'v2',
      requested_status: 'Active',
      confirmed_status: 'Active',
    });
  });

  it('leaves out record values, messages, the snapshot block and the org\'s own retrieve and query texts', () => {
    const { markdown, json } = buildEvidence(input(fiveKinds()));
    const text = JSON.stringify(json);
    for (const out of [markdown, text]) {
      expect(out).not.toContain('Secret Value');
      expect(out).not.toContain(CODE);
    }
    // The type names of the failed stamp queries are kept; their reasons are not.
    expect(json.requests[0]!.live_check!.probe_failure_types).toEqual(['CustomLabel']);
    expect(markdown).toContain('stamp queries failed for: `CustomLabel`');
  });

  it('prints the provenance record once per request, never the approver hint', () => {
    const rows = [
      row({ id: '20000000-0000-4000-8000-000000000001', kind: 'apex' }),
      row({
        id: '20000000-0000-4000-8000-000000000002',
        kind: 'apex',
        summary: {
          governance: governance({
            justification: {
              text: 'Month-end close needs this.',
              source: 'page',
              surface: 'approval_page',
              edited_at: '2026-11-17T14:03:00.000Z',
              agent_draft: WHY,
            },
          }),
        },
      }),
      row({
        id: '20000000-0000-4000-8000-000000000003',
        kind: 'apex',
        summary: {
          governance: governance({
            justification: {
              text: '',
              source: 'page',
              surface: 'approval_page',
              edited_at: '2026-11-17T14:04:00.000Z',
              agent_draft: WHY,
            },
          }),
        },
      }),
      row({
        id: '20000000-0000-4000-8000-000000000004',
        kind: 'apex',
        summary: {
          governance: governance({
            justification: { text: WHY, source: 'agent', confirmed_at: '2026-11-17T14:05:00.000Z' },
          }),
        },
      }),
      row({ id: '20000000-0000-4000-8000-000000000005', kind: 'apex', summary: { governance: governance({ justification: null }) } }),
    ];
    const { markdown, json } = buildEvidence(input(rows));
    expect(json.requests.map((r) => r.justification.record)).toEqual([
      'Drafted by the agent and not edited by the human. Contrail does not record whether the approver read it.',
      "Typed on the approval page at 2026-11-17T14:03:00.000Z. It replaced the agent's draft, which follows.",
      "Cleared on the approval page at 2026-11-17T14:04:00.000Z; the agent's draft that was removed follows.",
      'Drafted by the agent; shown prefilled in Deploy Review and approved unchanged at 2026-11-17T14:05:00.000Z.',
      'None given.',
    ]);
    expect(json.requests[1]!.justification).toEqual({
      text: 'Month-end close needs this.',
      record: "Typed on the approval page at 2026-11-17T14:03:00.000Z. It replaced the agent's draft, which follows.",
      agent_draft: WHY,
    });
    expect(json.requests[2]!.justification.text).toBeNull();
    expect(json.requests[2]!.justification.agent_draft).toBe(WHY);
    expect(markdown.split('\n').filter((l) => l.startsWith('- Justification: '))).toHaveLength(5);
    expect(markdown).toContain("The agent's draft:\n\n```\n" + WHY + '\n```');
    for (const out of [markdown, JSON.stringify(json)]) {
      expect(out).not.toContain('from your conversation');
      expect(out).not.toContain('Edit it if');
    }
  });

  it('records the freeze at proposal and the emergency reason the human typed', () => {
    const reason = 'P1 outage: checkout is down for every customer.';
    const { markdown, json } = buildEvidence(
      input([
        row({
          kind: 'apex',
          summary: {
            governance: governance({
              freeze: { rule: 'year-end freeze', window: 'holidays', until: '2027-01-04 08:00 America/Toronto', time_zone: 'America/Toronto' },
              freeze_override: {
                reason,
                at: '2026-11-17T14:06:00.000Z',
                surface: 'approval_page',
                rule: 'year-end freeze',
                window: 'holidays',
              },
            }),
          },
        }),
      ]),
    );
    expect(json.requests[0]!.freeze_override).toEqual({
      reason,
      at: '2026-11-17T14:06:00.000Z',
      surface: 'approval_page',
      rule: 'year-end freeze',
      window: 'holidays',
    });
    expect(markdown).toContain(
      '- Freeze at proposal: rule `year-end freeze` · window `holidays` · until `2027-01-04 08:00 America/Toronto` · time zone `America/Toronto`',
    );
    expect(markdown).toContain(
      '- Freeze override: recorded 2026-11-17T14:06:00.000Z on the approval page · rule `year-end freeze` · window `holidays`. Emergency reason:\n\n```\n' +
        reason +
        '\n```',
    );
  });

  it('labels the Deploy Review decision comment by where it came from', () => {
    const decided = (id: string, comment_source: string | null) =>
      row({
        id,
        kind: 'apex',
        status: 'executed',
        decision: { state: 'approved', at: '2026-11-17T14:08:00.000Z', comment: `comment for ${id}`, comment_source },
      });
    const { markdown, json } = buildEvidence(
      input(
        [
          decided('30000000-0000-4000-8000-000000000001', 'agent_draft_unchanged'),
          decided('30000000-0000-4000-8000-000000000002', 'human_text_unchanged'),
          decided('30000000-0000-4000-8000-000000000003', 'typed'),
          decided('30000000-0000-4000-8000-000000000004', null),
        ],
        { surface: 'desktop' },
      ),
    );
    expect(json.requests.map((r) => r.decision!.comment_label)).toEqual([
      "comment (the agent's draft, approved unchanged)",
      'comment (typed on the approval page earlier, approved unchanged)',
      'comment (typed in Deploy Review)',
      'comment',
    ]);
    expect(markdown).toContain(
      "comment (the agent's draft, approved unchanged):\n\n```\ncomment for 30000000-0000-4000-8000-000000000001\n```",
    );
    expect(markdown).toContain(
      'comment (typed on the approval page earlier, approved unchanged):\n\n```\ncomment for 30000000-0000-4000-8000-000000000002\n```',
    );
    expect(markdown).toContain(
      'comment (typed in Deploy Review):\n\n```\ncomment for 30000000-0000-4000-8000-000000000003\n```',
    );
    expect(markdown).toContain('- Deploy Review decision: `approved` at 2026-11-17T14:08:00.000Z');
    expect(markdown).toContain('by Contrail 0.40.0 (desktop)');
  });

  describe('requests an older Contrail created or executed', () => {
    function one(r: EvidenceRow) {
      const built = buildEvidence(input([r]));
      return { md: built.markdown, entry: built.json.requests[0]! };
    }
    const summaryLine = (md: string) => md.split('\n').find((l) => l.startsWith('| `'))!;

    it('created before 0.40.0 and never executed: no page view, no policies, nothing re-checked', () => {
      const { md, entry } = one(
        row({
          kind: 'deploy',
          status: 'expired',
          target_at_proposal: null,
          summary: { changes: [], destructive: [], blast: [] },
        }),
      );
      expect(md).toContain(PAGE_VIEW_OLDER);
      expect(md).toContain(`- ${POLICY_OLDER}`);
      expect(md).toContain(`- ${EXECUTE_CHECK_NOT_RUN}`);
      expect(entry.policy_checks).toBe('none (older Contrail)');
      expect(summaryLine(md).endsWith('| none (older Contrail) |')).toBe(true);
      expect(md).toContain('- Policy checks: none (older Contrail)');
    });

    it('a page view missing beside a recorded policy says only that it was not recorded', () => {
      const { md, entry } = one(row({ kind: 'apex', summary: { governance: governance() } }));
      expect(md).toContain(PAGE_VIEW_MISSING);
      expect(md).not.toContain(PAGE_VIEW_OLDER);
      expect(entry.page_view_note).toBe(PAGE_VIEW_MISSING);
      expect(entry.policy_checks).toBe('proposal (not executed)');
    });

    it('created by an older Contrail and executed by 0.40: the execute record only', () => {
      const { md, entry } = one(
        row({
          kind: 'dml',
          status: 'executed',
          executed_at: '2026-11-17T14:20:00.000Z',
          target_at_proposal: null,
          target_at_execution: { org_id: PROD.org_id, username: PROD.username },
          summary: { governance: { v: 1, execute_check: EXECUTE_CHECK } },
        }),
      );
      expect(md).toContain(PAGE_VIEW_OLDER);
      expect(md).toContain(`- ${POLICY_OLDER}`);
      expect(md).not.toContain(EXECUTE_CHECK_OLDER);
      expect(md).toContain(
        '- Policy re-check at execution: 2026-11-17T14:09:59.000Z · rules: `acme needs a reason` · freeze in effect: no · emergency override: no',
      );
      expect(entry.policy_checks).toBe('execution only (created by an older Contrail)');
      expect(summaryLine(md).endsWith('| execution only (created by an older Contrail) |')).toBe(true);
    });

    it('executed without an execute record: an older Contrail executed it', () => {
      const { md, entry } = one(
        row({ kind: 'apex', status: 'executed', executed_at: '2026-11-17T14:30:00.000Z' }),
      );
      expect(md).toContain(`- ${EXECUTE_CHECK_OLDER}`);
      expect(entry.execute_check_note).toBe(EXECUTE_CHECK_OLDER);
      expect(entry.policy_checks).toBe('proposal only (executed by an older Contrail)');
      expect(summaryLine(md).endsWith('| proposal only (executed by an older Contrail) |')).toBe(true);
    });

    it('never executed: the re-check is not applicable', () => {
      const { md, entry } = one(row({ kind: 'apex', status: 'superseded' }));
      expect(md).toContain(`- ${EXECUTE_CHECK_NOT_RUN}`);
      expect(entry.policy_checks).toBe('proposal (not executed)');
      expect(summaryLine(md).endsWith('| proposal (not executed) |')).toBe(true);
    });

    it('proposed and executed by 0.40: both checks', () => {
      const { md, entry } = one(
        row({
          kind: 'apex',
          status: 'executed',
          executed_at: '2026-11-17T14:30:00.000Z',
          target_at_execution: { org_id: PROD.org_id, username: PROD.username },
          summary: { governance: governance({ execute_check: EXECUTE_CHECK }), page_view: pageView('apex', []) },
        }),
      );
      expect(entry.policy_checks).toBe('proposal + execution');
      expect(summaryLine(md).endsWith('| proposal + execution |')).toBe(true);
      expect(md).toContain(
        '- Policies at proposal: evaluated 2026-11-17T13:59:00.000Z · source `config` · fingerprint `' +
          'a'.repeat(64) +
          '` · rules: `acme needs a reason`',
      );
    });

    const refusedAt = (ts: string, reason: string, requestId = '11111111-1111-4111-8111-111111111111') => ({
      ts,
      event_type: 'policy.refused',
      tool: 'apex_execute',
      outcome: 'refused',
      detail: { phase: 'execute', requestId, kind: 'apex', reason },
    });

    it('an execute the re-check refused, never executed: the refusal is the re-check, not "not applicable"', () => {
      for (const status of ['validated', 'expired', 'superseded']) {
        const { md, entry } = one(
          row({
            kind: 'apex',
            status,
            events: [
              refusedAt('2026-11-17T14:20:00.000Z', 'freeze'),
              refusedAt('2026-11-17T14:25:00.000Z', 'violations'),
              {
                ts: '2026-11-17T14:30:00.000Z',
                event_type: 'apex.refused',
                tool: 'apex_execute',
                outcome: 'refused',
                detail: { requestId: '11111111-1111-4111-8111-111111111111', reason: 'no_matching_code' },
              },
            ],
          }),
        );
        expect(entry.execute_refusal, status).toEqual({ at: '2026-11-17T14:25:00.000Z', reason: 'violations' });
        expect(entry.execute_check_note).toBe(EXECUTE_CHECK_REFUSED);
        expect(md).toContain(
          '- Policy re-check at execution: refused at 2026-11-17T14:25:00.000Z (reason `violations`) — not executed.',
        );
        expect(md).not.toContain(EXECUTE_CHECK_NOT_RUN);
        expect(entry.policy_checks).toBe('proposal + execution (refused)');
        expect(summaryLine(md).endsWith('| proposal + execution (refused) |')).toBe(true);
        expect(md).toContain('- Policy checks: proposal + execution (refused)');
      }
    });

    it('a refused execute on a request an older Contrail created; one later executed keeps its re-check', () => {
      const older = one(
        row({
          kind: 'dml',
          status: 'expired',
          target_at_proposal: null,
          summary: {},
          events: [refusedAt('2026-11-17T14:20:00.000Z', 'freeze')],
        }),
      );
      expect(older.md).toContain(
        '- Policy re-check at execution: refused at 2026-11-17T14:20:00.000Z (reason `freeze`) — not executed.',
      );
      expect(older.entry.policy_checks).toBe('execution only (refused; created by an older Contrail)');

      const later = one(
        row({
          kind: 'apex',
          status: 'executed',
          executed_at: '2026-11-17T14:30:00.000Z',
          target_at_execution: { org_id: PROD.org_id, username: PROD.username },
          summary: { governance: governance({ execute_check: EXECUTE_CHECK }), page_view: pageView('apex', []) },
          events: [refusedAt('2026-11-17T14:20:00.000Z', 'freeze')],
        }),
      );
      expect(later.entry.execute_refusal).toBeNull();
      expect(later.entry.policy_checks).toBe('proposal + execution');
      expect(later.md).not.toContain('refused at');
    });

    it('a request created before 0.40.0 and released by an emergency reason keeps the reason in evidence.md', () => {
      const reason = 'P1 outage: checkout is down for every customer.';
      const { md, entry } = one(
        row({
          kind: 'deploy',
          status: 'validated',
          target_at_proposal: null,
          summary: {
            changes: [],
            governance: {
              v: 1,
              freeze_override: {
                reason,
                at: '2026-11-17T14:06:00.000Z',
                surface: 'deploy_review',
                rule: 'year-end freeze',
                window: 'holidays',
              },
            },
          },
        }),
      );
      expect(entry.policy_at_proposal).toBeNull();
      expect(md).toContain(`- ${POLICY_OLDER}`);
      expect(md).toContain(
        '- Freeze override: recorded 2026-11-17T14:06:00.000Z in Deploy Review · rule `year-end freeze` · ' +
          'window `holidays`. Emergency reason:\n\n```\n' +
          reason +
          '\n```',
      );
      expect(md).not.toContain('- Freeze at proposal');
      expect(md).not.toContain('- Freeze override: none.');
      // With neither a policy record nor an override, no freeze line at all — as before.
      const plain = one(row({ kind: 'deploy', status: 'expired', target_at_proposal: null, summary: {} }));
      expect(plain.md).not.toContain('Freeze');
    });
  });

  describe('the org result of a request with no stored result', () => {
    const orgResultOf = (md: string) => {
      const start = md.indexOf('### Org result\n');
      return md.slice(start, md.indexOf('\n### ', start + 1));
    };

    it('executing: the write may still be running or may have committed — check the org', () => {
      const { markdown } = buildEvidence(
        input([
          row({
            kind: 'deploy',
            status: 'executing',
            target_at_execution: { org_id: PROD.org_id, username: PROD.username },
            summary: { governance: governance({ execute_check: EXECUTE_CHECK }) },
            result: null,
          }),
        ]),
      );
      const section = orgResultOf(markdown);
      expect(section).toBe(`### Org result\n\n${ORG_RESULT_EXECUTING}\n`);
      expect(section).not.toContain('not executed');
      // The header line says the same: never "not executed" for a claimed request.
      expect(markdown).not.toContain('executed: not executed');
      expect(markdown).toContain(
        ' · executed: not recorded — claimed for execution, no outcome stored (see Org result)\n',
      );
    });

    it('executed or failed with no stored result: not recorded; never executed: none', () => {
      for (const status of ['executed', 'execution_failed']) {
        const { markdown } = buildEvidence(
          input([row({ kind: 'apex', status, executed_at: '2026-11-17T14:30:00.000Z', result: null })]),
        );
        expect(orgResultOf(markdown), status).toBe('### Org result\n\nNot recorded on this request.\n');
        // With no stored execution time, the header says not recorded, not "not executed".
        const noTime = buildEvidence(input([row({ kind: 'apex', status, executed_at: null, result: null })]));
        expect(noTime.markdown, status).toContain(' · executed: not recorded\n');
        expect(noTime.markdown, status).not.toContain('executed: not executed');
      }
      const { markdown } = buildEvidence(input([row({ kind: 'apex', status: 'expired', result: null })]));
      expect(orgResultOf(markdown)).toBe('### Org result\n\nNone — the request was not executed.\n');
      expect(markdown).toContain(' · executed: not executed\n');
    });
  });

  describe('the org and the acting user', () => {
    it('prints the identity recorded at proposal, not the connection as it is now', () => {
      const { markdown, json } = buildEvidence(
        input([
          row({
            kind: 'apex',
            connection_now: {
              alias: 'acme-prod',
              org_id: '00D000000000009AAA',
              org_name: 'Acme Renamed',
              org_type: 'production',
              username: 'someone-else@acme.example.invalid',
            },
          }),
        ]),
      );
      expect(markdown).toContain(
        '- Org and acting user at proposal: `acme-prod` · org `Acme` · org id `00D000000000001AAA` (`production`) · user `admin@acme.example.invalid`',
      );
      for (const out of [markdown, JSON.stringify(json)]) {
        expect(out).not.toContain('someone-else@acme.example.invalid');
        expect(out).not.toContain('Acme Renamed');
      }
      expect(json.requests[0]!.org_and_user.connection_now).toBeNull();
    });

    it('prints the execution identity beside it when it differs, and says so when it is the same', () => {
      const differs = buildEvidence(
        input([
          row({
            kind: 'apex',
            status: 'executed',
            target_at_execution: { org_id: PROD.org_id, username: 'deployer@acme.example.invalid' },
          }),
        ]),
      );
      expect(differs.markdown).toContain('- Org and acting user at proposal: `acme-prod`');
      expect(differs.markdown).toContain(
        '- Org and acting user at execution: org id `00D000000000001AAA` · user `deployer@acme.example.invalid`',
      );
      expect(differs.json.requests[0]!.org_and_user.at_execution_differs).toBe(true);
      const same = buildEvidence(
        input([
          row({
            kind: 'apex',
            status: 'executed',
            // The 15-character form of the same org id.
            target_at_execution: { org_id: PROD.org_id.slice(0, 15), username: PROD.username },
          }),
        ]),
      );
      expect(same.markdown).toContain('- Org and acting user at execution: the same org and user.');
      expect(same.json.requests[0]!.org_and_user.at_execution_differs).toBe(false);
    });

    it('a request with no recorded identity prints the connection as it is now, under its label', () => {
      const now = buildEvidence(
        input([row({ kind: 'deploy', target_at_proposal: null, summary: { changes: [], destructive: [] } })]),
      );
      expect(now.markdown).toContain(
        `- ${NOW_LABEL}: \`acme-prod\` · org \`Acme\` · org id \`00D000000000001AAA\` (\`production\`) · user \`admin@acme.example.invalid\``,
      );
      expect(now.json.requests[0]!.org_and_user.label).toBe(NOW_LABEL);
      const removed = buildEvidence(
        input([
          row({ kind: 'deploy', target_at_proposal: null, connection_now: null, summary: { changes: [], destructive: [] } }),
        ]),
      );
      expect(removed.markdown).toContain(`- ${NOW_LABEL}: connection removed`);
      expect(removed.markdown).toMatch(/^## Request `[0-9a-f-]+` — deploy on a connection that has been removed$/m);
    });
  });

  it('says in place where a list was cut', () => {
    const { markdown, json } = buildEvidence(
      input([row({ kind: 'apex', events_truncated: true })], {
        refusals_truncated: true,
        refusals: [
          {
            ts: '2026-11-17T13:00:00.000Z',
            event_type: 'policy.refused',
            tool: 'dml_propose',
            outcome: 'refused',
            detail: { phase: 'propose', kind: 'dml', reason: 'violations', ticket_given: false },
            connection: 'acme-prod',
          },
        ],
      }),
    );
    expect(markdown).toContain('Only the newest 1,000 audit events of this request are listed.');
    // True whatever was read: one connection or several, and refusal rows
    // that name a request (listed under it) among those read.
    expect(markdown).toContain(
      'The policy refusal list was cut: at most the newest 1,000 refusal rows per connection were read.',
    );
    expect(markdown).not.toContain('Only the newest 1,000 policy refusals');
    expect(json.truncated).toBe(true);
    expect(json.requests_truncated).toBe(false);
    expect(json.policy_refusals).toEqual([
      {
        ts: '2026-11-17T13:00:00.000Z',
        event_type: 'policy.refused',
        tool: 'dml_propose',
        outcome: 'refused',
        detail: { phase: 'propose', kind: 'dml', reason: 'violations' },
        connection: 'acme-prod',
      },
    ]);
    expect(json.requests_scan_cut).toBe(false);
    const MORE = 'More requests matched than this dossier lists: it holds the newest 200.';
    const SCAN =
      'The ticket search read only the newest 20,000 requests; an older request recorded with this ticket would not be listed.';
    const cut = buildEvidence(input([row({ kind: 'apex' })], { truncated: true }));
    expect(cut.markdown).toContain(MORE);
    expect(cut.markdown).not.toContain(SCAN);
    expect(cut.json.truncated).toBe(true);
    expect(cut.json.requests_truncated).toBe(true);
    expect(cut.json.requests_scan_cut).toBe(false);
    // A ticket scan that stopped at its row limit: Contrail knows only that it stopped.
    const scan = buildEvidence(
      input([row({ kind: 'apex' })], {
        scan_cut: true,
        filters: { connection: null, ticket: 'INV-5', request_id: null, since: null, until: null },
      }),
    );
    expect(scan.markdown).toContain(SCAN);
    expect(scan.markdown).not.toContain(MORE);
    expect(scan.json.truncated).toBe(true);
    expect(scan.json.requests_truncated).toBe(false);
    expect(scan.json.requests_scan_cut).toBe(true);
  });

  it('keeps target-check reasons as codes and writes its own notes: the org\'s error text stays out', () => {
    const executed = (id: string, kind: ApprovalPageOptions['kind'], target_check: Record<string, unknown>) =>
      row({
        id,
        kind,
        status: 'executed',
        executed_at: '2026-11-17T14:30:00.000Z',
        target_at_execution: { org_id: PROD.org_id, username: PROD.username },
        summary: { governance: governance({ execute_check: EXECUTE_CHECK }), page_view: pageView(kind, []) },
        result: { connection: 'acme-prod', executed: true, target_check },
      });
    const { markdown, json } = buildEvidence(
      input([
        // The fail-open branch: the reason is the failed read's message.
        executed('60000000-0000-4000-8000-000000000001', 'deploy', {
          status: 'unavailable',
          reason: 'INVALID_SESSION_ID: Secret Value session text',
          note:
            'Contrail could not re-read the org to confirm nothing had moved before executing ' +
            '(INVALID_SESSION_ID: Secret Value session text); this deploy ran against whatever the org held.',
        }),
        // The deadline: the guard's own sentence, kept.
        executed('60000000-0000-4000-8000-000000000002', 'dml', {
          status: 'unavailable',
          reason: 'the org did not answer within 15 s',
          note: 'Contrail could not re-read the org (the org did not answer within 15 s).',
        }),
        // A deploy validated with the live check unavailable: the note quotes the retrieve's message.
        executed('60000000-0000-4000-8000-000000000003', 'deploy', {
          status: 'not_checked',
          checked_at: '2026-11-17T14:29:59.000Z',
          checked: [],
          unchecked: [
            { type: 'ApexClass', api_name: 'Invoice_Service', reason: 'live_check_unavailable_no_org_clock' },
            { type: 'ApexClass', api_name: 'Invoice_Helper', reason: 'Secret Value in an unchecked reason' },
          ],
          note: 'No live baseline was captured (retrieve_failed:Secret Value retrieve text) and no org-side time.',
        }),
        executed('60000000-0000-4000-8000-000000000004', 'apex', {
          status: 'not_applicable',
          note: 'Secret Value stored note',
        }),
      ]),
    );
    const tc = json.requests.map((r) => r.target_check);
    expect(tc[0]).toEqual({
      status: 'unavailable',
      reason: "the org read failed (the message stays in Contrail's local database)",
      note:
        'Contrail could not re-read the org before executing to confirm nothing had moved, so this deploy ' +
        "went ahead without a target check; the approval page's diff may not describe what was overwritten.",
    });
    expect(tc[1]).toEqual({
      status: 'unavailable',
      reason: 'the org did not answer within 15 s',
      note:
        'Contrail could not re-read the org before executing to confirm nothing had moved, so this data change ' +
        "went ahead without a target check; the approval page's diff may not describe what was overwritten.",
    });
    expect(tc[2]).toEqual({
      status: 'not_checked',
      checked_at: '2026-11-17T14:29:59.000Z',
      checked: [],
      unchecked: [
        { type: 'ApexClass', api_name: 'Invoice_Service', reason: 'live_check_unavailable_no_org_clock' },
        {
          type: 'ApexClass',
          api_name: 'Invoice_Helper',
          reason: "free text, left out (it stays in Contrail's local database)",
        },
      ],
      note:
        'No member could be compared (each one is listed with its reason), so this write went ahead without ' +
        'a target check.',
    });
    expect(tc[3]).toEqual({
      status: 'not_applicable',
      note: 'An anonymous Apex script has no fixed org target to re-check.',
    });
    expect(markdown).toContain(
      "Reason and note:\n\n```\nthe org read failed (the message stays in Contrail's local database)\nContrail could not re-read",
    );
    for (const out of [markdown, JSON.stringify(json)]) {
      expect(out).not.toContain('Secret Value');
      expect(out).not.toContain('INVALID_SESSION_ID');
      expect(out).not.toContain('retrieve_failed');
    }
    // The same message on the fail-open audit row is reduced the same way.
    expect(
      reduceAuditDetail({
        requestId: '60000000-0000-4000-8000-000000000001',
        kind: 'deploy',
        reason: 'INVALID_SESSION_ID: Secret Value session text',
      }),
    ).toEqual({
      requestId: '60000000-0000-4000-8000-000000000001',
      kind: 'deploy',
      reason: "free text, left out (it stays in Contrail's local database)",
    });
    expect(reduceAuditDetail({ reason: 'the org did not answer within 15 s' })).toEqual({
      reason: 'the org did not answer within 15 s',
    });
    expect(reduceAuditDetail({ reason: 'no_baseline' })).toEqual({ reason: 'no_baseline' });
  });

  it('keeps only the allow-listed audit detail keys', () => {
    const detail = {
      requestId: '40000000-0000-4000-8000-000000000001',
      reason: 'no_baseline',
      error: 'Secret Value from the org',
      detail: 'free text from the re-read',
      governance: { ticket: 'INV-42', justification_chars: 72 },
      origin: 'execute',
      refreshed: 2,
      removed: 0,
      skipped: 1,
      units: ['ApexClass:Invoice_Service', 'CustomField:Invoice__c.Amount__c'],
      duration_ms: 1234,
      comment: 'Looks right.',
      comment_source: 'typed',
      some_future_key: 'Secret Value',
    };
    const reduced = reduceAuditDetail(detail);
    expect(reduced).toEqual({
      requestId: '40000000-0000-4000-8000-000000000001',
      reason: 'no_baseline',
      comment: 'Looks right.',
      comment_source: 'typed',
      origin: 'execute',
      refreshed: 2,
      removed: 0,
      skipped: 1,
      units: ['ApexClass:Invoice_Service', 'CustomField:Invoice__c.Amount__c'],
      duration_ms: 1234,
    });
    expect(EVIDENCE_DETAIL_KEYS).not.toContain('detail');
    expect(EVIDENCE_DETAIL_KEYS).not.toContain('error');
    const { markdown, json } = buildEvidence(
      input([
        row({
          kind: 'deploy',
          events: [
            {
              ts: '2026-11-17T14:11:00.000Z',
              event_type: 'snapshot.members_refreshed',
              tool: 'execute_deploy',
              outcome: 'success',
              detail,
            },
          ],
        }),
      ]),
    );
    expect(json.requests[0]!.audit_events[0]!.detail).toEqual(reduced);
    for (const out of [markdown, JSON.stringify(json)]) {
      expect(out).not.toContain('Secret Value');
      expect(out).not.toContain('free text from the re-read');
      expect(out).not.toContain('justification_chars');
    }
    expect(markdown).toContain('`snapshot.members_refreshed`');
  });

  it('Markdown safety: no stored or supplied value can change the structure of evidence.md', () => {
    const HOSTILE =
      'Typed on the approval page at 14:03.\n### Org result\n| forged | row | here |\n|---|---|---|\n' +
      'tick ` three ``` five ````` pipe | slash-pipe \\| <img src=x> ![x](https://example.invalid/p.png)';
    const EDGE = '`' + HOSTILE + '`';
    const fixture = (v: (field: string) => string): EvidenceInput => {
      const alias = v('alias');
      const identity = { ...PROD, alias, org_name: v('org_name') };
      return input(
        [
          row({
            id: '50000000-0000-4000-8000-000000000001',
            kind: 'deploy',
            status: 'executed',
            target_at_proposal: identity,
            target_at_execution: { org_id: PROD.org_id, username: PROD.username },
            connection_now: identity,
            decision: { state: 'approved', at: '2026-11-17T14:08:00.000Z', comment: v('comment'), comment_source: 'typed' },
            summary: {
              changes: [
                {
                  type: 'ApexClass',
                  api_name: 'Invoice_Service',
                  change: 'modify',
                  warnings: [],
                  pre_image: {
                    present: true,
                    source: 'retrieve',
                    sha256: 'b'.repeat(64),
                    last_modified_date: '2026-11-16T10:00:00.000Z',
                    last_modified_by: v('last_modified_by'),
                    comparable: true,
                    restorable: true,
                  },
                },
              ],
              destructive: [],
              governance: governance({
                target: identity,
                ticket: v('ticket'),
                justification: {
                  text: v('justification'),
                  source: 'page',
                  surface: 'approval_page',
                  edited_at: '2026-11-17T14:03:00.000Z',
                  agent_draft: v('agent_draft'),
                },
                freeze: { rule: 'year-end freeze', window: 'holidays', until: 'mon 08:00 UTC', time_zone: 'UTC' },
                freeze_override: {
                  reason: v('reason'),
                  at: '2026-11-17T14:06:00.000Z',
                  surface: 'approval_page',
                  rule: 'year-end freeze',
                  window: 'holidays',
                },
                execute_check: EXECUTE_CHECK,
              }),
              page_view: {
                v: 1,
                kind: 'deploy',
                org: { alias, org_name: v('org_name'), org_type: 'production', instance_url: 'https://acme.example.invalid' },
                expires_at: '2026-11-17T15:00:00.000Z',
                warnings: [v('warning')],
                destructive: [],
                changes: [{ label: v('row_label'), warnings: [v('warning')] }],
                automation: [
                  {
                    object: 'Invoice__c',
                    snapshot_at: null,
                    summary_lines: [v('automation')],
                    notes: [],
                    not_covered: [],
                  },
                ],
                automation_not_covered: [],
                results: [],
                blast: [],
              },
            },
          }),
          row({
            id: '50000000-0000-4000-8000-000000000002',
            kind: 'bulk',
            target_at_proposal: identity,
            connection_now: identity,
            events: [
              {
                ts: v('refused_at'),
                event_type: 'policy.refused',
                tool: 'bulk_load_execute',
                outcome: 'refused',
                detail: {
                  phase: 'execute',
                  requestId: '50000000-0000-4000-8000-000000000002',
                  kind: 'bulk',
                  reason: v('refusal_reason'),
                },
              },
            ],
            summary: {
              governance: governance({ target: identity, ticket: v('ticket_edge') }),
              page_view: {
                v: 1,
                kind: 'bulk',
                org: { alias, org_name: v('org_name'), org_type: 'production', instance_url: 'https://acme.example.invalid' },
                expires_at: '2026-11-17T15:00:00.000Z',
                warnings: [],
                destructive: [],
                changes: [{ label: 'STEP 1  INSERT Account — 2 rows', warnings: [], detail: `from ${v('file')}` }],
                automation: [],
                automation_not_covered: [],
                results: [],
                blast: [],
              },
            },
          }),
        ],
        { filters: { connection: alias, ticket: v('ticket'), request_id: null, since: null, until: null } },
      );
    };
    const hostile = buildEvidence(
      fixture((field) => (field === 'ticket_edge' ? EDGE : HOSTILE)),
    ).markdown;
    const plain = buildEvidence(fixture(() => 'x')).markdown;

    // Outside every span and fence, the two files are the same, byte for byte.
    expect(stripCode(hostile)).toBe(stripCode(plain));
    // Headings and table rows as a Markdown reader finds them: lines outside every fence.
    const outsideFences = (md: string) => {
      const found: string[] = [];
      let fence: string | null = null;
      for (const line of md.split('\n')) {
        if (fence !== null) {
          if (line === fence) fence = null;
        } else if (/^`{3,}$/.test(line)) {
          fence = line;
        } else {
          found.push(line);
        }
      }
      return found;
    };
    const headings = (md: string) => outsideFences(md).filter((l) => l.startsWith('#'));
    expect(headings(hostile)).toHaveLength(headings(plain).length);
    expect(headings(hostile).map(stripCode)).toEqual(headings(plain).map(stripCode));
    expect(headings(hostile).filter((h) => h === '### Org result')).toHaveLength(2);
    // Every table row splits into the same cells as the plain file's.
    const tableShape = (md: string) =>
      outsideFences(md)
        .filter((l) => l.startsWith('|'))
        .map(cellCount);
    expect(tableShape(hostile)).toEqual(tableShape(plain));
    // One provenance sentence per request, written by the builder.
    const provenance = (md: string) =>
      stripCode(md)
        .split('\n')
        .filter((l) => l.startsWith('- Justification: '));
    expect(provenance(hostile)).toEqual([
      "- Justification: Typed on the approval page at 2026-11-17T14:03:00.000Z. It replaced the agent's draft, which follows.",
      '- Justification: Drafted by the agent and not edited by the human. Contrail does not record whether the approver read it.',
    ]);
    expect(stripCode(hostile).match(/Typed on the approval page at/g)).toHaveLength(1);
    // The hostile text is all still there, inside a span or a fence.
    expect(hostile).toContain(mdBlock(HOSTILE));
    expect(hostile).toContain(`from ${HOSTILE}`);
    expect(hostile).toContain(mdCode(HOSTILE));
    expect(hostile).toContain(mdCode(EDGE));
    expect(hostile).toContain(mdCode(HOSTILE, { cell: true }));
    // A refused execute's time stays in a span; a reason that is not a code is left out.
    expect(hostile).toContain(
      `- Policy re-check at execution: refused at ${mdCode(HOSTILE)} (reason ` +
        `${mdCode("free text, left out (it stays in Contrail's local database)")}) — not executed.`,
    );
    expect(plain).toContain('- Policy re-check at execution: refused at `x` (reason `x`) — not executed.');
    // evidence.json holds the values as stored.
    const json = JSON.stringify(buildEvidence(fixture(() => HOSTILE)).json);
    expect(json).toContain(JSON.stringify(HOSTILE));
  });

  it('a stored time that is not ISO stays inside its table cell, a pipe in it included', () => {
    const BAD = 'not a date | 14:00';
    const fixture = (t: string): EvidenceInput =>
      input(
        [
          row({
            id: '60000000-0000-4000-8000-000000000001',
            kind: 'deploy',
            status: 'executed',
            created_at: t,
            executed_at: t,
            summary: {
              changes: [
                {
                  type: 'ApexClass',
                  api_name: 'Invoice_Service',
                  change: 'modify',
                  warnings: [],
                  pre_image: {
                    present: true,
                    source: 'retrieve',
                    sha256: 'b'.repeat(64),
                    last_modified_date: t,
                    last_modified_by: 'Dev User',
                    comparable: true,
                    restorable: true,
                  },
                },
              ],
              destructive: [],
              governance: governance(),
            },
            events: [{ ts: t, event_type: 'deploy.validated', tool: 'validate_deploy', outcome: 'success', detail: null }],
          }),
        ],
        {
          refusals: [
            {
              ts: t,
              event_type: 'policy.refused',
              tool: 'dml_propose',
              outcome: 'refused',
              detail: { phase: 'propose', kind: 'dml', reason: 'violations' },
              connection: 'acme-prod',
            },
          ],
        },
      );
    const tableRows = (md: string) => md.split('\n').filter((l) => l.startsWith('|'));
    const plain = tableRows(buildEvidence(fixture('2026-11-17T14:00:00.000Z')).markdown);
    const odd = tableRows(buildEvidence(fixture(BAD)).markdown);
    // Every table row splits into the same cells as with an ISO time.
    expect(odd.map(cellCount)).toEqual(plain.map(cellCount));
    const cell = mdCode(BAD, { cell: true });
    expect(cell).toBe('`not a date \\| 14:00`');
    // The summary row (proposed and executed), the pre-image row, the
    // request's audit row and the policy-refusal row.
    const holding = odd.filter((l) => l.includes(cell));
    expect(holding).toHaveLength(4);
    expect(holding[0]!.split(cell)).toHaveLength(3);
    for (const l of odd) expect(l).not.toContain(mdCode(BAD));
  });
});

describe('mdCode and mdBlock', () => {
  it('mdCode: one line, a delimiter longer than any run inside, padding at a backtick edge', () => {
    expect(mdCode('INV-42')).toBe('`INV-42`');
    expect(mdCode('a ` b')).toBe('``a ` b``');
    expect(mdCode('a ``` b ` c')).toBe('````a ``` b ` c````');
    expect(mdCode('`x`')).toBe('`` `x` ``');
    expect(mdCode('line\r\nbreak\tand\u0007bell')).toBe('`line break and bell`');
    expect(mdCode('', { empty: 'none given' })).toBe('none given');
    expect(mdCode('')).toBe('none');
  });

  it('mdCode in a table cell escapes every pipe so it pairs, a backslash before it included', () => {
    expect(mdCode('a | b', { cell: true })).toBe('`a \\| b`');
    expect(mdCode('a \\| b', { cell: true })).toBe('`a \\\\\\| b`');
    expect(mdCode('a \\\\| b', { cell: true })).toBe('`a \\\\\\| b`');
    expect(cellCount(`| ${mdCode('a \\| b', { cell: true })} | ${mdCode('c|d', { cell: true })} |`)).toBe(2);
    expect(mdCode('a | b')).toBe('`a | b`');
  });

  it('mdBlock: LF only, a fence no line inside can close', () => {
    expect(mdBlock('one\r\ntwo\rthree')).toBe('```\none\ntwo\nthree\n```');
    expect(mdBlock('has ``` inside\n`````')).toBe('``````\nhas ``` inside\n`````\n``````');
  });
});

// ── reading and writing ──────────────────────────────────────────────────

describe('evidencePayload and evidenceRequestOf', () => {
  it('reduce each payload to what the dossier may hold', () => {
    expect(evidencePayload('deploy', JSON.stringify({ testLevel: 'RunSpecifiedTests', runTests: ['InvoiceTest'] }))).toEqual({
      test_level: 'RunSpecifiedTests',
      run_tests: ['InvoiceTest'],
    });
    const script = "Account a = [SELECT Id FROM Account LIMIT 1];\r\nSystem.debug('Secret Value');";
    expect(evidencePayload('apex', JSON.stringify({ apex: true, code: script }))).toEqual({
      sha256: crypto.createHash('sha256').update(script).digest('hex'),
      lines: 2,
      chars: script.length,
    });
    expect(
      evidencePayload(
        'activation',
        JSON.stringify({
          activation: true,
          bot_developer_name: 'Invoice_Agent',
          bot_version_developer_name: 'v2',
          bot_version_id: '0X9000000000001AAA',
          from_status: 'Inactive',
          to_status: 'Active',
        }),
      ),
    ).toEqual({ agent: 'Invoice_Agent', version: 'v2', from: 'Inactive', to: 'Active' });
    expect(
      evidencePayload(
        'bulk',
        JSON.stringify({
          bulk: true,
          version: 1,
          stop_on_failure: false,
          steps: [
            {
              n: 1,
              object: 'Account',
              operation: 'insert',
              external_id_field: null,
              file: 'step-1.csv',
              display_name: 'Secret Value accounts.csv',
              sha256: 'e'.repeat(64),
              row_count: 2,
              headers: ['Name'],
              line_ending: 'LF',
              bytes: 20,
            },
          ],
        }),
      ),
    ).toEqual({
      steps: [{ n: 1, object: 'Account', operation: 'insert', row_count: 2, sha256: 'e'.repeat(64) }],
      stop_on_failure: false,
    });
    expect(
      evidencePayload(
        'dml',
        JSON.stringify({ operation: 'update', object: 'Account', records: [{ Id: '001000000000001AAA', Name: 'Secret Value' }] }),
      ),
    ).toEqual({ operations: [{ operation: 'update', object: 'Account', rows: 1 }] });
    expect(
      evidencePayload(
        'dml',
        JSON.stringify({
          plan: true,
          version: 2,
          all_or_none: true,
          steps: [
            { operation: 'insert', object: 'Account', record: { Name: 'Secret Value' }, ref: 'acct' },
            { operation: 'delete', object: 'Contact', id: '003000000000001AAA' },
          ],
        }),
      ),
    ).toEqual({
      operations: [
        { step: 1, operation: 'insert', object: 'Account', rows: 1 },
        { step: 2, operation: 'delete', object: 'Contact', rows: 1 },
      ],
    });
    expect(evidencePayload('dml', '{not json')).toBeNull();
  });

  it('maps a stored row by name and never reads its confirmation code', () => {
    const stored = {
      id: '60000000-0000-4000-8000-000000000001',
      workspaceId: 'default',
      connectionId: 'conn-1',
      kind: 'dml',
      status: 'validated',
      createdAt: '2026-11-17T14:00:00.000Z',
      expiresAt: '2026-11-17T15:00:00.000Z',
      executedAt: null,
      payloadPath: null,
      payloadJson: JSON.stringify({ operation: 'delete', object: 'Account', ids: ['001000000000001AAA'] }),
      summaryJson: JSON.stringify({ governance: governance(), before: { x: 'Secret Value' } }),
      validationId: null,
      resultJson: null,
    };
    Object.defineProperty(stored, 'confirmationCode', {
      enumerable: true,
      get() {
        throw new Error('the dossier read the confirmation code');
      },
    });
    const rec = evidenceRequestOf(stored);
    expect(Object.keys(rec).sort()).toEqual(
      [
        'connection_id',
        'created_at',
        'executed_at',
        'expires_at',
        'id',
        'kind',
        'payload',
        'result',
        'status',
        'summary',
        'validation_id',
      ].sort(),
    );
    expect(rec.payload).toEqual({ operations: [{ operation: 'delete', object: 'Account', rows: 1 }] });
    expect(rec.connection_id).toBe('conn-1');
  });
});

describe('exportChangeEvidence', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-evidence-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const NOW = Date.parse('2026-11-17T16:00:00.000Z');
  const CONNECTIONS: Record<string, EvidenceIdentity> = {
    'conn-prod': { ...PROD },
    'conn-uat': { ...PROD, alias: 'acme-uat', org_id: '00D000000000002AAA', org_type: 'sandbox' },
  };

  function record(i: number, over: Partial<EvidenceRequestRecord> = {}): EvidenceRequestRecord {
    return {
      id: `70000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      connection_id: 'conn-prod',
      kind: 'apex',
      status: 'validated',
      created_at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(),
      expires_at: '2026-12-01T00:00:00.000Z',
      executed_at: null,
      validation_id: null,
      summary: { governance: governance({ ticket: `T-${i}` }) },
      result: null,
      payload: null,
      ...over,
    };
  }

  /** An in-memory engine with the database's orderings, recording each query. */
  function fakeIo(requests: EvidenceRequestRecord[], audit: EvidenceAuditRow[] = []) {
    const calls = { requests: [] as Array<Record<string, unknown>>, audit: [] as Array<Record<string, unknown>> };
    const io: EvidenceIo = {
      queryRequests: (f) => {
        calls.requests.push({ ...f });
        return requests
          .filter(
            (r) =>
              (!f.connectionId || r.connection_id === f.connectionId) &&
              (!f.since || r.created_at >= f.since) &&
              (!f.until || r.created_at <= f.until) &&
              (!f.id || r.id === f.id),
          )
          .sort((a, b) =>
            a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1,
          )
          .slice(f.offset, f.offset + f.limit);
      },
      getConnection: (id) => CONNECTIONS[id] ?? null,
      queryAudit: (f) => {
        calls.audit.push({ ...f });
        return audit
          .filter(
            (e) =>
              (!f.connectionId || e.connection_id === f.connectionId) &&
              (!f.since || e.ts >= f.since) &&
              (!f.until || e.ts <= f.until) &&
              (!f.requestId || e.detail?.requestId === f.requestId) &&
              (!f.eventType ||
                (f.eventType.endsWith('.') ? e.event_type.startsWith(f.eventType) : e.event_type === f.eventType)),
          )
          .sort((a, b) => (a.ts < b.ts ? 1 : -1))
          .slice(0, f.limit);
      },
      policyStatus: () => ({ status: 'ok', source: 'config' }),
      evidenceDir: () => dir,
      now: () => NOW,
      engineVersion: '0.40.0',
      surface: 'plugin',
    };
    return { io, calls };
  }

  const prod = { id: 'conn-prod', alias: 'acme-prod' };

  it('refuses without a filter, a bad timestamp and an unknown request id; nothing matched writes nothing', () => {
    const { io } = fakeIo([record(1)]);
    expect(exportChangeEvidence(io, {})).toEqual({ status: 'refused', refusal: 'no_filter' });
    expect(exportChangeEvidence(io, { until: '2026-11-17T00:00:00Z' })).toEqual({
      status: 'refused',
      refusal: 'no_filter',
    });
    expect(exportChangeEvidence(io, { since: 'last tuesday' })).toEqual({
      status: 'refused',
      refusal: 'bad_timestamp',
      field: 'since',
      value: 'last tuesday',
    });
    expect(
      exportChangeEvidence(io, { connection: prod, request_id: '70000000-0000-4000-8000-000000000099' }),
    ).toEqual({
      status: 'refused',
      refusal: 'request_not_found',
      request_id: '70000000-0000-4000-8000-000000000099',
      connection: 'acme-prod',
    });
    expect(exportChangeEvidence(io, { ticket: 'NOPE-1' })).toEqual({ status: 'empty' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes evidence.json then evidence.md into a new folder named from the filters, never outside the evidence directory', () => {
    const { io } = fakeIo([record(1)]);
    const first = exportChangeEvidence(io, { connection: { id: 'conn-prod', alias: '../x' } });
    expect(first.status).toBe('written');
    if (first.status !== 'written') return;
    expect(first.folder).toBe('20261117-160000-x');
    expect(path.dirname(first.path)).toBe(dir);
    expect(fs.readdirSync(first.path).sort()).toEqual(['evidence.json', 'evidence.md']);
    const json = JSON.parse(fs.readFileSync(path.join(first.path, 'evidence.json'), 'utf8')) as {
      requests: unknown[];
      filters: { connection: string };
    };
    expect(json.requests).toHaveLength(1);
    expect(json.filters.connection).toBe('../x');
    expect(first).toMatchObject({
      files: ['evidence.md', 'evidence.json'],
      requests: 1,
      by_status: { validated: 1 },
      audit_events: 0,
      policy_refusals: 0,
      truncated: false,
    });
    // The same second, the same filters: the next free name.
    const second = exportChangeEvidence(io, { connection: { id: 'conn-prod', alias: '../x' } });
    expect(second.status === 'written' && second.folder).toBe('20261117-160000-x-2');
    const third = exportChangeEvidence(io, { connection: { id: 'conn-prod', alias: '../x' } });
    expect(third.status === 'written' && third.folder).toBe('20261117-160000-x-3');
    // A label with nothing usable left in it.
    const since = exportChangeEvidence(io, { since: '2025-01-01T00:00:00Z' });
    expect(since.status === 'written' && since.folder).toBe('20261117-160000-evidence');
    const long = exportChangeEvidence(io, { connection: prod, ticket: 'T-1', request_id: record(1).id });
    expect(long.status === 'written' && long.folder.length).toBeLessThanOrEqual('20261117-160000-'.length + 60);
  });

  it('keeps the newest 200 requests and says the list was cut', () => {
    const { io } = fakeIo(Array.from({ length: 201 }, (_, i) => record(i)));
    const res = exportChangeEvidence(io, { connection: prod });
    expect(res.status === 'written' && res.requests).toBe(200);
    expect(res.status === 'written' && res.truncated).toBe(true);
    if (res.status !== 'written') return;
    const json = JSON.parse(fs.readFileSync(path.join(res.path, 'evidence.json'), 'utf8')) as {
      requests: Array<{ id: string }>;
      requests_truncated: boolean;
      requests_scan_cut: boolean;
    };
    expect(json.requests_truncated).toBe(true);
    expect(json.requests_scan_cut).toBe(false);
    const md = fs.readFileSync(path.join(res.path, 'evidence.md'), 'utf8');
    expect(md).toContain('More requests matched than this dossier lists: it holds the newest 200.');
    expect(md).not.toContain('The ticket search read only');
    // Newest first: request 200 is in, request 0 is not.
    expect(json.requests[0]!.id).toBe(record(200).id);
    expect(json.requests.some((r) => r.id === record(0).id)).toBe(false);
  });

  it('a ticket search pages through the requests and finds a match far down the list, case-insensitively', () => {
    // 1,500 requests; the one recorded with the ticket is the 1,400th newest.
    const rows = Array.from({ length: 1500 }, (_, i) =>
      record(i, { summary: { governance: governance({ ticket: i === 100 ? 'INV-1400' : `OTHER-${i}` }) } }),
    );
    const { io, calls } = fakeIo(rows);
    const res = exportChangeEvidence(io, { ticket: 'inv-1400' });
    expect(res.status === 'written' && res.requests).toBe(1);
    expect(calls.requests.map((c) => c.offset)).toEqual([0, 1000]);
    expect(calls.requests.every((c) => c.limit === 1000)).toBe(true);
    expect(res.status === 'written' && res.truncated).toBe(false);
  });

  it('a ticket search stops after 20,000 requests and says so', () => {
    let served = 0;
    const { io } = fakeIo([]);
    io.queryRequests = (f) => {
      served += f.limit;
      return Array.from({ length: f.limit }, (_, i) =>
        record(f.offset + i, {
          id: `80000000-0000-4000-8000-${String(f.offset + i).padStart(12, '0')}`,
          summary: { governance: governance({ ticket: f.offset + i === 5 ? 'INV-5' : 'OTHER' }) },
        }),
      );
    };
    const res = exportChangeEvidence(io, { ticket: 'INV-5' });
    expect(served).toBe(20_000);
    expect(res.status === 'written' && res.requests).toBe(1);
    expect(res.status === 'written' && res.truncated).toBe(true);
    if (res.status !== 'written') return;
    // One match: the dossier says the scan stopped, never that more matched.
    const json = JSON.parse(fs.readFileSync(path.join(res.path, 'evidence.json'), 'utf8')) as {
      requests_truncated: boolean;
      requests_scan_cut: boolean;
    };
    expect(json.requests_truncated).toBe(false);
    expect(json.requests_scan_cut).toBe(true);
    const md = fs.readFileSync(path.join(res.path, 'evidence.md'), 'utf8');
    expect(md).toContain(
      'The ticket search read only the newest 20,000 requests; an older request recorded with this ticket would not be listed.',
    );
    expect(md).not.toContain('More requests matched');
  });

  it('lists policy refusals of the matched connections only, and a request-named refusal under its request', () => {
    const mine = record(1, { connection_id: 'conn-prod', summary: { governance: governance({ ticket: 'INV-9' }) } });
    const audit: EvidenceAuditRow[] = [
      {
        ts: '2026-11-17T10:00:00.000Z',
        event_type: 'policy.refused',
        connection_id: 'conn-prod',
        tool: 'dml_propose',
        outcome: 'refused',
        detail: { phase: 'propose', kind: 'dml', reason: 'violations' },
      },
      {
        ts: '2026-11-17T10:05:00.000Z',
        event_type: 'policy.refused',
        connection_id: 'conn-uat',
        tool: 'apex_propose',
        outcome: 'refused',
        detail: { phase: 'propose', kind: 'apex', reason: 'violations' },
      },
      {
        ts: '2026-11-17T10:10:00.000Z',
        event_type: 'policy.refused',
        connection_id: 'conn-prod',
        tool: 'execute_deploy',
        outcome: 'refused',
        detail: { phase: 'execute', requestId: mine.id, kind: 'apex', reason: 'freeze' },
      },
    ];
    const { io, calls } = fakeIo([mine], audit);
    const res = exportChangeEvidence(io, { ticket: 'INV-9' });
    expect(res.status === 'written' && res.policy_refusals).toBe(1);
    if (res.status !== 'written') return;
    const json = JSON.parse(fs.readFileSync(path.join(res.path, 'evidence.json'), 'utf8')) as {
      policy_refusals: Array<{ tool: string; connection: string }>;
      requests: Array<{ audit_events: Array<{ event_type: string; detail: { phase: string } }> }>;
    };
    expect(json.policy_refusals.map((r) => [r.tool, r.connection])).toEqual([['dml_propose', 'acme-prod']]);
    expect(json.requests[0]!.audit_events.map((e) => e.detail.phase)).toEqual(['execute']);
    // One refusal query, for the matched request's connection.
    expect(calls.audit.filter((c) => c.eventType === 'policy.refused').map((c) => c.connectionId)).toEqual([
      'conn-prod',
    ]);

    // A window with no connection named covers every connection.
    const window = exportChangeEvidence(io, { since: '2026-11-17T00:00:00Z' });
    expect(window.status === 'written' && window.policy_refusals).toBe(2);
    // Refusals alone still make a dossier.
    const { io: refusalsOnly } = fakeIo([], audit);
    const res2 = exportChangeEvidence(refusalsOnly, { connection: { id: 'conn-uat', alias: 'acme-uat' } });
    expect(res2.status === 'written' && res2.requests).toBe(0);
    expect(res2.status === 'written' && res2.policy_refusals).toBe(1);
  });

  it('a request with 1,000 audit events says its list was cut', () => {
    const r = record(1);
    const audit: EvidenceAuditRow[] = Array.from({ length: 1000 }, (_, i) => ({
      ts: new Date(Date.parse('2026-11-17T00:00:00.000Z') + i * 1000).toISOString(),
      event_type: 'approval.notified',
      connection_id: 'conn-prod',
      tool: 'apex_propose',
      outcome: 'success',
      detail: { requestId: r.id, method: 'pushover' },
    }));
    const { io } = fakeIo([r], audit);
    const res = exportChangeEvidence(io, { request_id: r.id });
    expect(res.status === 'written' && res.audit_events).toBe(1000);
    expect(res.status === 'written' && res.truncated).toBe(true);
    if (res.status !== 'written') return;
    const md = fs.readFileSync(path.join(res.path, 'evidence.md'), 'utf8');
    expect(md).toContain('Only the newest 1,000 audit events of this request are listed.');
  });

  it('a refusal list cut on one of two connections says what was read — true though more than 1,000 are listed', () => {
    const ticket = { summary: { governance: governance({ ticket: 'INV-7' }) } };
    const requests = [
      record(1, { connection_id: 'conn-prod', ...ticket }),
      record(2, { connection_id: 'conn-uat', ...ticket }),
    ];
    const refusal = (connection: string, i: number): EvidenceAuditRow => ({
      ts: new Date(Date.parse('2026-11-16T00:00:00.000Z') + i * 1000).toISOString(),
      event_type: 'policy.refused',
      connection_id: connection,
      tool: 'dml_propose',
      outcome: 'refused',
      detail: { phase: 'propose', kind: 'dml', reason: 'violations' },
    });
    const audit = [
      ...Array.from({ length: 1000 }, (_, i) => refusal('conn-prod', i)),
      ...Array.from({ length: 5 }, (_, i) => refusal('conn-uat', i)),
    ];
    const { io, calls } = fakeIo(requests, audit);
    const res = exportChangeEvidence(io, { ticket: 'INV-7' });
    expect(res.status === 'written' && res.policy_refusals).toBe(1005);
    if (res.status !== 'written') return;
    expect(
      calls.audit.filter((c) => c.eventType === 'policy.refused').map((c) => [c.connectionId, c.limit]),
    ).toEqual([
      ['conn-uat', 1000],
      ['conn-prod', 1000],
    ]);
    const json = JSON.parse(fs.readFileSync(path.join(res.path, 'evidence.json'), 'utf8')) as {
      policy_refusals_truncated: boolean;
    };
    expect(json.policy_refusals_truncated).toBe(true);
    const md = fs.readFileSync(path.join(res.path, 'evidence.md'), 'utf8');
    expect(md).toContain(
      'The policy refusal list was cut: at most the newest 1,000 refusal rows per connection were read.',
    );
    expect(md).not.toContain('Only the newest 1,000 policy refusals');
  });
});
