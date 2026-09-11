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
    // EmailTemplate is not deployable through Contrail; deleting one must
    // still build. (This pin used Dashboard until S29 made that deployable.)
    const built = buildDeployZip(
      [],
      [
        { type: 'EmailTemplate', api_name: 'Old_Welcome_Template' },
        { type: 'ManagedEventSubscription', api_name: 'Old_Sub' },
      ],
      V,
      noMeta,
    );
    expect(built.files).toContain('destructiveChangesPost.xml');
    expect(built.destructiveXml).toContain('<name>EmailTemplate</name>');
    expect(built.destructiveXml).toContain('<members>Old_Sub</members>');
  });

  it('an undeployable type still fails loudly on the additive path', () => {
    expect(() =>
      buildDeployZip([comp('EmailTemplate', 'X-Y', '<EmailTemplate/>')], [], V, noMeta),
    ).toThrow(/not deployable through Contrail/);
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
        // S29: nested foldered content indexes folder-qualified (was pinned
        // unmapped before Dashboard became deployable).
        'dashboards/Ops/Weekly.dashboard': strToU8('<Dashboard/>'),
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
    expect(keys.has('Dashboard:Ops/Weekly')).toBe(true);
    expect([...keys].some((k) => k.includes('meta'))).toBe(false);

    // Child fragments carry their own block, not the whole container.
    const lv = artifacts.find((a) => a.type === 'ListView')!;
    expect(lv.content).toContain('<fullName>All_Open</fullName>');
    expect(lv.content).not.toContain('recordTypes');
    expect(lv.filePath).toBe('objects/Invoice__c.object');
  });
});

