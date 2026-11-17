import { describe, expect, it } from 'vitest';
import { diffText, diffXml, semanticDiff } from '../diff/semantic.js';
import { INVOICE_OBJECT_XML } from './fixtures.js';

const INVOICE_OBJECT_XML_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Invoice</label>
    <fields>
        <fullName>Amount__c</fullName>
        <type>Currency</type>
    </fields>
    <fields>
        <fullName>Status__c</fullName>
        <type>Text</type>
    </fields>
    <fields>
        <fullName>Due_Date__c</fullName>
        <type>Date</type>
    </fields>
    <validationRules>
        <fullName>Positive_Amount</fullName>
        <errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>
        <errorMessage>Amount cannot be negative</errorMessage>
    </validationRules>
</CustomObject>
`;

const REORDERED = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <validationRules>
        <fullName>Positive_Amount</fullName>
        <errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>
        <errorMessage>Amount must be positive</errorMessage>
    </validationRules>
    <fields>
        <fullName>Status__c</fullName>
        <type>Picklist</type>
    </fields>
    <fields>
        <fullName>Account__c</fullName>
        <type>Lookup</type>
        <referenceTo>Account</referenceTo>
    </fields>
    <fields>
        <fullName>Amount__c</fullName>
        <type>Currency</type>
    </fields>
    <label>Invoice</label>
</CustomObject>
`;

describe('diffXml', () => {
  it('reports added, removed, and changed keyed children with paths', () => {
    const d = diffXml(INVOICE_OBJECT_XML, INVOICE_OBJECT_XML_V2)!;
    expect(d.identical).toBe(false);
    const byKind = (kind: string) => d.changes.filter((c) => c.kind === kind);
    expect(byKind('added')).toContainEqual({ kind: 'added', path: 'fields', key: 'Due_Date__c' });
    expect(byKind('removed')).toContainEqual({ kind: 'removed', path: 'fields', key: 'Account__c' });
    const scalars = byKind('scalar') as Array<{ path: string; a: unknown; b: unknown }>;
    expect(scalars).toContainEqual({
      kind: 'scalar',
      path: 'fields[Status__c].type',
      a: 'Picklist',
      b: 'Text',
    });
    expect(scalars.some((c) => c.path === 'validationRules[Positive_Amount].errorMessage')).toBe(
      true,
    );
  });

  it('treats element reordering as identical — the diff is semantic, not textual', () => {
    const d = diffXml(INVOICE_OBJECT_XML, REORDERED)!;
    expect(d.identical).toBe(true);
    expect(d.changes).toEqual([]);
  });

  it('returns null on unparseable input (caller falls back to text)', () => {
    expect(diffXml('<<<', INVOICE_OBJECT_XML)).toBeNull();
  });

  it('keys permission-set children by field/object/apexClass', () => {
    const a = `<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
      <fieldPermissions><editable>false</editable><field>Invoice__c.Amount__c</field><readable>true</readable></fieldPermissions>
      <classAccesses><apexClass>InvoiceService</apexClass><enabled>true</enabled></classAccesses>
    </PermissionSet>`;
    const b = `<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
      <fieldPermissions><editable>true</editable><field>Invoice__c.Amount__c</field><readable>true</readable></fieldPermissions>
      <objectPermissions><allowRead>true</allowRead><object>Invoice__c</object></objectPermissions>
      <classAccesses><apexClass>InvoiceService</apexClass><enabled>true</enabled></classAccesses>
    </PermissionSet>`;
    const d = diffXml(a, b)!;
    expect(d.changes).toContainEqual({
      kind: 'scalar',
      path: 'fieldPermissions[Invoice__c.Amount__c].editable',
      a: 'false',
      b: 'true',
    });
    expect(d.changes).toContainEqual({
      kind: 'added',
      path: 'objectPermissions',
      key: 'Invoice__c',
    });
    expect(d.changes.some((c) => c.kind === 'unkeyed')).toBe(false);
  });

  it('reports a single keyed child appearing on one side as added, not a scalar blob', () => {
    const a = `<CustomObject xmlns="x"><label>Invoice</label></CustomObject>`;
    const b = `<CustomObject xmlns="x"><label>Invoice</label>
      <validationRules><fullName>New_Rule</fullName><errorMessage>no</errorMessage></validationRules>
    </CustomObject>`;
    const d = diffXml(a, b)!;
    expect(d.changes).toEqual([{ kind: 'added', path: 'validationRules', key: 'New_Rule' }]);
  });
});

