import { describe, expect, it } from 'vitest';
import {
  APPROVAL_NOTICES,
  DEFAULT_POLICIES,
  apexDeletesNote,
  dryRunPolicyNote,
  evaluatePolicies,
  freezeBannerText,
  freezeExecuteRefusalText,
  freezePageNotOpenedText,
  freezeProposeNote,
  freezeStartRefusalText,
  hostTimeZone,
  justificationProvenance,
  normalizeFreezeReason,
  normalizeJustification,
  normalizeTicket,
  parsePolicies,
  policyChangedText,
  policyInEffect,
  policyRefusalText,
  policyUnreadableText,
  unmatchedRuleText,
  unmatchedRules,
  type PolicyConfig,
  type PolicyContext,
  type PolicyRule,
} from '../core/policy.js';

// Invented fixtures only: acme-prod / acme-uat, org ids of zeros.
const ORG_15 = '00D000000000001';
const ORG_18 = '00D000000000001EAA';
const OTHER_ORG = '00D000000000002EAA';
const FRI_2026_11_20_1200Z = Date.UTC(2026, 10, 20, 12, 0);

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    orgType: 'production',
    alias: 'acme-prod',
    orgAliases: ['acme-prod'],
    orgId: ORG_18,
    kind: 'dml',
    destructive: false,
    testLevel: null,
    ticket: null,
    justification: null,
    now: FRI_2026_11_20_1200Z,
    hostTimeZone: 'UTC',
    ...over,
  };
}

function policies(...rules: PolicyRule[]): PolicyConfig {
  return { rules };
}

function parsed(raw: unknown): PolicyConfig {
  const r = parsePolicies(raw);
  if (!r.ok) throw new Error(`fixture did not parse: ${r.problem}`);
  return r.policies;
}

function problemOf(raw: unknown): string {
  const r = parsePolicies(raw);
  if (r.ok) throw new Error('expected a parse problem');
  return r.problem;
}

function frozenAt(rule: PolicyRule, now: number, hostZone = 'UTC'): ReturnType<typeof policyInEffect>['freeze'] {
  return policyInEffect(parsed({ rules: [rule] }), ctx({ now, hostTimeZone: hostZone })).freeze;
}

describe('matching', () => {
  it('the built-in rule matches production and unknown, never sandbox, developer or trial', () => {
    for (const orgType of ['production', 'unknown'] as const) {
      const v = evaluatePolicies(DEFAULT_POLICIES, ctx({ orgType }));
      expect(v.rules).toEqual(['default: production needs a justification']);
      expect(v.requirements.justification).toBe(true);
      expect(v.violations.map((x) => x.code)).toEqual(['justification_required']);
    }
    for (const orgType of ['sandbox', 'developer', 'trial'] as const) {
      const v = evaluatePolicies(DEFAULT_POLICIES, ctx({ orgType }));
      expect(v.rules).toEqual([]);
      expect(v.violations).toEqual([]);
      expect(v.lines).toEqual([]);
    }
    expect(
      evaluatePolicies(DEFAULT_POLICIES, ctx({ justification: 'Client asked to fix the invoice rounding today.' }))
        .violations,
    ).toEqual([]);
  });

  it('orgTypes ["production"] also matches an unknown-type connection, and no sandbox', () => {
    const p = policies({ name: 'prod', match: { orgTypes: ['production'] }, requireTicket: true });
    expect(policyInEffect(p, ctx({ orgType: 'unknown' })).rules).toEqual(['prod']);
    expect(policyInEffect(p, ctx({ orgType: 'production' })).rules).toEqual(['prod']);
    expect(policyInEffect(p, ctx({ orgType: 'sandbox' })).rules).toEqual([]);
    // An entry 'unknown' alone does not match production.
    const u = policies({ name: 'unknown only', match: { orgTypes: ['unknown'] }, requireTicket: true });
    expect(policyInEffect(u, ctx({ orgType: 'production' })).rules).toEqual([]);
  });

  it('match keys are ANDed; labels match case-insensitively, with * for any run of characters', () => {
    const p = policies({
      name: 'acme prod',
      match: { orgTypes: ['production'], connections: ['acme-prod'] },
      requireTicket: true,
    });
    expect(policyInEffect(p, ctx()).rules).toEqual(['acme prod']);
    expect(policyInEffect(p, ctx({ alias: 'ACME-PROD', orgAliases: ['ACME-PROD'] })).rules).toEqual(['acme prod']);
    expect(policyInEffect(p, ctx({ orgType: 'sandbox' })).rules).toEqual([]);
    expect(policyInEffect(p, ctx({ alias: 'globex-prod', orgAliases: ['globex-prod'] })).rules).toEqual([]);

    const wild = policies({ name: 'every acme', match: { connections: ['acme-*'] }, requireTicket: true });
    expect(policyInEffect(wild, ctx({ alias: 'acme-uat', orgAliases: ['acme-uat'] })).rules).toEqual(['every acme']);
    expect(policyInEffect(wild, ctx({ alias: 'ACME-', orgAliases: ['ACME-'] })).rules).toEqual(['every acme']);
    expect(policyInEffect(wild, ctx({ alias: 'xacme-uat', orgAliases: ['xacme-uat'] })).rules).toEqual([]);
    // Other regex characters in a label are literal.
    const dotted = policies({ name: 'dotted', match: { connections: ['acme.prod'] }, requireTicket: true });
    expect(policyInEffect(dotted, ctx({ alias: 'acmeXprod', orgAliases: ['acmeXprod'] })).rules).toEqual([]);
    expect(policyInEffect(dotted, ctx({ alias: 'acme.prod', orgAliases: ['acme.prod'] })).rules).toEqual(['dotted']);
  });

  it('org ids compare on their first 15 characters — a 15- and an 18-character id are one org', () => {
    const by15 = policies({ name: 'by 15', match: { orgIds: [ORG_15] }, requireTicket: true });
    const by18 = policies({ name: 'by 18', match: { orgIds: [ORG_18] }, requireTicket: true });
    expect(policyInEffect(by15, ctx({ orgId: ORG_18 })).rules).toEqual(['by 15']);
    expect(policyInEffect(by18, ctx({ orgId: ORG_15 })).rules).toEqual(['by 18']);
    expect(policyInEffect(by18, ctx({ orgId: OTHER_ORG })).rules).toEqual([]);
    expect(policyInEffect(by18, ctx({ orgId: null })).rules).toEqual([]);
  });

  it('a second label for the same org inherits a label rule through orgAliases', () => {
    const p = policies({ name: 'acme label', match: { connections: ['acme-prod'] }, requireJustification: true });
    const second = ctx({ alias: 'acme-prod-2', orgAliases: ['acme-prod-2', 'acme-prod'] });
    const v = evaluatePolicies(p, second);
    expect(v.rules).toEqual(['acme label']);
    // The text names the connection being proposed on.
    expect(v.violations[0]!.text).toContain('every change to "acme-prod-2"');
    expect(policyInEffect(p, ctx({ alias: 'acme-prod-2', orgAliases: ['acme-prod-2'] })).rules).toEqual([]);
  });

  it('a rule with no match applies to every connection', () => {
    const p = policies({ name: 'everywhere', requireTicket: true });
    for (const orgType of ['production', 'sandbox', 'developer', 'trial', 'unknown'] as const) {
      expect(policyInEffect(p, ctx({ orgType })).rules).toEqual(['everywhere']);
    }
  });

  it('unmatchedRules lists label and org-id rules no stored connection satisfies, never an orgTypes-only rule', () => {
    const p = policies(
      { name: 'old label', match: { connections: ['acme-old'] }, requireTicket: true },
      { name: 'gone org', match: { orgIds: [OTHER_ORG] }, requireTicket: true },
      { name: 'by type', match: { orgTypes: ['production'] }, requireTicket: true },
      { name: 'everywhere', requireTicket: true },
      { name: 'live label', match: { connections: ['acme-*'] }, requireTicket: true },
      { name: 'live org', match: { orgIds: [ORG_15] }, requireTicket: true },
      { name: 'label and org', match: { connections: ['acme-uat'], orgIds: [ORG_18] }, requireTicket: true },
    );
    const conns = [{ alias: 'acme-prod', orgId: ORG_18 }];
    expect(unmatchedRules(p, conns)).toEqual(['old label', 'gone org', 'label and org']);
    // A second connection to the same org under the label satisfies the label rule;
    // a rule with both matchers needs one org that satisfies both.
    expect(unmatchedRules(p, [...conns, { alias: 'acme-old', orgId: ORG_15 }])).toEqual([
      'gone org',
      'label and org',
    ]);
    expect(unmatchedRules(p, [...conns, { alias: 'acme-uat', orgId: ORG_15 }])).toEqual(['old label', 'gone org']);
    expect(unmatchedRules(p, [...conns, { alias: 'acme-uat', orgId: OTHER_ORG }])).toEqual([
      'old label',
      'label and org',
    ]);
    expect(unmatchedRules(p, [])).toEqual(['old label', 'gone org', 'live label', 'live org', 'label and org']);
    expect(unmatchedRules(DEFAULT_POLICIES, [])).toEqual([]);
  });
});

