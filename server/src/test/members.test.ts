import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { SnapshotStore } from '../snapshot/store.js';
import { ContrailError } from '../core/errors.js';
import {
  CONNECTION_REMOVED_TEXT,
  MEMBER_REFRESH_MAX,
  MEMBER_REFRESH_NOTES,
  MEMBER_RESULT_REUSE_MS,
  REBASELINE_PROGRESS,
  REBASELINE_QUEUE_WAIT_MS,
  absenceVerdict,
  applyMemberUnits,
  executeSnapshotResult,
  isPackageOwnedState,
  memberJobId,
  memberOutcomes,
  memberRetrieveManifest,
  memberSkipText,
  noMetadataReadText,
  noSnapshotText,
  partialWriteText,
  planMemberUnits,
  removableUnitKeys,
  unitTypeCoverage,
  type MemberApplyInput,
  type MemberRefreshSummary,
  type MemberSkipReason,
  type MemberUnit,
  type SnapshotMember,
} from '../snapshot/members.js';
import type { PreImageListing } from '../deploy/preimage.js';
import type { FileProperties } from '../salesforce/metadataSoap.js';

// S46 Part C. The snapshot store's replaceCurrentUnits cases (shared
// foundations), then the member-unit planning, coverage, absence, apply and
// outcome cases of snapshot/members.ts and every text it owns.

const CONN = '11111111-2222-3333-4444-555555555555';
const enc = (s: string) => new TextEncoder().encode(s);

let base: string;
let store: SnapshotStore;
let current: string;
let staged: string;

