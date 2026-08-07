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
