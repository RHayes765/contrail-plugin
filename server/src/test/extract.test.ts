import { describe, expect, it } from 'vitest';
import {
  buildKnownArtifacts,
  extractApexRefs,
  extractFlowRefs,
  extractObjectXmlRefs,
  extractPermissionSetRefs,
  extractAllEdges,
  type KnownArtifacts,
} from '../deps/extract.js';
import { indexSnapshotFiles } from '../snapshot/indexer.js';
import { strToU8 } from 'fflate';
import {
  INVOICE_OBJECT_XML,
  INVOICE_SERVICE_APEX,
  SEND_INVOICE_FLOW_XML,
  INVOICE_HELPER_APEX,
} from './fixtures.js';

function known(): KnownArtifacts {
  return {
    classes: new Map([
      ['invoiceservice', 'InvoiceService'],
      ['invoicehelper', 'InvoiceHelper'],
    ]),
    objects: new Map([['invoice__c', 'Invoice__c']]),
    fields: new Map([
      ['invoice__c.amount__c', 'Invoice__c.Amount__c'],
      ['invoice__c.status__c', 'Invoice__c.Status__c'],
    ]),
    flows: new Map([['send_alert', 'Send_Alert']]),
    fieldsByShortName: new Map([
      ['amount__c', ['Invoice__c.Amount__c']],
      ['status__c', ['Invoice__c.Status__c', 'Order__c.Status__c']],
    ]),
  };
}

describe('extractFlowRefs', () => {
  it('finds objects, fields, apex actions, and subflows', () => {
    const refs = extractFlowRefs(SEND_INVOICE_FLOW_XML);
    const keys = refs.map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toContain('CustomObject:Invoice__c');
    expect(keys).toContain('CustomField:Invoice__c.Amount__c');
    expect(keys).toContain('CustomField:Invoice__c.Status__c');
    expect(keys).toContain('ApexClass:InvoiceService');
    expect(keys).toContain('Flow:Send_Alert');
  });

  it('returns nothing for unparseable XML', () => {
    expect(extractFlowRefs('<<<not xml')).toEqual([]);
  });
});

describe('extractApexRefs', () => {
  it('finds known classes, objects, SOQL targets, and labels', () => {
    const refs = extractApexRefs(INVOICE_SERVICE_APEX, known(), 'InvoiceService');
    const keys = refs.map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toContain('ApexClass:InvoiceHelper');
    expect(keys).toContain('CustomObject:Invoice__c');
    expect(keys).toContain('CustomLabel:Invoice_Alert');
    // never self-references
    expect(keys).not.toContain('ApexClass:InvoiceService');
  });

  it('resolves unqualified field tokens only when the short name is unique org-wide', () => {
    const refs = extractApexRefs(INVOICE_SERVICE_APEX, known(), 'InvoiceService');
    const keys = refs.map((r) => `${r.toType}:${r.toName}`);
    // Amount__c is unique → resolves; Status__c exists on two objects → ambiguous, skipped.
    expect(keys).toContain('CustomField:Invoice__c.Amount__c');
    expect(keys.filter((k) => k.includes('Status__c'))).toEqual([]);
  });

  it('ignores identifiers inside comments and string literals', () => {
    const body = `public class X {
      // InvoiceHelper mentioned in a comment
      /* also Invoice__c here */
      String s = 'InvoiceHelper';
    }`;
    const refs = extractApexRefs(body, known(), 'X');
    expect(refs).toEqual([]);
  });
});

describe('extractObjectXmlRefs', () => {
  it('finds lookup targets and local field references in formulas', () => {
    const refs = extractObjectXmlRefs(INVOICE_OBJECT_XML, 'Invoice__c', known());
    const keys = refs.map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toContain('CustomObject:Account');
    expect(keys).toContain('CustomField:Invoice__c.Amount__c');
  });
});

describe('extractPermissionSetRefs', () => {
  it('finds object, field, and class access edges', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses><apexClass>InvoiceService</apexClass><enabled>true</enabled></classAccesses>
    <fieldPermissions><editable>true</editable><field>Invoice__c.Amount__c</field><readable>true</readable></fieldPermissions>
    <objectPermissions><allowRead>true</allowRead><object>Invoice__c</object></objectPermissions>
</PermissionSet>`;
    const keys = extractPermissionSetRefs(xml).map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toContain('CustomObject:Invoice__c');
    expect(keys).toContain('CustomField:Invoice__c.Amount__c');
    expect(keys).toContain('ApexClass:InvoiceService');
  });
});

describe('extractAllEdges', () => {
  it('builds a coherent edge set over a whole indexed snapshot', () => {
    const files = new Map(
      Object.entries({
        'classes/InvoiceService.cls': strToU8(INVOICE_SERVICE_APEX),
        'classes/InvoiceHelper.cls': strToU8(INVOICE_HELPER_APEX),
        'objects/Invoice__c.object': strToU8(INVOICE_OBJECT_XML),
        'flows/Send_Invoice.flow': strToU8(SEND_INVOICE_FLOW_XML),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-08-06T00:00:00.000Z');
    const edges = extractAllEdges('conn1', artifacts);
    const keys = edges.map((e) => `${e.fromType}:${e.fromName}→${e.toType}:${e.toName}`);
    expect(keys).toContain('Flow:Send_Invoice→ApexClass:InvoiceService');
    expect(keys).toContain('Flow:Send_Invoice→CustomObject:Invoice__c');
    expect(keys).toContain('ApexClass:InvoiceService→ApexClass:InvoiceHelper');
    expect(keys).toContain('ApexClass:InvoiceService→CustomObject:Invoice__c');
    expect(keys).toContain('ApexClass:InvoiceHelper→CustomObject:Invoice__c');
    expect(edges.every((e) => e.source === 'extractor')).toBe(true);
  });
});