/** Every file under a directory as rel path → bytes (hex), sorted; a link is recorded, never followed. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string) => {
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, e.name);
      const rel = path.relative(dir, child).replaceAll(path.sep, '/');
      if (e.isSymbolicLink()) out[rel] = 'link';
      else if (e.isDirectory()) walk(child);
      else out[rel] = fs.readFileSync(child).toString('hex');
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function put(rel: string, text: string): void {
  const file = path.join(current, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(rel: string): string | null {
  const file = path.join(current, ...rel.split('/'));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-members-'));
  store = new SnapshotStore(base);
  current = path.join(base, CONN, 'current');
  staged = path.join(base, CONN, 'staged');
  put('classes/InvoiceService.cls', 'old service');
  put('classes/InvoiceService.cls-meta.xml', 'old service meta');
  put('classes/InvoiceSelector.cls', 'selector');
  put('classes/InvoiceSelector.cls-meta.xml', 'selector meta');
  put('objects/Invoice__c.object', '<CustomObject>whole</CustomObject>');
  put('lwc/invoiceCard/invoiceCard.js', 'old js');
  put('lwc/invoiceCard/invoiceCard.html', 'old html');
  put('lwc/invoiceCard/invoiceCard.js-meta.xml', 'old lwc meta');
  put('lwc/otherCard/otherCard.js', 'other js');
  put('reports/Sales/Pipeline.report', 'pipeline');
  put('reports/Sales/Forecast.report', 'forecast');
  put('reports/Sales-meta.xml', 'folder meta');
  put('package.xml', 'package');
  fs.mkdirSync(path.join(base, CONN, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(base, CONN, 'archive', '2026-11-01T00-00-00.000Z.zip'), 'zip bytes');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

type Input = Parameters<SnapshotStore['replaceCurrentUnits']>[1];
function input(over: Partial<Input> = {}): Input {
  return { removeFiles: [], removeDirs: [], bundleTypeDirs: [], files: new Map(), ...over };
}

function expectRefused(over: Partial<Input>, rel: string): void {
  const before = tree(path.join(base, CONN));
  let caught: unknown;
  try {
    store.replaceCurrentUnits(CONN, input(over));
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ContrailError);
  expect((caught as ContrailError).code).toBe('unsafe_zip_entry');
  expect((caught as ContrailError).message).toBe(`unsafe snapshot path: ${rel}`);
  // Nothing changed — not current/, not archive/, and no staged/ was made.
  expect(tree(path.join(base, CONN))).toEqual(before);
  expect(fs.existsSync(staged)).toBe(false);
}

describe('replaceCurrentUnits — refusals, before any change', () => {
  it('one-segment paths: a top-level directory and package.xml are unrepresentable', () => {
    expectRefused({ files: new Map([['package.xml', enc('x')]]) }, 'package.xml');
    expectRefused({ removeFiles: ['classes'] }, 'classes');
    expectRefused({ removeDirs: ['lwc'], bundleTypeDirs: ['lwc'] }, 'lwc');
  });

  it('`..`, `.`, empty segments, a backslash, an absolute path or a drive letter', () => {
    expectRefused({ files: new Map([['classes/../../escape.cls', enc('x')]]) }, 'classes/../../escape.cls');
    expectRefused({ removeFiles: ['classes/./InvoiceService.cls'] }, 'classes/./InvoiceService.cls');
    expectRefused({ removeFiles: ['classes//InvoiceService.cls'] }, 'classes//InvoiceService.cls');
    expectRefused({ removeFiles: ['classes\\InvoiceService.cls'] }, 'classes\\InvoiceService.cls');
    expectRefused({ files: new Map([['/classes/Abs.cls', enc('x')]]) }, '/classes/Abs.cls');
    expectRefused({ files: new Map([['C:/classes/Abs.cls', enc('x')]]) }, 'C:/classes/Abs.cls');
    expectRefused({ removeDirs: ['lwc/..'], bundleTypeDirs: ['lwc'] }, 'lwc/..');
  });

  it('removeDirs: exactly two segments, under a declared bundle type directory', () => {
    expectRefused({ removeDirs: ['lwc/invoiceCard/sub'], bundleTypeDirs: ['lwc'] }, 'lwc/invoiceCard/sub');
    // A two-segment path that is a report folder, not a bundle: never removable.
    expectRefused({ removeDirs: ['reports/Sales'], bundleTypeDirs: ['lwc'] }, 'reports/Sales');
    expectRefused({ removeDirs: ['lwc/invoiceCard'], bundleTypeDirs: [] }, 'lwc/invoiceCard');
  });

  it('a directory at a removeFiles or files path is refused', () => {
    expectRefused({ removeFiles: ['lwc/invoiceCard'] }, 'lwc/invoiceCard');
    expectRefused({ files: new Map([['reports/Sales', enc('x')]]) }, 'reports/Sales');
  });

  it('a path under an existing file is refused, unless a write lands where that file is removed', () => {
    const write = (rel: string): Partial<Input> => ({ files: new Map([[rel, enc('x')]]) });
    expectRefused(write('classes/InvoiceService.cls/x.cls'), 'classes/InvoiceService.cls/x.cls');
    // A good removal ahead of the bad write is not made either.
    expectRefused(
      { removeFiles: ['classes/InvoiceSelector.cls'], ...write('classes/InvoiceService.cls/x.cls') },
      'classes/InvoiceService.cls/x.cls',
    );
    expectRefused({ removeFiles: ['objects/Invoice__c.object/x'] }, 'objects/Invoice__c.object/x');
    expectRefused(write('objects/Invoice__c.object/a/b'), 'objects/Invoice__c.object/a/b');
    // The file is removed before any staged file is moved into place, so this write can be made.
    const result = store.replaceCurrentUnits(
      CONN,
      input({ removeFiles: ['classes/InvoiceService.cls'], ...write('classes/InvoiceService.cls/x.cls') }),
    );
    expect(result).toEqual({ removed: 1, written: 1 });
    expect(read('classes/InvoiceService.cls/x.cls')).toBe('x');
  });

  it('a connection with no current/ tree is refused, and neither current/ nor staged/ is created', () => {
    fs.rmSync(current, { recursive: true, force: true });
    expectRefused({ files: new Map([['classes/InvoiceService.cls', enc('x')]]) }, 'classes/InvoiceService.cls');
    expectRefused({ removeFiles: ['classes/InvoiceService.cls'] }, 'classes/InvoiceService.cls');
    expectRefused({ removeDirs: ['lwc/invoiceCard'], bundleTypeDirs: ['lwc'] }, 'lwc/invoiceCard');
    expect(fs.existsSync(current)).toBe(false);
    // A connection whose directory is gone altogether: nothing is recreated.
    const gone = '99999999-2222-3333-4444-555555555555';
    expect(() =>
      store.replaceCurrentUnits(gone, input({ files: new Map([['classes/InvoiceService.cls', enc('x')]]) })),
    ).toThrow('unsafe snapshot path: classes/InvoiceService.cls');
    expect(fs.existsSync(path.join(base, gone))).toBe(false);
  });

  it('one bad entry among good ones changes nothing', () => {
    expectRefused(
      {
        removeFiles: ['classes/InvoiceService.cls', 'classes/InvoiceService.cls-meta.xml'],
        removeDirs: ['lwc/invoiceCard'],
        bundleTypeDirs: ['lwc'],
        files: new Map([
          ['classes/InvoiceService.cls', enc('new service')],
          ['../outside.txt', enc('x')],
        ]),
      },
      '../outside.txt',
    );
  });

  it('a link inside current/ cannot carry a write or a removal out of it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-members-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'victim.cls'), 'victim');
      try {
        fs.symlinkSync(outside, path.join(current, 'linked'), 'junction');
      } catch {
        return; // this machine cannot create a link here; the lexical checks still hold
      }
      expectRefused({ files: new Map([['linked/new.cls', enc('x')]]) }, 'linked/new.cls');
      expectRefused({ removeFiles: ['linked/victim.cls'] }, 'linked/victim.cls');
      expect(fs.readFileSync(path.join(outside, 'victim.cls'), 'utf8')).toBe('victim');
    } finally {
      try {
        fs.rmSync(path.join(current, 'linked'), { force: true, recursive: false });
      } catch {
        /* the link may not exist */
      }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('replaceCurrentUnits — stage, then swap', () => {
  it('replaces a document and its sidecar, a bundle directory and a removed file; nothing else moves', () => {
    const before = tree(current);
    const result = store.replaceCurrentUnits(
      CONN,
      input({
        removeFiles: [
          'classes/InvoiceService.cls',
          'classes/InvoiceService.cls-meta.xml',
          'reports/Sales/Forecast.report',
          'classes/Missing.cls',
        ],
        removeDirs: ['lwc/invoiceCard'],
        bundleTypeDirs: ['lwc'],
        files: new Map([
          ['classes/InvoiceService.cls', enc('new service')],
          ['classes/InvoiceService.cls-meta.xml', enc('new service meta')],
          ['lwc/invoiceCard/invoiceCard.js', enc('new js')],
          ['lwc/invoiceCard/invoiceCard.js-meta.xml', enc('new lwc meta')],
        ]),
      }),
    );
    // Four targets existed (the missing class did not); four files written.
    expect(result).toEqual({ removed: 4, written: 4 });
    expect(read('classes/InvoiceService.cls')).toBe('new service');
    expect(read('classes/InvoiceService.cls-meta.xml')).toBe('new service meta');
    expect(read('lwc/invoiceCard/invoiceCard.js')).toBe('new js');
    // A bundle file the org no longer returns is gone with the old directory.
    expect(read('lwc/invoiceCard/invoiceCard.html')).toBeNull();
    expect(read('reports/Sales/Forecast.report')).toBeNull();
    // Every other file is byte-identical.
    const after = tree(current);
    for (const rel of [
      'classes/InvoiceSelector.cls',
      'classes/InvoiceSelector.cls-meta.xml',
      'objects/Invoice__c.object',
      'lwc/otherCard/otherCard.js',
      'reports/Sales/Pipeline.report',
      'reports/Sales-meta.xml',
      'package.xml',
    ]) {
      expect(after[rel]).toBe(before[rel]);
    }
    expect(Object.keys(after)).toHaveLength(Object.keys(before).length - 2);
    expect(fs.existsSync(staged)).toBe(false);
    expect(fs.readFileSync(path.join(base, CONN, 'archive', '2026-11-01T00-00-00.000Z.zip'), 'utf8')).toBe('zip bytes');
  });

  it('writes a new unit into a type directory that did not exist', () => {
    const result = store.replaceCurrentUnits(
      CONN,
      input({ files: new Map([['triggers/InvoiceTrigger.trigger', enc('trigger')]]) }),
    );
    expect(result).toEqual({ removed: 0, written: 1 });
    expect(read('triggers/InvoiceTrigger.trigger')).toBe('trigger');
  });

  it('a staging write that fails on the k-th file leaves current/ byte-identical and no staged/ directory', () => {
    const before = tree(current);
    const real = fs.writeFileSync;
    let calls = 0;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      calls += 1;
      if (calls === 2) throw new Error('ENOSPC: no space left on device');
      return real(...args);
    }) as typeof fs.writeFileSync);
    expect(() =>
      store.replaceCurrentUnits(
        CONN,
        input({
          removeFiles: ['classes/InvoiceService.cls'],
          removeDirs: ['lwc/invoiceCard'],
          bundleTypeDirs: ['lwc'],
          files: new Map([
            ['classes/InvoiceService.cls', enc('new service')],
            ['lwc/invoiceCard/invoiceCard.js', enc('new js')],
            ['lwc/invoiceCard/invoiceCard.html', enc('new html')],
          ]),
        }),
      ),
    ).toThrow('ENOSPC: no space left on device');
    expect(calls).toBe(2);
    vi.restoreAllMocks();
    expect(tree(current)).toEqual(before);
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('a failure during the swap surfaces snapshot_partial_write', () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    let caught: unknown;
    try {
      store.replaceCurrentUnits(
        CONN,
        input({
          removeFiles: ['classes/InvoiceService.cls'],
          files: new Map([['classes/InvoiceService.cls', enc('new service')]]),
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContrailError);
    expect((caught as ContrailError).code).toBe('snapshot_partial_write');
    expect((caught as ContrailError).message).toBe(
      'snapshot files only partly replaced: EPERM: operation not permitted',
    );
    vi.restoreAllMocks();
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('a staged/ left by an earlier crash is cleared before staging, and none of it reaches current/', () => {
    // A directory where the staged file must go: staging fails unless staged/ is cleared first.
    fs.mkdirSync(path.join(staged, 'classes', 'InvoiceService.cls'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'classes', 'InvoiceService.cls', 'Stale.cls'), 'stale from a crash');
    fs.writeFileSync(path.join(staged, 'classes', 'Stale.cls'), 'stale from a crash');
    store.replaceCurrentUnits(
      CONN,
      input({
        removeFiles: ['classes/InvoiceService.cls'],
        files: new Map([['classes/InvoiceService.cls', enc('new service')]]),
      }),
    );
    expect(read('classes/Stale.cls')).toBeNull();
    expect(read('classes/InvoiceService.cls')).toBe('new service');
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('removals only: no file is written and staged/ is not left behind', () => {
    const result = store.replaceCurrentUnits(
      CONN,
      input({ removeDirs: ['lwc/otherCard'], bundleTypeDirs: ['lwc'] }),
    );
    expect(result).toEqual({ removed: 1, written: 0 });
    expect(fs.existsSync(path.join(current, 'lwc', 'otherCard'))).toBe(false);
    expect(read('lwc/invoiceCard/invoiceCard.js')).toBe('old js');
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(staged)).toBe(false);
  });
});

// ── snapshot/members.ts ──────────────────────────────────────────────────

const CHILD_TYPES = ['CustomField', 'ValidationRule', 'ListView', 'RecordType', 'CustomLabel', 'BotVersion'];
const RETRIEVED_AT = '2026-11-17T12:00:00.000Z';
const STAMP = '2026-11-10T09:00:00.000Z';

const mem = (type: string, api_name: string): SnapshotMember => ({ type, api_name });

function unitOf(type: string, name: string, over: Partial<MemberUnit> = {}): MemberUnit {
  return { key: `${type}:${name.toLowerCase()}`, type, name, bundle: false, companion: false, ...over };
}

function prop(type: string, fullName: string, over: Partial<FileProperties> = {}): FileProperties {
  return {
    type,
    fullName,
    fileName: `${type}/${fullName}`,
    id: 'x',
    lastModifiedDate: STAMP,
    lastModifiedByName: 'Dev User',
    ...over,
  };
}

function listingOf(props: FileProperties[] | null, over: Partial<PreImageListing> = {}): PreImageListing {
  return { props, unsupported: new Set(), ...over };
}

/** A retrieve zip as the org sends it: everything under unpackaged/, with a package.xml. */
function zipOf(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = { 'unpackaged/package.xml': strToU8('<Package>org</Package>') };
  for (const [rel, body] of Object.entries(files)) entries[`unpackaged/${rel}`] = strToU8(body);
  return Buffer.from(zipSync(entries));
}

function objectXml(fields: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
    fields
      .map((f) => `    <fields>\n        <fullName>${f}</fullName>\n        <label>${f}</label>\n    </fields>\n`)
      .join('') +
    '</CustomObject>\n'
  );
}

type UnitInput = MemberApplyInput['units'][number];

function applyUnits(
  units: Array<Partial<UnitInput> & { type: string; name: string }>,
  zip: Buffer | null,
  over: Partial<MemberApplyInput> = {},
) {
  const full: UnitInput[] = units.map((u) => ({
    key: `${u.type}:${u.name.toLowerCase()}`,
    bundle: false,
    oldFilePath: null,
    ifAbsent: 'keep',
    skipIfPackageOwned: false,
    ...u,
  }));
  return applyMemberUnits(store, {
    connectionId: CONN,
    zip,
    manifest: memberRetrieveManifest(full.map((u) => unitOf(u.type, u.name, { bundle: u.bundle }))),
    units: full,
    fileProps: [],
    retrievedAt: RETRIEVED_AT,
    ...over,
  });
}

function caughtError(fn: () => unknown): ContrailError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContrailError);
    return err as ContrailError;
  }
  throw new Error('expected a ContrailError');
}

describe('member constants', () => {
  it('pins the bounds and the re-baseline progress text', () => {
    expect(MEMBER_REFRESH_MAX).toBe(100);
    expect(REBASELINE_QUEUE_WAIT_MS).toBe(10_000);
    expect(MEMBER_RESULT_REUSE_MS).toBe(60_000);
    expect(REBASELINE_PROGRESS).toBe(
      'deployed — re-reading the deployed components into the local snapshot',
    );
  });
});

describe('memberJobId', () => {
  it('is order- and case-insensitive, with a members- prefix', () => {
    const a = memberJobId([mem('ApexClass', 'InvoiceService'), mem('CustomField', 'Invoice__c.Amount__c')]);
    const b = memberJobId([mem('CustomField', 'invoice__c.amount__c'), mem('ApexClass', 'INVOICESERVICE')]);
    expect(a).toBe(b);
    expect(a).toMatch(/^members-[0-9a-f]{12}$/);
    expect(memberJobId([mem('ApexClass', 'InvoiceService'), mem('ApexClass', 'invoiceservice')])).toBe(
      memberJobId([mem('ApexClass', 'InvoiceService')]),
    );
    expect(memberJobId([mem('ApexClass', 'InvoiceSelector')])).not.toBe(
      memberJobId([mem('ApexClass', 'InvoiceService')]),
    );
    // A different TYPE with the same name is a different member set.
    expect(memberJobId([mem('ApexTrigger', 'InvoiceService')])).not.toBe(
      memberJobId([mem('ApexClass', 'InvoiceService')]),
    );
  });
});

