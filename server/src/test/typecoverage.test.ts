import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync } from 'fflate';
import {
  analyzeChanges,
  analyzePermissionCoverage,
  buildDeployZip,
  type ProposedComponent,
} from '../deploy/package.js';
import { indexSnapshotFiles } from '../snapshot/indexer.js';
import type { ContrailDb } from '../core/db.js';
import type { SnapshotStore } from '../snapshot/store.js';
import type { ConnectionRecord } from '../core/types.js';

/**
 * S17 type-coverage expansion: the declarative UI / reporting / integration
 * types are deployable and indexable, ListView/RecordType join the CustomObject
 * children, and the destructive path's allowlist-free contract is pinned as
 * DELIBERATE (see the comment in package.ts — deletions are approval-gated and
 * being able to remove what Contrail cannot author is a feature).
 */

const V = '63.0';
const noMeta = () => null;

function comp(type: string, api_name: string, content: string): ProposedComponent {
  return { type, api_name, content };
}

function zipText(zip: Buffer, path: string): string {
  const entries = unzipSync(zip);
  const bytes = entries[path];
  if (!bytes) throw new Error(`zip is missing ${path}`);
  return Buffer.from(bytes).toString('utf8');
}

describe('S17 deployable types', () => {
  it('places each new file type in its metadata-format folder and manifest', () => {
    const cases: Array<[string, string, string]> = [
      ['FlexiPage', 'Invoice_Record_Page', 'flexipages/Invoice_Record_Page.flexipage'],
      ['CustomApplication', 'Invoicing', 'applications/Invoicing.app'],
      ['ReportType', 'Invoices_with_Accounts', 'reportTypes/Invoices_with_Accounts.reportType'],
      ['GlobalValueSet', 'Region_Values', 'globalValueSets/Region_Values.globalValueSet'],
      ['ConnectedApp', 'Contrail_App', 'connectedApps/Contrail_App.connectedApp'],
      ['NamedCredential', 'Billing_API', 'namedCredentials/Billing_API.namedCredential'],
      ['ExternalCredential', 'Billing_Auth', 'externalCredentials/Billing_Auth.externalCredential'],
      ['PlatformEventChannel', 'Ops__chn', 'platformEventChannels/Ops__chn.platformEventChannel'],
      [
        'PlatformEventChannelMember',
        'Ops_AccountChangeEvent',
        'platformEventChannelMembers/Ops_AccountChangeEvent.platformEventChannelMember',
      ],
      [
        'ManagedEventSubscription',
        'Ops_Sub',
        'managedEventSubscriptions/Ops_Sub.managedEventSubscription',
      ],
    ];
    for (const [type, name, path] of cases) {
      const built = buildDeployZip([comp(type, name, `<${type}/>`)], [], V, noMeta);
      expect(built.files, `${type} file placement`).toContain(path);
      expect(built.packageXml).toContain(`<name>${type}</name>`);
      expect(built.packageXml).toContain(`<members>${name}</members>`);
    }
  });

  it('ApexPage ships content plus a generated meta with label and NO status', () => {
    const built = buildDeployZip(
      [comp('ApexPage', 'Invoice_Portal', '<apex:page>hi</apex:page>')],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain('pages/Invoice_Portal.page');
    expect(built.files).toContain('pages/Invoice_Portal.page-meta.xml');
    const meta = zipText(built.zip, 'pages/Invoice_Portal.page-meta.xml');
    expect(meta).toContain('<apiVersion>63.0</apiVersion>');
    expect(meta).toContain('<label>Invoice_Portal</label>');
    expect(meta).not.toContain('<status>'); // ApexPage meta has no status element
  });

  it('a snapshot meta.xml still wins over the generated ApexPage meta', () => {
    const built = buildDeployZip(
      [comp('ApexPage', 'Invoice_Portal', '<apex:page/>')],
      [],
      V,
      () => '<ApexPage><apiVersion>58.0</apiVersion><label>Kept Label</label></ApexPage>',
    );
    expect(zipText(built.zip, 'pages/Invoice_Portal.page-meta.xml')).toContain('Kept Label');
  });

  it('ListView and RecordType children merge into one CustomObject container', () => {
    const built = buildDeployZip(
      [
        comp('ListView', 'Invoice__c.All_Open', '<listViews><fullName>All_Open</fullName></listViews>'),
        comp('RecordType', 'Invoice__c.Standard', '<recordTypes><fullName>Standard</fullName></recordTypes>'),
      ],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain('objects/Invoice__c.object');
    const doc = zipText(built.zip, 'objects/Invoice__c.object');
    expect(doc).toContain('<CustomObject xmlns=');
    expect(doc).toContain('<fullName>All_Open</fullName>');
    expect(doc).toContain('<fullName>Standard</fullName>');
    expect(built.packageXml).toContain('<name>ListView</name>');
    expect(built.packageXml).toContain('<name>RecordType</name>');
    expect(built.packageXml).toContain('<members>Invoice__c.All_Open</members>');
  });

  it('still refuses mixing a full .object with its individual children', () => {
    expect(() =>
      buildDeployZip(
        [
          comp('CustomObject', 'Invoice__c', '<CustomObject/>'),
          comp('ListView', 'Invoice__c.All_Open', '<listViews/>'),
        ],
        [],
        V,
        noMeta,
      ),
    ).toThrow(/pick one form/);
  });

  it('PIN: deletions are NOT gated by the deployable-type allowlist', () => {
    // Layout is not deployable through Contrail; deleting one must still build.
    const built = buildDeployZip(
      [],
      [
        { type: 'Layout', api_name: 'Invoice__c-Invoice Layout' },
        { type: 'ManagedEventSubscription', api_name: 'Old_Sub' },
      ],
      V,
      noMeta,
    );
    expect(built.files).toContain('destructiveChangesPost.xml');
    expect(built.destructiveXml).toContain('<name>Layout</name>');
    expect(built.destructiveXml).toContain('<members>Old_Sub</members>');
  });

  it('an undeployable type still fails loudly on the additive path', () => {
    expect(() => buildDeployZip([comp('Layout', 'X-Y', '<Layout/>')], [], V, noMeta)).toThrow(
      /not deployable through Contrail/,
    );
  });
});

describe('S17 change analysis', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
  function fakes(oldContent: string | null) {
    const db = {
      getArtifact: () =>
        oldContent === null ? null : { filePath: 'flexipages/P.flexipage' },
    } as unknown as ContrailDb;
    const store = {
      readCurrentFile: () => oldContent,
    } as unknown as SnapshotStore;
    return { db, store };
  }

  it('modifying a FlexiPage warns about whole-document replacement', () => {
    const { db, store } = fakes('<FlexiPage>old</FlexiPage>');
    const { changes } = analyzeChanges(
      db,
      store,
      conn,
      [comp('FlexiPage', 'P', '<FlexiPage>new</FlexiPage>')],
      [],
    );
    expect(changes[0]!.change).toBe('modify');
    expect(changes[0]!.warnings.join(' ')).toMatch(/WHOLE-DOCUMENT REPLACE/);
  });

  it('adding a FlexiPage carries no replace warning', () => {
    const { db, store } = fakes(null);
    const { changes } = analyzeChanges(
      db,
      store,
      conn,
      [comp('FlexiPage', 'P', '<FlexiPage/>')],
      [],
    );
    expect(changes[0]!.change).toBe('add');
    expect(changes[0]!.warnings).toHaveLength(0);
  });
});

describe('S17 permission coverage', () => {
  const page = comp('ApexPage', 'Invoice_Portal', '<apex:page/>');
  const app = comp('CustomApplication', 'Invoicing', '<CustomApplication/>');

  function permSet(body: string): ProposedComponent {
    return comp('PermissionSet', 'Invoice_Access', `<PermissionSet>${body}</PermissionSet>`);
  }

  it('flags ApexPage and CustomApplication with no permission container', () => {
    const cov = analyzePermissionCoverage([page, app]);
    expect(cov.has_permission_container).toBe(false);
    expect(cov.uncovered).toEqual([
      { type: 'ApexPage', api_name: 'Invoice_Portal', permission: 'Visualforce page access' },
      { type: 'CustomApplication', api_name: 'Invoicing', permission: 'app visibility' },
    ]);
    expect(cov.warning).toMatch(/no permission set or profile/);
  });

  it('counts pageAccesses/applicationVisibilities as coverage only when enabled', () => {
    const granted = permSet(
      '<pageAccesses><apexPage>Invoice_Portal</apexPage><enabled>true</enabled></pageAccesses>' +
        '<applicationVisibilities><application>Invoicing</application><visible>true</visible></applicationVisibilities>',
    );
    expect(analyzePermissionCoverage([page, app, granted]).uncovered).toHaveLength(0);

    const mentionedOff = permSet(
      '<pageAccesses><apexPage>Invoice_Portal</apexPage><enabled>false</enabled></pageAccesses>' +
        '<applicationVisibilities><application>Invoicing</application><visible>false</visible></applicationVisibilities>',
    );
    const cov = analyzePermissionCoverage([page, app, mentionedOff]);
    expect(cov.uncovered).toHaveLength(2); // a disabled mention is NOT coverage
    expect(cov.warning).toMatch(/not granted by the permission set/);
  });
});

describe('S17 snapshot indexing', () => {
  it('indexes the new folders and the new CustomObject children', () => {
    const objectXml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject>\n' +
      '  <fields><fullName>Amount__c</fullName><type>Currency</type></fields>\n' +
      '  <listViews><fullName>All_Open</fullName><label>All Open</label></listViews>\n' +
      '  <recordTypes><fullName>Standard</fullName><label>Standard</label></recordTypes>\n' +
      '</CustomObject>\n';
    const files = new Map(
      Object.entries({
        'objects/Invoice__c.object': strToU8(objectXml),
        'tabs/Invoice__c.tab': strToU8('<CustomTab/>'),
        'flexipages/Invoice_Record_Page.flexipage': strToU8('<FlexiPage/>'),
        'applications/Invoicing.app': strToU8('<CustomApplication/>'),
        'reportTypes/Invoices.reportType': strToU8('<ReportType/>'),
        'pages/Invoice_Portal.page': strToU8('<apex:page/>'),
        'pages/Invoice_Portal.page-meta.xml': strToU8('<ApexPage/>'),
        'globalValueSets/Region.globalValueSet': strToU8('<GlobalValueSet/>'),
        'connectedApps/Contrail.connectedApp': strToU8('<ConnectedApp/>'),
        'managedEventSubscriptions/Sub.managedEventSubscription': strToU8('<ManagedEventSubscription/>'),
        'layouts/Invoice__c-Layout.layout': strToU8('<Layout/>'), // still unmapped
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-08-26T00:00:00.000Z');
    const keys = new Set(artifacts.map((a) => `${a.type}:${a.apiName}`));

    expect(keys.has('CustomTab:Invoice__c')).toBe(true);
    expect(keys.has('FlexiPage:Invoice_Record_Page')).toBe(true);
    expect(keys.has('CustomApplication:Invoicing')).toBe(true);
    expect(keys.has('ReportType:Invoices')).toBe(true);
    expect(keys.has('ApexPage:Invoice_Portal')).toBe(true);
    expect(keys.has('GlobalValueSet:Region')).toBe(true);
    expect(keys.has('ConnectedApp:Contrail')).toBe(true);
    expect(keys.has('ManagedEventSubscription:Sub')).toBe(true);
    expect(keys.has('ListView:Invoice__c.All_Open')).toBe(true);
    expect(keys.has('RecordType:Invoice__c.Standard')).toBe(true);
    expect(keys.has('CustomField:Invoice__c.Amount__c')).toBe(true); // unchanged behavior
    expect([...keys].some((k) => k.startsWith('Layout:') || k.includes('meta'))).toBe(false);

    // Child fragments carry their own block, not the whole container.
    const lv = artifacts.find((a) => a.type === 'ListView')!;
    expect(lv.content).toContain('<fullName>All_Open</fullName>');
    expect(lv.content).not.toContain('recordTypes');
    expect(lv.filePath).toBe('objects/Invoice__c.object');
  });
});
