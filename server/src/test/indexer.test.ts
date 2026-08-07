import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { indexSnapshotFiles, extractChildBlocks, findChildBlock } from '../snapshot/indexer.js';
import { SnapshotStore } from '../snapshot/store.js';
import type { FileProperties } from '../salesforce/metadataSoap.js';
import {
  CUSTOM_LABELS_XML,
  INVOICE_OBJECT_XML,
  INVOICE_SERVICE_APEX,
  SEND_INVOICE_FLOW_XML,
} from './fixtures.js';

const PROPS: FileProperties[] = [
  {
    type: 'ApexClass',
    fullName: 'InvoiceService',
    fileName: 'classes/InvoiceService.cls',
    id: '01p1',
    lastModifiedDate: '2026-08-01T10:00:00.000Z',
    lastModifiedByName: 'Ryley Hayes',
  },
  {
    type: 'CustomObject',
    fullName: 'Invoice__c',
    fileName: 'objects/Invoice__c.object',
    id: '01I1',
    lastModifiedDate: '2026-07-15T09:00:00.000Z',
    lastModifiedByName: 'Ryley Hayes',
  },
];

function fixtureFiles(): Map<string, Uint8Array> {
  return new Map(
    Object.entries({
      'package.xml': strToU8('<Package/>'),
      'classes/InvoiceService.cls': strToU8(INVOICE_SERVICE_APEX),
      'classes/InvoiceService.cls-meta.xml': strToU8('<ApexClass/>'),
      'objects/Invoice__c.object': strToU8(INVOICE_OBJECT_XML),
      'flows/Send_Invoice.flow': strToU8(SEND_INVOICE_FLOW_XML),
      'labels/CustomLabels.labels': strToU8(CUSTOM_LABELS_XML),
    }),
  );
}

describe('indexSnapshotFiles', () => {
  it('indexes classes, flows, objects (with children), and labels (with children)', () => {
    const artifacts = indexSnapshotFiles(fixtureFiles(), PROPS, '2026-08-06T00:00:00.000Z');
    const byKey = new Map(artifacts.map((a) => [`${a.type}:${a.apiName}`, a]));

    expect(byKey.has('ApexClass:InvoiceService')).toBe(true);
    expect(byKey.has('Flow:Send_Invoice')).toBe(true);
    expect(byKey.has('CustomObject:Invoice__c')).toBe(true);
    expect(byKey.has('CustomField:Invoice__c.Amount__c')).toBe(true);
    expect(byKey.has('CustomField:Invoice__c.Status__c')).toBe(true);
    expect(byKey.has('CustomField:Invoice__c.Account__c')).toBe(true);
    expect(byKey.has('ValidationRule:Invoice__c.Positive_Amount')).toBe(true);
    expect(byKey.has('CustomLabels:CustomLabels')).toBe(true);
    expect(byKey.has('CustomLabel:Invoice_Alert')).toBe(true);
    // meta files and package.xml never become artifacts
    expect(artifacts.some((a) => a.apiName.includes('meta'))).toBe(false);

    const cls = byKey.get('ApexClass:InvoiceService')!;
    expect(cls.lastModifiedDate).toBe('2026-08-01T10:00:00.000Z');
    expect(cls.lastModifiedBy).toBe('Ryley Hayes');
    expect(cls.content).toContain('InvoiceHelper.process');

    // children inherit the container's file props
    const field = byKey.get('CustomField:Invoice__c.Amount__c')!;
    expect(field.lastModifiedDate).toBe('2026-07-15T09:00:00.000Z');
    expect(field.filePath).toBe('objects/Invoice__c.object');
    expect(field.content).toContain('<fullName>Amount__c</fullName>');
  });

  it('extracts and finds child blocks case-insensitively', () => {
    expect(extractChildBlocks(INVOICE_OBJECT_XML, 'fields')).toHaveLength(3);
    const block = findChildBlock(INVOICE_OBJECT_XML, 'validationRules', 'positive_amount');
    expect(block).toContain('Amount must be positive');
    expect(findChildBlock(INVOICE_OBJECT_XML, 'fields', 'Nope__c')).toBeNull();
  });
});

describe('SnapshotStore.extractRetrieveZip', () => {
  it('strips the unpackaged/ prefix and preserves content', () => {
    const zip = zipSync({
      'unpackaged/classes/Foo.cls': strToU8('public class Foo {}'),
      'unpackaged/package.xml': strToU8('<Package/>'),
    });
    const store = new SnapshotStore();
    const files = store.extractRetrieveZip(Buffer.from(zip));
    expect([...files.keys()].sort()).toEqual(['classes/Foo.cls', 'package.xml']);
    expect(Buffer.from(files.get('classes/Foo.cls')!).toString()).toBe('public class Foo {}');
  });

  it('refuses traversal-shaped entries', () => {
    const zip = zipSync({ 'unpackaged/../../evil.txt': strToU8('x') });
    const store = new SnapshotStore();
    expect(() => store.extractRetrieveZip(Buffer.from(zip))).toThrow(/unsafe zip entry/);
  });
});