describe('planMemberUnits', () => {
  it('a document is its own unit', () => {
    const plan = planMemberUnits([mem('ApexClass', 'InvoiceService')]);
    expect(plan.units).toEqual([unitOf('ApexClass', 'InvoiceService')]);
    expect(plan.unitOf.get('ApexClass:invoiceservice')).toBe('ApexClass:invoiceservice');
    expect(plan.members).toEqual([mem('ApexClass', 'InvoiceService')]);
    expect(plan.skipped).toEqual([]);
  });

  it('two fields and a list view of one object are ONE CustomObject unit', () => {
    const plan = planMemberUnits([
      mem('CustomField', 'Invoice__c.Amount__c'),
      mem('CustomField', 'Invoice__c.Due__c'),
      mem('ListView', 'Invoice__c.All'),
    ]);
    expect(plan.units).toEqual([unitOf('CustomObject', 'Invoice__c')]);
    expect([...plan.unitOf.values()]).toEqual([
      'CustomObject:invoice__c',
      'CustomObject:invoice__c',
      'CustomObject:invoice__c',
    ]);
  });

  it('a CustomLabel re-reads CustomLabels:CustomLabels, a BotVersion its Bot, a RecordType its object', () => {
    expect(planMemberUnits([mem('CustomLabel', 'Greeting')]).units).toEqual([
      unitOf('CustomLabels', 'CustomLabels'),
    ]);
    expect(planMemberUnits([mem('BotVersion', 'Concierge.v2')]).units).toEqual([unitOf('Bot', 'Concierge')]);
    expect(planMemberUnits([mem('RecordType', 'Account.Partner')]).units).toEqual([
      unitOf('CustomObject', 'Account'),
    ]);
    expect(planMemberUnits([mem('ValidationRule', 'Account.Needs_Region')]).units).toEqual([
      unitOf('CustomObject', 'Account'),
    ]);
  });

  it('a CustomLabels member is the CustomLabels:CustomLabels unit a CustomLabel re-reads — never unregistered_type', () => {
    const alone = planMemberUnits([mem('CustomLabels', 'CustomLabels')]);
    expect(alone.units).toEqual([unitOf('CustomLabels', 'CustomLabels')]);
    expect(alone.skipped).toEqual([]);
    expect(alone.unitOf.get('CustomLabels:customlabels')).toBe('CustomLabels:customlabels');
    // Named with a CustomLabel (in either order, any case): still ONE unit.
    for (const order of [
      [mem('CustomLabel', 'Greeting'), mem('CustomLabels', 'customlabels')],
      [mem('CustomLabels', 'CUSTOMLABELS'), mem('CustomLabel', 'Greeting')],
    ]) {
      const plan = planMemberUnits(order);
      expect(plan.units).toEqual([unitOf('CustomLabels', 'CustomLabels')]);
      expect(plan.skipped).toEqual([]);
      expect([...plan.unitOf.values()]).toEqual(['CustomLabels:customlabels', 'CustomLabels:customlabels']);
    }
    // The labels document has one name; any other cannot be placed.
    const err = caughtError(() => planMemberUnits([mem('CustomLabels', 'Greeting')]));
    expect(err.code).toBe('bad_member');
    expect(err.message).toBe(
      'invalid member "CustomLabels:Greeting" — expected a metadata type name and a full API name ' +
        '(children dotted, foldered names "Folder/Name").',
    );
  });

  it('a FlowDefinition re-reads the Flow', () => {
    const plan = planMemberUnits([mem('FlowDefinition', 'Send_Invoice')]);
    expect(plan.units).toEqual([unitOf('Flow', 'Send_Invoice')]);
    expect(plan.unitOf.get('FlowDefinition:send_invoice')).toBe('Flow:send_invoice');
  });

  it('LWC and Aura bundles are bundle units', () => {
    const plan = planMemberUnits([
      mem('LightningComponentBundle', 'invoiceCard'),
      mem('AuraDefinitionBundle', 'invoicePanel'),
      mem('ApexClass', 'InvoiceService'),
    ]);
    expect(plan.units).toEqual([
      unitOf('LightningComponentBundle', 'invoiceCard', { bundle: true }),
      unitOf('AuraDefinitionBundle', 'invoicePanel', { bundle: true }),
      unitOf('ApexClass', 'InvoiceService'),
    ]);
  });

  it('a report brings its folder definition as a companion; unfiled$public has none', () => {
    const plan = planMemberUnits([mem('Report', 'Sales/Pipeline')]);
    expect(plan.units).toEqual([
      unitOf('Report', 'Sales/Pipeline'),
      unitOf('ReportFolder', 'Sales', { companion: true }),
    ]);
    expect(plan.unitOf.size).toBe(1);
    expect(planMemberUnits([mem('Report', 'unfiled$public/Open_Deals')]).units).toEqual([
      unitOf('Report', 'unfiled$public/Open_Deals'),
    ]);
    expect(planMemberUnits([mem('Dashboard', 'Ops/Board')]).units).toEqual([
      unitOf('Dashboard', 'Ops/Board'),
      unitOf('DashboardFolder', 'Ops', { companion: true }),
    ]);
  });

  it('a ReportFolder member is a unit of its own, and a member is never a companion', () => {
    expect(planMemberUnits([mem('ReportFolder', 'Sales')]).units).toEqual([unitOf('ReportFolder', 'Sales')]);
    for (const order of [
      [mem('Report', 'Sales/Pipeline'), mem('ReportFolder', 'Sales')],
      [mem('ReportFolder', 'Sales'), mem('Report', 'Sales/Pipeline')],
    ]) {
      const plan = planMemberUnits(order);
      expect(plan.units.find((u) => u.type === 'ReportFolder')).toEqual(unitOf('ReportFolder', 'Sales'));
      expect(plan.units).toHaveLength(2);
    }
  });

  it('Profile and types Contrail does not snapshot are skipped with their reason, never given a unit', () => {
    const plan = planMemberUnits([
      mem('Profile', 'Admin'),
      mem('Settings', 'Security'),
      mem('ApexClass', 'InvoiceService'),
    ]);
    expect(plan.units).toEqual([unitOf('ApexClass', 'InvoiceService')]);
    expect(plan.skipped).toEqual([
      { type: 'Profile', api_name: 'Admin', outcome: 'skipped', reason: 'profile' },
      { type: 'Settings', api_name: 'Security', outcome: 'skipped', reason: 'unregistered_type' },
    ]);
    expect(plan.unitOf.has('Profile:admin')).toBe(false);
  });

  it('dedupes members case-insensitively and keeps request order', () => {
    const plan = planMemberUnits([
      mem('ApexClass', 'InvoiceService'),
      mem('ApexTrigger', 'InvoiceTrigger'),
      mem('ApexClass', 'invoiceservice'),
    ]);
    expect(plan.members).toEqual([mem('ApexClass', 'InvoiceService'), mem('ApexTrigger', 'InvoiceTrigger')]);
    expect(plan.units.map((u) => u.type)).toEqual(['ApexClass', 'ApexTrigger']);
  });

  it('dotted QuickAction and CustomMetadata names stay documents', () => {
    expect(planMemberUnits([mem('QuickAction', 'Account.New_Invoice')]).units).toEqual([
      unitOf('QuickAction', 'Account.New_Invoice'),
    ]);
    expect(planMemberUnits([mem('CustomMetadata', 'Invoice_Setting.Default')]).units).toEqual([
      unitOf('CustomMetadata', 'Invoice_Setting.Default'),
    ]);
  });

  it('a child whose parent cannot be read from its name is refused', () => {
    const err = caughtError(() => planMemberUnits([mem('CustomField', '.Amount__c')]));
    expect(err.code).toBe('bad_member');
    expect(err.message).toBe(
      'invalid member "CustomField:.Amount__c" — expected a metadata type name and a full API name ' +
        '(children dotted, foldered names "Folder/Name").',
    );
  });
});

