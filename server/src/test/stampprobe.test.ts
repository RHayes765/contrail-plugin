import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidComponentName } from '../deploy/package.js';
import { preImageKey } from '../deploy/preimage.js';
import {
  STAMP_NO_ROW_REASON,
  STAMP_NOT_QUERIED_REASON,
  STAMP_PROBE_TIMEOUT_MS,
  STAMP_QUERY_MAX_CHARS,
  STAMP_QUERY_MAX_PAIRS,
  STAMP_QUERY_MAX_ROWS,
  STAMP_SCHEME,
  UNCHECKED_STAMP_NOT_PROBEABLE,
  UNCHECKED_STAMP_QUERY_FAILED,
  UNCHECKED_STAMP_ROW_UNMATCHED,
  UNCHECKED_STAMP_SOURCE_MISMATCH,
  buildStampQueries,
  isProbeable,
  normalizeStamp,
  planProbe,
  readMemberStamps,
  stampAbsenceEvidence,
  stampKey,
  stampQueryFailedReason,
  stampSourceFor,
  stampSourceLabel,
  type StampMember,
  type StampQuery,
  type StampQueryApi,
} from '../deploy/stampprobe.js';

/**
 * S46 D1: the stamp probe — the name grammar, the four query texts, the
 * one-parent-per-name chunking, and the row mapping (namespace-exact, with
 * `unmatched` for a same-name row under another namespace). Pure: the
 * executor is a stub, no REST client.
 */

type Row = Record<string, unknown>;

/** A stamp as Tooling and the Data API write it (`+0000`, not `Z`). */
const ROW_PLUS0000 = '2026-11-17T17:30:19.000+0000';
const ROW_PLUS0000_AS_Z = '2026-11-17T17:30:19.000Z';

const Q_FIELDS =
  'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
  "FROM CustomField WHERE (DeveloperName = 'Tier' AND EntityDefinition.QualifiedApiName = 'Account') " +
  "OR (DeveloperName = 'Amount' AND EntityDefinition.QualifiedApiName = 'Invoice__c')";
const Q_RULES =
  'SELECT Id, ValidationName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
  "FROM ValidationRule WHERE (ValidationName = 'Positive_Amount' AND EntityDefinition.QualifiedApiName = 'Invoice__c') " +
  "OR (ValidationName = 'Needs_Owner' AND EntityDefinition.QualifiedApiName = 'Account')";
const Q_LABELS =
  'SELECT Id, Name, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
  "FROM ExternalString WHERE Name = 'Greeting' OR Name = 'Farewell'";
/** One target: a single clause keeps its parentheses. */
const Q_TIER_ONLY =
  'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
  "FROM CustomField WHERE (DeveloperName = 'Tier' AND EntityDefinition.QualifiedApiName = 'Account')";
const Q_VIEWS =
  'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
  "FROM ListView WHERE (SobjectType = 'Account' AND DeveloperName = 'Mine') " +
  "OR (SobjectType = 'Invoice__c' AND DeveloperName = 'Open_Invoices')";

const FIELD_MEMBERS: StampMember[] = [
  { type: 'CustomField', api_name: 'Account.Tier__c' },
  { type: 'CustomField', api_name: 'Invoice__c.Amount__c' },
];
const RULE_MEMBERS: StampMember[] = [
  { type: 'ValidationRule', api_name: 'Invoice__c.Positive_Amount' },
  { type: 'ValidationRule', api_name: 'Account.Needs_Owner' },
];
const LABEL_MEMBERS: StampMember[] = [
  { type: 'CustomLabel', api_name: 'Greeting' },
  { type: 'CustomLabel', api_name: 'Farewell' },
];
const VIEW_MEMBERS: StampMember[] = [
  { type: 'ListView', api_name: 'Account.Mine' },
  { type: 'ListView', api_name: 'Invoice__c.Open_Invoices' },
];

const TIER: StampMember = { type: 'CustomField', api_name: 'Account.Tier__c' };
const NS_TIER: StampMember = { type: 'CustomField', api_name: 'Account.ns__Tier__c' };
const KEY_TIER = 'CustomField:Account.Tier__c';
const KEY_NS_TIER = 'CustomField:Account.ns__Tier__c';

/** One returned record, shaped as the org sends it (the name column varies by sObject). */
function row(
  nameColumn: string,
  name: string,
  ns: string | null = null,
  date: unknown = ROW_PLUS0000,
  by: string | null = 'Dana Admin',
): Row {
  return {
    attributes: { type: 'stub' },
    Id: '000000000000001',
    [nameColumn]: name,
    NamespacePrefix: ns,
    LastModifiedDate: date,
    LastModifiedBy: by === null ? null : { Name: by },
  };
}
const fieldRow = (name: string, ns: string | null = null, date: unknown = ROW_PLUS0000): Row =>
  row('DeveloperName', name, ns, date);

/**
 * The stub executor: answers a query with the rows registered for the
 * sObject its FROM clause names (an array, or a function of the SOQL), and
 * records every call. `failOn` / `hangOn` are SOQL substrings: a matching
 * query rejects, or never answers and ignores its signal.
 */
