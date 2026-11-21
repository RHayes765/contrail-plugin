import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import { SnapshotStore } from '../snapshot/store.js';
import { renderApprovalPage, type ApprovalPageOptions } from '../connect/pages.js';
import {
  AUTOMATION_FLOW_FILE_CAP,
  NOT_COVERED,
  collectObjectAutomation,
  formatAutomationLines,
  parseApexObjectTargets,
  parseFlowStart,
  parseTriggerHeader,
  type ObjectAutomation,
} from '../deps/automation.js';

/**
 * S45 F3: the automation card — every Flow file read (never an edge or
 * search query), classified on triggerType, the empty line withheld whenever
 * something it depends on was not read, the six not_covered lines always on,
 * and the page card escaped.
 */

const CONN = 'conn-auto';
const RETRIEVED = '2026-11-10T09:30:00.000Z';

let tmp: string;
let db: ContrailDb;
let store: SnapshotStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-automation-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The desktop flowgraph.test.ts envelope: top-level facts around a start block. */
function flowXml(opts: {
  status: string;
  processType?: string;
  start?: string;
  body?: string;
  topLevel?: string;
  label?: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    ${opts.body ?? ''}
    <label>${opts.label ?? 'A Flow'}</label>
    ${opts.topLevel ?? ''}
    <processType>${opts.processType ?? 'AutoLaunchedFlow'}</processType>
    ${opts.start ?? ''}
    <status>${opts.status}</status>
</Flow>`;
}

function recordStart(object: string, triggerType: string, extra = ''): string {
  return `<start>
        <locationX>50</locationX>
        <connector><targetReference>Step_One</targetReference></connector>
        ${extra}
        <object>${object}</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>${triggerType}</triggerType>
    </start>`;
}

const SCHEDULED_START = `<start>
        <locationX>50</locationX>
        <connector><targetReference>Step_One</targetReference></connector>
        <filters/>
        <object>Account</object>
        <schedule>
            <frequency>Daily</frequency>
            <startDate>2026-01-05</startDate>
            <startTime>06:00:00.000Z</startTime>
        </schedule>
        <triggerType>Scheduled</triggerType>
    </start>`;

/** A flow that only LOOKS UP the object — the shape edgesTo would return. */
const LOOKUP_BODY = `<recordLookups>
        <name>Get_Invoice</name>
        <label>Get Invoice</label>
        <object>Invoice__c</object>
        <filters><field>Id</field><operator>EqualTo</operator></filters>
    </recordLookups>`;

const INVOICE_OBJECT = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Invoice</label>
    <validationRules>
        <fullName>Positive_Amount</fullName>
        <active>true</active>
        <errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>
        <errorMessage>Amount must be positive</errorMessage>
    </validationRules>
    <validationRules>
        <fullName>Old_Rule</fullName>
        <active>false</active>
        <errorConditionFormula>false</errorConditionFormula>
        <errorMessage>never</errorMessage>
    </validationRules>
</CustomObject>`;

const EMPTY_OBJECT = (label: string) => `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>${label}</label>
</CustomObject>`;

const TRIGGER_META = (status: string) => `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>63.0</apiVersion>
    <status>${status}</status>
</ApexTrigger>`;

const DIRS: Record<string, { dir: string; ext: string }> = {
  Flow: { dir: 'flows', ext: '.flow' },
  ApexTrigger: { dir: 'triggers', ext: '.trigger' },
  CustomObject: { dir: 'objects', ext: '.object' },
};

/**
 * Seed one snapshot: `members` become index rows AND files; `extraFiles` are
 * files with no row (the -meta.xml sidecars the indexer skips).
 */
function seed(
  members: Array<{ type: string; name: string; body: string | null }>,
  extraFiles: Record<string, string> = {},
): void {
  const files = new Map<string, Uint8Array>();
  for (const m of members) {
    const spec = DIRS[m.type]!;
    if (m.body !== null) files.set(`${spec.dir}/${m.name}${spec.ext}`, Buffer.from(m.body));
  }
  for (const [rel, body] of Object.entries(extraFiles)) files.set(rel, Buffer.from(body));
  store.writeCurrent(CONN, files);
  db.replaceArtifactsForTypes(
    CONN,
    Object.keys(DIRS),
    members.map((m) => {
      const spec = DIRS[m.type]!;
      return {
        connectionId: CONN,
        type: m.type,
        apiName: m.name,
        filePath: `${spec.dir}/${m.name}${spec.ext}`,
        contentHash: 'h',
        lastModifiedDate: null,
        lastModifiedBy: null,
        retrievedAt: RETRIEVED,
        content: '',
      };
    }),
  );
}

function collect(object: string, maxFlowFiles?: number): ObjectAutomation {
  return collectObjectAutomation({
    db,
    store,
    connectionId: CONN,
    object,
    ...(maxFlowFiles !== undefined ? { maxFlowFiles } : {}),
  });
}

const EMPTY_LINE = (object: string) =>
  `No active record-triggered flows, Apex triggers, or validation rules for ${object} in the snapshot.`;

describe('collectObjectAutomation — flow selection reads every flow file', () => {
  it('finds the one active record-triggered flow listed LAST behind 60 flows that only look the object up', () => {
    const members: Array<{ type: string; name: string; body: string | null }> = [];
    for (let i = 0; i < 60; i++) {
      members.push({
        type: 'Flow',
        name: `Lookup_${String(i).padStart(2, '0')}`,
        body: flowXml({
          status: 'Active',
          body: LOOKUP_BODY,
          start: '<start><connector><targetReference>Get_Invoice</targetReference></connector></start>',
        }),
      });
    }
    members.push({
      type: 'Flow',
      name: 'Zz_Invoice_After_Save',
      body: flowXml({ status: 'Active', start: recordStart('Invoice__c', 'RecordAfterSave') }),
    });
    members.push({ type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') });
    seed(members);
    // Every lookup flow is an edge into the object — exactly the set a
    // per-object cap over edgesTo would have truncated.
    db.replaceEdges(
      CONN,
      'extractor',
      ['Flow'],
      members
        .filter((m) => m.type === 'Flow')
        .map((m) => ({
          connectionId: CONN,
          fromType: 'Flow',
          fromName: m.name,
          toType: 'CustomObject',
          toName: 'Invoice__c',
          source: 'extractor' as const,
        })),
    );

    const a = collect('Invoice__c');
    expect(db.listArtifacts(CONN, 'Flow').at(-1)!.apiName).toBe('Zz_Invoice_After_Save');
    expect(a.flows.map((f) => f.name)).toEqual(['Zz_Invoice_After_Save']);
    expect(a.flow_files_read).toBe(61);
    expect(a.flow_files_total).toBe(61);
    expect(a.inactive_flow_count).toBe(0);
    expect(a.summary_lines.join('\n')).not.toContain('were read');
    expect(a.summary_lines).not.toContain(EMPTY_LINE('Invoice__c'));
  });

  it('past the file cap: the truncation line appears and the empty-state sentence is withheld', () => {
    expect(AUTOMATION_FLOW_FILE_CAP).toBe(2000);
    const members: Array<{ type: string; name: string; body: string | null }> = [];
    for (let i = 0; i < 7; i++) {
      members.push({
        type: 'Flow',
        name: `Other_${i}`,
        body: flowXml({ status: 'Active', start: recordStart('Contact', 'RecordAfterSave') }),
      });
    }
    // Sorted last: beyond a cap of 5, so never read.
    members.push({
      type: 'Flow',
      name: 'Zz_Invoice_After_Save',
      body: flowXml({ status: 'Active', start: recordStart('Invoice__c', 'RecordAfterSave') }),
    });
    members.push({ type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') });
    seed(members);

    const a = collect('Invoice__c', 5);
    expect(a.flow_files_read).toBe(5);
    expect(a.flow_files_total).toBe(8);
    expect(a.flows).toEqual([]);
    expect(a.summary_lines).toContain(
      'Only 5 of 8 flow files were read; the flow list above may be incomplete',
    );
    expect(a.summary_lines).not.toContain(EMPTY_LINE('Invoice__c'));

    // Uncapped, the same snapshot finds it and drops the truncation line.
    const full = collect('Invoice__c');
    expect(full.flows.map((f) => f.name)).toEqual(['Zz_Invoice_After_Save']);
    expect(full.summary_lines.join('\n')).not.toContain('were read');
  });

  it('a flow file listed in the index but missing on disk counts as unread', () => {
    seed([
      { type: 'Flow', name: 'Gone', body: null },
      { type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') },
    ]);
    const a = collect('Invoice__c');
    expect(a.flow_files_read).toBe(0);
    expect(a.flow_files_total).toBe(1);
    expect(a.summary_lines).toContain(
      'Only 0 of 1 flow files were read; the flow list above may be incomplete',
    );
    expect(a.summary_lines).not.toContain(EMPTY_LINE('Invoice__c'));
    expect(a.notes.join('\n')).toContain('Gone');
  });

  it('reads every flow file once per snapshot — the objects of one page share the pass', () => {
    seed([
      {
        type: 'Flow',
        name: 'Invoice_Flow',
        body: flowXml({ status: 'Active', start: recordStart('Invoice__c', 'RecordAfterSave') }),
      },
      {
        type: 'Flow',
        name: 'Contact_Flow',
        body: flowXml({ status: 'Active', start: recordStart('Contact', 'RecordBeforeSave') }),
      },
    ]);
    const spy = vi.spyOn(store, 'readCurrentFile');
    const flowReads = () =>
      spy.mock.calls.filter((c) => String(c[1]).startsWith('flows/')).length;
    expect(collect('Invoice__c').flows.map((f) => f.name)).toEqual(['Invoice_Flow']);
    expect(collect('Contact').flows.map((f) => f.name)).toEqual(['Contact_Flow']);
    expect(flowReads()).toBe(2);

    // A refresh re-stamps the rows → the next page reads the files again.
    db.replaceArtifactsForTypes(
      CONN,
      ['Flow'],
      ['Invoice_Flow', 'Contact_Flow'].map((name) => ({
        connectionId: CONN,
        type: 'Flow',
        apiName: name,
        filePath: `flows/${name}.flow`,
        contentHash: 'h',
        lastModifiedDate: null,
        lastModifiedBy: null,
        retrievedAt: '2026-11-11T09:30:00.000Z',
      })),
    );
    collect('Invoice__c');
    expect(flowReads()).toBe(4);
  });
});

describe('collectObjectAutomation — classification on triggerType', () => {
  it('formats an active record-triggered flow with its fan-out, and counts inactive ones', () => {
    seed([
      {
        type: 'Flow',
        name: 'Invoice_Router',
        body: flowXml({
          status: 'Active',
          label: 'Invoice Router',
          start: recordStart(
            'Invoice__c',
            'RecordAfterSave',
            `<filterLogic>and</filterLogic>
        <filters><field>Status__c</field><operator>EqualTo</operator>
            <value><stringValue>Open</stringValue></value></filters>
        <scheduledPaths>
            <name>Later</name>
            <label>1 day later</label>
            <offsetNumber>1</offsetNumber>
            <offsetUnit>Days</offsetUnit>
            <connector><targetReference>Step_Two</targetReference></connector>
        </scheduledPaths>`,
          ),
        }),
      },
      {
        type: 'Flow',
        name: 'Invoice_Draft',
        body: flowXml({ status: 'Draft', start: recordStart('Invoice__c', 'RecordBeforeSave') }),
      },
      {
        type: 'Flow',
        name: 'Invoice_Obsolete',
        body: flowXml({ status: 'Obsolete', start: recordStart('Invoice__c', 'RecordBeforeDelete') }),
      },
      { type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') },
    ]);
    db.replaceEdges(CONN, 'extractor', ['Flow'], [
      {
        connectionId: CONN,
        fromType: 'Flow',
        fromName: 'Invoice_Router',
        toType: 'ApexClass',
        toName: 'InvoiceService',
        source: 'extractor',
      },
      {
        connectionId: CONN,
        fromType: 'Flow',
        fromName: 'Invoice_Router',
        toType: 'Flow',
        toName: 'Sub_Notify',
        source: 'extractor',
      },
      {
        connectionId: CONN,
        fromType: 'Flow',
        fromName: 'Invoice_Router',
        toType: 'CustomField',
        toName: 'Invoice__c.Status__c',
        source: 'extractor',
      },
    ]);

    const a = collect('invoice__c');
    expect(a.flows).toHaveLength(1);
    expect(a.flows[0]).toMatchObject({
      name: 'Invoice_Router',
      label: 'Invoice Router',
      status: 'Active',
      trigger_type: 'RecordAfterSave',
      record_trigger_type: 'CreateAndUpdate',
      entry_criteria: true,
      scheduled_paths: 1,
    });
    expect(a.flows[0]!.calls).toEqual([
      { type: 'ApexClass', name: 'InvoiceService' },
      { type: 'Flow', name: 'Sub_Notify' },
    ]);
    expect(a.inactive_flow_count).toBe(2);
    expect(a.summary_lines).toContain(
      'Flow Invoice_Router — Active · record-triggered, after save, on create or update · ' +
        'entry criteria: yes · scheduled paths: 1 · calls Apex InvoiceService, Flow Sub_Notify',
    );
    expect(a.summary_lines).toContain(
      '2 other record-triggered flows on invoice__c are not Active in the snapshot (latest ' +
        'version Draft, Obsolete, InvalidDraft or UnderReview)',
    );
    expect(a.summary_lines).not.toContain(EMPTY_LINE('invoice__c'));
  });

  it('a Draft Scheduled flow is listed under scheduled_flows and never counted as inactive', () => {
    seed([
      {
        type: 'Flow',
        name: 'Nightly_Draft',
        body: flowXml({ status: 'Draft', start: SCHEDULED_START }),
      },
      { type: 'CustomObject', name: 'Account', body: EMPTY_OBJECT('Account') },
    ]);
    const a = collect('Account');
    expect(a.inactive_flow_count).toBe(0);
    expect(a.flows).toEqual([]);
    expect(a.scheduled_flows).toEqual([
      { name: 'Nightly_Draft', status: 'Draft', frequency: 'Daily', start_date: '2026-01-05' },
    ]);
    expect(a.summary_lines.join('\n')).not.toContain('other record-triggered flows');
  });

  it('an Active Scheduled flow appears under scheduled_flows and does NOT suppress the empty line', () => {
    seed([
      {
        type: 'Flow',
        name: 'Nightly_Cleanup',
        body: flowXml({ status: 'Active', start: SCHEDULED_START }),
      },
      { type: 'CustomObject', name: 'Account', body: EMPTY_OBJECT('Account') },
    ]);
    const a = collect('Account');
    expect(a.flows).toEqual([]);
    expect(a.scheduled_flows).toEqual([
      { name: 'Nightly_Cleanup', status: 'Active', frequency: 'Daily', start_date: '2026-01-05' },
    ]);
    expect(a.summary_lines).toEqual([
      'Flow Nightly_Cleanup — Active · scheduled (Daily from 2026-01-05) — runs on a schedule, ' +
        'not on save',
      EMPTY_LINE('Account'),
    ]);
  });

  it('a PlatformEvent flow is absent for an ordinary sObject and present for the event', () => {
    seed([
      {
        type: 'Flow',
        name: 'On_Order_Placed',
        body: flowXml({
          status: 'Active',
          start: `<start><object>Order_Placed__e</object><triggerType>PlatformEvent</triggerType></start>`,
        }),
      },
      {
        type: 'Flow',
        name: 'Odd_Event_Flow',
        body: flowXml({
          status: 'Active',
          start: `<start><object>Account</object><triggerType>PlatformEvent</triggerType></start>`,
        }),
      },
      { type: 'CustomObject', name: 'Account', body: EMPTY_OBJECT('Account') },
    ]);
    const account = collect('Account');
    expect(account.event_flows).toEqual([]);
    expect(account.flows).toEqual([]);
    expect(account.summary_lines.join('\n')).not.toContain('platform-event-triggered');
    expect(account.notes.join('\n')).toContain('Odd_Event_Flow');

    const event = collect('Order_Placed__e');
    expect(event.event_flows).toEqual([
      { name: 'On_Order_Placed', status: 'Active', event: 'Order_Placed__e' },
    ]);
    expect(event.summary_lines).toContain(
      'Flow On_Order_Placed — Active · platform-event-triggered — fires when Order_Placed__e ' +
        'is published',
    );
  });

  it('an unknown trigger type on the object is excluded and named in notes', () => {
    seed([
      {
        type: 'Flow',
        name: 'Segment_Flow',
        body: flowXml({
          status: 'Active',
          start: `<start><object>Account</object><triggerType>Segment</triggerType></start>`,
        }),
      },
      { type: 'CustomObject', name: 'Account', body: EMPTY_OBJECT('Account') },
    ]);
    const a = collect('Account');
    expect(a.flows).toEqual([]);
    expect(a.scheduled_flows).toEqual([]);
    expect(a.event_flows).toEqual([]);
    expect(a.notes.some((n) => n.includes('Segment_Flow') && n.includes('Segment'))).toBe(true);
    expect(a.summary_lines.join('\n')).not.toContain('Segment_Flow');
  });

  it('Process Builder rows come from processMetadataValues ObjectType, labelled best-effort', () => {
    seed([
      {
        type: 'Flow',
        name: 'Account_Process',
        body: flowXml({
          status: 'Active',
          processType: 'Workflow',
          body: `<actionCalls>
        <processMetadataValues><name>ObjectType</name>
            <value><stringValue>Contact</stringValue></value></processMetadataValues>
        <name>Action_One</name><label>Action One</label>
    </actionCalls>`,
          topLevel: `<processMetadataValues>
        <name>ObjectType</name>
        <value><stringValue>Account</stringValue></value>
    </processMetadataValues>`,
        }),
      },
      { type: 'CustomObject', name: 'Account', body: EMPTY_OBJECT('Account') },
    ]);
    expect(parseFlowStart(fs.readFileSync(
      path.join(tmp, 'snapshots', CONN, 'current', 'flows', 'Account_Process.flow'),
      'utf8',
    )).process_object).toBe('Account');
    const a = collect('Account');
    expect(a.processes).toEqual([
      { name: 'Account_Process', status: 'Active', object_source: 'processMetadataValues' },
    ]);
    expect(a.summary_lines).toContain(
      'Process (Process Builder) Account_Process — Active · object read from ' +
        'processMetadataValues (best-effort, unverified)',
    );
    expect(collect('Contact').processes).toEqual([]);
  });
});

describe('collectObjectAutomation — triggers and validation rules', () => {
  it('trigger status comes from the -meta.xml sidecar; without it the status is unknown', () => {
    seed(
      [
        {
          type: 'ApexTrigger',
          name: 'InvoiceTrigger',
          body: '// trigger Decoy on Contact (before delete)\n' +
            'trigger InvoiceTrigger on Invoice__c (before insert, after   update) {\n}\n',
        },
        {
          type: 'ApexTrigger',
          name: 'InvoiceAudit',
          body: '/* audit */ trigger InvoiceAudit on Invoice__c (after delete) {}',
        },
        {
          type: 'ApexTrigger',
          name: 'OldInvoiceTrigger',
          body: 'trigger OldInvoiceTrigger on Invoice__c (before update) {}',
        },
        {
          type: 'ApexTrigger',
          name: 'ContactTrigger',
          body: 'trigger ContactTrigger on Contact (before insert) {}',
        },
        { type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') },
      ],
      {
        'triggers/InvoiceTrigger.trigger-meta.xml': TRIGGER_META('Active'),
        'triggers/OldInvoiceTrigger.trigger-meta.xml': TRIGGER_META('Inactive'),
        'triggers/ContactTrigger.trigger-meta.xml': TRIGGER_META('Active'),
      },
    );
    const a = collect('Invoice__c');
    expect(a.triggers).toEqual([
      { name: 'InvoiceAudit', status: 'unknown', events: ['after delete'], meta_xml: false },
      {
        name: 'InvoiceTrigger',
        status: 'Active',
        events: ['before insert', 'after update'],
        meta_xml: true,
      },
      { name: 'OldInvoiceTrigger', status: 'Inactive', events: ['before update'], meta_xml: true },
    ]);
    expect(a.summary_lines).toContain('Trigger InvoiceTrigger — Active · before insert, after update');
    expect(a.summary_lines).toContain(
      'Trigger InvoiceAudit — status unknown (no trigger-meta.xml in the snapshot) · after delete',
    );
    expect(a.summary_lines).toContain('Trigger OldInvoiceTrigger — Inactive · before update');
    expect(a.summary_lines.join('\n')).not.toContain('ContactTrigger');
    // An unknown status may be active — the empty line is withheld.
    expect(a.summary_lines).not.toContain(EMPTY_LINE('Invoice__c'));
  });

  it('only inactive triggers on the object leave the empty line standing', () => {
    seed(
      [
        {
          type: 'ApexTrigger',
          name: 'OldInvoiceTrigger',
          body: 'trigger OldInvoiceTrigger on Invoice__c (before update) {}',
        },
        { type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') },
      ],
      { 'triggers/OldInvoiceTrigger.trigger-meta.xml': TRIGGER_META('Inactive') },
    );
    expect(collect('Invoice__c').summary_lines).toEqual([
      'Trigger OldInvoiceTrigger — Inactive · before update',
      EMPTY_LINE('Invoice__c'),
    ]);
    // A caller editing one answer never edits the memoized pass behind the next.
    collect('Invoice__c').triggers[0]!.events.push('after delete');
    expect(collect('Invoice__c').triggers[0]!.events).toEqual(['before update']);
  });

  it('a trigger whose header does not parse is named in notes and withholds the empty line', () => {
    seed([
      { type: 'ApexTrigger', name: 'Mangled', body: 'this is not apex' },
      { type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') },
    ]);
    const a = collect('Invoice__c');
    expect(a.triggers).toEqual([]);
    expect(a.notes.join('\n')).toContain('Mangled');
    expect(a.unread_sources).toContain('trigger Mangled');
    expect(a.summary_lines).not.toContain(EMPTY_LINE('Invoice__c'));
  });

  it('validation rules: active ones listed, inactive ones counted, the formula kept as data', () => {
    seed([{ type: 'CustomObject', name: 'Invoice__c', body: INVOICE_OBJECT }]);
    const a = collect('Invoice__c');
    expect(a.validation_rules).toEqual([
      { name: 'Positive_Amount', active: true, error_condition: 'Amount__c < 0' },
      { name: 'Old_Rule', active: false, error_condition: 'false' },
    ]);
    expect(a.summary_lines).toEqual([
      'Validation rule Positive_Amount — active',
      '1 inactive validation rules not listed',
    ]);
    expect(a.snapshot_at).toBe(RETRIEVED);
  });

  it('no object file in the snapshot: validation rules unread, named in notes, empty line withheld', () => {
    seed([
      {
        type: 'Flow',
        name: 'Contact_Flow',
        body: flowXml({ status: 'Active', start: recordStart('Contact', 'RecordAfterSave') }),
      },
    ]);
    const a = collect('Lead');
    expect(a.validation_rules).toEqual([]);
    expect(a.unread_sources).toEqual(['objects/Lead.object']);
    expect(a.notes.join('\n')).toContain('validation rules were not read');
    expect(a.summary_lines).toEqual([]);
    // Nothing read is about Lead: no date is borrowed from the Contact flow.
    expect(a.snapshot_at).toBeNull();
    expect(a.notes.join('\n')).toContain(
      'Nothing read from the snapshot (object row, flows, triggers) is about Lead, so this card ' +
        'has no snapshot date.',
    );
  });

  it('snapshot_at: the object row, else a flow ON the object, else a trigger ON it — never an unrelated flow', () => {
    seed([
      {
        type: 'Flow',
        name: 'Contact_Flow',
        body: flowXml({ status: 'Active', start: recordStart('Contact', 'RecordAfterSave') }),
      },
      {
        type: 'Flow',
        name: 'Invoice_Flow',
        body: flowXml({ status: 'Active', start: recordStart('Invoice__c', 'RecordAfterSave') }),
      },
      {
        type: 'ApexTrigger',
        name: 'InvoiceTrigger',
        body: 'trigger InvoiceTrigger on Invoice__c (before insert) {}',
      },
      {
        type: 'ApexTrigger',
        name: 'LeadTrigger',
        body: 'trigger LeadTrigger on Lead (before insert) {}',
      },
      { type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') },
    ]);
    // Distinct retrieval times per row, so each source is told apart.
    const stamps: Record<string, string> = {
      Contact_Flow: '2026-11-12T00:00:00.000Z',
      Invoice_Flow: '2026-11-11T00:00:00.000Z',
      InvoiceTrigger: '2026-11-09T00:00:00.000Z',
      LeadTrigger: '2026-11-08T00:00:00.000Z',
      Invoice__c: '2026-11-07T00:00:00.000Z',
    };
    const restamp = (keep: (name: string) => boolean) =>
      db.replaceArtifactsForTypes(
        CONN,
        Object.keys(DIRS),
        db
          .listArtifacts(CONN)
          .filter((r) => keep(r.apiName))
          .map((r) => ({ ...r, content: '', retrievedAt: stamps[r.apiName]! })),
      );
    restamp(() => true);
    // The object's own row wins over the flow and trigger on it.
    expect(collect('Invoice__c').snapshot_at).toBe(stamps.Invoice__c);
    // No object row: the flow ON the object, never Contact_Flow (listed first, newer).
    restamp((n) => n !== 'Invoice__c');
    expect(collect('Invoice__c').snapshot_at).toBe(stamps.Invoice_Flow);
    // No object row and no flow on it: a trigger ON the object.
    expect(collect('Lead').snapshot_at).toBe(stamps.LeadTrigger);
    // Nothing about the object at all: null, even though flows exist.
    expect(collect('Opportunity').snapshot_at).toBeNull();
  });

  it('flow and trigger rows OLDER than the heading date are disclosed; equal dates add nothing', () => {
    seed([
      {
        type: 'Flow',
        name: 'Contact_Flow',
        body: flowXml({ status: 'Active', start: recordStart('Contact', 'RecordAfterSave') }),
      },
      {
        type: 'ApexTrigger',
        name: 'LeadTrigger',
        body: 'trigger LeadTrigger on Lead (before insert) {}',
      },
      { type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') },
    ]);
    // Same retrievedAt everywhere (seed): no disclosure, the empty line stands.
    const same = collect('Invoice__c');
    expect(same.source_dates).toEqual({ flows: RETRIEVED, triggers: RETRIEVED });
    expect(same.summary_lines).toEqual([EMPTY_LINE('Invoice__c')]);

    // A CustomObject-only refresh on 2026-11-15 over flows and triggers from 2026-08-01.
    const restamp = (stamp: (type: string) => string) =>
      db.replaceArtifactsForTypes(
        CONN,
        Object.keys(DIRS),
        db.listArtifacts(CONN).map((r) => ({ ...r, content: '', retrievedAt: stamp(r.type) })),
      );
    restamp((t) => (t === 'CustomObject' ? '2026-11-15T08:00:00.000Z' : '2026-08-01T08:00:00.000Z'));
    const older = collect('Invoice__c');
    expect(older.snapshot_at).toBe('2026-11-15T08:00:00.000Z');
    expect(older.summary_lines).toEqual([
      'Flows in the snapshot were last retrieved 2026-08-01T08:00:00.000Z and Apex triggers ' +
        '2026-08-01T08:00:00.000Z — earlier than the date above; anything added or changed in the ' +
        'org since then is not visible either.',
      EMPTY_LINE('Invoice__c'),
    ]);

    // Only the flows are older: only they are named.
    restamp((t) =>
      t === 'Flow' ? '2026-08-01T08:00:00.000Z' : '2026-11-15T08:00:00.000Z',
    );
    expect(collect('Invoice__c').summary_lines[0]).toBe(
      'Flows in the snapshot were last retrieved 2026-08-01T08:00:00.000Z — earlier than the date ' +
        'above; anything added or changed in the org since then is not visible either.',
    );
  });
});

describe('collectObjectAutomation — the empty line and not_covered', () => {
  it('the empty line: object file read, every flow read, nothing on the object', () => {
    seed([
      {
        type: 'Flow',
        name: 'Contact_Flow',
        body: flowXml({ status: 'Active', start: recordStart('Contact', 'RecordAfterSave') }),
      },
      { type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') },
    ]);
    const a = collect('Invoice__c');
    expect(a.summary_lines).toEqual([
      'No active record-triggered flows, Apex triggers, or validation rules for Invoice__c in ' +
        'the snapshot.',
    ]);
    expect(a.unread_sources).toEqual([]);
    expect(a.flow_files_read).toBe(1);
  });

  it('the six not_covered lines are always present, verbatim', () => {
    const six = [
      'Workflow rules and email alerts (Workflow is not snapshotted)',
      'Assignment, escalation, auto-response, duplicate and matching rules',
      'Managed-package automation (hidden or namespaced code)',
      'Dynamic Apex, and anything invoked indirectly — Apex called from the flows and triggers ' +
        'above is named, not expanded',
      'Anything added or changed in the org since the snapshot date above',
      "Older flow versions — the snapshot holds each flow's latest version; a flow shown as " +
        'Draft or Obsolete may still have an older active version',
    ];
    expect([...NOT_COVERED]).toEqual(six);
    // No snapshot at all, an invalid name, an empty answer, a populated one.
    expect(collect('Invoice__c').not_covered).toEqual(six);
    expect(collect("Account WHERE Id='x'").not_covered).toEqual(six);
    seed([{ type: 'CustomObject', name: 'Invoice__c', body: INVOICE_OBJECT }]);
    expect(collect('Invoice__c').not_covered).toEqual(six);
    expect(collect('Contact').not_covered).toEqual(six);
  });

  it('a connection with no snapshot says so and asserts nothing', () => {
    const a = collect('Invoice__c');
    expect(a.snapshot_at).toBeNull();
    expect(a.summary_lines).toEqual([]);
    expect(a.notes.join('\n')).toContain('no metadata snapshot');
  });

  it('never throws: a failing store becomes notes', () => {
    seed([
      {
        type: 'Flow',
        name: 'Invoice_Flow',
        body: flowXml({ status: 'Active', start: recordStart('Invoice__c', 'RecordAfterSave') }),
      },
      { type: 'CustomObject', name: 'Invoice__c', body: EMPTY_OBJECT('Invoice') },
    ]);
    const spy = vi.spyOn(store, 'readCurrentFile').mockImplementation(() => {
      throw new Error('disk on fire');
    });
    const a = collect('Invoice__c');
    expect(a.notes.join('\n')).toContain('disk on fire');
    expect(a.summary_lines).toContain(
      'Only 0 of 1 flow files were read; the flow list above may be incomplete',
    );
    expect(a.summary_lines).not.toContain(EMPTY_LINE('Invoice__c'));
    expect(a.not_covered).toHaveLength(6);

    // A pass that threw is not remembered: the next page reads again.
    spy.mockRestore();
    const again = collect('Invoice__c');
    expect(again.flows.map((f) => f.name)).toEqual(['Invoice_Flow']);
    expect(again.flow_files_read).toBe(1);
  });

  it('formatAutomationLines is a pure function of the shape (the desktop card re-renders from it)', () => {
    seed([{ type: 'CustomObject', name: 'Invoice__c', body: INVOICE_OBJECT }]);
    const a = collect('Invoice__c');
    expect(formatAutomationLines(JSON.parse(JSON.stringify(a)) as ObjectAutomation)).toEqual(
      a.summary_lines,
    );
  });
});

describe('parsers', () => {
  it('parseTriggerHeader strips comments before matching the header', () => {
    expect(
      parseTriggerHeader(
        '/* trigger Fake on Lead (after insert) */\n// trigger Other on Case (before delete)\n' +
          'trigger RealOne on Opportunity (Before Insert,\n  after  UPDATE) { }',
      ),
    ).toEqual({ name: 'RealOne', object: 'Opportunity', events: ['before insert', 'after update'] });
    expect(parseTriggerHeader('public class NotATrigger {}')).toBeNull();
  });

  it('parseFlowStart reads the flow\'s own label/status, never an element\'s', () => {
    const s = parseFlowStart(
      flowXml({
        status: 'Obsolete',
        label: 'The Real Label',
        body: `<decisions><name>D</name><label>Decision Label</label><status>Bogus</status></decisions>`,
        start: recordStart('Case', 'RecordBeforeSave'),
      }),
    );
    expect(s).toMatchObject({
      label: 'The Real Label',
      status: 'Obsolete',
      process_type: 'AutoLaunchedFlow',
      object: 'Case',
      trigger_type: 'RecordBeforeSave',
      record_trigger_type: 'CreateAndUpdate',
      entry_criteria: false,
      scheduled_paths: 0,
      schedule: null,
      process_object: null,
    });
  });

  it('parseApexObjectTargets: new X(, static FROM, Database.op(v), bare DML through declarations', () => {
    const script = `
      // insert new Fake__c(); — commented out
      List<Contact> contacts = [SELECT Id, (SELECT Id FROM Cases) FROM Contact WHERE Email = 'x FROM Lead'];
      Account acct = new Account(Name = 'Acme');
      insert acct;
      Invoice__c[] invoices = new List<Invoice__c>();
      Database.update(invoices, false);
      Helper h = new Helper();
      Integer n = 5;
      update contacts;
      throw new MyCustomException('boom');
      String q = 'SELECT Id FROM Opportunity';
      Database.query(q);
      class Wrapper { }
      Wrapper w = new Wrapper();
    `;
    expect(parseApexObjectTargets(script, ['Helper'])).toEqual(['Contact', 'Account', 'Invoice__c']);
  });

  it('parseTriggerHeader: comment stripping is linear — a valid 1,000,000-character trigger parses fast', () => {
    const header = 'trigger Big on Account (before insert, after update) {';
    const filler = '/* '.repeat(Math.ceil(1_000_000 / 3));
    const body = `${header}\n// ${filler}\n}`.slice(0, 1_000_000);
    expect(body.length).toBe(1_000_000);
    const started = performance.now();
    expect(parseTriggerHeader(body)).toEqual({
      name: 'Big',
      object: 'Account',
      events: ['before insert', 'after update'],
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('parseTriggerHeader: an unclosed /* inside a // comment hides nothing; a closed block comment is stripped as before', () => {
    expect(
      parseTriggerHeader('// see /* the old notes\ntrigger After on Case (before delete) {}'),
    ).toEqual({ name: 'After', object: 'Case', events: ['before delete'] });
    expect(
      parseTriggerHeader('/* trigger Fake on Lead (after insert) */ trigger Real on Lead (after insert) {}'),
    ).toEqual({ name: 'Real', object: 'Lead', events: ['after insert'] });
  });

  it('parseApexObjectTargets returns every distinct object in first-appearance order (the card caps, not the parser)', () => {
    const script = Array.from({ length: 14 }, (_, i) => `insert new Obj${i}__c();`).join('\n');
    expect(parseApexObjectTargets(script, [])).toEqual(
      Array.from({ length: 14 }, (_, i) => `Obj${i}__c`),
    );
  });

  it('parseApexObjectTargets: a // or /* inside a string hides nothing; a subquery with a call keeps the outer FROM', () => {
    const script = [
      "req.setEndpoint('https://example.com/api'); insert new Account(Name = 'x');",
      "String open = '/*'; insert new Lead(LastName = 'y'); String close = '*/';",
      'List<Case> cs = [SELECT Id, (SELECT Id FROM CaseComments WHERE CALENDAR_YEAR(CreatedDate) = 2020) FROM Case];',
      "// don't insert new Fake__c();",
    ].join('\n');
    expect(parseApexObjectTargets(script, [])).toEqual(['Account', 'Lead', 'Case']);
  });
});

describe('the approval-page card', () => {
  function pageWith(
    kind: ApprovalPageOptions['kind'],
    automation: ApprovalPageOptions['automation'],
    extra: Partial<ApprovalPageOptions> = {},
  ): string {
    return renderApprovalPage({
      ...extra,
      kind,
      code: 'ABCD-EFGH',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      org: { alias: 'a-dev-org', orgName: 'Dev', orgType: 'developer', instanceUrl: 'https://x' },
      changes: [{ label: 'INSERT Invoice__c: Name=x', warnings: [] }],
      destructive: [],
      results: [{ label: 'Mode', value: 'all-or-none' }],
      blast: [],
      ...(automation ? { automation } : {}),
    });
  }

  it('renders after Changes and before Validation, everything escaped', () => {
    seed(
      [
        {
          type: 'Flow',
          name: 'Invoice_Flow',
          body: flowXml({ status: 'Active', start: recordStart('Invoice__c', 'RecordAfterSave') }),
        },
        { type: 'CustomObject', name: 'Invoice__c', body: INVOICE_OBJECT },
      ],
    );
    const real = collect('Invoice__c');
    const hostile: ObjectAutomation = {
      ...real,
      object: 'Evil<script>alert(1)</script>',
      summary_lines: ['Flow <img src=x onerror=alert(1)> — Active'],
      notes: ['note with <b>markup</b> & "quotes"'],
    };
    const html = pageWith('dml', [real, hostile]);

    const d = new Date(RETRIEVED);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const heading =
      `AUTOMATION IN YOUR SNAPSHOT (from ${stamp}) — read from the local snapshot, not the live org`;
    expect(html).toContain(`<h2>${heading}</h2>`);
    const changesAt = html.indexOf('<h2>Changes</h2>');
    const cardAt = html.indexOf('AUTOMATION IN YOUR SNAPSHOT');
    const validationAt = html.indexOf('<h2>Validation</h2>');
    expect(changesAt).toBeGreaterThan(-1);
    expect(cardAt).toBeGreaterThan(changesAt);
    expect(validationAt).toBeGreaterThan(cardAt);

    expect(html).toContain(
      'Flow Invoice_Flow — Active · record-triggered, after save, on create or update · ' +
        'entry criteria: no',
    );
    expect(html).toContain('Validation rule Positive_Amount — active');
    expect(html).toContain('Not visible in the snapshot:');
    for (const line of NOT_COVERED) expect(html).toContain(`<li>${line.replaceAll("'", '&#39;')}</li>`);
    // The six lines once, even with two objects.
    expect(html.split('Workflow rules and email alerts').length - 1).toBe(1);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Evil&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Flow &lt;img src=x onerror=alert(1)&gt; — Active');
    expect(html).toContain('note with &lt;b&gt;markup&lt;/b&gt; &amp; &quot;quotes&quot;');
  });

  it('an Apex page names the parsed objects first; no automation → no card', () => {
    seed([{ type: 'CustomObject', name: 'Invoice__c', body: INVOICE_OBJECT }]);
    const html = pageWith('apex', [collect('Invoice__c'), collect('Contact')]);
    expect(html).toContain(
      'Objects this script MAY touch (parsed from the text; dynamic SOQL and called Apex hide ' +
        'more): Invoice__c, Contact',
    );
    expect(pageWith('dml', [collect('Invoice__c')])).not.toContain('Objects this script MAY touch');
    expect(pageWith('apex', [])).not.toContain('AUTOMATION IN YOUR SNAPSHOT');
    expect(pageWith('dml', undefined)).not.toContain('AUTOMATION IN YOUR SNAPSHOT');
  });

  it('an Apex page whose script names no object still renders the card: "none found in the text" + not_covered', () => {
    const html = pageWith('apex', [], { automationNotCovered: [...NOT_COVERED] });
    expect(html).toContain('AUTOMATION IN YOUR SNAPSHOT — read from the local snapshot, not the live org');
    expect(html).not.toContain('unknown date');
    const prefix =
      'Objects this script MAY touch (parsed from the text; dynamic SOQL and called Apex hide ' +
      'more): none found in the text';
    expect(html).toContain(prefix);
    expect(html.indexOf('Not visible in the snapshot:')).toBeGreaterThan(html.indexOf(prefix));
    for (const line of NOT_COVERED) expect(html).toContain(`<li>${line.replaceAll("'", '&#39;')}</li>`);
    // Only Apex pages take this path: a DML page with no objects shows no card.
    expect(pageWith('dml', [], { automationNotCovered: [...NOT_COVERED] })).not.toContain(
      'AUTOMATION IN YOUR SNAPSHOT',
    );
  });

  // S46 D6: a screenshot of this page pasted into the chat hands the agent the
  // code, and closing the tab voids nothing — so the card says what Contrail
  // does and what the human does, and no longer claims the agent "cannot see"
  // the page or that closing the tab makes "nothing happen".
  it('the code card: Contrail never gives the agent the page or the code — and a screenshot does', () => {
    for (const kind of ['deploy', 'dml', 'apex', 'bulk', 'activation'] as const) {
      const html = pageWith(kind, undefined);
      const from = html.indexOf('id="code-card"');
      const to = html.indexOf('id="dead"');
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      const card = html.slice(from, to);
      expect(card).toContain('ABCD-EFGH');
      expect(card).toContain('Contrail itself never gives the agent this page or the code');
      expect(card).toContain('a screenshot or copy pasted into the chat');
      expect(card).toContain('an agent that can view your screen');
      expect(card).toContain('close this tab and do not give the agent the code');
      expect(card).toContain('tell it you do not approve');
      expect(card).toContain('re-validating replaces it.');
      expect(html).not.toContain('The agent cannot see this page');
      expect(html).not.toContain('nothing happens');
    }
  });
});

describe('parseFlowStart in linear time (slow-path follow-up)', () => {
  // A flow is text an agent deployed, and the approval card for a data write
  // parses the snapshot's flows (up to 2,000 files). The patterns this
  // parser used started again from every opener with no closer after it and
  // read to the end (quadratic): about 16 s for 1 MB of such openers, with
  // every tool waiting. Each shape must answer in well under a second, and
  // the same.
  const MB = 1_000_000;
  const fill = (unit: string, bytes = MB) => unit.repeat(Math.floor(bytes / unit.length));
  const body =
    '<status>Active</status>' +
    '<processType>AutoLaunchedFlow</processType><start><object>Account</object>' +
    '<triggerType>RecordAfterSave</triggerType><recordTriggerType>Update</recordTriggerType>' +
    '</start>';
  const flow = `<Flow><label>Sync Owner</label>${body}`;

  it('element, label and start openers with no closer, packed close together', () => {
    const shapes: Array<[string, string, string | null]> = [
      ['element openers', flow + fill('<actionCalls>'), 'Sync Owner'],
      // A control: the flow's own label closes first, so the old pattern was
      // fast here too.
      ['label openers after the label', flow + fill('<label>'), 'Sync Owner'],
      // No label of its own: the first label opener has no closer after it.
      ['label openers and no label', `<Flow>${body}${fill('<label>')}`, null],
      ['start openers', flow + fill('<start>'), 'Sync Owner'],
    ];
    for (const [what, xml, label] of shapes) {
      const started = performance.now();
      const start = parseFlowStart(xml);
      const took = performance.now() - started;
      expect(start, what).toMatchObject({
        label,
        status: 'Active',
        process_type: 'AutoLaunchedFlow',
        object: 'Account',
        trigger_type: 'RecordAfterSave',
        record_trigger_type: 'Update',
        entry_criteria: false,
        scheduled_paths: 0,
      });
      expect(took, `${what}: ${Math.round(took)} ms`).toBeLessThan(1000);
    }
  });
});