describe('memberRetrieveManifest — whole documents only', () => {
  it('folders are members of their content type; children come by their parent', () => {
    const plan = planMemberUnits([
      mem('Report', 'Sales/Pipeline'),
      mem('CustomField', 'Account.Region__c'),
      mem('ApexClass', 'InvoiceService'),
      mem('LightningComponentBundle', 'invoiceCard'),
      mem('CustomLabel', 'Greeting'),
      mem('DashboardFolder', 'Ops'),
      mem('FlowDefinition', 'Send_Invoice'),
    ]);
    expect(memberRetrieveManifest(plan.units)).toEqual({
      Report: ['Sales/Pipeline', 'Sales'],
      CustomObject: ['Account'],
      ApexClass: ['InvoiceService'],
      LightningComponentBundle: ['invoiceCard'],
      CustomLabels: ['CustomLabels'],
      Dashboard: ['Ops'],
      Flow: ['Send_Invoice'],
    });
  });

  it('for a member of each of the six child types the manifest names the container alone', () => {
    const cases: Array<[SnapshotMember, Record<string, string[]>]> = [
      [mem('CustomField', 'Account.Region__c'), { CustomObject: ['Account'] }],
      [mem('ValidationRule', 'Account.Needs_Region'), { CustomObject: ['Account'] }],
      [mem('ListView', 'Account.All_Accounts'), { CustomObject: ['Account'] }],
      [mem('RecordType', 'Account.Partner'), { CustomObject: ['Account'] }],
      [mem('CustomLabel', 'Greeting'), { CustomLabels: ['CustomLabels'] }],
      [mem('BotVersion', 'Concierge.v2'), { Bot: ['Concierge'] }],
    ];
    for (const [member, want] of cases) {
      const manifest = memberRetrieveManifest(planMemberUnits([member]).units);
      expect(manifest).toEqual(want);
      for (const child of CHILD_TYPES) expect(Object.keys(manifest)).not.toContain(child);
    }
  });

  it('a CustomLabels member retrieves the labels document by itself, once beside a CustomLabel', () => {
    expect(memberRetrieveManifest(planMemberUnits([mem('CustomLabels', 'CustomLabels')]).units)).toEqual({
      CustomLabels: ['CustomLabels'],
    });
    expect(
      memberRetrieveManifest(
        planMemberUnits([mem('CustomLabels', 'CustomLabels'), mem('CustomLabel', 'Greeting')]).units,
      ),
    ).toEqual({ CustomLabels: ['CustomLabels'] });
  });

  it('two fields and a list view of one object retrieve ONE CustomObject member', () => {
    const plan = planMemberUnits([
      mem('CustomField', 'Invoice__c.Amount__c'),
      mem('ListView', 'Invoice__c.All'),
      mem('CustomField', 'invoice__c.Due__c'),
      mem('CustomObject', 'INVOICE__C'),
    ]);
    expect(memberRetrieveManifest(plan.units)).toEqual({ CustomObject: ['Invoice__c'] });
  });

  it('a hand-built child-typed unit is refused before anything is retrieved', () => {
    for (const [type, name] of [
      ['CustomField', 'Account.Region__c'],
      ['ValidationRule', 'Account.Needs_Region'],
      ['ListView', 'Account.All_Accounts'],
      ['RecordType', 'Account.Partner'],
      ['CustomLabel', 'Greeting'],
      ['BotVersion', 'Concierge.v2'],
      ['CustomField', ''],
    ] as const) {
      const err = caughtError(() =>
        memberRetrieveManifest([unitOf('ApexClass', 'InvoiceService'), unitOf(type, name)]),
      );
      expect(err.code).toBe('snapshot_partial_container');
      expect(err.message).toBe(`a snapshot unit must be a whole document, never a child type: ${type}`);
    }
  });

  it('applyMemberUnits refuses a zip retrieved with a child-typed manifest and leaves the store byte-identical', () => {
    put('objects/Invoice__c.object', objectXml(['Amount__c', 'Due__c', 'Status__c']));
    const before = tree(path.join(base, CONN));
    // What a child-typed retrieve returns: the parent document holding ONLY the named block.
    const partial = zipOf({ 'objects/Invoice__c.object': objectXml(['Amount__c']) });
    const units: UnitInput[] = [
      {
        key: 'CustomObject:invoice__c',
        type: 'CustomObject',
        name: 'Invoice__c',
        bundle: false,
        oldFilePath: 'objects/Invoice__c.object',
        ifAbsent: 'keep',
        skipIfPackageOwned: false,
      },
    ];
    const manifests: Array<Record<string, string[]>> = [
      { CustomField: ['Invoice__c.Amount__c'] },
      // A container named together with one of its children is refused too.
      { CustomObject: ['Invoice__c'], CustomField: ['Invoice__c.Amount__c'] },
      { CustomLabel: ['Greeting'] },
    ];
    for (const manifest of manifests) {
      const extract = vi.spyOn(store, 'extractRetrieveZip');
      const err = caughtError(() =>
        applyMemberUnits(store, {
          connectionId: CONN,
          zip: partial,
          manifest,
          units,
          fileProps: [],
          retrievedAt: RETRIEVED_AT,
        }),
      );
      expect(err.code).toBe('snapshot_partial_container');
      expect(err.message).toMatch(
        /^a snapshot unit must be a whole document, never a child type: Custom(Field|Label)$/,
      );
      // Refused before the zip is opened.
      expect(extract).not.toHaveBeenCalled();
      extract.mockRestore();
    }
    // The object file — and with it every sibling field — is untouched.
    expect(tree(path.join(base, CONN))).toEqual(before);
    expect(read('objects/Invoice__c.object')).toContain('<fullName>Status__c</fullName>');
  });
});

describe('unitTypeCoverage', () => {
  const triggerUnit = unitOf('ApexTrigger', 'InvoiceTrigger');

  it('a type with rows is covered, whatever the listing says', () => {
    const cov = unitTypeCoverage({
      counts: { ApexClass: 3 },
      units: [unitOf('ApexClass', 'InvoiceService')],
      listing: listingOf(null, { failure: 'boom' }),
    });
    expect(cov.get('ApexClass')).toBe(true);
  });

  it('an analytics type is covered when its coupled type has rows, and only then', () => {
    const units = [unitOf('Report', 'Sales/Pipeline'), unitOf('ReportFolder', 'Sales', { companion: true })];
    const covered = unitTypeCoverage({ counts: { ReportFolder: 1 }, units, listing: listingOf([]) });
    expect(covered.get('Report')).toBe(true);
    expect(covered.get('ReportFolder')).toBe(true);
    const dash = unitTypeCoverage({
      counts: { Dashboard: 2 },
      units: [unitOf('DashboardFolder', 'Ops')],
      listing: listingOf([]),
    });
    expect(dash.get('DashboardFolder')).toBe(true);
  });

  it("proof: the listing names this run's unit and no other unpackaged component of the type", () => {
    const cov = unitTypeCoverage({
      counts: { ApexClass: 1 },
      units: [triggerUnit],
      listing: listingOf([prop('ApexTrigger', 'invoicetrigger'), prop('ApexClass', 'Other')]),
    });
    expect(cov.get('ApexTrigger')).toBe(true);
  });

  it('no proof when the listing names another component of the type', () => {
    const cov = unitTypeCoverage({
      counts: { ApexClass: 1 },
      units: [triggerUnit],
      listing: listingOf([prop('ApexTrigger', 'InvoiceTrigger'), prop('ApexTrigger', 'PaymentTrigger')]),
    });
    expect(cov.get('ApexTrigger')).toBe(false);
  });

  it('package-owned listed components (installed, installedEditable) do not break the proof', () => {
    const cov = unitTypeCoverage({
      counts: { ApexClass: 1 },
      units: [triggerUnit],
      listing: listingOf([
        prop('ApexTrigger', 'InvoiceTrigger'),
        prop('ApexTrigger', 'pkg__Sync', { manageableState: 'installed', namespacePrefix: 'pkg' }),
        prop('ApexTrigger', 'Unmanaged_Sync', { manageableState: 'installedEditable' }),
      ]),
    });
    expect(cov.get('ApexTrigger')).toBe(true);
    // Any other state is the org's own component: no proof.
    const released = unitTypeCoverage({
      counts: { ApexClass: 1 },
      units: [triggerUnit],
      listing: listingOf([
        prop('ApexTrigger', 'InvoiceTrigger'),
        prop('ApexTrigger', 'Own_Sync', { manageableState: 'released' }),
      ]),
    });
    expect(released.get('ApexTrigger')).toBe(false);
  });

  it('a failed or unsupported listing is no proof', () => {
    const failed = unitTypeCoverage({
      counts: { ApexClass: 1 },
      units: [triggerUnit],
      listing: listingOf(null, { failure: 'x' }),
    });
    expect(failed.get('ApexTrigger')).toBe(false);
    const unsupported = unitTypeCoverage({
      counts: { ApexClass: 1 },
      units: [triggerUnit],
      listing: listingOf([prop('ApexTrigger', 'InvoiceTrigger')], {
        unsupported: new Set(['ApexTrigger']),
      }),
    });
    expect(unsupported.get('ApexTrigger')).toBe(false);
  });

  it('foldered and folder types never use the proof', () => {
    const cov = unitTypeCoverage({
      counts: { ApexClass: 1 },
      units: [unitOf('Report', 'Sales/Pipeline'), unitOf('ReportFolder', 'Sales', { companion: true })],
      listing: listingOf([prop('Report', 'Sales/Pipeline'), prop('ReportFolder', 'Sales')]),
    });
    expect(cov.get('Report')).toBe(false);
    expect(cov.get('ReportFolder')).toBe(false);
  });

  it('the vacuous case: a listing with no entry of the type at all is not a proof', () => {
    const cov = unitTypeCoverage({
      counts: { ApexClass: 1 },
      units: [triggerUnit],
      listing: listingOf([prop('ApexClass', 'InvoiceService')]),
    });
    expect(cov.get('ApexTrigger')).toBe(false);
  });
});