function fakeQuery(
  rowsBySobject: Record<string, Row[] | ((soql: string) => Row[])> = {},
  options: { failOn?: string; hangOn?: string } = {},
): {
  query: StampQuery;
  issued: Array<{ api: StampQueryApi; soql: string }>;
  signals: Array<AbortSignal | undefined>;
} {
  const issued: Array<{ api: StampQueryApi; soql: string }> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const query: StampQuery = async (api, soql, signal) => {
    issued.push({ api, soql });
    signals.push(signal);
    if (options.failOn !== undefined && soql.includes(options.failOn)) {
      throw new Error('Salesforce API error 400 on /services/data/v68.0/tooling/query: stub fault');
    }
    if (options.hangOn !== undefined && soql.includes(options.hangOn)) {
      return new Promise<Row[]>(() => {});
    }
    const sobject = / FROM (\w+) WHERE /.exec(soql)?.[1] ?? '';
    const rows = rowsBySobject[sobject];
    return typeof rows === 'function' ? rows(soql) : (rows ?? []);
  };
  return { query, issued, signals };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('S46 D1: constants and the labels', () => {
  it('pins the scheme, the bounds and the reason codes', () => {
    expect(STAMP_SCHEME).toBe(2);
    expect(STAMP_QUERY_MAX_PAIRS).toBe(20);
    expect(STAMP_QUERY_MAX_CHARS).toBe(3500);
    expect(STAMP_QUERY_MAX_ROWS).toBe(200);
    expect(STAMP_PROBE_TIMEOUT_MS).toBe(30_000);
    expect(UNCHECKED_STAMP_QUERY_FAILED).toBe('stamp_query_failed_at_execute');
    expect(UNCHECKED_STAMP_NOT_PROBEABLE).toBe('stamp_not_probeable');
    expect(UNCHECKED_STAMP_SOURCE_MISMATCH).toBe('stamp_source_mismatch');
    expect(UNCHECKED_STAMP_ROW_UNMATCHED).toBe('stamp_row_unmatched');
  });

  it('the three page reasons, verbatim; a failure reason is cut at 160 characters', () => {
    expect(STAMP_NO_ROW_REASON).toBe('the stamp query returned no usable stamp for them');
    expect(STAMP_NOT_QUERIED_REASON).toBe('Contrail has no stamp query for them');
    expect(stampQueryFailedReason('no answer within 30 s')).toBe(
      'the stamp query failed: no answer within 30 s',
    );
    expect(stampQueryFailedReason('x'.repeat(500))).toBe(
      `the stamp query failed: ${'x'.repeat(160)}`,
    );
  });

  it('stampSourceFor: the four probed types name their source; every other type is listMetadata', () => {
    expect(stampSourceFor('CustomField')).toBe('tooling:CustomField');
    expect(stampSourceFor('ValidationRule')).toBe('tooling:ValidationRule');
    expect(stampSourceFor('CustomLabel')).toBe('tooling:ExternalString');
    expect(stampSourceFor('ListView')).toBe('data:ListView');
    // The other two child types keep the listing, and so does everything else —
    // including a type name that is a property of every object.
    for (const type of ['RecordType', 'BotVersion', 'ApexClass', 'CustomObject', 'Madeup']) {
      expect(stampSourceFor(type)).toBe('listMetadata');
    }
    expect(stampSourceFor('constructor')).toBe('listMetadata');
    expect(stampSourceFor('toString')).toBe('listMetadata');
  });

  it('stampSourceLabel, verbatim (undefined = a 0.39 pre-image = listMetadata)', () => {
    expect(stampSourceLabel(undefined)).toBe('listMetadata');
    expect(stampSourceLabel('listMetadata')).toBe('listMetadata');
    expect(stampSourceLabel('tooling:CustomField')).toBe('a Tooling query on CustomField');
    expect(stampSourceLabel('tooling:ValidationRule')).toBe('a Tooling query on ValidationRule');
    expect(stampSourceLabel('tooling:ExternalString')).toBe('a Tooling query on ExternalString');
    expect(stampSourceLabel('data:ListView')).toBe('a query on ListView');
  });

  it('stampAbsenceEvidence, verbatim: it names what was read, never "the org has none"', () => {
    expect(stampAbsenceEvidence(undefined)).toBe('listMetadata reports no such member');
    expect(stampAbsenceEvidence('listMetadata')).toBe('listMetadata reports no such member');
    expect(stampAbsenceEvidence('tooling:CustomField')).toBe(
      'the retrieve returned nothing for it and a Tooling query on CustomField found no row',
    );
    expect(stampAbsenceEvidence('tooling:ValidationRule')).toBe(
      'the retrieve returned nothing for it and a Tooling query on ValidationRule found no row',
    );
    expect(stampAbsenceEvidence('tooling:ExternalString')).toBe(
      'the retrieve returned nothing for it and a Tooling query on ExternalString found no row',
    );
    expect(stampAbsenceEvidence('data:ListView')).toBe(
      'the retrieve returned nothing for it and a query on ListView found no row',
    );
  });

  it('stampKey is the preImageKey format', () => {
    expect(stampKey('CustomField', 'Invoice__c.Amount__c')).toBe(
      'CustomField:Invoice__c.Amount__c',
    );
    for (const [type, name] of [
      ['CustomField', 'Invoice__c.Amount__c'],
      ['CustomLabel', 'Greeting'],
      ['ListView', 'Account.ns__Mine'],
    ] as const) {
      expect(stampKey(type, name)).toBe(preImageKey(type, name));
    }
  });

  it('isValidComponentName is the existing type/name grammar as a predicate', () => {
    expect(isValidComponentName('CustomField', 'Account.Tier__c')).toBe(true);
    expect(isValidComponentName('Report', 'Ops/Pipeline')).toBe(true);
    // The component grammar admits an apostrophe (layout labels) — which is
    // why the probe grammar below is tighter.
    expect(isValidComponentName('CustomField', "Account.Bad'Name__c")).toBe(true);
    expect(isValidComponentName('CustomField', 'Account.Bad\\Name__c')).toBe(false);
    expect(isValidComponentName('CustomField', 'Account..Tier__c')).toBe(false);
    expect(isValidComponentName('CustomField', 'Account/Tier__c')).toBe(false);
    expect(isValidComponentName('Custom Field', 'Account.Tier__c')).toBe(false);
    expect(isValidComponentName('Report', 'NoFolder')).toBe(false);
    expect(isValidComponentName('CustomField', '')).toBe(false);
  });
});

describe('S46 D1: planProbe — the name grammar', () => {
  it('places a custom field: parent, developer name without __c, no namespace', () => {
    expect(planProbe(TIER)).toEqual({
      target: {
        type: 'CustomField',
        api_name: 'Account.Tier__c',
        parent: 'Account',
        name: 'Tier',
        namespace: null,
      },
    });
    // The suffix is matched case-insensitively.
    expect(planProbe({ type: 'CustomField', api_name: 'Account.Tier__C' })).toMatchObject({
      target: { parent: 'Account', name: 'Tier', namespace: null },
    });
  });

  it('splits a namespace off at the double underscore', () => {
    expect(planProbe({ type: 'CustomField', api_name: 'Invoice__c.ns__Amount__c' })).toEqual({
      target: {
        type: 'CustomField',
        api_name: 'Invoice__c.ns__Amount__c',
        parent: 'Invoice__c',
        name: 'Amount',
        namespace: 'ns',
      },
    });
    expect(planProbe({ type: 'ListView', api_name: 'Account.ns__Mine' })).toEqual({
      target: {
        type: 'ListView',
        api_name: 'Account.ns__Mine',
        parent: 'Account',
        name: 'Mine',
        namespace: 'ns',
      },
    });
    expect(planProbe({ type: 'CustomLabel', api_name: 'ns__Greeting' })).toMatchObject({
      target: { parent: null, name: 'Greeting', namespace: 'ns' },
    });
    // A namespaced parent stays whole: the parent is filtered as written.
    expect(planProbe({ type: 'CustomField', api_name: 'ns__Invoice__c.Amount__c' })).toMatchObject({
      target: { parent: 'ns__Invoice__c', name: 'Amount', namespace: null },
    });
  });

  it('a validation rule, a list view and a label', () => {
    expect(planProbe({ type: 'ValidationRule', api_name: 'Invoice__c.Positive_Amount' })).toEqual({
      target: {
        type: 'ValidationRule',
        api_name: 'Invoice__c.Positive_Amount',
        parent: 'Invoice__c',
        name: 'Positive_Amount',
        namespace: null,
      },
    });
    expect(planProbe({ type: 'ListView', api_name: 'Account.Mine' })).toMatchObject({
      target: { parent: 'Account', name: 'Mine', namespace: null },
    });
    expect(planProbe({ type: 'CustomLabel', api_name: 'Greeting' })).toEqual({
      target: {
        type: 'CustomLabel',
        api_name: 'Greeting',
        parent: null,
        name: 'Greeting',
        namespace: null,
      },
    });
  });

  it('a standard field has no stamp query', () => {
    expect(planProbe({ type: 'CustomField', api_name: 'Account.Industry' })).toEqual({
      reason: 'standard_field',
    });
    expect(isProbeable({ type: 'CustomField', api_name: 'Account.Industry' })).toBe(false);
    // Only CustomField has the rule: a rule or a view never ends in __c.
    expect(isProbeable({ type: 'ValidationRule', api_name: 'Account.Industry' })).toBe(true);
  });

  it('a name the grammar cannot place is not probeable — no quote ever reaches a query', () => {
    for (const api_name of [
      "Account.Bad'Name__c",
      'NoDot__c',
      'A.B.C__c',
      '.Tier__c',
      'Account.',
      'Account.__c',
      'Account.9Lives__c',
      'Account.ns__a__b__c',
      'Account.ns____c',
      'My Object.Tier__c',
      'Account.Tier (old)__c',
      'Account.Bad\\Name__c',
      'Account..Tier__c',
    ]) {
      expect(planProbe({ type: 'CustomField', api_name }), api_name).toEqual({
        reason: 'name_not_probeable',
      });
      expect(isProbeable({ type: 'CustomField', api_name }), api_name).toBe(false);
    }
    expect(planProbe({ type: 'ValidationRule', api_name: "Account.It's_Wrong" })).toEqual({
      reason: 'name_not_probeable',
    });
    expect(planProbe({ type: 'ListView', api_name: 'Mine' })).toEqual({
      reason: 'name_not_probeable',
    });
    expect(planProbe({ type: 'CustomLabel', api_name: 'Greeting.Formal' })).toEqual({
      reason: 'name_not_probeable',
    });
    expect(planProbe({ type: 'CustomLabel', api_name: "Driver's_License" })).toEqual({
      reason: 'name_not_probeable',
    });

    const { queries, unprobed } = buildStampQueries([
      { type: 'CustomField', api_name: "Account.Bad'Name__c" },
      { type: 'CustomLabel', api_name: "Driver's_License" },
      TIER,
    ]);
    expect(unprobed).toEqual([
      { type: 'CustomField', api_name: "Account.Bad'Name__c", reason: 'name_not_probeable' },
      { type: 'CustomLabel', api_name: "Driver's_License", reason: 'name_not_probeable' },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.soql).not.toContain('Bad');
    // Two string literals, four quotes — nothing else.
    expect(queries[0]!.soql.split("'")).toHaveLength(5);
    expect(queries[0]!.soql).not.toContain('\\');
  });

  it('the component grammar is asked first: a name it refuses is never called a standard field', () => {
    // None of these ends in __c, so the field rule alone would answer
    // `standard_field` — and nothing after it would look at the name again.
    for (const api_name of ['Account.Bad\\Name', 'Account.Bad/Name', 'Account.Bad"Name']) {
      expect(isValidComponentName('CustomField', api_name), api_name).toBe(false);
      expect(planProbe({ type: 'CustomField', api_name }), api_name).toEqual({
        reason: 'name_not_probeable',
      });
      expect(isProbeable({ type: 'CustomField', api_name }), api_name).toBe(false);
    }
    const { queries, unprobed } = buildStampQueries([
      { type: 'CustomField', api_name: 'Account.Bad\\Name' },
    ]);
    expect(queries).toEqual([]);
    expect(unprobed).toEqual([
      { type: 'CustomField', api_name: 'Account.Bad\\Name', reason: 'name_not_probeable' },
    ]);
  });

  it('the base is an identifier before it is split, so the namespace is one too', () => {
    // The component grammar admits a dash, a space and a leading digit; the
    // developer name after the `__` is clean in every case, so only the check
    // on the whole base keeps these out of a target's namespace.
    for (const member of [
      { type: 'CustomField', api_name: 'Account.a-b__Tier__c' },
      { type: 'CustomField', api_name: 'Account.9ns__Tier__c' },
      { type: 'ValidationRule', api_name: 'Account.a-b__Needs_Owner' },
      { type: 'ListView', api_name: 'Account.a b__Mine' },
      { type: 'CustomLabel', api_name: 'a-b__Greeting' },
    ]) {
      const label = `${member.type} ${member.api_name}`;
      expect(isValidComponentName(member.type, member.api_name), label).toBe(true);
      expect(planProbe(member), label).toEqual({ reason: 'name_not_probeable' });
      expect(isProbeable(member), label).toBe(false);
    }
  });

  it('a type with no table row is not probeable', () => {
    for (const member of [
      { type: 'ApexClass', api_name: 'Foo' },
      { type: 'RecordType', api_name: 'Invoice__c.Biz' },
      { type: 'BotVersion', api_name: 'MyBot.v1' },
      { type: 'CustomObject', api_name: 'Invoice__c' },
      { type: 'constructor', api_name: 'Foo' },
    ]) {
      expect(planProbe(member), member.type).toEqual({ reason: 'name_not_probeable' });
      expect(isProbeable(member), member.type).toBe(false);
    }
  });
});

describe('S46 D1: buildStampQueries — the query texts', () => {
  it('CustomField: the Tooling query, name then parent', () => {
    const { queries, unprobed } = buildStampQueries(FIELD_MEMBERS);
    expect(unprobed).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.soql).toBe(Q_FIELDS);
    expect(queries[0]).toMatchObject({
      type: 'CustomField',
      source: 'tooling:CustomField',
      api: 'tooling',
    });
    expect(queries[0]!.targets.map((t) => t.api_name)).toEqual([
      'Account.Tier__c',
      'Invoice__c.Amount__c',
    ]);
  });

  it('ValidationRule: the Tooling query on ValidationName', () => {
    const { queries } = buildStampQueries(RULE_MEMBERS);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.soql).toBe(Q_RULES);
    expect(queries[0]).toMatchObject({
      type: 'ValidationRule',
      source: 'tooling:ValidationRule',
      api: 'tooling',
    });
  });

  it('CustomLabel: Tooling ExternalString, a plain OR chain with no parent', () => {
    const { queries } = buildStampQueries(LABEL_MEMBERS);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.soql).toBe(Q_LABELS);
    expect(queries[0]).toMatchObject({
      type: 'CustomLabel',
      source: 'tooling:ExternalString',
      api: 'tooling',
    });
    expect(queries[0]!.soql).not.toContain('(');
  });

  it('ListView: the Data API, and the parent comes first', () => {
    const { queries } = buildStampQueries(VIEW_MEMBERS);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.soql).toBe(Q_VIEWS);
    expect(queries[0]).toMatchObject({ type: 'ListView', source: 'data:ListView', api: 'data' });
    expect(queries[0]!.soql.indexOf('SobjectType =')).toBeLessThan(
      queries[0]!.soql.indexOf('DeveloperName ='),
    );
  });

  it('a single clause keeps its parentheses; a single label has none', () => {
    expect(buildStampQueries([TIER]).queries[0]!.soql).toBe(Q_TIER_ONLY);
    const oneLabel = buildStampQueries([{ type: 'CustomLabel', api_name: 'Greeting' }]);
    expect(oneLabel.queries[0]!.soql).toBe(
      'SELECT Id, Name, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
        "FROM ExternalString WHERE Name = 'Greeting'",
    );
  });

  it('no query ever uses TableEnumOrId or ORDER BY, and none filters on namespace', () => {
    const { queries } = buildStampQueries([
      ...FIELD_MEMBERS,
      ...RULE_MEMBERS,
      ...LABEL_MEMBERS,
      ...VIEW_MEMBERS,
      NS_TIER,
      { type: 'CustomLabel', api_name: 'ns__Greeting' },
    ]);
    expect(queries.map((q) => q.type)).toEqual([
      'CustomField',
      'ValidationRule',
      'CustomLabel',
      'ListView',
    ]);
    for (const q of queries) {
      expect(q.soql).not.toContain('TableEnumOrId');
      expect(q.soql).not.toContain('ORDER BY');
      // NamespacePrefix is selected, never filtered.
      expect(q.soql.split('NamespacePrefix')).toHaveLength(2);
      expect(q.soql.indexOf('NamespacePrefix')).toBeLessThan(q.soql.indexOf(' WHERE '));
      expect(q.soql).not.toContain('ns__');
    }
  });

  it('members of a type with no table row are ignored; unprobeable members are reported', () => {
    const { queries, unprobed } = buildStampQueries([
      { type: 'ApexClass', api_name: 'Foo' },
      { type: 'RecordType', api_name: 'Invoice__c.Biz' },
      { type: 'CustomField', api_name: 'Account.Industry' },
      { type: 'CustomField', api_name: 'NoDot__c' },
    ]);
    expect(queries).toEqual([]);
    expect(unprobed).toEqual([
      { type: 'CustomField', api_name: 'Account.Industry', reason: 'standard_field' },
      { type: 'CustomField', api_name: 'NoDot__c', reason: 'name_not_probeable' },
    ]);
  });
});