describe('diffText', () => {
  it('produces hunks with line numbers for a local edit', () => {
    const a = ['public class X {', '  void a() {}', '  void b() {}', '}'].join('\n');
    const b = ['public class X {', '  void a() {}', '  void b2() { run(); }', '}'].join('\n');
    const d = diffText(a, b);
    expect(d.identical).toBe(false);
    expect(d.lines_added).toBe(1);
    expect(d.lines_removed).toBe(1);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({
      a_line: 3,
      removed: ['  void b() {}'],
      added: ['  void b2() { run(); }'],
    });
  });

  it('falls back to counts-only for very large diffs', () => {
    const a = Array.from({ length: 2100 }, (_, i) => `line-a-${i}`).join('\n');
    const b = Array.from({ length: 2100 }, (_, i) => `line-b-${i}`).join('\n');
    const d = diffText(a, b);
    expect(d.counts_only).toBe(true);
    expect(d.lines_added).toBe(2100);
    expect(d.lines_removed).toBe(2100);
    expect(d.hunks).toEqual([]);
  });

  it('caps hunk lines at the default limit but honors caller-supplied limits', () => {
    // One contiguous 120-line insertion: defaults keep 40 lines and flag the
    // cut; a UI-sized limit keeps the whole block with no flag.
    const a = ['start', 'end'].join('\n');
    const b = ['start', ...Array.from({ length: 120 }, (_, i) => `added-${i}`), 'end'].join('\n');

    const capped = diffText(a, b);
    expect(capped.hunks).toHaveLength(1);
    expect(capped.hunks[0]!.added).toHaveLength(40);
    expect(capped.hunks[0]!.added_truncated).toBe(true);
    expect(capped.lines_added).toBe(120); // counts stay exact even when display is capped

    const full = diffText(a, b, { maxHunkLines: 2_000 });
    expect(full.hunks[0]!.added).toHaveLength(120);
    expect(full.hunks[0]!.added_truncated).toBeUndefined();
  });
});

describe('semanticDiff', () => {
  it('routes XML to structural diff and identical content to a cheap short-circuit', () => {
    expect(semanticDiff(INVOICE_OBJECT_XML, INVOICE_OBJECT_XML).identical).toBe(true);
    const d = semanticDiff(INVOICE_OBJECT_XML, INVOICE_OBJECT_XML_V2);
    expect(d.format).toBe('xml');
    expect(d.xml!.changes.length).toBeGreaterThan(0);
  });

  it('routes non-XML to line diff', () => {
    const d = semanticDiff('class A {}', 'class B {}');
    expect(d.format).toBe('text');
    expect(d.text!.identical).toBe(false);
  });
});

describe('S45: DiffLimits (converged with the desktop copy; defaults unchanged)', () => {
  // Two local edits far enough apart to form two hunks.
  const a = ['h1', 'x', 'same', 'same', 'same', 'same', 'same', 'y', 'tail'].join('\n');
  const b = ['h1', 'X', 'same', 'same', 'same', 'same', 'same', 'Y', 'tail'].join('\n');

  it('no limits → the pre-S45 defaults (existing callers pass none)', () => {
    const d = diffText(a, b);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks_truncated).toBe(false);
    expect(d.lines_added).toBe(2);
    expect(d.lines_removed).toBe(2);
  });

  it('maxHunks caps the hunk list and flags the truncation; counts are never capped', () => {
    const d = diffText(a, b, { maxHunks: 1 });
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks_truncated).toBe(true);
    expect(d.lines_added).toBe(2);
    expect(d.lines_removed).toBe(2);
  });

  it('maxHunkLines and maxLineChars clamp what one hunk carries', () => {
    const many = Array.from({ length: 5 }, (_, i) => `removed-line-${i}`).join('\n');
    const d = diffText(`k\n${many}\nk`, 'k\nk', { maxHunkLines: 2, maxLineChars: 7 });
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]!.removed).toEqual(['removed…', 'removed…']);
    expect(d.hunks[0]!.removed_truncated).toBe(true);
    expect(d.lines_removed).toBe(5);
  });

  it('maxHunkBudgetChars drops whole hunks once the budget is spent', () => {
    // Hunk 1 costs ("x"+1)+("X"+1) = 4 chars: a budget of 4 keeps it and
    // nothing after it; 3 keeps none.
    const one = diffText(a, b, { maxHunkBudgetChars: 4 });
    expect(one.hunks).toHaveLength(1);
    expect(one.hunks_truncated).toBe(true);
    const none = diffText(a, b, { maxHunkBudgetChars: 3 });
    expect(none.hunks).toEqual([]);
    expect(none.hunks_truncated).toBe(true);
    expect(none.counts_only).toBe(false);
  });

  it('maxChanges caps structural XML changes and flags it', () => {
    const capped = diffXml(INVOICE_OBJECT_XML, INVOICE_OBJECT_XML_V2, { maxChanges: 1 })!;
    expect(capped.changes).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    expect(capped.identical).toBe(false);
    expect(diffXml(INVOICE_OBJECT_XML, INVOICE_OBJECT_XML_V2)!.truncated).toBe(false);
  });

  it('semanticDiff forwards the limits to whichever format it routes to', () => {
    expect(semanticDiff(a, b, { maxHunks: 1 }).text!.hunks).toHaveLength(1);
    expect(semanticDiff(a, b).text!.hunks).toHaveLength(2);
    const xml = semanticDiff(INVOICE_OBJECT_XML, INVOICE_OBJECT_XML_V2, { maxChanges: 1 });
    expect(xml.format).toBe('xml');
    expect(xml.xml!.changes).toHaveLength(1);
    expect(xml.xml!.truncated).toBe(true);
  });
});