describe('absenceVerdict', () => {
  const cls = unitOf('ApexClass', 'InvoiceService');

  it('removes only what a readable listing enumerated without naming', () => {
    expect(absenceVerdict(cls, listingOf([prop('ApexClass', 'Other')]))).toBe('remove');
    expect(absenceVerdict(cls, listingOf([]))).toBe('remove');
    expect(absenceVerdict(cls, listingOf([prop('ApexClass', 'invoiceservice')]))).toBe('keep');
    // A listing that could not be read, or a type the org does not support, proves nothing.
    expect(absenceVerdict(cls, listingOf(null, { failure: 'boom' }))).toBe('keep');
    expect(absenceVerdict(cls, listingOf([], { unsupported: new Set(['ApexClass']) }))).toBe('keep');
    // A name no listing can report: slash-shaped outside a folder table, or foldered with no folder.
    expect(absenceVerdict(unitOf('ApexClass', 'a/b'), listingOf([]))).toBe('keep');
    expect(absenceVerdict(unitOf('Report', 'Pipeline'), listingOf([]))).toBe('keep');
    // A foldered member is listed by its folder.
    const report = unitOf('Report', 'Sales/Pipeline');
    expect(absenceVerdict(report, listingOf([prop('Report', 'Sales/Forecast')]))).toBe('remove');
    expect(absenceVerdict(report, listingOf([prop('Report', 'Sales/Pipeline')]))).toBe('keep');
  });
});

describe('isPackageOwnedState', () => {
  it('the two states get_org_changes leaves out — installed and installedEditable — and nothing else', () => {
    const owned = (manageableState?: string) =>
      isPackageOwnedState(prop('ApexClass', 'X', manageableState === undefined ? {} : { manageableState }));
    expect(owned('installed')).toBe(true);
    expect(owned('installedEditable')).toBe(true);
    for (const state of ['released', 'unmanaged', 'beta', 'deleted', 'deprecated', '']) {
      expect(owned(state), state).toBe(false);
    }
    expect(owned()).toBe(false);
    expect(isPackageOwnedState(undefined)).toBe(false);
  });
});

describe('removableUnitKeys', () => {
  it('only units a deleted member names itself — a deleted child never makes its parent removable', () => {
    const keys = removableUnitKeys([
      mem('ApexClass', 'OldService'),
      mem('CustomField', 'Invoice__c.Legacy__c'),
      mem('FlowDefinition', 'Old_Flow'),
      mem('LightningComponentBundle', 'oldCard'),
      mem('Profile', 'Admin'),
    ]);
    expect([...keys].sort()).toEqual([
      'ApexClass:oldservice',
      'Flow:old_flow',
      'LightningComponentBundle:oldcard',
    ]);
  });
});