describe('S46 D1: buildStampQueries — chunking', () => {
  const clauseCount = (soql: string): number => soql.split(' OR ').length;

  it('45 distinct fields make three queries: 20, 20 and 5', () => {
    const members = Array.from({ length: 45 }, (_, i) => ({
      type: 'CustomField',
      api_name: `Account.F${i + 1}__c`,
    }));
    const { queries } = buildStampQueries(members);
    expect(queries.map((q) => q.targets.length)).toEqual([20, 20, 5]);
    expect(queries.map((q) => clauseCount(q.soql))).toEqual([20, 20, 5]);
    expect(queries[0]!.targets[0]!.api_name).toBe('Account.F1__c');
    expect(queries[2]!.targets[4]!.api_name).toBe('Account.F45__c');
  });

  it('one parent per child name per query: the same field name on two objects is two queries', () => {
    const { queries } = buildStampQueries([
      TIER,
      { type: 'CustomField', api_name: 'Invoice__c.Amount__c' },
      { type: 'CustomField', api_name: 'Contact.Tier__c' },
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[0]!.soql).toBe(Q_FIELDS);
    expect(queries[1]!.soql).toBe(
      'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
        "FROM CustomField WHERE (DeveloperName = 'Tier' AND EntityDefinition.QualifiedApiName = 'Contact')",
    );
    // The name is compared case-insensitively, as the org compares it.
    expect(
      buildStampQueries([TIER, { type: 'CustomField', api_name: 'Contact.TIER__c' }]).queries,
    ).toHaveLength(2);
  });

  it('…whatever the namespaces: Account.Tier__c and Contact.ns__Tier__c never share a query', () => {
    // Both clauses read DeveloperName = 'Tier'. In one query a local
    // Contact.Tier__c row would come back for the second clause and be
    // stamped onto the Account target (the parent is not selected).
    const { queries } = buildStampQueries([
      TIER,
      { type: 'CustomField', api_name: 'Contact.ns__Tier__c' },
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[0]!.targets.map((t) => t.api_name)).toEqual(['Account.Tier__c']);
    expect(queries[1]!.targets.map((t) => t.api_name)).toEqual(['Contact.ns__Tier__c']);
    expect(queries[1]!.soql).toContain(
      "(DeveloperName = 'Tier' AND EntityDefinition.QualifiedApiName = 'Contact')",
    );
  });

  it('targets of one parent that differ only by namespace share one clause', () => {
    const { queries } = buildStampQueries([TIER, NS_TIER]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.targets.map((t) => [t.name, t.namespace])).toEqual([
      ['Tier', null],
      ['Tier', 'ns'],
    ]);
    expect(clauseCount(queries[0]!.soql)).toBe(1);
    expect(queries[0]!.soql).toBe(Q_TIER_ONLY);
  });

  it('two same-name labels of different namespaces share one clause', () => {
    const { queries } = buildStampQueries([
      { type: 'CustomLabel', api_name: 'Greeting' },
      { type: 'CustomLabel', api_name: 'ns__Greeting' },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.targets).toHaveLength(2);
    expect(queries[0]!.soql).toBe(
      'SELECT Id, Name, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
        "FROM ExternalString WHERE Name = 'Greeting'",
    );
  });

  it('a query stays within 3,500 characters of SOQL', () => {
    const members = Array.from({ length: 20 }, (_, i) => ({
      type: 'CustomLabel',
      api_name: `L${String(i).padStart(2, '0')}_${'x'.repeat(196)}`,
    }));
    const { queries, unprobed } = buildStampQueries(members);
    expect(unprobed).toEqual([]);
    expect(queries).toHaveLength(2);
    for (const q of queries) expect(q.soql.length).toBeLessThanOrEqual(STAMP_QUERY_MAX_CHARS);
    // The pair cap alone would have put all 20 in one query; the text cap cut it —
    // and cut it only where the next clause would not fit.
    const first = queries[0]!;
    expect(first.targets.length).toBeLessThan(STAMP_QUERY_MAX_PAIRS);
    const nextClause = `Name = '${queries[1]!.targets[0]!.name}'`;
    expect(first.soql.length + ' OR '.length + nextClause.length).toBeGreaterThan(
      STAMP_QUERY_MAX_CHARS,
    );
    expect(queries.flatMap((q) => q.targets.map((t) => t.api_name))).toEqual(
      members.map((m) => m.api_name),
    );
  });

  it('duplicate members collapse', () => {
    const { queries, unprobed } = buildStampQueries([
      TIER,
      { type: 'CustomField', api_name: 'Account.Industry' },
      TIER,
      { type: 'CustomField', api_name: 'Account.Industry' },
      { ...TIER },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.targets).toHaveLength(1);
    expect(unprobed).toEqual([
      { type: 'CustomField', api_name: 'Account.Industry', reason: 'standard_field' },
    ]);
  });
});

describe('S46 D1: normalizeStamp', () => {
  it('stores a probe stamp in the …000Z form the listing uses', () => {
    expect(normalizeStamp(ROW_PLUS0000)).toBe(ROW_PLUS0000_AS_Z);
    expect(normalizeStamp('2026-11-17T17:30:19.000Z')).toBe(ROW_PLUS0000_AS_Z);
    expect(normalizeStamp('2026-11-17T17:30:19.000+00:00')).toBe(ROW_PLUS0000_AS_Z);
    expect(normalizeStamp('2026-11-17T17:30:19Z')).toBe(ROW_PLUS0000_AS_Z);
    expect(normalizeStamp('2026-11-17T17:30:19+0000')).toBe(ROW_PLUS0000_AS_Z);
    // An offset is applied, not dropped: both ends compare as epoch ms.
    expect(normalizeStamp('2026-11-17T09:30:19.000-0800')).toBe(ROW_PLUS0000_AS_Z);
    expect(normalizeStamp('2026-11-17T23:00:19.250+05:30')).toBe('2026-11-17T17:30:19.250Z');
    expect(Date.parse(normalizeStamp(ROW_PLUS0000)!)).toBe(Date.parse(ROW_PLUS0000_AS_Z));
  });

  it('anything else is null', () => {
    for (const raw of [
      '',
      'yesterday',
      '2026-11-17',
      '2026-11-17T17:30:19',
      '2026-11-17 17:30:19Z',
      '2026-13-45T17:30:19.000Z',
      '2026-11-17T17:30:19.000+0000 ',
      null,
      undefined,
      1763400619000,
      { date: ROW_PLUS0000 },
    ]) {
      expect(normalizeStamp(raw), String(raw)).toBeNull();
    }
  });
});

describe('S46 D1: readMemberStamps', () => {
  it('maps rows to members, issuing each query once on its own API', async () => {
    const { query, issued, signals } = fakeQuery({
      CustomField: [fieldRow('Tier'), fieldRow('Amount', null, '2026-11-16T08:00:00.000+0000')],
      ValidationRule: [row('ValidationName', 'Positive_Amount')],
      ExternalString: [row('Name', 'Greeting')],
      ListView: [row('DeveloperName', 'Mine')],
    });
    const result = await readMemberStamps(query, [
      ...FIELD_MEMBERS,
      ...RULE_MEMBERS,
      ...LABEL_MEMBERS,
      ...VIEW_MEMBERS,
    ]);

    expect(issued).toEqual([
      { api: 'tooling', soql: Q_FIELDS },
      { api: 'tooling', soql: Q_RULES },
      { api: 'tooling', soql: Q_LABELS },
      { api: 'data', soql: Q_VIEWS },
    ]);
    // Every query is handed a signal, whether or not the caller passed one.
    expect(signals.every((s) => s instanceof AbortSignal && !s.aborted)).toBe(true);
    expect(Object.fromEntries(result.rows)).toEqual({
      'CustomField:Account.Tier__c': {
        last_modified_date: ROW_PLUS0000_AS_Z,
        last_modified_by: 'Dana Admin',
      },
      'CustomField:Invoice__c.Amount__c': {
        last_modified_date: '2026-11-16T08:00:00.000Z',
        last_modified_by: 'Dana Admin',
      },
      'ValidationRule:Invoice__c.Positive_Amount': {
        last_modified_date: ROW_PLUS0000_AS_Z,
        last_modified_by: 'Dana Admin',
      },
      'CustomLabel:Greeting': {
        last_modified_date: ROW_PLUS0000_AS_Z,
        last_modified_by: 'Dana Admin',
      },
      'ListView:Account.Mine': {
        last_modified_date: ROW_PLUS0000_AS_Z,
        last_modified_by: 'Dana Admin',
      },
    });
    // Queried, no row: simply not in `rows` — and not failed, unprobed or unmatched.
    expect(result.rows.has('ValidationRule:Account.Needs_Owner')).toBe(false);
    expect(result.failed.size).toBe(0);
    expect(result.unprobed.size).toBe(0);
    expect(result.unmatched.size).toBe(0);
  });

  it('matches the name and the namespace case-insensitively', async () => {
    const members = [TIER, { type: 'CustomField', api_name: 'Invoice__c.ns__Amount__c' }];
    const { query } = fakeQuery({
      CustomField: [fieldRow('TIER'), fieldRow('amount', 'NS')],
    });
    const result = await readMemberStamps(query, members);
    expect([...result.rows.keys()].sort()).toEqual([
      KEY_TIER,
      'CustomField:Invoice__c.ns__Amount__c',
    ]);
    expect(result.unmatched.size).toBe(0);
  });

  it('a +0000 stamp is stored as …Z; a missing editor or an unparseable date is null, the row kept', async () => {
    const { query } = fakeQuery({
      CustomField: [
        row('DeveloperName', 'Tier', null, ROW_PLUS0000, null),
        fieldRow('Amount', null, 'not a date'),
        { DeveloperName: 'Bare' },
        { ...fieldRow('Blank'), LastModifiedBy: { Name: '' } },
      ],
    });
    const result = await readMemberStamps(query, [
      ...FIELD_MEMBERS,
      { type: 'CustomField', api_name: 'Account.Bare__c' },
      { type: 'CustomField', api_name: 'Account.Blank__c' },
    ]);
    expect(result.rows.get(KEY_TIER)).toEqual({
      last_modified_date: ROW_PLUS0000_AS_Z,
      last_modified_by: null,
    });
    expect(result.rows.get('CustomField:Invoice__c.Amount__c')).toEqual({
      last_modified_date: null,
      last_modified_by: 'Dana Admin',
    });
    // A row with no NamespacePrefix key at all is a non-namespaced row.
    expect(result.rows.get('CustomField:Account.Bare__c')).toEqual({
      last_modified_date: null,
      last_modified_by: null,
    });
    expect(result.rows.get('CustomField:Account.Blank__c')).toEqual({
      last_modified_date: ROW_PLUS0000_AS_Z,
      last_modified_by: null,
    });
  });

  it('two targets that differ only by namespace each get their own row', async () => {
    const { query, issued } = fakeQuery({
      CustomField: [
        fieldRow('Tier', 'ns', '2026-11-10T00:00:00.000+0000'),
        fieldRow('Tier', null, '2026-11-12T00:00:00.000+0000'),
      ],
    });
    const result = await readMemberStamps(query, [TIER, NS_TIER]);
    expect(issued).toHaveLength(1);
    expect(result.rows.get(KEY_TIER)?.last_modified_date).toBe('2026-11-12T00:00:00.000Z');
    expect(result.rows.get(KEY_NS_TIER)?.last_modified_date).toBe('2026-11-10T00:00:00.000Z');
    expect(result.unmatched.size).toBe(0);
  });

  it('a namespaced row for a non-namespaced target is never its stamp: the target is unmatched', async () => {
    const { query } = fakeQuery({ CustomField: [fieldRow('Tier', 'ns')] });
    const result = await readMemberStamps(query, [TIER]);
    expect(result.rows.has(KEY_TIER)).toBe(false);
    expect([...result.unmatched]).toEqual([KEY_TIER]);
    expect(result.failed.size).toBe(0);
  });

  it('a null-namespace row for a namespaced target is never its stamp: the target is unmatched', async () => {
    const { query } = fakeQuery({ CustomField: [fieldRow('Tier', null)] });
    const result = await readMemberStamps(query, [NS_TIER]);
    expect(result.rows.has(KEY_NS_TIER)).toBe(false);
    expect([...result.unmatched]).toEqual([KEY_NS_TIER]);

    // The same for a label, which has no parent at all.
    const labels = fakeQuery({ ExternalString: [row('Name', 'Greeting', 'other')] });
    const labelResult = await readMemberStamps(labels.query, [
      { type: 'CustomLabel', api_name: 'Greeting' },
      { type: 'CustomLabel', api_name: 'Farewell' },
    ]);
    expect(labelResult.rows.size).toBe(0);
    // Only the target whose name the row carries; a target with no row at all is just "no row".
    expect([...labelResult.unmatched]).toEqual(['CustomLabel:Greeting']);
  });

  it('a target with its own row is not unmatched when a same-name row under another namespace also comes back', async () => {
    const { query } = fakeQuery({
      CustomField: [fieldRow('Tier', 'other'), fieldRow('Tier', null)],
    });
    const result = await readMemberStamps(query, [TIER]);
    expect(result.rows.get(KEY_TIER)).toEqual({
      last_modified_date: ROW_PLUS0000_AS_Z,
      last_modified_by: 'Dana Admin',
    });
    expect(result.unmatched.size).toBe(0);

    // Two targets of the name, one with its row: only the other is unmatched.
    const both = await readMemberStamps(query, [TIER, NS_TIER]);
    expect(both.rows.has(KEY_TIER)).toBe(true);
    expect(both.rows.has(KEY_NS_TIER)).toBe(false);
    expect([...both.unmatched]).toEqual([KEY_NS_TIER]);
  });

  it('two rows for one target null its stamp; the row still counts as there', async () => {
    const { query } = fakeQuery({
      CustomField: [
        fieldRow('Tier', null, '2026-11-10T00:00:00.000+0000'),
        fieldRow('Tier', null, '2026-11-12T00:00:00.000+0000'),
        fieldRow('Amount'),
      ],
    });
    const result = await readMemberStamps(query, FIELD_MEMBERS);
    expect(result.rows.has(KEY_TIER)).toBe(true);
    expect(result.rows.get(KEY_TIER)).toEqual({ last_modified_date: null, last_modified_by: null });
    expect(result.rows.get('CustomField:Invoice__c.Amount__c')?.last_modified_date).toBe(
      ROW_PLUS0000_AS_Z,
    );
    expect(result.unmatched.size).toBe(0);
  });

  it('a row whose name no target carries is ignored', async () => {
    const { query } = fakeQuery({
      CustomField: [fieldRow('Stranger'), fieldRow('Stranger', 'ns'), null as unknown as Row],
    });
    const result = await readMemberStamps(query, [TIER]);
    expect(result.rows.size).toBe(0);
    expect(result.unmatched.size).toBe(0);
    expect(result.failed.size).toBe(0);
  });

  it('one failing chunk fails its whole type and leaves the other types alone', async () => {
    const fields = Array.from({ length: 21 }, (_, i) => ({
      type: 'CustomField',
      api_name: i === 20 ? 'Account.Last_One__c' : `Account.F${i + 1}__c`,
    }));
    const { query, issued } = fakeQuery(
      {
        CustomField: [fieldRow('F1'), fieldRow('F2')],
        ExternalString: [row('Name', 'Greeting')],
      },
      { failOn: "DeveloperName = 'Last_One'" },
    );
    const result = await readMemberStamps(query, [...fields, ...LABEL_MEMBERS]);

    // Three queries went out — two CustomField chunks and the labels; nothing was retried.
    expect(issued).toHaveLength(3);
    expect(Object.fromEntries(result.failed)).toEqual({
      CustomField:
        'Salesforce API error 400 on /services/data/v68.0/tooling/query: stub fault',
    });
    // The first chunk answered, and its rows are discarded with the type.
    expect([...result.rows.keys()]).toEqual(['CustomLabel:Greeting']);
  });

  it('a failed type leaves no unmatched entry of that type', async () => {
    // Two queries (one parent per name). The first returns a namespaced row —
    // an unmatched candidate — and the second fails.
    const members = [TIER, { type: 'CustomField', api_name: 'Contact.Tier__c' }];
    const { query, issued } = fakeQuery(
      { CustomField: [fieldRow('Tier', 'ns')], ExternalString: [row('Name', 'Greeting', 'ns')] },
      { failOn: "QualifiedApiName = 'Contact'" },
    );
    const result = await readMemberStamps(query, [
      ...members,
      { type: 'CustomLabel', api_name: 'Greeting' },
    ]);
    expect(issued).toHaveLength(3);
    expect([...result.failed.keys()]).toEqual(['CustomField']);
    expect(result.rows.size).toBe(0);
    // Without the failure, Account.Tier__c would be here.
    expect([...result.unmatched]).toEqual(['CustomLabel:Greeting']);

    const healthy = fakeQuery({ CustomField: [fieldRow('Tier', 'ns')] });
    expect([...(await readMemberStamps(healthy.query, members)).unmatched].sort()).toEqual([
      KEY_TIER,
      'CustomField:Contact.Tier__c',
    ]);
  });

  it('an already-aborted signal: every planned type is cancelled and no query is issued', async () => {
    const { query, issued } = fakeQuery({ CustomField: [fieldRow('Tier')] });
    const ctl = new AbortController();
    ctl.abort();
    const result = await readMemberStamps(
      query,
      [TIER, ...LABEL_MEMBERS, { type: 'CustomField', api_name: 'Account.Industry' }],
      { signal: ctl.signal },
    );
    expect(issued).toEqual([]);
    expect(Object.fromEntries(result.failed)).toEqual({
      CustomField: 'cancelled',
      CustomLabel: 'cancelled',
    });
    expect(result.rows.size).toBe(0);
    // What no query names is still reported.
    expect(Object.fromEntries(result.unprobed)).toEqual({
      'CustomField:Account.Industry': 'standard_field',
    });
  });

  it('an abort while a query hangs returns `cancelled` and aborts the signal the executor was handed', async () => {
    const { query, issued, signals } = fakeQuery(
      { ExternalString: [row('Name', 'Greeting')] },
      { hangOn: 'FROM CustomField' },
    );
    const ctl = new AbortController();
    const pending = readMemberStamps(query, [TIER, ...LABEL_MEMBERS], { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    const result = await pending;
    expect(issued).toHaveLength(2);
    expect(Object.fromEntries(result.failed)).toEqual({ CustomField: 'cancelled' });
    // The label query had already answered.
    expect([...result.rows.keys()]).toEqual(['CustomLabel:Greeting']);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('timeoutMs bounds a hanging executor: `no answer within 20 ms`, well inside 500 ms', async () => {
    const { query, issued, signals } = fakeQuery({}, { hangOn: 'FROM CustomField' });
    const started = Date.now();
    const result = await readMemberStamps(query, [TIER], { timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(issued).toHaveLength(1);
    expect(Object.fromEntries(result.failed)).toEqual({ CustomField: 'no answer within 20 ms' });
    expect(result.rows.size).toBe(0);
    // The executor's signal was aborted, so an abortable fetch is released too.
    expect(signals[0]?.aborted).toBe(true);
  }, 500);

  it('an executor that rejects when its signal aborts reports the abort, not its own text', async () => {
    // The stubs above ignore their signal. The engine's executor does not: a
    // fetch handed the signal rejects with its own message as the signal
    // aborts, and that rejection is the outcome readMemberStamps reads.
    const abortable: StampQuery = (_api, _soql, signal) =>
      new Promise<Row[]>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      });

    const timedOut = await readMemberStamps(abortable, [TIER], { timeoutMs: 20 });
    expect(Object.fromEntries(timedOut.failed)).toEqual({ CustomField: 'no answer within 20 ms' });
    expect(timedOut.rows.size).toBe(0);

    const ctl = new AbortController();
    const pending = readMemberStamps(abortable, [TIER, ...LABEL_MEMBERS], { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    expect(Object.fromEntries((await pending).failed)).toEqual({
      CustomField: 'cancelled',
      CustomLabel: 'cancelled',
    });
  }, 500);

  it('a timeout of a second or more is worded in seconds', async () => {
    vi.useFakeTimers();
    const { query } = fakeQuery({}, { hangOn: 'FROM CustomField' });
    const pending = readMemberStamps(query, [TIER], { timeoutMs: STAMP_PROBE_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(STAMP_PROBE_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(Object.fromEntries((await pending).failed)).toEqual({
      CustomField: 'no answer within 30 s',
    });
  });

  it('a timeout that never fires leaves an answered probe alone', async () => {
    const { query } = fakeQuery({ CustomField: [fieldRow('Tier')] });
    const result = await readMemberStamps(query, [TIER], { timeoutMs: 5_000 });
    expect(result.failed.size).toBe(0);
    expect(result.rows.has(KEY_TIER)).toBe(true);
  });

  it('no members, or only members of unprobed types: nothing is issued', async () => {
    const { query, issued } = fakeQuery();
    const empty = await readMemberStamps(query, []);
    expect(empty).toEqual({
      rows: new Map(),
      failed: new Map(),
      unprobed: new Map(),
      unmatched: new Set(),
    });
    const listed = await readMemberStamps(query, [
      { type: 'ApexClass', api_name: 'Foo' },
      { type: 'RecordType', api_name: 'Invoice__c.Biz' },
    ]);
    expect(listed.unprobed.size).toBe(0);
    expect(issued).toEqual([]);
  });

  it('a standard field is unprobed and no query is issued for it', async () => {
    const { query, issued } = fakeQuery();
    const result = await readMemberStamps(query, [
      { type: 'CustomField', api_name: 'Account.Industry' },
      { type: 'CustomField', api_name: 'NoDot__c' },
    ]);
    expect(issued).toEqual([]);
    expect(Object.fromEntries(result.unprobed)).toEqual({
      'CustomField:Account.Industry': 'standard_field',
      'CustomField:NoDot__c': 'name_not_probeable',
    });
    expect(result.rows.size).toBe(0);
    expect(result.failed.size).toBe(0);

    // Beside a probeable field, only the probeable one is named in the query.
    const mixed = fakeQuery({ CustomField: [fieldRow('Tier')] });
    const mixedResult = await readMemberStamps(mixed.query, [
      { type: 'CustomField', api_name: 'Account.Industry' },
      TIER,
    ]);
    expect(mixed.issued).toHaveLength(1);
    expect(mixed.issued[0]!.soql).not.toContain('Industry');
    expect(mixedResult.rows.has(KEY_TIER)).toBe(true);
    expect(mixedResult.unprobed.get('CustomField:Account.Industry')).toBe('standard_field');
  });

  it('a throwing stub never makes the function throw', async () => {
    const throwsSync = (() => {
      throw new Error('boom');
    }) as unknown as StampQuery;
    const sync = await readMemberStamps(throwsSync, [TIER, ...LABEL_MEMBERS]);
    expect(Object.fromEntries(sync.failed)).toEqual({ CustomField: 'boom', CustomLabel: 'boom' });
    expect(sync.rows.size).toBe(0);

    const rejectsWithText: StampQuery = () => Promise.reject('not an Error');
    expect((await readMemberStamps(rejectsWithText, [TIER])).failed.get('CustomField')).toBe(
      'not an Error',
    );

    // A rejection's message is kept to 300 characters.
    const longWinded: StampQuery = async () => {
      throw new Error('y'.repeat(500));
    };
    expect((await readMemberStamps(longWinded, [TIER])).failed.get('CustomField')).toBe(
      'y'.repeat(300),
    );

    // An executor that answers with no list fails the type: it is never read as "no row".
    const noList = (async () => undefined) as unknown as StampQuery;
    const result = await readMemberStamps(noList, [TIER]);
    expect([...result.failed.keys()]).toEqual(['CustomField']);
    expect(result.rows.size).toBe(0);
    expect(result.unmatched.size).toBe(0);
  });
});