describe('S19: Layout and CustomMetadata', () => {
  it('places layouts (spaces and all) and custom metadata records correctly', () => {
    const built = buildDeployZip(
      [
        comp('Layout', 'Invoice__c-Invoice Layout', '<Layout/>'),
        comp('CustomMetadata', 'Billing_Config.Default_Terms', '<CustomMetadata/>'),
      ],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain('layouts/Invoice__c-Invoice Layout.layout');
    expect(built.files).toContain('customMetadata/Billing_Config.Default_Terms.md');
    expect(built.packageXml).toContain('<name>Layout</name>');
    expect(built.packageXml).toContain('<members>Invoice__c-Invoice Layout</members>');
    expect(built.packageXml).toContain('<name>CustomMetadata</name>');
    expect(built.packageXml).toContain('<members>Billing_Config.Default_Terms</members>');
  });

  it('one package carries a __mdt type definition AND its records', () => {
    const built = buildDeployZip(
      [
        comp('CustomObject', 'Billing_Config__mdt', '<CustomObject/>'),
        comp('CustomMetadata', 'Billing_Config.Default_Terms', '<CustomMetadata/>'),
        comp('CustomMetadata', 'Billing_Config.Rush_Terms', '<CustomMetadata/>'),
      ],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain('objects/Billing_Config__mdt.object');
    expect(built.files).toContain('customMetadata/Billing_Config.Default_Terms.md');
    expect(built.files).toContain('customMetadata/Billing_Config.Rush_Terms.md');
    expect(built.packageXml).toContain('<members>Billing_Config__mdt</members>');
  });

  it('warns per change kind: layout add = unassigned; layout/record modify = replace', () => {
    const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
    const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
    const storeNone = { readCurrentFile: () => null } as unknown as SnapshotStore;
    const added = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('Layout', 'Invoice__c-Invoice Layout', '<Layout>new</Layout>')],
      [],
    );
    expect(added.changes[0]!.change).toBe('add');
    expect(added.changes[0]!.warnings.join(' ')).toMatch(/NOT ASSIGNED/);

    const dbMod = {
      getArtifact: () => ({ filePath: 'x' }),
    } as unknown as ContrailDb;
    const storeOld = { readCurrentFile: () => '<old/>' } as unknown as SnapshotStore;
    const modified = analyzeChanges(
      dbMod,
      storeOld,
      conn,
      [
        comp('Layout', 'Invoice__c-Invoice Layout', '<Layout>new</Layout>'),
        comp('CustomMetadata', 'Billing_Config.Default_Terms', '<CustomMetadata>new</CustomMetadata>'),
      ],
      [],
    );
    expect(modified.changes[0]!.warnings.join(' ')).toMatch(/WHOLE-DOCUMENT REPLACE/);
    expect(modified.changes[0]!.warnings.join(' ')).not.toMatch(/NOT ASSIGNED/);
    expect(modified.changes[1]!.warnings.join(' ')).toMatch(/FULL-RECORD REPLACE/);
  });

  it('indexes layouts (decoding percent-escapes) and custom metadata records', () => {
    const files = new Map(
      Object.entries({
        'layouts/Invoice__c-Invoice Layout.layout': strToU8('<Layout/>'),
        'layouts/Account-Account %28Marketing%29 Layout.layout': strToU8('<Layout/>'),
        'customMetadata/Billing_Config.Default_Terms.md': strToU8('<CustomMetadata/>'),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-08-27T00:00:00.000Z');
    const keys = new Set(artifacts.map((a) => `${a.type}:${a.apiName}`));
    expect(keys.has('Layout:Invoice__c-Invoice Layout')).toBe(true);
    expect(keys.has('Layout:Account-Account (Marketing) Layout')).toBe(true); // decoded
    expect(keys.has('CustomMetadata:Billing_Config.Default_Terms')).toBe(true);
    // The file path stays as retrieved (encoded) so snapshot reads resolve.
    const marketing = artifacts.find((a) => a.apiName.includes('(Marketing)'))!;
    expect(marketing.filePath).toBe('layouts/Account-Account %28Marketing%29 Layout.layout');
  });

  it('paren-named standard layouts round-trip: index decoded, deploy encoded, member literal', () => {
    const name = 'Account-Account (Marketing) Layout';
    const built = buildDeployZip([comp('Layout', name, '<Layout/>')], [], V, noMeta);
    // The zip entry mirrors the retrieve encoding; the manifest stays literal.
    expect(built.files).toContain('layouts/Account-Account %28Marketing%29 Layout.layout');
    expect(built.packageXml).toContain(`<members>${name}</members>`);
  });

  it('__mdt fields never trigger the FLS permission warning (cmdt has no FLS)', () => {
    const cov = analyzePermissionCoverage([
      comp(
        'CustomObject',
        'Billing_Config__mdt',
        '<CustomObject><fields><fullName>Rate__c</fullName></fields></CustomObject>',
      ),
      comp('CustomField', 'Billing_Config__mdt.Extra__c', '<fields/>'),
      comp('CustomMetadata', 'Billing_Config.Default_Terms', '<CustomMetadata/>'),
    ]);
    expect(cov.uncovered).toEqual([]);
    expect(cov.warning).toBeNull();
  });

  it('a stray % beside real escapes decodes the escapes and keeps the stray', () => {
    const files = new Map(
      Object.entries({ 'layouts/Odd-100% %28VIP%29 Layout.layout': strToU8('<Layout/>') }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-08-27T00:00:00.000Z');
    expect(artifacts[0]!.apiName).toBe('Odd-100% (VIP) Layout');
  });

  it('a literal % that is not an escape survives indexing unchanged', () => {
    const files = new Map(
      Object.entries({ 'layouts/Odd-100% Done Layout.layout': strToU8('<Layout/>') }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-08-27T00:00:00.000Z');
    expect(artifacts[0]!.apiName).toBe('Odd-100% Done Layout');
  });
});

describe('S29: Report & Dashboard (foldered types)', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;

  it('places foldered content with the / preserved and the member literal', () => {
    const built = buildDeployZip(
      [
        comp('Report', 'Ops_Reports/Weekly_Pipeline', '<Report/>'),
        comp('Dashboard', 'Exec/Pipeline_Overview', '<Dashboard/>'),
      ],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain('reports/Ops_Reports/Weekly_Pipeline.report');
    expect(built.files).toContain('dashboards/Exec/Pipeline_Overview.dashboard');
    expect(built.packageXml).toContain('<name>Report</name>');
    expect(built.packageXml).toContain('<members>Ops_Reports/Weekly_Pipeline</members>');
    expect(built.packageXml).toContain('<name>Dashboard</name>');
    expect(built.packageXml).toContain('<members>Exec/Pipeline_Overview</members>');
  });

  it('a folder component IS its -meta.xml and manifests as the CONTENT type', () => {
    const folderDoc =
      '<?xml version="1.0" encoding="UTF-8"?>\n<ReportFolder xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
      '  <name>Ops Reports</name>\n' +
      '  <folderShares><accessLevel>View</accessLevel><sharedTo>AllInternalUsers</sharedTo>' +
      '<sharedToType>Organization</sharedToType></folderShares>\n</ReportFolder>\n';
    const built = buildDeployZip([comp('ReportFolder', 'Ops_Reports', folderDoc)], [], V, noMeta);
    expect(built.files).toContain('reports/Ops_Reports-meta.xml');
    // No separate content file, no ReportFolder types block in the manifest.
    expect(built.files.filter((f) => f.startsWith('reports/'))).toEqual([
      'reports/Ops_Reports-meta.xml',
    ]);
    expect(built.packageXml).toContain('<name>Report</name>');
    expect(built.packageXml).toContain('<members>Ops_Reports</members>');
    expect(built.packageXml).not.toContain('<name>ReportFolder</name>');
    expect(zipText(built.zip, 'reports/Ops_Reports-meta.xml')).toContain('<folderShares>');
  });

  it('folder + report ship in ONE types block of one package', () => {
    const built = buildDeployZip(
      [
        comp('ReportFolder', 'Ops_Reports', '<ReportFolder/>'),
        comp('Report', 'Ops_Reports/Weekly_Pipeline', '<Report/>'),
      ],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain('reports/Ops_Reports-meta.xml');
    expect(built.files).toContain('reports/Ops_Reports/Weekly_Pipeline.report');
    const reportBlocks = built.packageXml.match(/<name>Report<\/name>/g) ?? [];
    expect(reportBlocks).toHaveLength(1);
    expect(built.packageXml).toContain('<members>Ops_Reports</members>');
    expect(built.packageXml).toContain('<members>Ops_Reports/Weekly_Pipeline</members>');
  });

  it('unfiled$public names validate and keep the $ literal in the zip path', () => {
    const built = buildDeployZip(
      [comp('Report', 'unfiled$public/Quick_Check', '<Report/>')],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain('reports/unfiled$public/Quick_Check.report');
    expect(built.packageXml).toContain('<members>unfiled$public/Quick_Check</members>');
  });

  it('rejects every malformed foldered name; flat types still reject any slash', () => {
    const bad = [
      'Ops/../evil',
      'a/b/c',
      '/Ops',
      'Ops/',
      'Ops//x',
      'Ops\\x',
      'Ops/We ekly',
      'Ops/(Weekly)',
      'Weekly', // foldered types REQUIRE the folder qualifier
    ];
    for (const name of bad) {
      expect(
        () => buildDeployZip([comp('Report', name, '<Report/>')], [], V, noMeta),
        `Report "${name}" must be rejected`,
      ).toThrow(/invalid/);
    }
    // Folder components: single segment only.
    expect(() =>
      buildDeployZip([comp('ReportFolder', 'Ops/Nested', '<ReportFolder/>')], [], V, noMeta),
    ).toThrow(/invalid/);
    // Flat types keep the hard no-slash rule.
    expect(() =>
      buildDeployZip([comp('ApexClass', 'a/b', 'class a {}')], [], V, noMeta),
    ).toThrow(/invalid component name/);
    // Deletions run the same grammar for registered foldered types.
    expect(() => buildDeployZip([], [{ type: 'Report', api_name: 'Ops/../evil' }], V, noMeta)).toThrow(
      /invalid/,
    );
  });

  it('deployZipEntryPath matches the builder for foldered and folder components', async () => {
    const { deployZipEntryPath } = await import('../deploy/package.js');
    const report = deployZipEntryPath('Report', 'Ops_Reports/Weekly_Pipeline');
    expect(report).toEqual({ path: 'reports/Ops_Reports/Weekly_Pipeline.report', child: false });
    const folder = deployZipEntryPath('ReportFolder', 'Ops_Reports');
    expect(folder).toEqual({ path: 'reports/Ops_Reports-meta.xml', child: false });
    const built = buildDeployZip(
      [
        comp('Report', 'Ops_Reports/Weekly_Pipeline', '<Report/>'),
        comp('ReportFolder', 'Ops_Reports', '<ReportFolder/>'),
      ],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain((report as { path: string }).path);
    expect(built.files).toContain((folder as { path: string }).path);
  });

  it('deleting foldered content and folders remaps to the content type manifest', () => {
    const built = buildDeployZip(
      [],
      [
        { type: 'Report', api_name: 'Ops_Reports/Old_Report' },
        { type: 'ReportFolder', api_name: 'Dead_Folder' },
      ],
      V,
      noMeta,
    );
    expect(built.destructiveXml).toContain('<name>Report</name>');
    expect(built.destructiveXml).toContain('<members>Ops_Reports/Old_Report</members>');
    expect(built.destructiveXml).toContain('<members>Dead_Folder</members>');
    expect(built.destructiveXml).not.toContain('<name>ReportFolder</name>');
  });

  it('warns honestly: modify = whole-doc replace; add = folder-sharing governs access', () => {
    const dbMod = { getArtifact: () => ({ filePath: 'x' }) } as unknown as ContrailDb;
    const storeOld = { readCurrentFile: () => '<old/>' } as unknown as SnapshotStore;
    const modified = analyzeChanges(
      dbMod,
      storeOld,
      conn,
      [comp('Report', 'Ops/Weekly', '<Report>new</Report>')],
      [],
    );
    expect(modified.changes[0]!.warnings.join(' ')).toMatch(/WHOLE-DOCUMENT REPLACE/);

    const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
    const storeNone = { readCurrentFile: () => null } as unknown as SnapshotStore;
    const added = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('Dashboard', 'Exec/Overview', '<Dashboard/>')],
      [],
    );
    expect(added.changes[0]!.warnings.join(' ')).toMatch(/FOLDER's sharing/);
    expect(added.changes[0]!.warnings.join(' ')).toMatch(/grants nobody new access/);

    const folderMod = analyzeChanges(
      dbMod,
      storeOld,
      conn,
      [comp('ReportFolder', 'Ops', '<ReportFolder>new</ReportFolder>')],
      [],
    );
    expect(folderMod.changes[0]!.warnings.join(' ')).toMatch(/FOLDER REPLACE/);
  });

  it('permission coverage stays SILENT for reports/dashboards (folder sharing, not FLS)', () => {
    const cov = analyzePermissionCoverage([
      comp('Report', 'Ops/Weekly', '<Report/>'),
      comp('Dashboard', 'Exec/Overview', '<Dashboard/>'),
    ]);
    expect(cov.uncovered).toEqual([]);
    expect(cov.warning).toBeNull();
  });

  it('indexes nested content folder-qualified, folder -meta.xml as folder types', () => {
    const files = new Map(
      Object.entries({
        'reports/Ops-meta.xml': strToU8('<ReportFolder><name>Ops</name></ReportFolder>'),
        'reports/Ops/Weekly.report': strToU8('<Report>ops</Report>'),
        'reports/Sales/Weekly.report': strToU8('<Report>sales</Report>'),
        'reports/unfiled$public/Quick.report': strToU8('<Report/>'),
        'dashboards/Exec-meta.xml': strToU8('<DashboardFolder/>'),
        'dashboards/Exec/Overview.dashboard': strToU8('<Dashboard/>'),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-09-08T00:00:00.000Z');
    const keys = new Set(artifacts.map((a) => `${a.type}:${a.apiName}`));
    expect(keys.has('Report:Ops/Weekly')).toBe(true);
    expect(keys.has('Report:Sales/Weekly')).toBe(true); // same leaf, distinct rows
    expect(keys.has('Report:unfiled$public/Quick')).toBe(true);
    expect(keys.has('ReportFolder:Ops')).toBe(true);
    expect(keys.has('Dashboard:Exec/Overview')).toBe(true);
    expect(keys.has('DashboardFolder:Exec')).toBe(true);
    // The two same-leaf reports carry their own content — no clobbering.
    const ops = artifacts.find((a) => a.apiName === 'Ops/Weekly')!;
    const sales = artifacts.find((a) => a.apiName === 'Sales/Weekly')!;
    expect(ops.content).toContain('ops');
    expect(sales.content).toContain('sales');
    expect(ops.filePath).toBe('reports/Ops/Weekly.report');
  });

  it('decodes percent-escapes per segment, never the separator', () => {
    const files = new Map(
      Object.entries({
        'reports/Ops/Weekly %28Q3%29.report': strToU8('<Report/>'),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-09-08T00:00:00.000Z');
    expect(artifacts[0]!.apiName).toBe('Ops/Weekly (Q3)');
    expect(artifacts[0]!.filePath).toBe('reports/Ops/Weekly %28Q3%29.report');
  });

  it('round-trip: an indexed foldered name deploys to the same entry path, member literal', () => {
    const files = new Map(
      Object.entries({ 'reports/Ops/Weekly.report': strToU8('<Report/>') }),
    );
    const [indexed] = indexSnapshotFiles(files, [], '2026-09-08T00:00:00.000Z');
    const built = buildDeployZip([comp('Report', indexed!.apiName, '<Report/>')], [], V, noMeta);
    expect(built.files).toContain(indexed!.filePath);
    expect(built.packageXml).toContain(`<members>${indexed!.apiName}</members>`);
  });
});

describe('S30: Agentforce types', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;

  it('places each single-file agent type in its folder with a literal member', () => {
    const cases: Array<[string, string, string]> = [
      ['Bot', 'Support_Agent', 'bots/Support_Agent.bot'],
      ['GenAiPlugin', 'Order_Topic', 'genAiPlugins/Order_Topic.genAiPlugin'],
      [
        'GenAiPromptTemplate',
        'Case_Summary',
        'genAiPromptTemplates/Case_Summary.genAiPromptTemplate',
      ],
      [
        'GenAiPromptTemplateActv',
        'Case_Summary_Actv',
        'genAiPromptTemplateActivations/Case_Summary_Actv.genAiPromptTemplateActivation',
      ],
      [
        'AiEvaluationDefinition',
        'Support_Agent_Tests',
        'aiEvaluationDefinitions/Support_Agent_Tests.aiEvaluationDefinition',
      ],
      ['BotTemplate', 'Support_Tmpl', 'botTemplates/Support_Tmpl.botTemplate'],
      ['BotBlock', 'Greeting_Block', 'botBlocks/Greeting_Block.botBlock'],
    ];
    for (const [type, name, path] of cases) {
      const built = buildDeployZip([comp(type, name, `<${type}/>`)], [], V, noMeta);
      expect(built.files, `${type} placement`).toContain(path);
      expect(built.packageXml).toContain(`<name>${type}</name>`);
      expect(built.packageXml).toContain(`<members>${name}</members>`);
    }
  });

  it('BotVersion children merge into one Bot container document', () => {
    const built = buildDeployZip(
      [
        comp('BotVersion', 'Support_Agent.v1', '<botVersions><fullName>v1</fullName></botVersions>'),
        comp('BotVersion', 'Support_Agent.v2', '<botVersions><fullName>v2</fullName></botVersions>'),
      ],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain('bots/Support_Agent.bot');
    const doc = zipText(built.zip, 'bots/Support_Agent.bot');
    expect(doc).toContain('<Bot xmlns=');
    expect(doc).toContain('<fullName>v1</fullName>');
    expect(doc).toContain('<fullName>v2</fullName>');
    expect(built.packageXml).toContain('<name>BotVersion</name>');
    expect(built.packageXml).toContain('<members>Support_Agent.v1</members>');
  });

  it('still refuses mixing a full Bot document with its version children', () => {
    expect(() =>
      buildDeployZip(
        [
          comp('Bot', 'Support_Agent', '<Bot/>'),
          comp('BotVersion', 'Support_Agent.v1', '<botVersions/>'),
        ],
        [],
        V,
        noMeta,
      ),
    ).toThrow(/pick one form/);
  });

  it('PIN: AiAuthoringBundle stays read-only — an Agent Script deploy would lie', () => {
    expect(() =>
      buildDeployZip([comp('AiAuthoringBundle', 'X', 'agent script')], [], V, noMeta),
    ).toThrow(/not deployable through Contrail/);
  });

  it('warns honestly on the prompt-template identifier, both change kinds', () => {
    const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
    const storeNone = { readCurrentFile: () => null } as unknown as SnapshotStore;
    const added = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [
        comp(
          'GenAiPromptTemplate',
          'Fresh',
          '<GenAiPromptTemplate><activeVersionIdentifier>abc=_1</activeVersionIdentifier></GenAiPromptTemplate>',
        ),
      ],
      [],
    );
    expect(added.changes[0]!.warnings.join(' ')).toMatch(/org-generated/);

    const dbMod = { getArtifact: () => ({ filePath: 'x' }) } as unknown as ContrailDb;
    const storeOld = {
      readCurrentFile: () =>
        '<GenAiPromptTemplate><activeVersionIdentifier>REAL_TOKEN=_1</activeVersionIdentifier></GenAiPromptTemplate>',
    } as unknown as SnapshotStore;
    const altered = analyzeChanges(
      dbMod,
      storeOld,
      conn,
      [
        comp(
          'GenAiPromptTemplate',
          'Fresh',
          '<GenAiPromptTemplate><activeVersionIdentifier>FAKED_TOKEN=_2</activeVersionIdentifier></GenAiPromptTemplate>',
        ),
      ],
      [],
    );
    expect(altered.changes[0]!.warnings.join(' ')).toMatch(/ALTERED/);
    expect(altered.changes[0]!.warnings.join(' ')).toMatch(/WHOLE-DOCUMENT REPLACE/);

    const unchangedId = analyzeChanges(
      dbMod,
      storeOld,
      conn,
      [
        comp(
          'GenAiPromptTemplate',
          'Fresh',
          '<GenAiPromptTemplate><activeVersionIdentifier>REAL_TOKEN=_1</activeVersionIdentifier><x/></GenAiPromptTemplate>',
        ),
      ],
      [],
    );
    expect(unchangedId.changes[0]!.warnings.join(' ')).not.toMatch(/ALTERED/);
  });

  it('warns on the deactivate gate for topic modifies; Bot modify names version deletes', () => {
    const dbMod = { getArtifact: () => ({ filePath: 'x' }) } as unknown as ContrailDb;
    const storeOld = { readCurrentFile: () => '<old/>' } as unknown as SnapshotStore;
    const topic = analyzeChanges(
      dbMod,
      storeOld,
      conn,
      [comp('GenAiPlugin', 'Order_Topic', '<GenAiPlugin>new</GenAiPlugin>')],
      [],
    );
    expect(topic.changes[0]!.warnings.join(' ')).toMatch(/DEACTIVATED FIRST/);
    expect(topic.changes[0]!.warnings.join(' ')).toMatch(/WHOLE-DOCUMENT REPLACE/);

    const bot = analyzeChanges(
      dbMod,
      storeOld,
      conn,
      [comp('Bot', 'Support_Agent', '<Bot>new</Bot>')],
      [],
    );
    expect(bot.changes[0]!.warnings.join(' ')).toMatch(/VERSION DELETE/);
  });

  it('deployZipEntryPath matches the builder for Bot and its version children', async () => {
    const { deployZipEntryPath } = await import('../deploy/package.js');
    expect(deployZipEntryPath('Bot', 'Support_Agent')).toEqual({
      path: 'bots/Support_Agent.bot',
      child: false,
    });
    expect(deployZipEntryPath('BotVersion', 'Support_Agent.v1')).toEqual({
      path: 'bots/Support_Agent.bot',
      child: true,
      childTag: 'botVersions',
      childName: 'v1',
    });
  });

  it('indexes agent metadata: flat types, the Bot container, and bundles as ONE row', () => {
    const botXml =
      '<Bot><label>S</label><botVersions><fullName>v1</fullName>' +
      '<entryDialog>Welcome</entryDialog></botVersions>' +
      '<botVersions><fullName>v2</fullName></botVersions></Bot>';
    const files = new Map(
      Object.entries({
        'bots/Support_Agent.bot': strToU8(botXml),
        'genAiPlugins/Order_Topic.genAiPlugin': strToU8('<GenAiPlugin/>'),
        'genAiPromptTemplates/Case_Summary.genAiPromptTemplate': strToU8('<GenAiPromptTemplate/>'),
        'aiEvaluationDefinitions/Agent_Tests.aiEvaluationDefinition': strToU8(
          '<AiEvaluationDefinition/>',
        ),
        'genAiFunctions/Get_Status/Get_Status.genAiFunction': strToU8('<GenAiFunction/>'),
        'genAiFunctions/Get_Status/input/schema.json': strToU8('{"title":"inputs"}'),
        'genAiFunctions/Get_Status/output/schema.json': strToU8('{"title":"outputs"}'),
        'genAiPlannerBundles/Agent_v1/Agent_v1.genAiPlannerBundle': strToU8(
          '<GenAiPlannerBundle/>',
        ),
        'genAiPlannerBundles/Agent_v1/agentGraph/Agent_v1_graph.json': strToU8('{"nodes":[]}'),
        'genAiPlannerBundles/Agent_v1/localActions/Topic_1/Act_1/input/schema.json': strToU8('{}'),
        'aiAuthoringBundles/My_Agent/My_Agent.agent': strToU8('agent script text'),
        'aiAuthoringBundles/My_Agent/My_Agent.bundle-meta.xml': strToU8(
          '<AiAuthoringBundle><bundleType>AGENT</bundleType></AiAuthoringBundle>',
        ),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-09-10T00:00:00.000Z');
    const keys = new Set(artifacts.map((a) => `${a.type}:${a.apiName}`));

    expect(keys.has('Bot:Support_Agent')).toBe(true);
    expect(keys.has('BotVersion:Support_Agent.v1')).toBe(true);
    expect(keys.has('BotVersion:Support_Agent.v2')).toBe(true);
    expect(keys.has('GenAiPlugin:Order_Topic')).toBe(true);
    expect(keys.has('GenAiPromptTemplate:Case_Summary')).toBe(true);
    expect(keys.has('AiEvaluationDefinition:Agent_Tests')).toBe(true);
    // Bundles: exactly ONE row each, main file as filePath, every sibling in content.
    expect(keys.has('GenAiFunction:Get_Status')).toBe(true);
    expect(keys.has('GenAiPlannerBundle:Agent_v1')).toBe(true);
    expect(keys.has('AiAuthoringBundle:My_Agent')).toBe(true);
    expect(artifacts.filter((a) => a.type === 'GenAiFunction')).toHaveLength(1);

    const fn = artifacts.find((a) => a.apiName === 'Get_Status')!;
    expect(fn.filePath).toBe('genAiFunctions/Get_Status/Get_Status.genAiFunction');
    expect(fn.content).toContain('contrail:file genAiFunctions/Get_Status/input/schema.json');
    expect(fn.content).toContain('"title":"inputs"');
    expect(fn.content).toContain('"title":"outputs"');

    // The .bundle-meta.xml is bundle CONTENT — not swallowed by the meta skip.
    const authoring = artifacts.find((a) => a.apiName === 'My_Agent')!;
    expect(authoring.filePath).toBe('aiAuthoringBundles/My_Agent/My_Agent.agent');
    expect(authoring.content).toContain('<bundleType>AGENT</bundleType>');

    // BotVersion children carry their own fragment, pointing at the parent file.
    const v1 = artifacts.find((a) => a.apiName === 'Support_Agent.v1')!;
    expect(v1.content).toContain('<entryDialog>Welcome</entryDialog>');
    expect(v1.content).not.toContain('v2');
    expect(v1.filePath).toBe('bots/Support_Agent.bot');
  });

  it('two bundles with same-named inner files never collide', () => {
    const files = new Map(
      Object.entries({
        'genAiFunctions/Fn_A/Fn_A.genAiFunction': strToU8('<GenAiFunction>a</GenAiFunction>'),
        'genAiFunctions/Fn_A/input/schema.json': strToU8('{"a":1}'),
        'genAiFunctions/Fn_B/Fn_B.genAiFunction': strToU8('<GenAiFunction>b</GenAiFunction>'),
        'genAiFunctions/Fn_B/input/schema.json': strToU8('{"b":2}'),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-09-10T00:00:00.000Z');
    const a = artifacts.find((x) => x.apiName === 'Fn_A')!;
    const b = artifacts.find((x) => x.apiName === 'Fn_B')!;
    expect(artifacts).toHaveLength(2);
    expect(a.content).toContain('"a":1');
    expect(a.content).not.toContain('"b":2');
    expect(b.content).toContain('"b":2');
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe('S30 Stage 2: bundle envelope deploys', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;

  function envelope(files: Record<string, string>): string {
    return JSON.stringify({ contrail_bundle: 1, files });
  }

  const FN_ENVELOPE = envelope({
    'Dog_Facts.genAiFunction-meta.xml': '<GenAiFunction><masterLabel>Dog Facts</masterLabel></GenAiFunction>',
    'input/schema.json': '{"properties":{}}',
    'output/schema.json': '{"properties":{"promptResponse":{"copilotAction:isUsedByPlanner":true}}}',
  });

  it('an envelope expands to N zip entries under the bundle dir with ONE member', () => {
    const built = buildDeployZip([comp('GenAiFunction', 'Dog_Facts', FN_ENVELOPE)], [], V, noMeta);
    expect(built.files).toContain('genAiFunctions/Dog_Facts/Dog_Facts.genAiFunction-meta.xml');
    expect(built.files).toContain('genAiFunctions/Dog_Facts/input/schema.json');
    expect(built.files).toContain('genAiFunctions/Dog_Facts/output/schema.json');
    expect(zipText(built.zip, 'genAiFunctions/Dog_Facts/input/schema.json')).toBe(
      '{"properties":{}}',
    );
    const members = built.packageXml.match(/<members>Dog_Facts<\/members>/g) ?? [];
    expect(members).toHaveLength(1);
    expect(built.packageXml).toContain('<name>GenAiFunction</name>');
    // The envelope itself never reaches the zip or the manifest.
    expect(built.packageXml).not.toContain('contrail_bundle');
    expect(built.files.some((f) => f.endsWith('.json') && f.includes('contrail'))).toBe(false);
  });

  it('GenAiPlannerBundle uses the bare main-file suffix', () => {
    const built = buildDeployZip(
      [
        comp(
          'GenAiPlannerBundle',
          'Agent_v1',
          envelope({
            'Agent_v1.genAiPlannerBundle': '<GenAiPlannerBundle/>',
            'agentGraph/Agent_v1_graph.json': '{}',
          }),
        ),
      ],
      [],
      V,
      noMeta,
    );
    expect(built.files).toContain('genAiPlannerBundles/Agent_v1/Agent_v1.genAiPlannerBundle');
    expect(built.files).toContain('genAiPlannerBundles/Agent_v1/agentGraph/Agent_v1_graph.json');
  });

  it('rejects every malformed envelope, each with the honest error', () => {
    const cases: Array<[string, string | RegExp]> = [
      ['not json at all', /bundle envelope/],
      [JSON.stringify({ files: {} }), /contrail_bundle: 1/],
      [envelope({}), /1–100/],
      [envelope({ '../evil': 'x', 'Dog_Facts.genAiFunction-meta.xml': 'y' }), /invalid envelope path/],
      [envelope({ 'a\\b': 'x', 'Dog_Facts.genAiFunction-meta.xml': 'y' }), /invalid envelope path/],
      [
        envelope({ 'a/b/c/d/e/f/g/h/i.json': 'x', 'Dog_Facts.genAiFunction-meta.xml': 'y' }),
        /invalid envelope path/,
      ],
      [envelope({ '.hidden': 'x', 'Dog_Facts.genAiFunction-meta.xml': 'y' }), /invalid envelope path/],
      [envelope({ 'input/schema.json': 'x' }), /missing its main file/],
      [
        JSON.stringify({
          contrail_bundle: 1,
          files: { 'Dog_Facts.genAiFunction-meta.xml': 42 },
        }),
        /string body/,
      ],
    ];
    for (const [content, err] of cases) {
      expect(
        () => buildDeployZip([comp('GenAiFunction', 'Dog_Facts', content)], [], V, noMeta),
        `must reject: ${content.slice(0, 60)}`,
      ).toThrow(err);
    }
  });

  it('a stray envelope aimed at a single-file type fails locally and honestly', () => {
    expect(() =>
      buildDeployZip([comp('GenAiPlugin', 'Topic', FN_ENVELOPE)], [], V, noMeta),
    ).toThrow(/single-file type/);
  });

  it('deployZipEntryPath returns the main path plus bundleDir for envelope types', async () => {
    const { deployZipEntryPath } = await import('../deploy/package.js');
    expect(deployZipEntryPath('GenAiFunction', 'Dog_Facts')).toEqual({
      path: 'genAiFunctions/Dog_Facts/Dog_Facts.genAiFunction-meta.xml',
      child: false,
      bundleDir: 'genAiFunctions/Dog_Facts/',
    });
    expect(deployZipEntryPath('GenAiPlannerBundle', 'Agent_v1')).toEqual({
      path: 'genAiPlannerBundles/Agent_v1/Agent_v1.genAiPlannerBundle',
      child: false,
      bundleDir: 'genAiPlannerBundles/Agent_v1/',
    });
  });

  it('classifies envelope changes file-by-file against the snapshot bundle', () => {
    const snapshot: Record<string, string> = {
      'genAiFunctions/Dog_Facts/Dog_Facts.genAiFunction-meta.xml':
        '<GenAiFunction><masterLabel>Dog Facts</masterLabel></GenAiFunction>',
      'genAiFunctions/Dog_Facts/input/schema.json': '{"properties":{}}',
      'genAiFunctions/Dog_Facts/output/schema.json': '{"old":true}',
    };
    const db = {
      getArtifact: () => ({ filePath: 'genAiFunctions/Dog_Facts/Dog_Facts.genAiFunction-meta.xml' }),
    } as unknown as ContrailDb;
    const store = {
      readCurrentFile: (_c: string, rel: string) => snapshot[rel] ?? null,
      listCurrentFiles: (_c: string, prefix: string) =>
        Object.keys(snapshot).filter((k) => k.startsWith(prefix)),
    } as unknown as SnapshotStore;

    // Sibling-only change (output schema differs) classifies as modify with
    // the per-file delta named — the altitude test.
    const { changes } = analyzeChanges(
      db,
      store,
      conn,
      [comp('GenAiFunction', 'Dog_Facts', FN_ENVELOPE)],
      [],
    );
    expect(changes[0]!.change).toBe('modify');
    expect(changes[0]!.warnings.join(' ')).toMatch(/BUNDLE REPLACE/);
    expect(changes[0]!.warnings.join(' ')).toMatch(/output\/schema\.json/);

    // An envelope matching the snapshot exactly is unchanged_content.
    const same = analyzeChanges(
      db,
      store,
      conn,
      [
        comp(
          'GenAiFunction',
          'Dog_Facts',
          envelope({
            'Dog_Facts.genAiFunction-meta.xml':
              '<GenAiFunction><masterLabel>Dog Facts</masterLabel></GenAiFunction>',
            'input/schema.json': '{"properties":{}}',
            'output/schema.json': '{"old":true}',
          }),
        ),
      ],
      [],
    );
    expect(same.changes[0]!.change).toBe('unchanged_content');
    expect(same.changes[0]!.warnings).toHaveLength(0);

    // No snapshot row → add.
    const dbNone = { getArtifact: () => null } as unknown as ContrailDb;
    const added = analyzeChanges(
      dbNone,
      store,
      conn,
      [comp('GenAiFunction', 'Dog_Facts', FN_ENVELOPE)],
      [],
    );
    expect(added.changes[0]!.change).toBe('add');
  });

  it('planner-bundle modifies carry the deactivate + published-snapshot warning', () => {
    const snapshot: Record<string, string> = {
      'genAiPlannerBundles/Agent_v1/Agent_v1.genAiPlannerBundle': '<GenAiPlannerBundle>old</GenAiPlannerBundle>',
    };
    const db = {
      getArtifact: () => ({ filePath: 'genAiPlannerBundles/Agent_v1/Agent_v1.genAiPlannerBundle' }),
    } as unknown as ContrailDb;
    const store = {
      readCurrentFile: (_c: string, rel: string) => snapshot[rel] ?? null,
      listCurrentFiles: (_c: string, prefix: string) =>
        Object.keys(snapshot).filter((k) => k.startsWith(prefix)),
    } as unknown as SnapshotStore;
    const { changes } = analyzeChanges(
      db,
      store,
      conn,
      [
        comp(
          'GenAiPlannerBundle',
          'Agent_v1',
          envelope({ 'Agent_v1.genAiPlannerBundle': '<GenAiPlannerBundle>new</GenAiPlannerBundle>' }),
        ),
      ],
      [],
    );
    expect(changes[0]!.warnings.join(' ')).toMatch(/DEACTIVATED FIRST/);
    expect(changes[0]!.warnings.join(' ')).toMatch(/PUBLISHED\s+SNAPSHOTS/);
  });

  it('Bot components get the agentAccesses coverage arm; grants must be enabled', () => {
    const bot = comp('Bot', 'Support_Agent', '<Bot/>');
    const uncovered = analyzePermissionCoverage([bot]);
    expect(uncovered.uncovered).toEqual([
      { type: 'Bot', api_name: 'Support_Agent', permission: 'agent access (agentAccesses)' },
    ]);

    const granted = comp(
      'PermissionSet',
      'Agent_Access',
      '<PermissionSet><agentAccesses><agentName>Support_Agent</agentName><enabled>true</enabled></agentAccesses></PermissionSet>',
    );
    expect(analyzePermissionCoverage([bot, granted]).uncovered).toHaveLength(0);

    const mentionedOff = comp(
      'PermissionSet',
      'Agent_Access',
      '<PermissionSet><agentAccesses><agentName>Support_Agent</agentName><enabled>false</enabled></agentAccesses></PermissionSet>',
    );
    expect(analyzePermissionCoverage([bot, mentionedOff]).uncovered).toHaveLength(1);
  });
});