describe('applyMemberUnits on a temp store', () => {
  it('writes a document and its sidecar, never package.xml, and leaves sibling files byte-identical', () => {
    const before = tree(current);
    const result = applyUnits(
      [{ type: 'ApexClass', name: 'InvoiceService', oldFilePath: 'classes/InvoiceService.cls' }],
      zipOf({
        'classes/InvoiceService.cls': 'new service',
        'classes/InvoiceService.cls-meta.xml': 'new service meta',
      }),
      { fileProps: [prop('ApexClass', 'InvoiceService')] },
    );
    expect(result.units).toEqual([
      { key: 'ApexClass:invoiceservice', applied: 'written', filePath: 'classes/InvoiceService.cls' },
    ]);
    expect(
      result.artifacts.map((a) => [a.type, a.apiName, a.filePath, a.lastModifiedDate, a.retrievedAt]),
    ).toEqual([['ApexClass', 'InvoiceService', 'classes/InvoiceService.cls', STAMP, RETRIEVED_AT]]);
    expect(result.filesWritten).toBe(2);
    expect(read('classes/InvoiceService.cls')).toBe('new service');
    expect(read('classes/InvoiceService.cls-meta.xml')).toBe('new service meta');
    // The zip's package.xml never reaches current/.
    expect(read('package.xml')).toBe('package');
    const after = tree(current);
    for (const rel of Object.keys(before)) {
      if (rel.startsWith('classes/InvoiceService.cls')) continue;
      expect(after[rel]).toBe(before[rel]);
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('a container re-indexes the parent and all its children; a child the org dropped has no row', () => {
    put('objects/Invoice__c.object', objectXml(['Amount__c', 'Due__c', 'Status__c']));
    const result = applyUnits(
      [{ type: 'CustomObject', name: 'Invoice__c', oldFilePath: 'objects/Invoice__c.object' }],
      zipOf({ 'objects/Invoice__c.object': objectXml(['Amount__c', 'Status__c', 'Region__c']) }),
      { fileProps: [prop('CustomObject', 'Invoice__c')] },
    );
    expect(result.artifacts.map((a) => `${a.type}:${a.apiName}`).sort()).toEqual([
      'CustomField:Invoice__c.Amount__c',
      'CustomField:Invoice__c.Region__c',
      'CustomField:Invoice__c.Status__c',
      'CustomObject:Invoice__c',
    ]);
    // Children carry their parent document's stamp and file.
    for (const a of result.artifacts) {
      expect(a.lastModifiedDate).toBe(STAMP);
      expect(a.filePath).toBe('objects/Invoice__c.object');
    }
    // The whole document the org returned replaced the old one.
    expect(read('objects/Invoice__c.object')).toBe(objectXml(['Amount__c', 'Status__c', 'Region__c']));
  });

  it('a bundle is replaced whole: a file the org no longer returns is gone, other bundles untouched', () => {
    const result = applyUnits(
      [
        {
          type: 'LightningComponentBundle',
          name: 'invoiceCard',
          bundle: true,
          oldFilePath: 'lwc/invoiceCard/invoiceCard.js',
        },
      ],
      zipOf({
        'lwc/invoiceCard/invoiceCard.js': 'new js',
        'lwc/invoiceCard/invoiceCard.js-meta.xml': 'new lwc meta',
        'lwc/invoiceCard/templates/compact.html': 'compact',
      }),
    );
    expect(result.units).toEqual([
      {
        key: 'LightningComponentBundle:invoicecard',
        applied: 'written',
        filePath: 'lwc/invoiceCard/invoiceCard.js',
      },
    ]);
    expect(result.artifacts.map((a) => `${a.type}:${a.apiName}`)).toEqual([
      'LightningComponentBundle:invoiceCard',
    ]);
    expect(read('lwc/invoiceCard/invoiceCard.js')).toBe('new js');
    expect(read('lwc/invoiceCard/templates/compact.html')).toBe('compact');
    expect(read('lwc/invoiceCard/invoiceCard.html')).toBeNull();
    expect(read('lwc/otherCard/otherCard.js')).toBe('other js');
  });

  it("removal: the unit's files go, nothing else does", () => {
    const before = tree(current);
    const result = applyUnits(
      [
        {
          type: 'ApexClass',
          name: 'InvoiceService',
          oldFilePath: 'classes/InvoiceService.cls',
          ifAbsent: 'remove',
        },
        {
          type: 'LightningComponentBundle',
          name: 'invoiceCard',
          bundle: true,
          oldFilePath: 'lwc/invoiceCard/invoiceCard.js',
          ifAbsent: 'remove',
        },
      ],
      // A re-read whose every named member is absent: a zip holding only package.xml.
      zipOf({}),
    );
    expect(result.units.map((u) => u.applied)).toEqual(['removed', 'removed']);
    expect(result.artifacts).toEqual([]);
    expect(result.filesWritten).toBe(0);
    const after = tree(current);
    expect(Object.keys(after).sort()).toEqual(
      Object.keys(before)
        .filter((rel) => !rel.startsWith('classes/InvoiceService.cls') && !rel.startsWith('lwc/invoiceCard/'))
        .sort(),
    );
    for (const rel of Object.keys(after)) expect(after[rel]).toBe(before[rel]);
  });

  it('kept writes nothing', () => {
    const before = tree(path.join(base, CONN));
    const held = { type: 'ApexClass', name: 'InvoiceService', oldFilePath: 'classes/InvoiceService.cls' };
    const result = applyUnits([{ ...held, ifAbsent: 'keep' }], zipOf({}));
    expect(result).toEqual({
      artifacts: [],
      units: [{ key: 'ApexClass:invoiceservice', applied: 'kept', filePath: 'classes/InvoiceService.cls' }],
      filesWritten: 0,
      filesRemoved: 0,
    });
    expect(tree(path.join(base, CONN))).toEqual(before);
    // With no zip at all, the same.
    expect(applyUnits([held], null).units[0]!.applied).toBe('kept');
    expect(tree(path.join(base, CONN))).toEqual(before);
  });

  it('matches a percent-encoded layout file name to its API name', () => {
    const rel = 'layouts/Account-Account %28Marketing%29 Layout.layout';
    put(rel, 'old layout');
    const result = applyUnits(
      [{ type: 'Layout', name: 'Account-Account (Marketing) Layout', oldFilePath: rel }],
      zipOf({ [rel]: 'new layout' }),
    );
    expect(result.units[0]).toMatchObject({ applied: 'written', filePath: rel });
    expect(result.artifacts.map((a) => a.apiName)).toEqual(['Account-Account (Marketing) Layout']);
    expect(read(rel)).toBe('new layout');
  });

  it('a case-changed rename replaces the old file and leaves exactly one file', () => {
    put('classes/invoiceHelper.cls', 'old helper');
    put('classes/invoiceHelper.cls-meta.xml', 'old helper meta');
    const result = applyUnits(
      [{ type: 'ApexClass', name: 'InvoiceHelper', oldFilePath: 'classes/invoiceHelper.cls' }],
      zipOf({ 'classes/InvoiceHelper.cls': 'new helper', 'classes/InvoiceHelper.cls-meta.xml': 'new meta' }),
    );
    expect(result.units[0]).toMatchObject({ applied: 'written', filePath: 'classes/InvoiceHelper.cls' });
    const listed = fs.readdirSync(path.join(current, 'classes'));
    const names = listed.filter((n) => /^invoicehelper\.cls$/i.test(n));
    expect(names).toEqual(['InvoiceHelper.cls']);
    expect(fs.readFileSync(path.join(current, 'classes', names[0]!), 'utf8')).toBe('new helper');
    expect(listed.filter((n) => /^invoicehelper\.cls-meta\.xml$/i.test(n))).toHaveLength(1);
  });

  it('a Report refresh and a removed Report leave every other file in the folder byte-identical', () => {
    const before = tree(current);
    const written = applyUnits(
      [
        { type: 'Report', name: 'Sales/Pipeline', oldFilePath: 'reports/Sales/Pipeline.report' },
        { type: 'ReportFolder', name: 'Sales', oldFilePath: 'reports/Sales-meta.xml' },
      ],
      zipOf({ 'reports/Sales/Pipeline.report': 'new pipeline', 'reports/Sales-meta.xml': 'new folder meta' }),
    );
    expect(written.units.map((u) => u.applied)).toEqual(['written', 'written']);
    expect(written.artifacts.map((a) => `${a.type}:${a.apiName}`).sort()).toEqual([
      'Report:Sales/Pipeline',
      'ReportFolder:Sales',
    ]);
    expect(read('reports/Sales/Pipeline.report')).toBe('new pipeline');
    expect(read('reports/Sales-meta.xml')).toBe('new folder meta');
    expect(tree(current)['reports/Sales/Forecast.report']).toBe(before['reports/Sales/Forecast.report']);

    const mid = tree(current);
    const removed = applyUnits(
      [
        {
          type: 'Report',
          name: 'Sales/Forecast',
          oldFilePath: 'reports/Sales/Forecast.report',
          ifAbsent: 'remove',
        },
      ],
      zipOf({}),
    );
    expect(removed.units[0]).toMatchObject({ applied: 'removed' });
    const after = tree(current);
    expect(after['reports/Sales/Forecast.report']).toBeUndefined();
    for (const rel of Object.keys(mid)) {
      if (rel === 'reports/Sales/Forecast.report') continue;
      expect(after[rel]).toBe(mid[rel]);
    }
  });

  it('a CustomLabels member: the labels document is written whole and the member is refreshed by its own row', () => {
    const labelsXml = (names: string[]): string =>
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
      names
        .map(
          (n) =>
            `    <labels>\n        <fullName>${n}</fullName>\n        <language>en_US</language>\n` +
            `        <protected>false</protected>\n        <shortDescription>${n}</shortDescription>\n` +
            `        <value>${n}</value>\n    </labels>\n`,
        )
        .join('') +
      '</CustomLabels>\n';
    put('labels/CustomLabels.labels', labelsXml(['Greeting']));
    const plan = planMemberUnits([mem('CustomLabels', 'CustomLabels')]);
    const fresh = labelsXml(['Greeting', 'Farewell']);
    const applied = applyMemberUnits(store, {
      connectionId: CONN,
      zip: zipOf({ 'labels/CustomLabels.labels': fresh }),
      manifest: memberRetrieveManifest(plan.units),
      units: plan.units.map((u) => ({
        key: u.key,
        type: u.type,
        name: u.name,
        bundle: u.bundle,
        oldFilePath: 'labels/CustomLabels.labels',
        ifAbsent: 'keep' as const,
        skipIfPackageOwned: false,
      })),
      fileProps: [prop('CustomLabels', 'CustomLabels')],
      retrievedAt: RETRIEVED_AT,
    });
    expect(applied.units).toEqual([
      { key: 'CustomLabels:customlabels', applied: 'written', filePath: 'labels/CustomLabels.labels' },
    ]);
    expect(applied.artifacts.map((a) => `${a.type}:${a.apiName}`).sort()).toEqual([
      'CustomLabel:Farewell',
      'CustomLabel:Greeting',
      'CustomLabels:CustomLabels',
    ]);
    expect(read('labels/CustomLabels.labels')).toBe(fresh);
    expect(
      memberOutcomes({
        plan,
        origin: 'refresh_snapshot',
        deleted: [],
        preSkipped: new Map(),
        applied,
        oldRows: [{ type: 'CustomLabels', apiName: 'CustomLabels' }],
        listing: listingOf([prop('CustomLabels', 'CustomLabels')]),
        retrievedProps: [prop('CustomLabels', 'CustomLabels')],
      }),
    ).toEqual([
      { type: 'CustomLabels', api_name: 'CustomLabels', unit: 'CustomLabels:CustomLabels', outcome: 'refreshed' },
    ]);
  });

  it('package-owned: a unit the index does not hold is kept when the org marks it installed or installedEditable', () => {
    const before = tree(path.join(base, CONN));
    const zip = zipOf({
      'lwc/pkgCard/pkgCard.js': 'pkg js',
      'lwc/pkgCard/pkgCard.js-meta.xml': 'pkg meta',
    });
    const pkgCard = { type: 'LightningComponentBundle', name: 'pkgCard', bundle: true };
    for (const state of ['installed', 'installedEditable']) {
      const result = applyUnits([{ ...pkgCard, skipIfPackageOwned: true }], zip, {
        fileProps: [prop('LightningComponentBundle', 'pkgCard', { manageableState: state })],
      });
      expect(result).toEqual({
        artifacts: [],
        units: [
          {
            key: 'LightningComponentBundle:pkgcard',
            applied: 'kept',
            keptReason: 'package_owned',
            filePath: null,
          },
        ],
        filesWritten: 0,
        filesRemoved: 0,
      });
      expect(tree(path.join(base, CONN))).toEqual(before);
    }
    // A unit the index already holds (skipIfPackageOwned false) is always re-read.
    const held = applyUnits([{ ...pkgCard, skipIfPackageOwned: false }], zip, {
      fileProps: [prop('LightningComponentBundle', 'pkgCard', { manageableState: 'installed' })],
    });
    expect(held.units[0]).toMatchObject({ applied: 'written' });
    expect(read('lwc/pkgCard/pkgCard.js')).toBe('pkg js');
  });
});

describe('memberOutcomes', () => {
  const emptyListing: PreImageListing = { props: [], unsupported: new Set<string>() };
  type OutcomeInput = Parameters<typeof memberOutcomes>[0];
  type Applied = NonNullable<OutcomeInput['applied']>;

  function outcomes(over: Partial<OutcomeInput> & { members: SnapshotMember[] }) {
    const { members, ...rest } = over;
    return memberOutcomes({
      plan: planMemberUnits(members),
      origin: 'refresh_snapshot',
      deleted: [],
      preSkipped: new Map(),
      applied: null,
      oldRows: [],
      listing: emptyListing,
      retrievedProps: [],
      ...rest,
    });
  }

  const row = (type: string, apiName: string): Applied['artifacts'][number] => ({
    type,
    apiName,
    filePath: 'x/y',
    contentHash: 'h',
    lastModifiedDate: STAMP,
    lastModifiedBy: 'Dev User',
    retrievedAt: RETRIEVED_AT,
    content: '',
  });

  const written = (keys: string[], rows: Applied['artifacts']): Applied => ({
    artifacts: rows,
    units: keys.map((key) => ({ key, applied: 'written', filePath: 'x/y' })),
    filesWritten: keys.length,
    filesRemoved: 0,
  });

  it('refreshed by its own row; a FlowDefinition by its Flow row; companions never appear', () => {
    const got = outcomes({
      members: [
        mem('ApexClass', 'InvoiceService'),
        mem('FlowDefinition', 'Send_Invoice'),
        mem('Report', 'Sales/Pipeline'),
      ],
      applied: written(
        ['ApexClass:invoiceservice', 'Flow:send_invoice', 'Report:sales/pipeline', 'ReportFolder:sales'],
        [
          row('ApexClass', 'InvoiceService'),
          row('Flow', 'Send_Invoice'),
          row('Report', 'Sales/Pipeline'),
          row('ReportFolder', 'Sales'),
        ],
      ),
    });
    expect(got).toEqual([
      { type: 'ApexClass', api_name: 'InvoiceService', unit: 'ApexClass:InvoiceService', outcome: 'refreshed' },
      { type: 'FlowDefinition', api_name: 'Send_Invoice', unit: 'Flow:Send_Invoice', outcome: 'refreshed' },
      { type: 'Report', api_name: 'Sales/Pipeline', unit: 'Report:Sales/Pipeline', outcome: 'refreshed' },
    ]);
  });

  it('a child missing from its re-read parent: removed on the tool path; after a deploy only when deleted', () => {
    const applied = written(
      ['CustomObject:invoice__c'],
      [row('CustomObject', 'Invoice__c'), row('CustomField', 'Invoice__c.Amount__c')],
    );
    const members = [mem('CustomField', 'Invoice__c.Amount__c'), mem('CustomField', 'Invoice__c.Legacy__c')];
    expect(outcomes({ members, applied })[1]).toEqual({
      type: 'CustomField',
      api_name: 'Invoice__c.Legacy__c',
      unit: 'CustomObject:Invoice__c',
      outcome: 'removed',
      detail: 'not in the parent document the org returned',
    });
    expect(outcomes({ members, applied, origin: 'execute_deploy' })[1]).toMatchObject({
      outcome: 'skipped',
      reason: 'child_not_in_parent',
    });
    const deleted = [mem('CustomField', 'invoice__c.legacy__c')];
    expect(outcomes({ members, applied, origin: 'execute_deploy', deleted })[1]).toMatchObject({
      outcome: 'removed',
      detail: 'not in the parent document the org returned',
    });
  });

  it('a removed unit: "already absent" when the snapshot had no row; never an undeleted member after a deploy', () => {
    const applied: Applied = {
      artifacts: [],
      units: [
        { key: 'ApexClass:oldservice', applied: 'removed', filePath: 'classes/OldService.cls' },
        { key: 'ApexClass:ghost', applied: 'removed', filePath: null },
      ],
      filesWritten: 0,
      filesRemoved: 2,
    };
    const members = [mem('ApexClass', 'OldService'), mem('ApexClass', 'Ghost')];
    const oldRows = [{ type: 'ApexClass', apiName: 'OldService' }];
    expect(outcomes({ members, applied, oldRows })).toEqual([
      { type: 'ApexClass', api_name: 'OldService', unit: 'ApexClass:OldService', outcome: 'removed' },
      {
        type: 'ApexClass',
        api_name: 'Ghost',
        unit: 'ApexClass:Ghost',
        outcome: 'removed',
        detail: 'already absent from the snapshot',
      },
    ]);
    const afterDeploy = outcomes({
      members,
      applied,
      oldRows,
      origin: 'execute_deploy',
      deleted: [mem('ApexClass', 'OldService')],
    });
    expect(afterDeploy[0]).toMatchObject({ outcome: 'removed' });
    expect(afterDeploy[1]).toMatchObject({ outcome: 'skipped', reason: 'child_not_in_parent' });
  });

  it('kept units: package_owned, not_indexable, not_returned, presence_unknown, not_confirmed', () => {
    const key = 'ApexClass:invoiceservice';
    const kept = (keptReason?: 'package_owned'): Applied => ({
      artifacts: [],
      units: [{ key, applied: 'kept', filePath: null, ...(keptReason ? { keptReason } : {}) }],
      filesWritten: 0,
      filesRemoved: 0,
    });
    const members = [mem('ApexClass', 'InvoiceService')];
    const base = { type: 'ApexClass', api_name: 'InvoiceService', unit: 'ApexClass:InvoiceService' };
    const listed = listingOf([prop('ApexClass', 'InvoiceService')]);
    expect(outcomes({ members, applied: kept('package_owned'), listing: listed })[0]).toEqual({
      ...base,
      outcome: 'skipped',
      reason: 'package_owned',
    });
    // The org says it returned a file for the unit, and no row came of it.
    const returned = [prop('ApexClass', 'InvoiceService')];
    expect(outcomes({ members, applied: kept(), listing: listed, retrievedProps: returned })[0]).toEqual({
      ...base,
      outcome: 'skipped',
      reason: 'not_indexable',
    });
    expect(outcomes({ members, applied: kept(), listing: listed })[0]).toEqual({
      ...base,
      outcome: 'skipped',
      reason: 'not_returned',
    });
    const failed = listingOf(null, { failure: 'listMetadata timed out' });
    expect(outcomes({ members, applied: kept(), listing: failed })[0]).toEqual({
      ...base,
      outcome: 'skipped',
      reason: 'presence_unknown',
      detail: 'listMetadata timed out',
    });
    expect(
      outcomes({ members, applied: kept(), listing: listingOf([]), origin: 'execute_deploy' })[0],
    ).toEqual({ ...base, outcome: 'skipped', reason: 'not_confirmed' });
  });

  it('pre-retrieve skips carry their reason; plan skips come through as planned', () => {
    const got = outcomes({
      members: [mem('Profile', 'Admin'), mem('Report', 'Sales/Pipeline'), mem('ApexTrigger', 'InvoiceTrigger')],
      preSkipped: new Map<string, MemberSkipReason>([
        ['Report:sales/pipeline', 'type_not_in_snapshot'],
        ['ReportFolder:sales', 'type_not_in_snapshot'],
        ['ApexTrigger:invoicetrigger', 'type_unsupported'],
      ]),
    });
    expect(got).toEqual([
      { type: 'Profile', api_name: 'Admin', outcome: 'skipped', reason: 'profile' },
      {
        type: 'Report',
        api_name: 'Sales/Pipeline',
        unit: 'Report:Sales/Pipeline',
        outcome: 'skipped',
        reason: 'type_not_in_snapshot',
      },
      {
        type: 'ApexTrigger',
        api_name: 'InvoiceTrigger',
        unit: 'ApexTrigger:InvoiceTrigger',
        outcome: 'skipped',
        reason: 'type_unsupported',
      },
    ]);
  });
});

describe('member texts (verbatim)', () => {
  it('every skip reason', () => {
    const t = (reason: MemberSkipReason, detail?: string) =>
      memberSkipText(reason, { type: 'CustomField', unitType: 'CustomObject', detail });
    expect(t('unregistered_type')).toBe('CustomField is not a type Contrail snapshots.');
    expect(t('profile')).toBe(
      'Profile is never snapshotted — a single-profile retrieve is package-relative, so its bytes would not be a faithful copy.',
    );
    expect(t('type_not_in_snapshot')).toBe(
      "This connection's snapshot holds no CustomObject, and Contrail could not confirm from the org's listing that the named components are the only ones of that type — writing just these would make any other CustomObject in the org read as new or missing. Run refresh_snapshot with types: [\"CustomObject\"].",
    );
    expect(t('type_unsupported')).toBe('The org reports CustomObject as unsupported at this API version.');
    expect(t('package_owned')).toBe(
      'The org lists its CustomObject as package-owned and this snapshot holds no copy of it. get_org_changes leaves package-owned components out of its comparison, so a copy added here would read as gone from the org — not added. A member-scoped refresh will skip it again.',
    );
    expect(t('not_returned')).toBe(
      'The org lists it, but the retrieve returned no file for it — the snapshot copy was left as it was.',
    );
    expect(t('presence_unknown', 'INVALID_SESSION_ID')).toBe(
      "The retrieve returned no file for it and the org's listing could not be read (INVALID_SESSION_ID) — the snapshot copy was left as it was.",
    );
    expect(t('not_confirmed')).toBe(
      "This deploy changed it, but the org's listing did not name it and the retrieve returned no file for it under this name — the snapshot copy was left as it was.",
    );
    expect(t('child_not_in_parent')).toBe(
      'The re-read parent document does not contain it, so the snapshot holds no copy of it now. Contrail did not check the org for it separately.',
    );
    expect(t('not_indexable')).toBe(
      'The org returned a file Contrail has no snapshot mapping for — nothing was written.',
    );
  });

  it('the no-snapshot, commit-point and partly-updated errors, and the notes', () => {
    expect(noSnapshotText('acme-uat')).toBe(
      '"acme-uat" has no snapshot yet — a member-scoped refresh only updates an existing snapshot. Run refresh_snapshot without members first.',
    );
    expect(noMetadataReadText('acme-uat')).toBe(
      '"acme-uat" no longer grants metadata_read — nothing was written to the snapshot.',
    );
    expect(CONNECTION_REMOVED_TEXT).toBe(
      'The connection was removed while the member refresh was running — nothing was written.',
    );
    expect(partialWriteText('EPERM: operation not permitted')).toBe(
      'the snapshot may be only partly updated for these components (EPERM: operation not permitted) — its files and its index can disagree until they are re-read',
    );
    expect(MEMBER_REFRESH_NOTES).toEqual([
      'Dependency edges extracted FROM the re-read components were rebuilt. References TO a new or deleted component from other components, and the org-computed dependency data (MetadataComponentDependency), were not rebuilt — a whole-type refresh_snapshot does that.',
      'Only the named components were re-read (a child re-reads its whole parent document). Anything else that changed in the org is not in the snapshot until a whole-type refresh_snapshot.',
    ]);
  });
});

describe('executeSnapshotResult (verbatim notes)', () => {
  type Outcome = Parameters<typeof executeSnapshotResult>[0];
  type Unavailable = Extract<Outcome, { status: 'unavailable' }>['reason'];
  const members = [
    mem('ApexClass', 'InvoiceService'),
    mem('CustomField', 'Invoice__c.Amount__c'),
    mem('ApexClass', 'OldService'),
  ];
  const REREAD =
    'Dependency edges extracted FROM the re-read components were rebuilt. References TO a new or deleted component from other components, and the org-computed dependency data (MetadataComponentDependency), were not rebuilt — a whole-type refresh_snapshot does that. Only the components in this deploy were re-read (a child re-reads its whole parent document); anything else the deploy caused the org to create or change is not in the snapshot until a whole-type refresh_snapshot.';
  const PENDING =
    'Deployed. Contrail had not finished re-reading this deploy\'s components into the local snapshot when this result was stored. If snapshot.status still reads "pending", the snapshot may be stale for them — run refresh_snapshot with members set to this deploy\'s components.';
  const DISABLED =
    'Deployed. Automatic snapshot re-baseline is turned off (snapshot.rebaselineAfterDeploy) — run refresh_snapshot to bring the local snapshot up to date.';
  const empty = { rebaselined: [], removed: [], skipped: [] };

  function summary(outcomes: MemberRefreshSummary['members']): MemberRefreshSummary {
    return {
      connection: 'acme-uat',
      members: outcomes,
      counts: { refreshed: 0, removed: 0, skipped: 0 },
      units: [],
      artifact_counts: {},
      edge_counts: { extractor: 0 },
      retrieved_at: RETRIEVED_AT,
      notes: [],
      duration_ms: 5,
    };
  }

  it('pending and disabled', () => {
    expect(executeSnapshotResult({ status: 'pending' }, members, 60_000)).toEqual({
      snapshot: { status: 'pending', ...empty, note: PENDING.slice('Deployed. '.length) },
      note: PENDING,
    });
    expect(executeSnapshotResult({ status: 'disabled' }, members, 60_000)).toEqual({
      snapshot: { status: 'disabled', ...empty, note: DISABLED.slice('Deployed. '.length) },
      note: DISABLED,
    });
  });

  it('every unavailable reason', () => {
    const note = (reason: Unavailable, detail?: string, m = members): string => {
      const r = executeSnapshotResult({ status: 'unavailable', reason, detail }, m, 60_000);
      expect(r.snapshot).toEqual({
        status: 'unavailable',
        reason,
        ...empty,
        note: r.note.slice('Deployed. '.length),
      });
      expect(r.note.startsWith('Deployed. ')).toBe(true);
      return r.note;
    };
    const notUpdated = (why: string) =>
      `Deployed. The local snapshot was NOT updated for this deploy (${why}). Run refresh_snapshot with members set to this deploy's components to bring it up to date.`;
    expect(note('timeout')).toBe(notUpdated('the re-read did not finish within 60 s'));
    expect(executeSnapshotResult({ status: 'unavailable', reason: 'timeout' }, members, 1).note).toBe(
      notUpdated('the re-read did not finish within 0.001 s'),
    );
    expect(note('locked')).toBe(
      notUpdated("another Contrail process is refreshing this connection's snapshot"),
    );
    expect(note('refresh_running')).toBe(
      notUpdated('a snapshot refresh was already running on this connection'),
    );
    expect(note('failed', 'retrieve failed: INVALID_SESSION_ID')).toBe(
      notUpdated('the re-read failed: retrieve failed: INVALID_SESSION_ID'),
    );
    expect(note('failed', 'x'.repeat(300))).toBe(notUpdated(`the re-read failed: ${'x'.repeat(200)}`));
    expect(note('failed_after_write', 'snapshot files only partly replaced: EBUSY')).toBe(
      "Deployed. The local snapshot may be only PARTLY updated for this deploy (the re-read stopped while writing: snapshot files only partly replaced: EBUSY) — its files and its index can disagree for these components. Run refresh_snapshot with members set to this deploy's components to repair it.",
    );
    expect(note('no_snapshot')).toBe(
      'Deployed. This connection has no local snapshot, so there was nothing to re-baseline. Run refresh_snapshot when you need one.',
    );
    const many = [
      ...Array.from({ length: 101 }, (_, i) => mem('ApexClass', `Cls${i}`)),
      mem('CustomField', 'Invoice__c.Amount__c'),
    ];
    expect(note('too_many_members', 'ApexClass, CustomObject', many)).toBe(
      'Deployed. The local snapshot was NOT updated: this deploy has 102 components, more than the 100 a member-scoped re-read takes. Run refresh_snapshot with types: ["ApexClass", "CustomObject"] to bring it up to date.',
    );
    expect(note('no_metadata_read')).toBe(
      'Deployed. The local snapshot was NOT updated: this connection no longer grants metadata_read, so Contrail did not copy org metadata into the snapshot.',
    );
    expect(note('connection_removed')).toBe(
      'Deployed. The local snapshot was NOT updated: this connection was removed before Contrail finished re-reading the deployed components.',
    );
  });

  it('complete, partial and none', () => {
    const complete = executeSnapshotResult(
      {
        status: 'ran',
        summary: summary([
          { type: 'ApexClass', api_name: 'InvoiceService', unit: 'ApexClass:InvoiceService', outcome: 'refreshed' },
          {
            type: 'CustomField',
            api_name: 'Invoice__c.Amount__c',
            unit: 'CustomObject:Invoice__c',
            outcome: 'refreshed',
          },
          { type: 'ApexClass', api_name: 'OldService', unit: 'ApexClass:OldService', outcome: 'removed' },
        ]),
      },
      members,
      60_000,
    );
    expect(complete).toEqual({
      snapshot: {
        status: 'complete',
        rebaselined: [mem('ApexClass', 'InvoiceService'), mem('CustomField', 'Invoice__c.Amount__c')],
        removed: [mem('ApexClass', 'OldService')],
        skipped: [],
        retrieved_at: RETRIEVED_AT,
        note: REREAD,
      },
      note: 'Deployed. Contrail re-read the 3 component(s) in this deploy from the org into the local snapshot — no refresh_snapshot is needed for them.',
    });

    const partial = executeSnapshotResult(
      {
        status: 'ran',
        summary: summary([
          { type: 'ApexClass', api_name: 'InvoiceService', unit: 'ApexClass:InvoiceService', outcome: 'refreshed' },
          {
            type: 'CustomField',
            api_name: 'Invoice__c.Amount__c',
            unit: 'CustomObject:Invoice__c',
            outcome: 'skipped',
            reason: 'child_not_in_parent',
          },
          { type: 'ApexClass', api_name: 'OldService', unit: 'ApexClass:OldService', outcome: 'removed' },
        ]),
      },
      members,
      60_000,
    );
    expect(partial).toEqual({
      snapshot: {
        status: 'partial',
        rebaselined: [mem('ApexClass', 'InvoiceService')],
        removed: [mem('ApexClass', 'OldService')],
        skipped: [
          {
            type: 'CustomField',
            api_name: 'Invoice__c.Amount__c',
            code: 'child_not_in_parent',
            reason:
              'The re-read parent document does not contain it, so the snapshot holds no copy of it now. Contrail did not check the org for it separately.',
          },
        ],
        retrieved_at: RETRIEVED_AT,
        note: REREAD,
      },
      note: 'Deployed. Contrail re-read 2 of 3 component(s) in this deploy into the local snapshot; 1 were not re-baselined — snapshot.skipped gives the reason for each. Run refresh_snapshot for those you need current.',
    });

    const none = executeSnapshotResult(
      {
        status: 'ran',
        summary: {
          ...summary([
            {
              type: 'Report',
              api_name: 'Sales/Pipeline',
              unit: 'Report:Sales/Pipeline',
              outcome: 'skipped',
              reason: 'type_not_in_snapshot',
            },
            { type: 'Profile', api_name: 'Admin', outcome: 'skipped', reason: 'profile' },
          ]),
          retrieved_at: null,
        },
      },
      [mem('Report', 'Sales/Pipeline'), mem('Profile', 'Admin')],
      60_000,
    );
    expect(none).toEqual({
      snapshot: {
        status: 'none',
        rebaselined: [],
        removed: [],
        skipped: [
          {
            type: 'Report',
            api_name: 'Sales/Pipeline',
            code: 'type_not_in_snapshot',
            reason:
              "This connection's snapshot holds no Report, and Contrail could not confirm from the org's listing that the named components are the only ones of that type — writing just these would make any other Report in the org read as new or missing. Run refresh_snapshot with types: [\"Report\"].",
          },
          {
            type: 'Profile',
            api_name: 'Admin',
            code: 'profile',
            reason:
              'Profile is never snapshotted — a single-profile retrieve is package-relative, so its bytes would not be a faithful copy.',
          },
        ],
        note: 'The local snapshot was NOT updated for this deploy — snapshot.skipped gives the reason for each component. Run refresh_snapshot for those you need current.',
      },
      note: 'Deployed. The local snapshot was NOT updated for this deploy — snapshot.skipped gives the reason for each component. Run refresh_snapshot for those you need current.',
    });
  });

  it('none with a unit written: every member skipped, yet the parent was written — the note says so, and the edge note is kept', () => {
    // A deploy of only Account.A__c whose re-read Account document lacks it:
    // the parent was replaced whole and its edges rebuilt; the child's copy dropped.
    const childOnly = [mem('CustomField', 'Account.A__c')];
    const skippedChild = {
      type: 'CustomField',
      api_name: 'Account.A__c',
      unit: 'CustomObject:Account',
      outcome: 'skipped' as const,
      reason: 'child_not_in_parent' as const,
    };
    const childSkip = {
      type: 'CustomField',
      api_name: 'Account.A__c',
      code: 'child_not_in_parent',
      reason:
        'The re-read parent document does not contain it, so the snapshot holds no copy of it now. Contrail did not check the org for it separately.',
    };
    const NOTE =
      'Deployed. None of the components in this deploy was re-baselined — snapshot.skipped gives the reason for each. Contrail did write to the local snapshot one or more documents it re-read for them (a parent document or a folder). Run refresh_snapshot for those you need current.';
    const written = executeSnapshotResult(
      { status: 'ran', summary: { ...summary([skippedChild]), units: ['CustomObject:Account'] } },
      childOnly,
      60_000,
    );
    expect(written).toEqual({
      snapshot: {
        status: 'none',
        rebaselined: [],
        removed: [],
        skipped: [childSkip],
        retrieved_at: RETRIEVED_AT,
        note: REREAD,
      },
      note: NOTE,
    });
    // With a pre-skipped member beside it, the same.
    const mixed = executeSnapshotResult(
      {
        status: 'ran',
        summary: {
          ...summary([skippedChild, { type: 'Profile', api_name: 'Admin', outcome: 'skipped', reason: 'profile' }]),
          units: ['CustomObject:Account'],
        },
      },
      [...childOnly, mem('Profile', 'Admin')],
      60_000,
    );
    expect(mixed.snapshot.status).toBe('none');
    expect(mixed.snapshot.note).toBe(REREAD);
    expect(mixed.note).toBe(NOTE);
    // Nothing written (no unit): the NOT-updated note, unchanged.
    const nothing = executeSnapshotResult({ status: 'ran', summary: summary([skippedChild]) }, childOnly, 60_000);
    expect(nothing.snapshot.status).toBe('none');
    expect(nothing.note).toBe(
      'Deployed. The local snapshot was NOT updated for this deploy — snapshot.skipped gives the reason for each component. Run refresh_snapshot for those you need current.',
    );
  });
});