describe('union, strictest wins', () => {
  it('two rules: booleans OR, both ticket patterns enforced, the highest minTestLevel', () => {
    const p = policies(
      { name: 'tracker', ticketPattern: 'ACME-\\d+', minTestLevel: 'RunSpecifiedTests' },
      { name: 'change board', ticketPattern: '[A-Z]+-\\d{3}', minTestLevel: 'RunLocalTests', requireTicket: true },
    );
    const inEffect = policyInEffect(p, ctx());
    expect(inEffect.requirements).toEqual({
      justification: false,
      ticket: true,
      ticketPatterns: ['ACME-\\d+', '[A-Z]+-\\d{3}'],
      denyDestructiveMetadata: false,
      denyDataDeletes: false,
      denyAnonymousApex: false,
      minTestLevel: 'RunLocalTests',
    });
    // Matches the first pattern, not the second (four digits).
    const v = evaluatePolicies(p, ctx({ kind: 'deploy', testLevel: 'RunLocalTests', ticket: 'ACME-1234' }));
    expect(v.violations.map((x) => [x.code, x.rule])).toEqual([['ticket_pattern', 'change board']]);
    expect(evaluatePolicies(p, ctx({ kind: 'deploy', testLevel: 'RunLocalTests', ticket: 'ACME-123' })).violations).toEqual([]);
    // Neither matches: one violation per pattern.
    expect(
      evaluatePolicies(p, ctx({ kind: 'deploy', testLevel: 'RunLocalTests', ticket: 'nope' })).violations.map((x) => x.rule),
    ).toEqual(['tracker', 'change board']);
    // The minimum is the highest of the two, and is named by its rule.
    const weak = evaluatePolicies(p, ctx({ kind: 'deploy', testLevel: 'RunSpecifiedTests', ticket: 'ACME-123' }));
    expect(weak.violations.map((x) => [x.code, x.rule])).toEqual([['min_test_level', 'change board']]);
  });

  it('lists every matched rule in config order, and the lines of each', () => {
    const p = parsed({
      rules: [
        { name: 'r1', requireJustification: true, requireTicket: true, ticketPattern: 'T-\\d+' },
        {
          name: 'r2',
          denyDestructiveMetadata: true,
          denyDataDeletes: true,
          denyAnonymousApex: true,
          minTestLevel: 'RunLocalTests',
          freezeWindows: [
            { name: 'Weekend', weekly: { from: 'fri 17:00', to: 'mon 08:00' }, timeZone: 'America/Toronto' },
            { name: 'Holidays', range: { from: '2026-12-19T17:00', to: '2027-01-04T08:00' } },
          ],
        },
      ],
    });
    const e = policyInEffect(p, ctx({ hostTimeZone: 'Asia/Tokyo' }));
    expect(e.rules).toEqual(['r1', 'r2']);
    expect(e.lines).toEqual([
      'A justification is required (rule "r1").',
      'A ticket is required (rule "r1").',
      'A ticket, when given, must match T-\\d+ (rule "r1").',
      'Destructive metadata changes are denied (rule "r2").',
      'Data deletes through dml_propose and bulk_load_propose are denied (rule "r2"); anonymous Apex is not inspected.',
      'Anonymous Apex is denied (rule "r2").',
      'Deploys need test_level RunLocalTests or stricter, passed explicitly (rule "r2").',
      'Freeze window "Weekend": every fri 17:00 to mon 08:00 America/Toronto (rule "r2").',
      'Freeze window "Holidays": 2026-12-19 17:00 to 2027-01-04 08:00 Asia/Tokyo (rule "r2").',
    ]);
    expect(e.windows).toEqual([
      { rule: 'r2', name: 'Weekend', when: 'every fri 17:00 to mon 08:00', timeZone: 'America/Toronto' },
      { rule: 'r2', name: 'Holidays', when: '2026-12-19 17:00 to 2027-01-04 08:00', timeZone: 'Asia/Tokyo' },
    ]);
  });
});

describe('violations', () => {
  const T = (rule: PolicyRule, over: Partial<PolicyContext>) =>
    evaluatePolicies(policies(rule), ctx(over)).violations;

  it('each violation text, verbatim', () => {
    expect(T({ name: 'J', requireJustification: true }, {})).toEqual([
      {
        code: 'justification_required',
        rule: 'J',
        text: 'policy rule "J" requires a justification for every change to "acme-prod" — pass justification: one or two sentences, drafted from what the human asked for, on why this change is being made now',
      },
    ]);
    expect(T({ name: 'T', requireTicket: true }, { justification: '   ' })).toEqual([
      {
        code: 'ticket_required',
        rule: 'T',
        text: 'policy rule "T" requires a ticket for every change to "acme-prod" — pass ticket with the reference the human gave you; if they gave none, ask them (never invent one)',
      },
    ]);
    expect(T({ name: 'P', ticketPattern: 'ACME-\\d+' }, { ticket: 'acme 12' })).toEqual([
      {
        code: 'ticket_pattern',
        rule: 'P',
        text: 'policy rule "P" requires the ticket to match ACME-\\d+ — "acme 12" does not; ask the human for the correct reference (never adjust one to fit)',
      },
    ]);
    expect(T({ name: 'D', denyDestructiveMetadata: true }, { kind: 'deploy', destructive: true, testLevel: 'RunLocalTests' })).toEqual([
      {
        code: 'destructive_metadata_denied',
        rule: 'D',
        text: 'policy rule "D" denies destructive metadata changes on "acme-prod" — this package contains deletions',
      },
    ]);
    expect(T({ name: 'X', denyDataDeletes: true }, { kind: 'dml', destructive: true })).toEqual([
      {
        code: 'data_deletes_denied',
        rule: 'X',
        text: 'policy rule "X" denies data deletes on "acme-prod" — this data change deletes records',
      },
    ]);
    expect(T({ name: 'X', denyDataDeletes: true }, { kind: 'bulk', destructive: true })).toEqual([
      {
        code: 'data_deletes_denied',
        rule: 'X',
        text: 'policy rule "X" denies data deletes on "acme-prod" — this bulk plan deletes records',
      },
    ]);
    expect(T({ name: 'A', denyAnonymousApex: true }, { kind: 'apex' })).toEqual([
      { code: 'anonymous_apex_denied', rule: 'A', text: 'policy rule "A" denies anonymous Apex on "acme-prod"' },
    ]);
    expect(T({ name: 'L', minTestLevel: 'RunLocalTests' }, { kind: 'deploy', testLevel: 'RunSpecifiedTests' })).toEqual([
      {
        code: 'min_test_level',
        rule: 'L',
        text: 'policy rule "L" requires test_level RunLocalTests or stricter on "acme-prod" — RunSpecifiedTests is weaker (weakest to strictest: NoTestRun, RunSpecifiedTests, RunLocalTests, RunAllTestsInOrg)',
      },
    ]);
    expect(T({ name: 'L', minTestLevel: 'RunLocalTests' }, { kind: 'deploy', testLevel: null })).toEqual([
      {
        code: 'min_test_level',
        rule: 'L',
        text: "policy rule \"L\" requires test_level RunLocalTests or stricter on \"acme-prod\" — test_level was omitted, which leaves the choice to the org's own default, so Contrail cannot show the minimum is met; pass test_level explicitly",
      },
    ]);
  });

  it('a minimum test level: equal or stricter passes; it applies to deploys only', () => {
    const rule: PolicyRule = { name: 'L', minTestLevel: 'RunLocalTests' };
    expect(T(rule, { kind: 'deploy', testLevel: 'RunLocalTests' })).toEqual([]);
    expect(T(rule, { kind: 'deploy', testLevel: 'RunAllTestsInOrg' })).toEqual([]);
    expect(T(rule, { kind: 'deploy', testLevel: 'NoTestRun' }).map((v) => v.code)).toEqual(['min_test_level']);
    for (const kind of ['dml', 'apex', 'bulk', 'activation'] as const) expect(T(rule, { kind })).toEqual([]);
  });

  it('ticketPattern is tested against the whole trimmed ticket', () => {
    const rule: PolicyRule = { name: 'P', ticketPattern: 'ACME-\\d+' };
    expect(T(rule, { ticket: 'ACME-12' })).toEqual([]);
    expect(T(rule, { ticket: '  ACME-12  ' })).toEqual([]);
    expect(T(rule, { ticket: 'xACME-12' }).map((v) => v.code)).toEqual(['ticket_pattern']);
    expect(T(rule, { ticket: 'ACME-12x' }).map((v) => v.code)).toEqual(['ticket_pattern']);
    // An alternation is anchored as a whole, not per branch.
    const alt: PolicyRule = { name: 'alt', ticketPattern: 'A-\\d+|B-\\d+' };
    expect(T(alt, { ticket: 'B-7' })).toEqual([]);
    expect(T(alt, { ticket: 'A-7 B-7' }).map((v) => v.code)).toEqual(['ticket_pattern']);
  });

  it('a ticket test that runs too long counts as not matching, in well under a second', () => {
    // A repeated group inside a repetition: unbounded, this backtracks for hours.
    const nested: PolicyRule = { name: 'nested', ticketPattern: '([A-Z0-9]+-?)+' };
    const started = Date.now();
    expect(T(nested, { ticket: 'A'.repeat(40) + 'x' })).toEqual([
      {
        code: 'ticket_pattern',
        rule: 'nested',
        text: `policy rule "nested" requires the ticket to match ([A-Z0-9]+-?)+ — "${'A'.repeat(40)}x" does not; ask the human for the correct reference (never adjust one to fit)`,
      },
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
    // A ticket the same pattern matches quickly still passes.
    expect(T(nested, { ticket: 'ACME-12' })).toEqual([]);
  });

  it('a supplied ticket that fails the pattern violates even when no ticket is required; none supplied passes', () => {
    const rule: PolicyRule = { name: 'P', ticketPattern: 'ACME-\\d+' };
    expect(T(rule, { ticket: 'WRONG' }).map((v) => v.code)).toEqual(['ticket_pattern']);
    expect(T(rule, { ticket: null })).toEqual([]);
    expect(T(rule, { ticket: '' })).toEqual([]);
  });

  it('denyDataDeletes touches dml and bulk deletes only, never apex; denyAnonymousApex refuses every apex proposal', () => {
    const deletes: PolicyRule = { name: 'X', denyDataDeletes: true };
    expect(T(deletes, { kind: 'apex', destructive: true })).toEqual([]);
    expect(T(deletes, { kind: 'dml', destructive: false })).toEqual([]);
    expect(T(deletes, { kind: 'deploy', destructive: true, testLevel: 'RunLocalTests' })).toEqual([]);
    expect(T(deletes, { kind: 'dml', destructive: true }).map((v) => v.code)).toEqual(['data_deletes_denied']);
    const apex: PolicyRule = { name: 'A', denyAnonymousApex: true };
    expect(T(apex, { kind: 'apex', destructive: false }).map((v) => v.code)).toEqual(['anonymous_apex_denied']);
    expect(T(apex, { kind: 'dml' })).toEqual([]);
    const meta: PolicyRule = { name: 'D', denyDestructiveMetadata: true };
    expect(T(meta, { kind: 'dml', destructive: true })).toEqual([]);
    expect(T(meta, { kind: 'deploy', destructive: false })).toEqual([]);
  });

  it('violations come in a fixed order: justification, ticket, pattern, deny rules, test level', () => {
    const rule: PolicyRule = {
      name: 'all',
      requireJustification: true,
      requireTicket: true,
      denyDestructiveMetadata: true,
      minTestLevel: 'RunLocalTests',
    };
    expect(T(rule, { kind: 'deploy', destructive: true }).map((v) => v.code)).toEqual([
      'justification_required',
      'ticket_required',
      'destructive_metadata_denied',
      'min_test_level',
    ]);
  });
});

describe('freeze windows', () => {
  const weekend: PolicyRule = {
    name: 'weekend freeze',
    freezeWindows: [{ name: 'Weekend', weekly: { from: 'fri 17:00', to: 'mon 08:00' }, timeZone: 'UTC' }],
  };

  it('weekly: inside, outside, and the boundary minutes (from inclusive, to exclusive)', () => {
    expect(frozenAt(weekend, Date.UTC(2026, 10, 21, 12, 0))).toEqual({
      rule: 'weekend freeze',
      window: 'Weekend',
      until: 'mon 08:00 UTC',
      timeZone: 'UTC',
    });
    expect(frozenAt(weekend, Date.UTC(2026, 10, 18, 12, 0))).toBeNull(); // Wednesday
    expect(frozenAt(weekend, Date.UTC(2026, 10, 20, 16, 59))).toBeNull(); // Fri 16:59
    expect(frozenAt(weekend, Date.UTC(2026, 10, 20, 17, 0))).not.toBeNull(); // Fri 17:00
    expect(frozenAt(weekend, Date.UTC(2026, 10, 23, 7, 59))).not.toBeNull(); // Mon 07:59
    expect(frozenAt(weekend, Date.UTC(2026, 10, 23, 8, 0))).toBeNull(); // Mon 08:00
  });

  it('weekly: a window wraps across the end of Sunday', () => {
    expect(frozenAt(weekend, Date.UTC(2026, 10, 22, 23, 59))).not.toBeNull(); // Sun 23:59
    expect(frozenAt(weekend, Date.UTC(2026, 10, 23, 0, 0))).not.toBeNull(); // Mon 00:00
    const night: PolicyRule = {
      name: 'night',
      freezeWindows: [{ name: 'Sunday night', weekly: { from: 'sun 22:00', to: 'mon 02:00' }, timeZone: 'UTC' }],
    };
    expect(frozenAt(night, Date.UTC(2026, 10, 22, 23, 30))).not.toBeNull();
    expect(frozenAt(night, Date.UTC(2026, 10, 23, 1, 0))).not.toBeNull();
    expect(frozenAt(night, Date.UTC(2026, 10, 23, 2, 0))).toBeNull();
    expect(frozenAt(night, Date.UTC(2026, 10, 22, 21, 59))).toBeNull();
  });

  it('the same instant in two zones gives different answers', () => {
    const inZone = (zone: string): PolicyRule => ({
      name: 'z',
      freezeWindows: [{ name: 'Weekend', weekly: { from: 'fri 17:00', to: 'mon 08:00' }, timeZone: zone }],
    });
    const fri2000Z = Date.UTC(2026, 10, 20, 20, 0);
    expect(frozenAt(inZone('UTC'), fri2000Z)).not.toBeNull(); // Fri 20:00 UTC
    expect(frozenAt(inZone('America/Toronto'), fri2000Z)).toBeNull(); // Fri 15:00 in Toronto
    expect(frozenAt(inZone('America/Toronto'), fri2000Z)?.until ?? 'mon 08:00 America/Toronto').toBe(
      'mon 08:00 America/Toronto',
    );
  });

  it('wall-clock across the spring-forward and fall-back instants in America/Toronto', () => {
    // 2026-03-08 02:00 EST → 03:00 EDT (07:00Z).
    const spring: PolicyRule = {
      name: 's',
      freezeWindows: [{ name: 'early', weekly: { from: 'sun 02:30', to: 'sun 03:30' }, timeZone: 'America/Toronto' }],
    };
    expect(frozenAt(spring, Date.UTC(2026, 2, 8, 7, 10))).not.toBeNull(); // 03:10 EDT
    expect(frozenAt(spring, Date.UTC(2026, 2, 8, 6, 50))).toBeNull(); // 01:50 EST
    expect(frozenAt(spring, Date.UTC(2026, 2, 8, 7, 40))).toBeNull(); // 03:40 EDT
    // 2026-11-01 02:00 EDT → 01:00 EST (06:00Z): 01:30 happens twice.
    const fall: PolicyRule = {
      name: 'f',
      freezeWindows: [{ name: 'small hours', weekly: { from: 'sun 01:00', to: 'sun 02:00' }, timeZone: 'America/Toronto' }],
    };
    expect(frozenAt(fall, Date.UTC(2026, 10, 1, 5, 30))).not.toBeNull(); // 01:30 EDT
    expect(frozenAt(fall, Date.UTC(2026, 10, 1, 6, 30))).not.toBeNull(); // 01:30 EST
    expect(frozenAt(fall, Date.UTC(2026, 10, 1, 7, 10))).toBeNull(); // 02:10 EST
  });

  it('range: local wall-clock, half-open, and its until string', () => {
    const holidays: PolicyRule = {
      name: 'holidays',
      freezeWindows: [{ name: 'Holidays', range: { from: '2026-12-19T17:00', to: '2027-01-04T08:00' }, timeZone: 'UTC' }],
    };
    expect(frozenAt(holidays, Date.UTC(2026, 11, 19, 16, 59))).toBeNull();
    expect(frozenAt(holidays, Date.UTC(2026, 11, 19, 17, 0))).toEqual({
      rule: 'holidays',
      window: 'Holidays',
      until: '2027-01-04 08:00 UTC',
      timeZone: 'UTC',
    });
    expect(frozenAt(holidays, Date.UTC(2027, 0, 4, 7, 59))).not.toBeNull();
    expect(frozenAt(holidays, Date.UTC(2027, 0, 4, 8, 0))).toBeNull();
    const toronto: PolicyRule = {
      name: 'holidays',
      freezeWindows: [{ name: 'Holidays', range: { from: '2026-12-19T17:00', to: '2027-01-04T08:00' }, timeZone: 'America/Toronto' }],
    };
    // 2026-12-19 17:00 UTC is 12:00 in Toronto: not yet.
    expect(frozenAt(toronto, Date.UTC(2026, 11, 19, 17, 0))).toBeNull();
    expect(frozenAt(toronto, Date.UTC(2026, 11, 19, 22, 0))?.until).toBe('2027-01-04 08:00 America/Toronto');
  });

  it('a window with no timeZone uses the host zone from the context', () => {
    const fridayHour: PolicyRule = {
      name: 'hostzone',
      freezeWindows: [{ name: 'Friday 17h', weekly: { from: 'fri 17:00', to: 'fri 18:00' } }],
    };
    const at = Date.UTC(2026, 10, 20, 8, 30); // 17:30 in Tokyo, 08:30 UTC
    expect(frozenAt(fridayHour, at, 'Asia/Tokyo')).toEqual({
      rule: 'hostzone',
      window: 'Friday 17h',
      until: 'fri 18:00 Asia/Tokyo',
      timeZone: 'Asia/Tokyo',
    });
    expect(frozenAt(fridayHour, at, 'UTC')).toBeNull();
    expect(typeof hostTimeZone()).toBe('string');
    expect(hostTimeZone().length).toBeGreaterThan(0);
  });

  it('of the active windows, the one with the most time left is named; ties keep config order', () => {
    // Both end at Saturday 00:00: a tie, so the first in config order.
    const tie = parsed({
      rules: [
        { name: 'first', freezeWindows: [{ name: 'A', weekly: { from: 'fri 00:00', to: 'sat 00:00' }, timeZone: 'UTC' }] },
        { name: 'second', freezeWindows: [{ name: 'B', weekly: { from: 'thu 00:00', to: 'sat 00:00' }, timeZone: 'UTC' }] },
      ],
    });
    expect(policyInEffect(tie, ctx()).freeze?.rule).toBe('first');
    // A freeze is reported by policyInEffect, never as a violation.
    expect(evaluatePolicies(tie, ctx()).violations).toEqual([]);
    // The later window in config order ends later: it is named.
    const later = parsed({
      rules: [
        { name: 'first', freezeWindows: [{ name: 'A', weekly: { from: 'fri 00:00', to: 'sat 00:00' }, timeZone: 'UTC' }] },
        { name: 'second', freezeWindows: [{ name: 'B', weekly: { from: 'thu 00:00', to: 'sun 00:00' }, timeZone: 'UTC' }] },
      ],
    });
    expect(policyInEffect(later, ctx()).freeze).toEqual({
      rule: 'second',
      window: 'B',
      until: 'sun 00:00 UTC',
      timeZone: 'UTC',
    });
    // A window whose zone cannot be read stays active with no known end, so
    // it is named; among such windows the first in config order.
    const unreadable = policies(
      { name: 'readable', freezeWindows: [{ name: 'A', weekly: { from: 'fri 00:00', to: 'sat 00:00' }, timeZone: 'UTC' }] },
      {
        name: 'unreadable',
        freezeWindows: [
          { name: 'X', weekly: { from: 'mon 00:00', to: 'tue 00:00' }, timeZone: 'Mars/Olympus' },
          { name: 'Y', weekly: { from: 'mon 00:00', to: 'tue 00:00' }, timeZone: 'Mars/Olympus' },
        ],
      },
    );
    expect(policyInEffect(unreadable, ctx()).freeze).toMatchObject({ rule: 'unreadable', window: 'X' });
  });

  it('the Getting Started example: the year-end close is named over a weekend inside it', () => {
    const example = parsed({
      rules: [
        {
          name: 'default: production needs a justification',
          match: { orgTypes: ['production', 'unknown'] },
          requireJustification: true,
        },
        {
          name: 'acme production',
          match: { orgIds: ['00D000000000000'] },
          requireTicket: true,
          ticketPattern: '[A-Z][A-Z0-9]+-[0-9]+',
          denyDestructiveMetadata: true,
          denyDataDeletes: true,
          minTestLevel: 'RunLocalTests',
          freezeWindows: [
            { name: 'weekend', weekly: { from: 'fri 17:00', to: 'mon 08:00' }, timeZone: 'America/Toronto' },
            {
              name: 'year-end close',
              range: { from: '2026-12-19T17:00', to: '2027-01-04T08:00' },
              timeZone: 'America/Toronto',
            },
          ],
        },
      ],
    });
    const at = (now: number) => policyInEffect(example, ctx({ orgId: '00D000000000000', now })).freeze;
    const yearEnd = {
      rule: 'acme production',
      window: 'year-end close',
      until: '2027-01-04 08:00 America/Toronto',
      timeZone: 'America/Toronto',
    };
    expect(at(Date.UTC(2026, 11, 19, 23, 0))).toEqual(yearEnd); // Sat 2026-12-19 18:00 in Toronto
    expect(at(Date.UTC(2026, 11, 28, 12, 30))).toEqual(yearEnd); // Mon 2026-12-28 07:30 in Toronto
    // Before the close begins, the weekend alone.
    expect(at(Date.UTC(2026, 11, 19, 21, 0))).toEqual({
      rule: 'acme production',
      window: 'weekend',
      until: 'mon 08:00 America/Toronto',
      timeZone: 'America/Toronto',
    }); // Sat 2026-12-19 16:00 in Toronto
    // The last weekend ends with the close (Mon 2027-01-04 08:00): a tie, so the weekend.
    expect(at(Date.UTC(2027, 0, 1, 23, 0))?.window).toBe('weekend'); // Fri 2027-01-01 18:00
    expect(at(Date.UTC(2027, 0, 4, 13, 0))).toBeNull(); // Mon 2027-01-04 08:00
  });
});

describe('parsePolicies', () => {
  it('parsePolicies(DEFAULT_POLICIES) round-trips, from the object and from its JSON', () => {
    expect(parsePolicies(DEFAULT_POLICIES)).toEqual({ ok: true, policies: DEFAULT_POLICIES });
    expect(parsePolicies(JSON.parse(JSON.stringify(DEFAULT_POLICIES)))).toEqual({
      ok: true,
      policies: DEFAULT_POLICIES,
    });
    expect(parsePolicies({ rules: [] })).toEqual({ ok: true, policies: { rules: [] } });
  });

  it('an unknown key is a problem, named with its path and the known keys', () => {
    expect(problemOf({ rules: [{ name: 'r', requireTickets: true }] })).toBe(
      'rules[0]: unknown key "requireTickets" (known: name, match, requireJustification, requireTicket, ticketPattern, denyDestructiveMetadata, denyDataDeletes, denyAnonymousApex, minTestLevel, freezeWindows)',
    );
    expect(problemOf({ rules: [], extra: 1 })).toBe('unknown key "extra" (known: rules)');
    expect(problemOf({ rules: [{ name: 'r', match: { org: ['x'] } }] })).toBe(
      'rules[0].match: unknown key "org" (known: orgTypes, connections, orgIds)',
    );
    expect(
      problemOf({ rules: [{ name: 'r', freezeWindows: [{ name: 'w', weekly: { from: 'fri 17:00', to: 'mon 08:00' }, tz: 'UTC' }] }] }),
    ).toBe('rules[0].freezeWindows[0]: unknown key "tz" (known: name, weekly, range, timeZone)');
  });

  it('the root must be {rules: [...]}', () => {
    expect(problemOf([])).toBe('expected {"rules": [ … ]}, got a list');
    expect(problemOf(null)).toBe('expected {"rules": [ … ]}, got null');
    expect(problemOf({})).toBe('rules: missing — expected a list of rules');
    expect(problemOf({ rules: {} })).toBe('rules: expected a list, got an object');
  });

  it('names: missing, duplicate (case-insensitive) and over-long', () => {
    expect(problemOf({ rules: [{ requireTicket: true }] })).toBe('rules[0].name: missing — every rule needs a name');
    expect(problemOf({ rules: [{ name: 'Prod' }, { name: 'prod' }] })).toBe(
      'rules[1].name: "prod" is already used by rules[0] — rule names must be unique',
    );
    expect(problemOf({ rules: [{ name: 'x'.repeat(81) }] })).toBe('rules[0].name: longer than 80 characters');
    expect(parsePolicies({ rules: [{ name: 'x'.repeat(80) }] }).ok).toBe(true);
  });

  it('an empty match list is a problem, not "match nothing"', () => {
    expect(problemOf({ rules: [{ name: 'a' }, { name: 'b', match: { connections: [] } }] })).toBe(
      'rules[1].match.connections: empty list — remove the key to match every connection',
    );
    expect(problemOf({ rules: [{ name: 'a', match: { orgTypes: [] } }] })).toMatch(/^rules\[0\]\.match\.orgTypes: empty list/);
    expect(problemOf({ rules: [{ name: 'a', match: { orgTypes: ['prod'] } }] })).toBe(
      'rules[0].match.orgTypes[0]: "prod" is not an org type (production, sandbox, developer, trial, unknown)',
    );
    expect(problemOf({ rules: [{ name: 'a', match: { orgIds: ['00D1'] } }] })).toMatch(
      /^rules\[0\]\.match\.orgIds\[0\]: expected a 15- or 18-character org id/,
    );
  });

  it('a flag must be a boolean; a test level must be one of the four', () => {
    expect(problemOf({ rules: [{ name: 'a', requireTicket: 'yes' }] })).toBe(
      'rules[0].requireTicket: expected true or false, got "yes"',
    );
    expect(problemOf({ rules: [{ name: 'a', minTestLevel: 'RunLocal' }] })).toBe(
      'rules[0].minTestLevel: "RunLocal" is not a test level (NoTestRun, RunSpecifiedTests, RunLocalTests, RunAllTestsInOrg)',
    );
  });

  it('a ticketPattern that does not compile is a problem', () => {
    expect(problemOf({ rules: [{ name: 'a', ticketPattern: 'ACME-(' }] })).toMatch(
      /^rules\[0\]\.ticketPattern: does not compile as a regular expression/,
    );
    // Balanced only by the anchoring wrapper: still refused.
    expect(problemOf({ rules: [{ name: 'a', ticketPattern: 'a)(b' }] })).toMatch(
      /^rules\[0\]\.ticketPattern: does not compile/,
    );
  });

  it('a window needs exactly one of weekly or range', () => {
    expect(
      problemOf({
        rules: [
          {
            name: 'a',
            freezeWindows: [
              { name: 'w', weekly: { from: 'fri 17:00', to: 'mon 08:00' }, range: { from: '2026-12-19T17:00', to: '2027-01-04T08:00' } },
            ],
          },
        ],
      }),
    ).toBe('rules[0].freezeWindows[0]: give exactly one of weekly or range');
    expect(problemOf({ rules: [{ name: 'a', freezeWindows: [{ name: 'w' }] }] })).toBe(
      'rules[0].freezeWindows[0]: give exactly one of weekly or range',
    );
  });

  it('weekly tokens: a bad day, 24:00, and from equal to to', () => {
    expect(
      problemOf({
        rules: [{ name: 'a' }, { name: 'b', freezeWindows: [{ name: 'w', weekly: { from: 'friday 5pm', to: 'mon 08:00' } }] }],
      }),
    ).toBe(
      'rules[1].freezeWindows[0].weekly.from: expected "<day> HH:MM" (day mon|tue|wed|thu|fri|sat|sun, 24-hour time), got "friday 5pm"',
    );
    expect(
      problemOf({ rules: [{ name: 'a', freezeWindows: [{ name: 'w', weekly: { from: 'fri 17:00', to: 'sun 24:00' } }] }] }),
    ).toMatch(/^rules\[0\]\.freezeWindows\[0\]\.weekly\.to: expected "<day> HH:MM"/);
    expect(
      problemOf({ rules: [{ name: 'a', freezeWindows: [{ name: 'w', weekly: { from: 'fri 17:00', to: 'fri 17:00' } }] }] }),
    ).toMatch(/^rules\[0\]\.freezeWindows\[0\]\.weekly: from and to are the same time/);
    // The day token is read case-insensitively and stored lower-case.
    const ok = parsed({ rules: [{ name: 'a', freezeWindows: [{ name: 'w', weekly: { from: 'Fri 17:00', to: 'MON 08:00' } }] }] });
    expect(ok.rules[0]!.freezeWindows![0]!.weekly).toEqual({ from: 'fri 17:00', to: 'mon 08:00' });
  });

  it('range: an impossible date, a malformed stamp, and from not before to', () => {
    expect(
      problemOf({ rules: [{ name: 'a', freezeWindows: [{ name: 'w', range: { from: '2026-02-30T10:00', to: '2026-03-02T10:00' } }] }] }),
    ).toBe('rules[0].freezeWindows[0].range.from: "2026-02-30T10:00" is not a real date and time');
    expect(
      problemOf({ rules: [{ name: 'a', freezeWindows: [{ name: 'w', range: { from: '2026-12-19 17:00', to: '2027-01-04T08:00' } }] }] }),
    ).toMatch(/^rules\[0\]\.freezeWindows\[0\]\.range\.from: expected "YYYY-MM-DDTHH:MM"/);
    expect(
      problemOf({ rules: [{ name: 'a', freezeWindows: [{ name: 'w', range: { from: '2027-01-04T08:00', to: '2026-12-19T17:00' } }] }] }),
    ).toBe('rules[0].freezeWindows[0].range: from must be before to');
    expect(
      problemOf({ rules: [{ name: 'a', freezeWindows: [{ name: 'w', range: { from: '2027-01-04T08:00', to: '2027-01-04T08:00' } }] }] }),
    ).toBe('rules[0].freezeWindows[0].range: from must be before to');
    // 29 February exists in a leap year only.
    expect(
      parsePolicies({ rules: [{ name: 'a', freezeWindows: [{ name: 'w', range: { from: '2028-02-29T10:00', to: '2028-03-01T10:00' } }] }] }).ok,
    ).toBe(true);
  });

  it('a time zone this machine does not know is a problem', () => {
    expect(
      problemOf({
        rules: [
          { name: 'a' },
          { name: 'b', freezeWindows: [{ name: 'w', weekly: { from: 'fri 17:00', to: 'mon 08:00' }, timeZone: 'Mars/Olympus' }] },
        ],
      }),
    ).toBe('rules[1].freezeWindows[0].timeZone: "Mars/Olympus" is not a time zone this machine knows');
  });
});

describe('inputs', () => {
  it('normalizeTicket: one line of at most 120 characters; blank → null', () => {
    expect(normalizeTicket(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeTicket('   ')).toEqual({ ok: true, value: null });
    expect(normalizeTicket('  ACME-42 ')).toEqual({ ok: true, value: 'ACME-42' });
    expect(normalizeTicket('x'.repeat(120))).toEqual({ ok: true, value: 'x'.repeat(120) });
    const problem = 'ticket must be one line of at most 120 characters with no control characters';
    expect(normalizeTicket('x'.repeat(121))).toEqual({ ok: false, problem });
    expect(normalizeTicket('ACME\n42')).toEqual({ ok: false, problem });
    expect(normalizeTicket('ACME\r\n42')).toEqual({ ok: false, problem });
    expect(normalizeTicket('ACME\r42')).toEqual({ ok: false, problem });
    expect(normalizeTicket('ACME\t42')).toEqual({ ok: false, problem });
    expect(normalizeTicket(42)).toEqual({ ok: false, problem });
  });

  it('normalizeJustification: CR LF and a lone CR fold to LF before the limit; blank → null', () => {
    const crlf = 'a'.repeat(499) + '\r\n' + 'b'.repeat(500); // 1,001 raw, 1,000 folded
    expect(normalizeJustification(crlf)).toEqual({ ok: true, value: 'a'.repeat(499) + '\n' + 'b'.repeat(500) });
    expect(normalizeJustification('first\rsecond')).toEqual({ ok: true, value: 'first\nsecond' });
    expect(normalizeJustification(' \r\n ')).toEqual({ ok: true, value: null });
    expect(normalizeJustification(null)).toEqual({ ok: true, value: null });
    const problem = 'justification must be at most 1000 characters with no control characters other than line breaks';
    expect(normalizeJustification('x'.repeat(1001))).toEqual({ ok: false, problem });
    expect(normalizeJustification('bell\u0007')).toEqual({ ok: false, problem });
    expect(normalizeJustification('tab\there')).toEqual({ ok: false, problem });
  });

  it('normalizeFreezeReason: 14 / 15 / 1,000 / 1,001 characters, counted after folding', () => {
    expect(normalizeFreezeReason('x'.repeat(14))).toEqual({ ok: false, code: 'override_too_short' });
    expect(normalizeFreezeReason('x'.repeat(15))).toEqual({ ok: true, value: 'x'.repeat(15) });
    expect(normalizeFreezeReason('x'.repeat(1000))).toEqual({ ok: true, value: 'x'.repeat(1000) });
    expect(normalizeFreezeReason('x'.repeat(1001))).toEqual({ ok: false, code: 'override_too_long' });
    // 16 characters as typed, 15 once the CR LF is one LF.
    expect(normalizeFreezeReason('abcdefg\r\nhijklmn')).toEqual({ ok: true, value: 'abcdefg\nhijklmn' });
    // 15 as typed, 14 folded: too short.
    expect(normalizeFreezeReason('abcdefg\r\nhijklm')).toEqual({ ok: false, code: 'override_too_short' });
    expect(normalizeFreezeReason('   ' + 'x'.repeat(14) + '   ')).toEqual({ ok: false, code: 'override_too_short' });
    expect(normalizeFreezeReason('outage in checkout\u0007')).toEqual({ ok: false, code: 'invalid_text' });
    expect(normalizeFreezeReason(undefined)).toEqual({ ok: false, code: 'invalid_text' });
  });
});

describe('texts', () => {
  const v = [{ text: 'policy rule "J" requires a justification for every change to "acme-prod" — pass justification' }];
  const CONFIG_S = "These rules are in the policies section of Contrail's config.json.";
  const DEFAULT_S =
    "This is Contrail's built-in default rule: config.json has no policies section (rules written there replace it).";
  const H =
    "No Contrail tool can change the policies, and changing them is the human's decision alone: do not edit config.json yourself and do not ask the human to loosen it for this change.";
  const freeze = { rule: 'weekend freeze', window: 'Weekend', until: 'mon 08:00 America/Toronto' };

  it('policyRefusalText in its four phases, with each source sentence', () => {
    for (const [source, S] of [
      ['config', CONFIG_S],
      ['default', DEFAULT_S],
    ] as const) {
      expect(policyRefusalText('acme-prod', 'production', v, 'propose', source)).toBe(
        [
          'POLICY REFUSAL — nothing was validated, proposed or sent to "acme-prod" (production), and any pending approval on it is untouched.',
          `- ${v[0]!.text}`,
          `${S} ${H} Relay this refusal to them as it stands — do not try another tool, connection or route to make the same change.`,
        ].join('\n'),
      );
      expect(policyRefusalText('acme-prod', 'production', v, 'attach', source)).toBe(
        [
          'POLICY REFUSAL — this call was not attached to the validation already running on "acme-prod" (production) with these arguments; this call sent nothing and left any pending approval untouched. That validation goes on and is checked against the policies again when it finishes — no approval is created unless they then allow it; poll it by job_id to see its outcome. The policies now do not allow this request:',
          `- ${v[0]!.text}`,
          `${S} ${H} Relay this refusal to them as it stands — do not try another tool, connection or route to make the same change.`,
        ].join('\n'),
      );
      expect(policyRefusalText('acme-prod', 'production', v, 'after_validation', source)).toBe(
        [
          'POLICY REFUSAL — the check-only validation ran on "acme-prod" (production), but no approval was created and any pending approval on it is untouched. Contrail re-read the policies when the validation finished, and they do not allow this request:',
          `- ${v[0]!.text}`,
          `${S} ${H} Relay this refusal to them as it stands — do not try another tool, connection or route to make the same change.`,
        ].join('\n'),
      );
      expect(policyRefusalText('acme-prod', 'unknown', v, 'execute', source)).toBe(
        [
          'POLICY REFUSAL — not executed. The code was not used up and the request is still pending, but it cannot run on "acme-prod" (unknown) while this holds:',
          `- ${v[0]!.text}`,
          `Contrail re-checks the policies when a change executes, and this request does not satisfy them as they stand now. ${S} No Contrail tool can change that file, and you must not edit it yourself. Relay this to the human — if the change is still wanted, propose it again so the approval reflects the current rules.`,
        ].join('\n'),
      );
    }
    for (const phase of ['propose', 'attach', 'after_validation', 'execute'] as const) {
      expect(policyRefusalText('a', 'production', v, phase, 'config')).toContain('are in the policies section');
      const d = policyRefusalText('a', 'production', v, phase, 'default');
      expect(d).toContain('built-in default rule');
      expect(d).not.toContain('are in the policies section');
    }
    // One line per violation.
    expect(
      policyRefusalText('a', 'production', [{ text: 'one' }, { text: 'two' }], 'propose', 'config').split('\n').slice(1, 3),
    ).toEqual(['- one', '- two']);
    // The execute text never says the policies changed (it also covers a pre-0.40 request).
    expect(policyRefusalText('a', 'production', v, 'execute', 'config')).not.toMatch(/changed/);
  });

  it('policyUnreadableText in its four phases', () => {
    const problem = 'config.json is not valid JSON (Unexpected end of JSON input)';
    expect(policyUnreadableText(problem, 'propose')).toBe(
      `POLICY CHECK FAILED CLOSED — nothing was validated, proposed or sent. Contrail could not read the policies in config.json: ${problem}. Until that file is fixed, no write can be proposed and no agent test run started on any connection (reads still work). No Contrail tool edits config.json, and repairing it is the human's job — do not edit it yourself. Relay this message to them exactly — do not try another route.`,
    );
    expect(policyUnreadableText(problem, 'attach')).toBe(
      `POLICY CHECK FAILED CLOSED — this call was not attached to the validation already running with these arguments, and it sent nothing. Contrail could not read the policies in config.json: ${problem}. That validation goes on and is checked again when it finishes — no approval is created while the file cannot be read; poll it by job_id to see its outcome. Until that file is fixed, no write can be proposed and no agent test run started on any connection (reads still work). No Contrail tool edits config.json, and repairing it is the human's job — do not edit it yourself. Relay this message to them exactly — do not try another route.`,
    );
    expect(policyUnreadableText(problem, 'after_validation')).toBe(
      `POLICY CHECK FAILED CLOSED — the check-only validation ran, but no approval was created and any pending approval is untouched. Contrail could not read the policies in config.json when the validation finished: ${problem}. No Contrail tool edits config.json, and repairing it is the human's job — do not edit it yourself. Relay this message to them exactly; once the file is fixed, validate again.`,
    );
    expect(policyUnreadableText(problem, 'execute')).toBe(
      `POLICY CHECK FAILED CLOSED — not executed. Contrail could not read the policies in config.json: ${problem}. The code was not used up; once the human has fixed the file, the same code works again until it expires. No Contrail tool edits config.json, and you must not edit it yourself.`,
    );
  });

  it('the freeze texts, verbatim', () => {
    expect(freezeBannerText('acme-prod', freeze)).toBe(
      'FREEZE — policy rule "weekend freeze" freezes changes to "acme-prod" during "Weekend" (until mon 08:00 America/Toronto).',
    );
    expect(freezeProposeNote('acme-prod', freeze, 'page')).toBe(
      'CHANGE FREEZE in effect — policy rule "weekend freeze" freezes changes to "acme-prod" during "Weekend" (until mon 08:00 America/Toronto). The approval page shows NO confirmation code, and none was pushed to a phone. Releasing this request is the human\'s decision alone, at their desk, by typing an emergency reason on that page — the code appears there afterwards. No Contrail tool can do that, and you must not do it for them or change the freeze yourself. Present the summary, tell the human a freeze is in effect and what it asks of them, and wait. If the change can wait, say so: once the freeze has ended, reloading the page shows the code with no override, provided the code has not expired by then (otherwise propose again). If Contrail is restarted before then (a new session or a reconnect), the page closes and this request can no longer be released; propose it again only if the human asks.',
    );
    expect(freezeProposeNote('acme-prod', freeze, 'native')).toBe(
      'CHANGE FREEZE in effect — policy rule "weekend freeze" freezes changes to "acme-prod" during "Weekend" (until mon 08:00 America/Toronto). The request is waiting in the app\'s Deploy Review screen, where, while the freeze lasts, Approve stays disabled until the human types an emergency reason. No Contrail tool can do that, and you must not do it for them or change the freeze yourself. Present the summary, tell the human a freeze is in effect and what it asks of them, then call the execute tool WITHOUT a confirmation code and wait for their decision. If the change can wait, say so.',
    );
    for (const surface of ['page', 'native'] as const) {
      expect(freezeProposeNote('acme-prod', freeze, surface)).not.toContain('is open');
    }
    expect(freezePageNotOpenedText()).toBe(
      'The approval page could not be opened automatically. Its URL was written to the Contrail server log (stderr) for the human to open — it is deliberately NOT provided to you. Ask the human to open the Contrail log and visit the page; while the freeze lasts it shows no code until they type an emergency reason there.',
    );
    expect(freezeExecuteRefusalText('acme-prod', freeze, 'page')).toBe(
      'CHANGE FREEZE — not executed. Policy rule "weekend freeze" freezes changes to "acme-prod" during "Weekend" (until mon 08:00 America/Toronto). The code was not used up. Releasing this request is the human\'s decision alone, at their desk: they reload the approval page, type an emergency reason there, and then the same code works. No Contrail tool can record that reason, and you must not enter one or change the freeze yourself. Tell the human exactly this and wait — do not try another route. If the approval page no longer loads (Contrail was restarted since this request was proposed), this request cannot be released while the freeze lasts; propose it again only if the human asks.',
    );
    expect(freezeExecuteRefusalText('acme-prod', freeze, 'native')).toBe(
      'CHANGE FREEZE — not executed. Policy rule "weekend freeze" freezes changes to "acme-prod" during "Weekend" (until mon 08:00 America/Toronto). Releasing this request is the human\'s decision alone, in the Contrail desktop app: Deploy Review asks for an emergency reason before Approve. No Contrail tool can record that reason, and you must not enter one or change the freeze yourself. Tell the human exactly this and wait — do not propose again or try another route.',
    );
    expect(freezeStartRefusalText('acme-prod', freeze)).toBe(
      'CHANGE FREEZE — the test run was not started. Policy rule "weekend freeze" freezes changes to "acme-prod" during "Weekend" (until mon 08:00 America/Toronto). A test run executes the agent\'s real actions and has no approval page on which the human could record an emergency reason, so Contrail starts none while the freeze lasts. Tell the human; the run can be started once the freeze has ended, or the test can be run in a sandbox instead.',
    );
  });

  it('policyChangedText and unmatchedRuleText, on this machine\'s wall clock', () => {
    const at = new Date(2026, 10, 17, 14, 3).toISOString(); // local 14:03 on 2026-11-17
    expect(policyChangedText(at)).toBe(
      'Contrail noticed at 14:03 on 2026-11-17 that the policies section of config.json had changed. The policies listed below are what applies now — a rule or freeze window that was removed is not shown. If you did not edit that file, do not approve this request.',
    );
    expect(unmatchedRuleText('acme label')).toBe(
      'Not applied to any connection on this machine: rule "acme label" — its label or org id matches none.',
    );
  });

  it('the three dryRunPolicyNote statuses', () => {
    const evaluated =
      'Dry run: policies were evaluated and are reported here, not enforced. A real validation with these arguments would be refused for each entry in would_refuse.';
    expect(dryRunPolicyNote('ok')).toBe(evaluated);
    expect(dryRunPolicyNote('would_refuse')).toBe(evaluated);
    expect(dryRunPolicyNote('unreadable', 'config.json is not valid JSON (x)')).toBe(
      'Dry run: Contrail could not read the policies in config.json (config.json is not valid JSON (x)), so none were evaluated. A real validation would be refused until the human fixes that file.',
    );
    expect(dryRunPolicyNote('unreadable', 'x')).not.toContain('policies were evaluated');
  });

  it('apexDeletesNote, verbatim', () => {
    expect(apexDeletesNote('no deletes')).toBe(
      'POLICY NOTE — rule "no deletes" denies data deletes on this connection through dml_propose and bulk_load_propose. Contrail does not inspect anonymous Apex, so it cannot tell whether this script deletes records — read it.',
    );
  });

  it('every justificationProvenance sentence', () => {
    const at = new Date(2026, 10, 17, 9, 5).toISOString(); // local 09:05
    expect(justificationProvenance(null)).toBe('None given.');
    expect(justificationProvenance({ text: 'Why now.', source: 'agent' })).toBe(
      'Drafted by the agent. Edit it if it is not what you would say.',
    );
    expect(justificationProvenance({ text: 'Why now.', source: 'agent', confirmed_at: at })).toBe(
      'Drafted by the agent; approved unchanged in Deploy Review at 09:05.',
    );
    expect(
      justificationProvenance({ text: 'Typed.', source: 'page', surface: 'approval_page', edited_at: at, agent_draft: 'd' }),
    ).toBe('Typed on the approval page at 09:05.');
    expect(justificationProvenance({ text: 'Typed.', source: 'page', surface: 'deploy_review', edited_at: at })).toBe(
      'Typed in Deploy Review at 09:05.',
    );
    expect(
      justificationProvenance({ text: '', source: 'page', surface: 'approval_page', edited_at: at, agent_draft: 'd' }),
    ).toBe('Cleared on the approval page at 09:05.');
    expect(justificationProvenance({ text: '', source: 'page', surface: 'deploy_review', edited_at: at })).toBe(
      'Cleared in Deploy Review at 09:05.',
    );
  });

  it('APPROVAL_NOTICES, verbatim', () => {
    expect(APPROVAL_NOTICES).toEqual({
      justification_saved: { kind: 'success', text: 'Justification saved. It is recorded as typed on this page.' },
      justification_cleared: { kind: 'success', text: 'Justification cleared. It is recorded as cleared on this page.' },
      justification_unchanged: { kind: 'success', text: 'No change — the justification is the same as before.' },
      justification_required: {
        kind: 'error',
        text: "This connection's policy requires a justification — it cannot be left empty. Nothing was changed.",
      },
      justification_too_long: { kind: 'error', text: 'The justification is limited to 1,000 characters. Nothing was changed.' },
      override_recorded: {
        kind: 'success',
        text: 'Emergency reason recorded. The confirmation code is shown below; the freeze itself stays configured.',
      },
      override_too_short: { kind: 'error', text: 'The emergency reason must be at least 15 characters. Nothing was recorded.' },
      override_too_long: { kind: 'error', text: 'The emergency reason is limited to 1,000 characters. Nothing was recorded.' },
      override_not_needed: {
        kind: 'success',
        text: 'No freeze is in effect for this request right now, so there is nothing to override.',
      },
      override_already_recorded: {
        kind: 'success',
        text: 'An emergency reason is already recorded for this request. Nothing was changed.',
      },
      override_blocked: { kind: 'error', text: 'This request is blocked by policy, so no emergency reason was recorded.' },
      request_closed: { kind: 'error', text: 'This request is no longer pending, so nothing was changed.' },
      invalid_text: { kind: 'error', text: 'The text contains control characters. Nothing was changed.' },
      policies_unreadable: {
        kind: 'error',
        text: 'Contrail could not read the policies in config.json, so nothing was recorded.',
      },
    });
  });

  it('no builder output claims what an agent or "no tool" cannot do, or quotes the conversation', () => {
    const at = new Date(2026, 10, 17, 9, 5).toISOString();
    const verdict = evaluatePolicies(
      parsed({
        rules: [
          {
            name: 'all',
            requireJustification: true,
            requireTicket: true,
            ticketPattern: 'T-\\d+',
            denyDestructiveMetadata: true,
            denyDataDeletes: true,
            denyAnonymousApex: true,
            minTestLevel: 'RunLocalTests',
            freezeWindows: [{ name: 'w', weekly: { from: 'fri 00:00', to: 'sat 00:00' }, timeZone: 'UTC' }],
          },
        ],
      }),
      ctx({ kind: 'deploy', destructive: true, ticket: 'bad' }),
    );
    const outputs = [
      ...verdict.violations.map((x) => x.text),
      ...verdict.lines,
      ...(['propose', 'attach', 'after_validation', 'execute'] as const).flatMap((phase) => [
        policyRefusalText('acme-prod', 'production', verdict.violations, phase, 'config'),
        policyRefusalText('acme-prod', 'production', verdict.violations, phase, 'default'),
        policyUnreadableText('p', phase),
      ]),
      freezeBannerText('acme-prod', freeze),
      freezeProposeNote('acme-prod', freeze, 'page'),
      freezeProposeNote('acme-prod', freeze, 'native'),
      freezePageNotOpenedText(),
      freezeExecuteRefusalText('acme-prod', freeze, 'page'),
      freezeExecuteRefusalText('acme-prod', freeze, 'native'),
      freezeStartRefusalText('acme-prod', freeze),
      policyChangedText(at),
      unmatchedRuleText('r'),
      apexDeletesNote('r'),
      dryRunPolicyNote('ok'),
      dryRunPolicyNote('unreadable', 'p'),
      justificationProvenance(null),
      justificationProvenance({ text: 'x', source: 'agent' }),
      justificationProvenance({ text: 'x', source: 'agent', confirmed_at: at }),
      justificationProvenance({ text: 'x', source: 'page', surface: 'approval_page', edited_at: at }),
      justificationProvenance({ text: '', source: 'page', surface: 'deploy_review', edited_at: at }),
      ...Object.values(APPROVAL_NOTICES).map((n) => n.text),
    ];
    expect(outputs.length).toBeGreaterThan(40);
    for (const text of outputs) {
      expect(text).not.toContain('Only the human can');
      expect(text).not.toContain('no tool can');
      expect(text).not.toContain('You cannot do that');
      expect(text).not.toContain('from your conversation');
    }
  });
});
