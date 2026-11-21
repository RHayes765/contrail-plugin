import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync } from 'fflate';
import {
  analyzeChanges,
  analyzePermissionCoverage,
  buildDeployZip,
  changeDependentWarnings,
  deployZipEntryPath,
  isRegisteredType,
  isValidComponentName,
  parseEnvelopeFor,
  readOldContent,
  retrieveMemberFor,
  type ProposedComponent,
} from '../deploy/package.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  childBlockNames,
  extractChildBlocks,
  findChildBlock,
  indexSnapshotFiles,
} from '../snapshot/indexer.js';
import {
  withoutXmlBlocks,
  xmlBlocks,
  xmlBlockText,
  xmlTagTexts,
  xmlTagValue,
} from '../salesforce/xml.js';
import { ContrailDb } from '../core/db.js';
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
      {
        type: 'ApexPage',
        api_name: 'Invoice_Portal',
        permission: 'Visualforce page access',
        presence: 'unknown',
      },
      {
        type: 'CustomApplication',
        api_name: 'Invoicing',
        permission: 'app visibility',
        presence: 'unknown',
      },
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

  it('PIN FLIP (S30→S34): AiAuthoringBundle deploys — as a DRAFT-stage envelope', () => {
    // S30 pinned this type read-only because pretending a deploy compiles
    // Agent Script would lie. S34 reversed it DELIBERATELY: a no-target
    // deploy is the documented draft-staging step, and the D1 warning now
    // carries the honesty instead (see the S34 describe below). Raw
    // non-envelope content still fails — as an envelope error, not a
    // not-deployable one.
    expect(() =>
      buildDeployZip([comp('AiAuthoringBundle', 'X', 'agent script')], [], V, noMeta),
    ).toThrow(/bundle envelope/);
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
        // S44: the Studio suite and custom-scorer types index as flat rows too.
        'aiTestingDefinitions/Order_Tests.aiTestingDefinition': strToU8('<AiTestingDefinition/>'),
        'aiAgentScorerDefinitions/Tone_Check.aiAgentScorerDefinition': strToU8(
          '<AiAgentScorerDefinition/>',
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
    expect(keys.has('AiTestingDefinition:Order_Tests')).toBe(true);
    expect(keys.has('AiAgentScorerDefinition:Tone_Check')).toBe(true);
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
      {
        type: 'Bot',
        api_name: 'Support_Agent',
        permission: 'agent access (agentAccesses)',
        presence: 'unknown',
      },
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

describe('S31: LeadConvertSettings (the lead-conversion singleton)', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;

  it('places the singleton with the platform-quirk naming and a literal member', () => {
    const built = buildDeployZip(
      [comp('LeadConvertSettings', 'LeadConvertSettings', '<LeadConvertSettings/>')],
      [],
      V,
      noMeta,
    );
    // Live-confirmed quirk: CAPITALIZED dir, singular '.LeadConvertSetting'.
    expect(built.files).toContain('LeadConvertSettings/LeadConvertSettings.LeadConvertSetting');
    expect(built.packageXml).toContain('<name>LeadConvertSettings</name>');
    expect(built.packageXml).toContain('<members>LeadConvertSettings</members>');
  });

  it('indexes the retrieved singleton file', () => {
    const files = new Map(
      Object.entries({
        'LeadConvertSettings/LeadConvertSettings.LeadConvertSetting': strToU8(
          '<LeadConvertSettings><objectMapping><inputObject>Lead</inputObject></objectMapping></LeadConvertSettings>',
        ),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-09-11T00:00:00.000Z');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      type: 'LeadConvertSettings',
      apiName: 'LeadConvertSettings',
      filePath: 'LeadConvertSettings/LeadConvertSettings.LeadConvertSetting',
    });
  });

  it('a modify warns that omitted mappings are DELETED org-wide', () => {
    const db = {
      getArtifact: () => ({
        filePath: 'LeadConvertSettings/LeadConvertSettings.LeadConvertSetting',
      }),
    } as unknown as ContrailDb;
    const store = {
      readCurrentFile: () => '<LeadConvertSettings>old</LeadConvertSettings>',
    } as unknown as SnapshotStore;
    const { changes } = analyzeChanges(
      db,
      store,
      conn,
      [comp('LeadConvertSettings', 'LeadConvertSettings', '<LeadConvertSettings>new</LeadConvertSettings>')],
      [],
    );
    expect(changes[0]!.change).toBe('modify');
    expect(changes[0]!.warnings.join(' ')).toMatch(/WHOLE-DOCUMENT REPLACE/);
    expect(changes[0]!.warnings.join(' ')).toMatch(/mapping DELETED org-wide/);
  });
});

describe('S33: the credential family (NamedCredential / ExternalCredential / AuthProvider)', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;

  it('places AuthProvider in its all-lowercase folder (live-confirmed) and manifests it', () => {
    const built = buildDeployZip([comp('AuthProvider', 'Acme_SSO', '<AuthProvider/>')], [], V, noMeta);
    expect(built.files).toContain('authproviders/Acme_SSO.authprovider');
    expect(built.packageXml).toContain('<name>AuthProvider</name>');
    expect(built.packageXml).toContain('<members>Acme_SSO</members>');
  });

  it('indexes a retrieved authproviders tree', () => {
    const files = new Map(
      Object.entries({
        'authproviders/Acme_SSO.authprovider': strToU8('<AuthProvider><providerType>OpenIdConnect</providerType></AuthProvider>'),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-09-24T00:00:00.000Z');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ type: 'AuthProvider', apiName: 'Acme_SSO' });
  });

  it('modifying any credential-family document warns WHOLE-DOCUMENT REPLACE (principals called out)', () => {
    const db = {
      getArtifact: (_c: string, type: string, name: string) => ({
        filePath: `x/${type}/${name}`,
      }),
    } as unknown as ContrailDb;
    const store = { readCurrentFile: () => '<old/>' } as unknown as SnapshotStore;
    for (const [type, tail] of [
      ['NamedCredential', null],
      ['ExternalCredential', /principal parameter omitted here is DELETED/],
      ['AuthProvider', null],
    ] as Array<[string, RegExp | null]>) {
      const { changes } = analyzeChanges(db, store, conn, [comp(type, 'Thing', '<new/>')], []);
      const text = changes[0]!.warnings.join(' ');
      expect(text, type).toMatch(/WHOLE-DOCUMENT REPLACE/);
      if (tail) expect(text, type).toMatch(tail);
    }
  });

  it('a NEW external credential warns: no secrets deployed, nobody granted', () => {
    const db = { getArtifact: () => null } as unknown as ContrailDb;
    const store = { readCurrentFile: () => null } as unknown as SnapshotStore;
    const { changes } = analyzeChanges(
      db,
      store,
      conn,
      [comp('ExternalCredential', 'Billing_Auth', '<ExternalCredential/>')],
      [],
    );
    const text = changes[0]!.warnings.join(' ');
    expect(text).toMatch(/carries no secrets and grants nobody access/);
    expect(text).toMatch(/externalCredentialPrincipalAccesses/);
  });

  it('a literal secret in legacy NamedCredential or AuthProvider content is flagged', () => {
    const db = { getArtifact: () => null } as unknown as ContrailDb;
    const store = { readCurrentFile: () => null } as unknown as SnapshotStore;
    const nc = analyzeChanges(db, store, conn, [
      comp('NamedCredential', 'Legacy_API', '<NamedCredential><password>hunter2</password></NamedCredential>'),
    ], []);
    expect(nc.changes[0]!.warnings.join(' ')).toMatch(/LITERAL SECRET IN DEPLOY CONTENT \(<password>\)/);
    const ap = analyzeChanges(db, store, conn, [
      comp('AuthProvider', 'Acme_SSO', '<AuthProvider><consumerSecret>shh</consumerSecret></AuthProvider>'),
    ], []);
    expect(ap.changes[0]!.warnings.join(' ')).toMatch(/LITERAL SECRET IN DEPLOY CONTENT \(<consumerSecret>\)/);
    // An EMPTY tag is not a literal secret, and modern external credentials
    // never trip the arm at all.
    const clean = analyzeChanges(db, store, conn, [
      comp('NamedCredential', 'Modern_API', '<NamedCredential><password></password></NamedCredential>'),
      comp('ExternalCredential', 'Auth', '<ExternalCredential><externalCredentialParameters><parameterValue>notasecret</parameterValue></externalCredentialParameters></ExternalCredential>'),
    ], []);
    for (const c of clean.changes) {
      expect(c.warnings.join(' ')).not.toMatch(/LITERAL SECRET/);
    }
  });

  it('every principal an ExternalCredential defines needs a dash-named principal-access grant', () => {
    const cred = comp(
      'ExternalCredential',
      'Mulesoft',
      '<ExternalCredential><authenticationProtocol>Basic</authenticationProtocol>' +
        '<externalCredentialParameters><parameterName>Custom</parameterName>' +
        '<parameterType>AuthProtocolVariant</parameterType></externalCredentialParameters>' +
        '<externalCredentialParameters><parameterName>Basic</parameterName>' +
        '<parameterType>NamedPrincipal</parameterType><sequenceNumber>1</sequenceNumber></externalCredentialParameters>' +
        '<externalCredentialParameters><parameterName>Per_User</parameterName>' +
        '<parameterType>PerUserPrincipal</parameterType><sequenceNumber>2</sequenceNumber></externalCredentialParameters>' +
        '</ExternalCredential>',
    );
    // No permission container: both principals uncovered, non-principal params silent.
    const bare = analyzePermissionCoverage([cred]);
    expect(bare.uncovered.map((u) => u.api_name).sort()).toEqual(['Mulesoft-Basic', 'Mulesoft-Per_User']);
    // The live-confirmed dash-named grant covers exactly its principal.
    const ps = comp(
      'PermissionSet',
      'Integration_User',
      '<PermissionSet><externalCredentialPrincipalAccesses><enabled>true</enabled>' +
        '<externalCredentialPrincipal>Mulesoft-Basic</externalCredentialPrincipal>' +
        '</externalCredentialPrincipalAccesses></PermissionSet>',
    );
    const covered = analyzePermissionCoverage([cred, ps]);
    expect(covered.uncovered.map((u) => u.api_name)).toEqual(['Mulesoft-Per_User']);
    // enabled=false is a mention, not coverage.
    const disabled = comp(
      'PermissionSet',
      'Integration_User',
      '<PermissionSet><externalCredentialPrincipalAccesses><enabled>false</enabled>' +
        '<externalCredentialPrincipal>Mulesoft-Basic</externalCredentialPrincipal>' +
        '</externalCredentialPrincipalAccesses></PermissionSet>',
    );
    expect(analyzePermissionCoverage([cred, disabled]).uncovered).toHaveLength(2);
  });

  it('NamedCredential and AuthProvider deliberately produce NO permission needs', () => {
    const res = analyzePermissionCoverage([
      comp('NamedCredential', 'Billing_API', '<NamedCredential/>'),
      comp('AuthProvider', 'Acme_SSO', '<AuthProvider/>'),
    ]);
    expect(res.uncovered).toHaveLength(0);
  });
});

describe('S34: AiAuthoringBundle draft-stage deploys', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
  const env = (name: string, files: Record<string, string>) =>
    comp('AiAuthoringBundle', name, JSON.stringify({ contrail_bundle: 1, files }));
  const okFiles = (name: string) => ({
    [`${name}.agent`]: 'system:\n  instructions: |\n    Probe.\n',
    [`${name}.bundle-meta.xml`]:
      '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <bundleType>AGENT</bundleType>\n</AiAuthoringBundle>\n',
  });

  it('places the two-file envelope under aiAuthoringBundles/ with ONE member', () => {
    const built = buildDeployZip([env('My_Agent', okFiles('My_Agent'))], [], V, noMeta);
    expect(built.files).toContain('aiAuthoringBundles/My_Agent/My_Agent.agent');
    expect(built.files).toContain('aiAuthoringBundles/My_Agent/My_Agent.bundle-meta.xml');
    expect(built.packageXml).toContain('<name>AiAuthoringBundle</name>');
    expect(built.packageXml.match(/<members>My_Agent<\/members>/g)).toHaveLength(1);
  });

  it('refuses an envelope missing the required .bundle-meta.xml, naming the 2-file shape', () => {
    const files = okFiles('My_Agent');
    delete files['My_Agent.bundle-meta.xml'];
    expect(() => buildDeployZip([env('My_Agent', files)], [], V, noMeta)).toThrow(
      /missing required file "My_Agent\.bundle-meta\.xml".*My_Agent\.agent \+ My_Agent\.bundle-meta\.xml/,
    );
    // The main-file check stays its own distinct error.
    const noMain = okFiles('My_Agent');
    delete noMain['My_Agent.agent'];
    expect(() => buildDeployZip([env('My_Agent', noMain)], [], V, noMeta)).toThrow(
      /missing its main file "My_Agent\.agent"/,
    );
  });

  it('D1: EVERY draft deploy warns that nothing compiles — add and modify alike', () => {
    const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
    const storeNone = { readCurrentFile: () => null, listCurrentFiles: () => [] } as unknown as SnapshotStore;
    const add = analyzeChanges(dbAdd, storeNone, conn, [env('My_Agent', okFiles('My_Agent'))], []);
    expect(add.changes[0]!.change).toBe('add');
    expect(add.changes[0]!.warnings.join(' ')).toMatch(/DRAFT STAGE ONLY/);
    expect(add.changes[0]!.warnings.join(' ')).toMatch(/RUNNING AGENT IS UNCHANGED/);

    const dbMod = {
      getArtifact: () => ({ filePath: 'aiAuthoringBundles/My_Agent/My_Agent.agent' }),
    } as unknown as ContrailDb;
    const storeMod = {
      readCurrentFile: (_c: unknown, rel: string) =>
        rel.endsWith('.agent') ? 'old script' : '<AiAuthoringBundle/>',
      listCurrentFiles: () => [
        'aiAuthoringBundles/My_Agent/My_Agent.agent',
        'aiAuthoringBundles/My_Agent/My_Agent.bundle-meta.xml',
      ],
    } as unknown as SnapshotStore;
    const mod = analyzeChanges(dbMod, storeMod, conn, [env('My_Agent', okFiles('My_Agent'))], []);
    expect(mod.changes[0]!.change).toBe('modify');
    const text = mod.changes[0]!.warnings.join(' ');
    expect(text).toMatch(/DRAFT STAGE ONLY/);
    expect(text).toMatch(/BUNDLE REPLACE/);
  });

  it('D2: a <target> in the bundle meta warns LINK-not-compile; absent stays silent', () => {
    const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
    const storeNone = { readCurrentFile: () => null, listCurrentFiles: () => [] } as unknown as SnapshotStore;
    const files = okFiles('My_Agent');
    files['My_Agent.bundle-meta.xml'] = files['My_Agent.bundle-meta.xml']!.replace(
      '</AiAuthoringBundle>',
      '    <target>My_Agent.v2</target>\n</AiAuthoringBundle>',
    );
    const withTarget = analyzeChanges(dbAdd, storeNone, conn, [env('My_Agent', files)], []);
    expect(withTarget.changes[0]!.warnings.join(' ')).toMatch(/TARGET LINK, NOT A COMPILE/);
    expect(withTarget.changes[0]!.warnings.join(' ')).toContain('My_Agent.v2');

    const noTarget = analyzeChanges(dbAdd, storeNone, conn, [env('My_Agent', okFiles('My_Agent'))], []);
    expect(noTarget.changes[0]!.warnings.join(' ')).not.toMatch(/TARGET LINK/);
  });

  it('D3: a version-suffixed name warns PUBLISHED-SNAPSHOT; naked names stay silent', () => {
    const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
    const storeNone = { readCurrentFile: () => null, listCurrentFiles: () => [] } as unknown as SnapshotStore;
    const suffixed = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [env('My_Agent_2', okFiles('My_Agent_2'))],
      [],
    );
    expect(suffixed.changes[0]!.warnings.join(' ')).toMatch(/PUBLISHED-SNAPSHOT NAME/);
    const naked = analyzeChanges(dbAdd, storeNone, conn, [env('My_Agent', okFiles('My_Agent'))], []);
    expect(naked.changes[0]!.warnings.join(' ')).not.toMatch(/PUBLISHED-SNAPSHOT/);
  });
});

describe('S36: permissions & UI-action types', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
  const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
  const storeNone = {
    readCurrentFile: () => null,
    listCurrentFiles: () => [],
  } as unknown as SnapshotStore;
  const lwcEnv = (name: string, files: Record<string, string>) =>
    comp('LightningComponentBundle', name, JSON.stringify({ contrail_bundle: 1, files }));
  const lwcFiles = (name: string): Record<string, string> => ({
    [`${name}.js`]:
      "import { LightningElement } from 'lwc';\nexport default class X extends LightningElement {}\n",
    [`${name}.html`]: '<template>hi</template>\n',
    [`${name}.js-meta.xml`]:
      '<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>61.0</apiVersion>\n    <isExposed>false</isExposed>\n</LightningComponentBundle>\n',
  });

  it('places the single-file types — dotted QuickActions literal, dot intact', () => {
    const cases: Array<[string, string, string]> = [
      [
        'CustomPermission',
        'Can_Approve_Refunds',
        'customPermissions/Can_Approve_Refunds.customPermission',
      ],
      [
        'PermissionSetGroup',
        'Support_Agents',
        'permissionsetgroups/Support_Agents.permissionsetgroup',
      ],
      [
        'MutingPermissionSet',
        'Support_Mutes',
        'mutingpermissionsets/Support_Mutes.mutingpermissionset',
      ],
      ['QuickAction', 'New_Global_Note', 'quickActions/New_Global_Note.quickAction'],
      // The first standalone dotted fullName that is NOT a child type
      // (CustomMetadata precedent) — live-confirmed file shape.
      ['QuickAction', 'Account.New_Case', 'quickActions/Account.New_Case.quickAction'],
    ];
    for (const [type, name, path] of cases) {
      const built = buildDeployZip([comp(type, name, `<${type}/>`)], [], V, noMeta);
      expect(built.files, `${type} file placement`).toContain(path);
      expect(built.packageXml).toContain(`<name>${type}</name>`);
      expect(built.packageXml).toContain(`<members>${name}</members>`);
    }
  });

  it('expands an LWC envelope under lwc/<name>/ with ONE member; JS-only and subdirs allowed', () => {
    const built = buildDeployZip([lwcEnv('navCard', lwcFiles('navCard'))], [], V, noMeta);
    expect(built.files).toContain('lwc/navCard/navCard.js');
    expect(built.files).toContain('lwc/navCard/navCard.html');
    expect(built.files).toContain('lwc/navCard/navCard.js-meta.xml');
    expect(built.packageXml).toContain('<name>LightningComponentBundle</name>');
    expect(built.packageXml.match(/<members>navCard<\/members>/g)).toHaveLength(1);

    // A service component is just <n>.js + <n>.js-meta.xml (live-confirmed
    // shape: ldsUtils) — nothing requires .html.
    const files = lwcFiles('ldsUtils');
    delete files['ldsUtils.html'];
    const svc = buildDeployZip([lwcEnv('ldsUtils', files)], [], V, noMeta);
    expect(svc.files).toContain('lwc/ldsUtils/ldsUtils.js');

    // Subdirectories are real bundle content (secondary templates,
    // live-confirmed) — the envelope carries them.
    const withTpl = lwcFiles('codeBlock');
    withTpl['templates/inlineMessage.html'] = '<template>alt</template>\n';
    const tpl = buildDeployZip([lwcEnv('codeBlock', withTpl)], [], V, noMeta);
    expect(tpl.files).toContain('lwc/codeBlock/templates/inlineMessage.html');
  });

  it('refuses an envelope missing .js-meta.xml, and __tests__ trees everywhere', () => {
    const files = lwcFiles('navCard');
    delete files['navCard.js-meta.xml'];
    expect(() => buildDeployZip([lwcEnv('navCard', files)], [], V, noMeta)).toThrow(
      /missing required file "navCard\.js-meta\.xml".*navCard\.js \+ navCard\.js-meta\.xml/,
    );
    const withTests = lwcFiles('navCard');
    withTests['__tests__/navCard.test.js'] = 'jest\n';
    expect(() => buildDeployZip([lwcEnv('navCard', withTests)], [], V, noMeta)).toThrow(
      /local test files never deploy/,
    );
  });

  it('PSG: recalc note on add AND modify; whole-doc replace carries the member-detach suffix', () => {
    const psg =
      '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSetGroup>\n' +
      '    <label>Support</label>\n    <permissionSets>Support_Base</permissionSets>\n' +
      '</PermissionSetGroup>\n';
    const add = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('PermissionSetGroup', 'Support_Agents', psg)],
      [],
    );
    expect(add.changes[0]!.change).toBe('add');
    const addText = add.changes[0]!.warnings.join(' ');
    expect(addText).toMatch(/RECALCULATES ASYNCHRONOUSLY/);
    expect(addText).toContain("DeveloperName = 'Support_Agents'");
    expect(addText).not.toMatch(/WHOLE-DOCUMENT REPLACE/);

    const dbMod = {
      getArtifact: () => ({ filePath: 'permissionsetgroups/Support_Agents.permissionsetgroup' }),
    } as unknown as ContrailDb;
    const storeMod = {
      readCurrentFile: () => '<PermissionSetGroup>old</PermissionSetGroup>',
    } as unknown as SnapshotStore;
    const mod = analyzeChanges(
      dbMod,
      storeMod,
      conn,
      [comp('PermissionSetGroup', 'Support_Agents', psg)],
      [],
    );
    expect(mod.changes[0]!.change).toBe('modify');
    const modText = mod.changes[0]!.warnings.join(' ');
    expect(modText).toMatch(/RECALCULATES ASYNCHRONOUSLY/);
    expect(modText).toMatch(/WHOLE-DOCUMENT REPLACE/);
    expect(modText).toMatch(/DETACHED from the group/);
  });

  it('MutingPermissionSet modify warns that an omitted mute RESTORES the permission', () => {
    const dbMod = {
      getArtifact: () => ({ filePath: 'mutingpermissionsets/Support_Mutes.mutingpermissionset' }),
    } as unknown as ContrailDb;
    const storeMod = {
      readCurrentFile: () => '<MutingPermissionSet>old</MutingPermissionSet>',
    } as unknown as SnapshotStore;
    const mod = analyzeChanges(
      dbMod,
      storeMod,
      conn,
      [comp('MutingPermissionSet', 'Support_Mutes', '<MutingPermissionSet>new</MutingPermissionSet>')],
      [],
    );
    const text = mod.changes[0]!.warnings.join(' ');
    expect(text).toMatch(/WHOLE-DOCUMENT REPLACE/);
    expect(text).toMatch(/UN-MUTED org-side, silently RESTORING/);
  });

  it('a NEW QuickAction warns it is surfaced nowhere; a modify does not', () => {
    const add = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('QuickAction', 'Account.New_Case', '<QuickAction/>')],
      [],
    );
    expect(add.changes[0]!.warnings.join(' ')).toMatch(/surfaced NOWHERE/);

    const dbMod = {
      getArtifact: () => ({ filePath: 'quickActions/Account.New_Case.quickAction' }),
    } as unknown as ContrailDb;
    const storeMod = {
      readCurrentFile: () => '<QuickAction>old</QuickAction>',
    } as unknown as SnapshotStore;
    const mod = analyzeChanges(
      dbMod,
      storeMod,
      conn,
      [comp('QuickAction', 'Account.New_Case', '<QuickAction/>')],
      [],
    );
    expect(mod.changes[0]!.warnings.join(' ')).not.toMatch(/surfaced NOWHERE/);
  });

  it('CustomPermission coverage: uncovered without a grant, covered only when enabled', () => {
    const perm = comp('CustomPermission', 'Can_Approve_Refunds', '<CustomPermission/>');
    const bare = analyzePermissionCoverage([perm]);
    expect(bare.uncovered).toEqual([
      {
        type: 'CustomPermission',
        api_name: 'Can_Approve_Refunds',
        permission: 'custom permission access (customPermissions)',
        presence: 'unknown',
      },
    ]);

    // Live-confirmed block shape (enabled-first ordering as real orgs emit it).
    const granted = comp(
      'PermissionSet',
      'Refund_Access',
      '<PermissionSet><customPermissions><enabled>true</enabled>' +
        '<name>Can_Approve_Refunds</name></customPermissions></PermissionSet>',
    );
    expect(analyzePermissionCoverage([perm, granted]).uncovered).toHaveLength(0);

    const mentionedOff = comp(
      'PermissionSet',
      'Refund_Access',
      '<PermissionSet><customPermissions><enabled>false</enabled>' +
        '<name>Can_Approve_Refunds</name></customPermissions></PermissionSet>',
    );
    expect(analyzePermissionCoverage([perm, mentionedOff]).uncovered).toHaveLength(1);

    // Profiles use the identical block shape.
    const profile = comp(
      'Profile',
      'Support',
      '<Profile><customPermissions><enabled>true</enabled>' +
        '<name>Can_Approve_Refunds</name></customPermissions></Profile>',
    );
    expect(analyzePermissionCoverage([perm, profile]).uncovered).toHaveLength(0);
  });

  it('QuickAction, PSG, MutingPermissionSet, and LWC deliberately produce NO permission needs', () => {
    const cov = analyzePermissionCoverage([
      comp('QuickAction', 'Account.New_Case', '<QuickAction/>'),
      comp('PermissionSetGroup', 'Support_Agents', '<PermissionSetGroup/>'),
      comp('MutingPermissionSet', 'Support_Mutes', '<MutingPermissionSet/>'),
      lwcEnv('navCard', lwcFiles('navCard')),
    ]);
    expect(cov.uncovered).toHaveLength(0);
  });

  it('a PSG is NOT a grant container — coverage still warns beside one', () => {
    const perm = comp('CustomPermission', 'Can_Approve_Refunds', '<CustomPermission/>');
    const psg = comp(
      'PermissionSetGroup',
      'Support_Agents',
      '<PermissionSetGroup><permissionSets>Refund_Access</permissionSets></PermissionSetGroup>',
    );
    const cov = analyzePermissionCoverage([perm, psg]);
    expect(cov.has_permission_container).toBe(false);
    expect(cov.uncovered).toHaveLength(1);
  });

  it('deployZipEntryPath matches the builder for dotted QuickActions and LWC bundles', async () => {
    const { deployZipEntryPath } = await import('../deploy/package.js');
    expect(deployZipEntryPath('QuickAction', 'Account.New_Case')).toEqual({
      path: 'quickActions/Account.New_Case.quickAction',
      child: false,
    });
    expect(deployZipEntryPath('LightningComponentBundle', 'navCard')).toEqual({
      path: 'lwc/navCard/navCard.js',
      child: false,
      bundleDir: 'lwc/navCard/',
    });
  });

  it('indexes the new dirs: dotted names survive, LWC bundles are ONE row keeping js-meta.xml', () => {
    const files = new Map(
      Object.entries({
        'customPermissions/Can_Approve_Refunds.customPermission': strToU8('<CustomPermission/>'),
        'permissionsetgroups/Support_Agents.permissionsetgroup': strToU8('<PermissionSetGroup/>'),
        'mutingpermissionsets/Support_Mutes.mutingpermissionset': strToU8('<MutingPermissionSet/>'),
        'quickActions/Account.New_Case.quickAction': strToU8('<QuickAction/>'),
        'quickActions/New_Global_Note.quickAction': strToU8('<QuickAction/>'),
        'lwc/navCard/navCard.js': strToU8('export default class NavCard {}'),
        'lwc/navCard/navCard.html': strToU8('<template>hi</template>'),
        'lwc/navCard/navCard.js-meta.xml': strToU8(
          '<LightningComponentBundle><isExposed>true</isExposed></LightningComponentBundle>',
        ),
        'lwc/navCard/templates/alt.html': strToU8('<template>alt</template>'),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-10-02T00:00:00.000Z');
    const keys = new Set(artifacts.map((a) => `${a.type}:${a.apiName}`));
    expect(keys.has('CustomPermission:Can_Approve_Refunds')).toBe(true);
    expect(keys.has('PermissionSetGroup:Support_Agents')).toBe(true);
    expect(keys.has('MutingPermissionSet:Support_Mutes')).toBe(true);
    // The dot is part of the name — only the FINAL extension strips.
    expect(keys.has('QuickAction:Account.New_Case')).toBe(true);
    expect(keys.has('QuickAction:New_Global_Note')).toBe(true);

    const lwc = artifacts.filter((a) => a.type === 'LightningComponentBundle');
    expect(lwc).toHaveLength(1);
    expect(lwc[0]!.apiName).toBe('navCard');
    expect(lwc[0]!.filePath).toBe('lwc/navCard/navCard.js');
    // The js-meta.xml is bundle CONTENT (isExposed/targets live there), not
    // a skippable sidecar — and subdir templates ride along.
    expect(lwc[0]!.content).toContain('contrail:file lwc/navCard/navCard.js-meta.xml');
    expect(lwc[0]!.content).toContain('<isExposed>true</isExposed>');
    expect(lwc[0]!.content).toContain('contrail:file lwc/navCard/templates/alt.html');
  });
});

describe('S41: AuraDefinitionBundle', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
  const V41 = '66.0';

  function envelope(files: Record<string, string>): string {
    return JSON.stringify({ contrail_bundle: 1, files });
  }
  const META =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<AuraDefinitionBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
    '    <apiVersion>66.0</apiVersion>\n</AuraDefinitionBundle>\n';
  const metaAt = (ver: string) => META.replace('66.0', ver);
  const CMP =
    '<aura:component implements="lightning:backgroundUtilityItem" access="global">' +
    '<c:childCmp/></aura:component>';

  function popEnvelope(extra: Record<string, string> = {}, omit: string[] = []): string {
    const files: Record<string, string> = {
      'voiceCallPop.cmp': CMP,
      'voiceCallPop.cmp-meta.xml': META,
      'voiceCallPopController.js': '({ onCall: function (cmp) {} })',
      'voiceCallPop.design': '<design:component label="Voice Call Pop"/>',
      ...extra,
    };
    for (const k of omit) delete files[k];
    return envelope(files);
  }

  const dbNone = {
    getArtifact: () => null,
    edgesTo: () => [],
  } as unknown as ContrailDb;
  const storeNone = {
    readCurrentFile: () => null,
    listCurrentFiles: () => [],
  } as unknown as SnapshotStore;

  it('places a .cmp bundle flat under aura/<n>/ with ONE package.xml member', () => {
    const built = buildDeployZip(
      [comp('AuraDefinitionBundle', 'voiceCallPop', popEnvelope())],
      [],
      V41,
      noMeta,
    );
    expect(built.files).toContain('aura/voiceCallPop/voiceCallPop.cmp');
    expect(built.files).toContain('aura/voiceCallPop/voiceCallPop.cmp-meta.xml');
    expect(built.files).toContain('aura/voiceCallPop/voiceCallPopController.js');
    expect(built.packageXml).toContain('<members>voiceCallPop</members>');
    expect(built.packageXml).toContain('<name>AuraDefinitionBundle</name>');
    // ONE member per bundle — never one per file.
    expect(built.packageXml.match(/<members>/g)).toHaveLength(1);
    expect(zipText(built.zip, 'aura/voiceCallPop/voiceCallPop.cmp')).toContain('aura:component');
  });

  it('an .app bundle resolves its own primary (multi-candidate main)', () => {
    const built = buildDeployZip(
      [
        comp(
          'AuraDefinitionBundle',
          'consoleApp',
          envelope({
            'consoleApp.app': '<aura:application/>',
            'consoleApp.app-meta.xml': META,
          }),
        ),
      ],
      [],
      V41,
      noMeta,
    );
    expect(built.files).toContain('aura/consoleApp/consoleApp.app');
  });

  it('each grammar mistake is refused with ITS OWN message', () => {
    const cases: Array<{ env: string; name?: string; re: RegExp }> = [
      // Zero primaries.
      {
        env: envelope({ 'voiceCallPopController.js': '({})', 'voiceCallPop.cmp-meta.xml': META }),
        re: /NO primary file — exactly one of/,
      },
      // Two primaries.
      {
        env: envelope({
          'voiceCallPop.cmp': CMP,
          'voiceCallPop.app': '<aura:application/>',
          'voiceCallPop.cmp-meta.xml': META,
        }),
        re: /MORE THAN ONE primary/,
      },
      // A subfolder in a FLAT bundle.
      {
        env: popEnvelope({ 'helpers/extra.js': '({})' }),
        re: /FLAT: no subfolders/,
      },
      // Provider.js is not part of the bundle format.
      {
        env: popEnvelope({ 'voiceCallPopProvider.js': '({})' }),
        re: /Provider\/Model\/Test files are not/,
      },
      // .design belongs to component bundles only.
      {
        env: envelope({
          'alertEvt.evt': '<aura:event type="APPLICATION"/>',
          'alertEvt.evt-meta.xml': META,
          'alertEvt.design': '<design:component/>',
        }),
        name: 'alertEvt',
        re: /\.design belongs only to a component/,
      },
      // A stray meta not named after the primary.
      {
        env: popEnvelope({ 'voiceCallPop.app-meta.xml': META }),
        re: /only meta file is "voiceCallPop\.cmp-meta\.xml"/,
      },
      // Missing the required meta.
      {
        env: popEnvelope({}, ['voiceCallPop.cmp-meta.xml']),
        re: /missing "voiceCallPop\.cmp-meta\.xml"/,
      },
      // A file not prefixed with the bundle name.
      {
        env: popEnvelope({ 'other.css': '.x{}' }),
        re: /starts with the bundle name/,
      },
    ];
    for (const { env, name, re } of cases) {
      expect(() =>
        buildDeployZip([comp('AuraDefinitionBundle', name ?? 'voiceCallPop', env)], [], V41, noMeta),
      ).toThrow(re);
    }
    // Name grammar: namespaced and malformed names get separate refusals.
    expect(() =>
      buildDeployZip([comp('AuraDefinitionBundle', 'ns__Pop', popEnvelope())], [], V41, noMeta),
    ).toThrow(/namespaced bundle/);
    expect(() =>
      buildDeployZip([comp('AuraDefinitionBundle', 'pop_', popEnvelope())], [], V41, noMeta),
    ).toThrow(/Lightning developer name/);
    // Per-file size cap.
    expect(() =>
      buildDeployZip(
        [
          comp(
            'AuraDefinitionBundle',
            'voiceCallPop',
            popEnvelope({ 'voiceCallPop.css': 'x'.repeat(1_000_001) }),
          ),
        ],
        [],
        V41,
        noMeta,
      ),
    ).toThrow(/1,000,000-byte/);
  });

  it('tokens/event bundles take only their allowed files', () => {
    // A tokens bundle is main + meta only.
    expect(() =>
      buildDeployZip(
        [
          comp(
            'AuraDefinitionBundle',
            'brandTokens',
            envelope({
              'brandTokens.tokens': '<aura:tokens/>',
              'brandTokens.tokens-meta.xml': META,
              'brandTokensController.js': '({})',
            }),
          ),
        ],
        [],
        V41,
        noMeta,
      ),
    ).toThrow(/not a valid file for a \.tokens bundle/);
    // An event bundle allows .auradoc.
    const ok = buildDeployZip(
      [
        comp(
          'AuraDefinitionBundle',
          'alertEvt',
          envelope({
            'alertEvt.evt': '<aura:event type="APPLICATION"/>',
            'alertEvt.evt-meta.xml': META,
            'alertEvt.auradoc': '<aura:documentation/>',
          }),
        ),
      ],
      [],
      V41,
      noMeta,
    );
    expect(ok.files).toContain('aura/alertEvt/alertEvt.auradoc');
  });

  it('INERT UNTIL PLACED fires for an unreferenced surface component; info line always', () => {
    const { changes } = analyzeChanges(
      dbNone,
      storeNone,
      conn,
      [comp('AuraDefinitionBundle', 'voiceCallPop', popEnvelope())],
      [],
    );
    expect(changes[0]!.change).toBe('add');
    const text = changes[0]!.warnings.join(' ');
    expect(text).toMatch(/INERT UNTIL PLACED/);
    expect(text).toMatch(/Background region/);
    expect(text).toMatch(/Consoles already open keep the OLD definition/);

    // Referenced by another package component: the arm stays quiet.
    const placed = analyzeChanges(
      dbNone,
      storeNone,
      conn,
      [
        comp('AuraDefinitionBundle', 'voiceCallPop', popEnvelope()),
        comp(
          'FlexiPage',
          'Console_Bar',
          '<FlexiPage><componentName>c:voiceCallPop</componentName></FlexiPage>',
        ),
      ],
      [],
    );
    expect(placed.changes[0]!.warnings.join(' ')).not.toMatch(/INERT UNTIL PLACED/);
  });

  it('BUNDLE REPLACE on modify names removed files; KIND CHANGE is refused', () => {
    const snapshot: Record<string, string> = {
      'aura/voiceCallPop/voiceCallPop.cmp': CMP,
      'aura/voiceCallPop/voiceCallPop.cmp-meta.xml': META,
      'aura/voiceCallPop/voiceCallPop.css': '.old {}',
    };
    const db = {
      getArtifact: () => ({ filePath: 'aura/voiceCallPop/voiceCallPop.cmp' }),
      edgesTo: () => [],
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
      [comp('AuraDefinitionBundle', 'voiceCallPop', popEnvelope())],
      [],
    );
    expect(changes[0]!.change).toBe('modify');
    const text = changes[0]!.warnings.join(' ');
    expect(text).toMatch(/BUNDLE REPLACE/);
    expect(text).toMatch(/removed: voiceCallPop\.css/);

    // Same name, different kind: refused outright (untested platform path).
    expect(() =>
      analyzeChanges(
        db,
        store,
        conn,
        [
          comp(
            'AuraDefinitionBundle',
            'voiceCallPop',
            envelope({ 'voiceCallPop.app': '<aura:application/>', 'voiceCallPop.app-meta.xml': META }),
          ),
        ],
        [],
      ),
    ).toThrow(/changing a bundle's kind/);
  });

  it('crossing the 39/40 apiVersion boundary warns about Locker, phrased as an org matter', () => {
    const snapshot: Record<string, string> = {
      'aura/voiceCallPop/voiceCallPop.cmp': CMP,
      'aura/voiceCallPop/voiceCallPop.cmp-meta.xml': metaAt('39.0'),
    };
    const db = {
      getArtifact: () => ({ filePath: 'aura/voiceCallPop/voiceCallPop.cmp' }),
      edgesTo: () => [],
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
          'AuraDefinitionBundle',
          'voiceCallPop',
          envelope({ 'voiceCallPop.cmp': CMP, 'voiceCallPop.cmp-meta.xml': metaAt('66.0') }),
        ),
      ],
      [],
    );
    const text = changes[0]!.warnings.join(' ');
    expect(text).toMatch(/39\/40 boundary/);
    expect(text).toMatch(/LWS is an org setting/);
  });

  it('ORDERING: a host referencing a bundle in neither package nor index warns on the HOST', () => {
    const { changes } = analyzeChanges(
      dbNone,
      storeNone,
      conn,
      [
        comp(
          'FlexiPage',
          'Console_Bar',
          '<FlexiPage><componentName>c:ghostCmp</componentName></FlexiPage>',
        ),
      ],
      [],
    );
    const host = changes.find((c) => c.api_name === 'Console_Bar')!;
    expect(host.warnings.join(' ')).toMatch(/ghostCmp .*neither this package nor the snapshot/);
  });

  it('destructive: whole-bundle delete warning with dependents; unregistered types flagged', () => {
    const db = {
      getArtifact: () => ({ filePath: 'x' }),
      edgesTo: () => [
        { fromType: 'FlexiPage', fromName: 'Console_Bar', toType: 'AuraDefinitionBundle', toName: 'voiceCallPop' },
      ],
    } as unknown as ContrailDb;
    const { destructive } = analyzeChanges(db, storeNone, conn, [], [
      { type: 'AuraDefinitionBundle', api_name: 'voiceCallPop' },
      { type: 'PresenceUserConfig', api_name: 'Voice_Agents' },
    ]);
    expect(destructive[0]!.warnings.join(' ')).toMatch(/ENTIRE bundle/);
    expect(destructive[0]!.warnings.join(' ')).toMatch(/FlexiPage:Console_Bar/);
    expect(destructive[1]!.warnings.join(' ')).toMatch(/UNREGISTERED TYPE DELETE/);
  });

  it('a server-side controller warns on the bundle unless a package permission set grants it', () => {
    const pop = comp(
      'AuraDefinitionBundle',
      'voiceCallPop',
      popEnvelope({
        'voiceCallPop.cmp': '<aura:component controller="VoicePopController"/>',
      }),
    );
    const bare = analyzeChanges(dbNone, storeNone, conn, [pop], []);
    const text = bare.changes[0]!.warnings.join(' ');
    expect(text).toMatch(/server-side controller "VoicePopController"/);
    expect(text).toMatch(/classAccesses/);
    // Honest about its own blindness: the grant may live org-side already.
    expect(text).toMatch(/may already be granted org-side/);

    const granted = analyzeChanges(
      dbNone,
      storeNone,
      conn,
      [
        pop,
        comp(
          'PermissionSet',
          'Voice_Access',
          '<PermissionSet><classAccesses><apexClass>VoicePopController</apexClass>' +
            '<enabled>true</enabled></classAccesses></PermissionSet>',
        ),
      ],
      [],
    );
    expect(granted.changes[0]!.warnings.join(' ')).not.toMatch(/server-side controller/);

    // The coverage TABLE deliberately has no Aura arm: a needs-row would
    // claim certainty the engine lacks (the class is usually long-deployed
    // and granted org-side) — the advisory above is a warning, not a need.
    expect(analyzePermissionCoverage([pop]).uncovered).toHaveLength(0);
  });

  it('deployZipEntryPath: probes resolve the real primary; no probe = no guessed path', async () => {
    const { deployZipEntryPath } = await import('../deploy/package.js');
    for (const [name, ext] of [
      ['voiceCallPop', '.cmp'],
      ['consoleApp', '.app'],
      ['alertEvt', '.evt'],
    ] as const) {
      const entries = [`aura/${name}/${name}${ext}`, `aura/${name}/${name}${ext}-meta.xml`];
      const entry = deployZipEntryPath('AuraDefinitionBundle', name, { zipEntries: entries });
      expect(entry).toMatchObject({ path: `aura/${name}/${name}${ext}`, bundleDir: `aura/${name}/` });
    }
    const blind = deployZipEntryPath('AuraDefinitionBundle', 'voiceCallPop');
    expect(blind).toMatchObject({ path: '', bundleDir: 'aura/voiceCallPop/' });
    expect((blind as { mainCandidates?: string[] }).mainCandidates).toContain(
      'aura/voiceCallPop/voiceCallPop.cmp',
    );
  });

  it('indexes an .app bundle resolving its main without the alphabetical fallback', () => {
    const files = new Map<string, Uint8Array>([
      // 'aaa.css' sorts BEFORE the .app file — the fallback would pick it.
      ['aura/consoleApp/consoleApp.css', strToU8('.x {}')],
      ['aura/consoleApp/consoleApp.app', strToU8('<aura:application/>')],
      ['aura/consoleApp/consoleApp.app-meta.xml', strToU8(META)],
    ]);
    const rows = indexSnapshotFiles(files, [], '2026-11-04T00:00:00.000Z');
    const aura = rows.filter((r) => r.type === 'AuraDefinitionBundle');
    expect(aura).toHaveLength(1);
    expect(aura[0]!.apiName).toBe('consoleApp');
    expect(aura[0]!.filePath).toBe('aura/consoleApp/consoleApp.app');
    expect(aura[0]!.content).toContain('contrail:file aura/consoleApp/consoleApp.app-meta.xml');
  });

  it('indexes a meta-less bundle (old retrieves) without complaint', () => {
    const files = new Map<string, Uint8Array>([
      ['aura/OpenURL/OpenURL.cmp', strToU8('<aura:component/>')],
      ['aura/OpenURL/OpenURLController.js', strToU8('({})')],
    ]);
    const rows = indexSnapshotFiles(files, [], '2026-11-04T00:00:00.000Z');
    const aura = rows.filter((r) => r.type === 'AuraDefinitionBundle');
    expect(aura).toHaveLength(1);
    expect(aura[0]!.filePath).toBe('aura/OpenURL/OpenURL.cmp');
  });
});

describe('S44: Agentforce Studio test suites & custom scorers', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
  const V44 = '66.0';
  const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
  const storeNone = {
    readCurrentFile: () => null,
    listCurrentFiles: () => [],
  } as unknown as SnapshotStore;
  const dbMod = (filePath: string) =>
    ({ getArtifact: () => ({ filePath }) }) as unknown as ContrailDb;
  const storeWith = (old: string) =>
    ({ readCurrentFile: () => old, listCurrentFiles: () => [] }) as unknown as SnapshotStore;
  const warningsOf = (res: ReturnType<typeof analyzeChanges>) =>
    res.changes[0]!.warnings.join(' ');

  // Grammar per Salesforce's open-source agents library (the type is Beta;
  // element order and the custom-scorer marker are unverified until the
  // live fixture — these strings pin Contrail's own arms, not the org's shape).
  const singleCase = (n: number) =>
    `<testCase><number>${n}</number><inputs><utterance>hi</utterance></inputs>` +
    `<scorer><name>topic_sequence_match</name><expectedValue>agent_router</expectedValue>` +
    `</scorer></testCase>`;
  const multiCase = (n: number) =>
    `<testCase><number>${n}</number><inputs><utterance>and then?</utterance>` +
    `<conversationHistory><role>user</role><message>hi</message><index>0</index>` +
    `</conversationHistory></inputs><scorer><name>task_resolution</name></scorer></testCase>`;
  const suite = (cases: string) =>
    `<AiTestingDefinition><name>Order_Tests</name><subjectName>Order_Agent</subjectName>` +
    `<subjectType>AGENT</subjectType><subjectVersion>v2</subjectVersion>${cases}` +
    `</AiTestingDefinition>`;
  // Alphabetical element order and samplingRate 1.0 as the org writes them
  // (live-observed on a retrieved std_* scorer 2026-11-08).
  const version = (n: number, status: string) =>
    `<scorerVersion><agentAssociation><agentApiName>Order_Agent</agentApiName>` +
    `<inputScope>Session</inputScope><isActive>false</isActive>` +
    `<samplingRate>1.0</samplingRate></agentAssociation><engine>` +
    `<engineRef>Tone_Prompt</engineRef><engineType>PromptTemplate</engineType></engine>` +
    `<label>v${n}</label><status>${status}</status><versionNumber>${n}</versionNumber>` +
    `</scorerVersion>`;
  const scorer = (versions: string) =>
    `<AiAgentScorerDefinition><dataType>Text</dataType><inputScope>Session</inputScope>` +
    `<scorerType>OpenEnded</scorerType>${versions}<semanticType>Quality</semanticType>` +
    `</AiAgentScorerDefinition>`;
  const idx = (xml: string, needle: string) => {
    const i = xml.indexOf(needle);
    expect(i, `${needle} present`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('places both single-file types in their folders with literal members and NO meta sidecar', () => {
    const built = buildDeployZip(
      [
        comp('AiTestingDefinition', 'Order_Tests', suite(singleCase(1))),
        comp('AiAgentScorerDefinition', 'Tone_Check', scorer(version(1, 'Draft'))),
      ],
      [],
      V44,
      noMeta,
    );
    expect(built.files).toContain('aiTestingDefinitions/Order_Tests.aiTestingDefinition');
    expect(built.files).toContain('aiAgentScorerDefinitions/Tone_Check.aiAgentScorerDefinition');
    expect(built.files.filter((f) => f.endsWith('-meta.xml'))).toEqual([]);
    expect(built.packageXml).toContain('<name>AiTestingDefinition</name>');
    expect(built.packageXml).toContain('<members>Order_Tests</members>');
    expect(built.packageXml).toContain('<name>AiAgentScorerDefinition</name>');
    expect(built.packageXml).toContain('<members>Tone_Check</members>');
    expect(zipText(built.zip, 'aiTestingDefinitions/Order_Tests.aiTestingDefinition')).toContain(
      '<subjectName>Order_Agent</subjectName>',
    );
  });

  it('MANIFEST ORDER: GenAiPromptTemplate precedes AiAgentScorerDefinition in package.xml; the rest stays alphabetical; destructive stays alphabetical', () => {
    const built = buildDeployZip(
      [
        comp('ApexClass', 'Util', 'public class Util {}'),
        comp('AiAgentScorerDefinition', 'Tone_Check', scorer(version(1, 'Draft'))),
        comp('GenAiPromptTemplate', 'Tone_Prompt', '<GenAiPromptTemplate/>'),
        comp('Bot', 'Order_Agent', '<Bot/>'),
      ],
      [
        { type: 'AiAgentScorerDefinition', api_name: 'Old_Check' },
        { type: 'GenAiPromptTemplate', api_name: 'Old_Prompt' },
      ],
      V44,
      noMeta,
    );
    const pkg = built.packageXml;
    // Documented requirement (Salesforce's custom-scorer guide): the template
    // the scorer engines on appears BEFORE the scorer. Alphabetical would put
    // the scorer first (Ai… < Gen…).
    expect(idx(pkg, '<name>ApexClass</name>')).toBeLessThan(idx(pkg, '<name>Bot</name>'));
    expect(idx(pkg, '<name>Bot</name>')).toBeLessThan(idx(pkg, '<name>GenAiPromptTemplate</name>'));
    expect(idx(pkg, '<name>GenAiPromptTemplate</name>')).toBeLessThan(
      idx(pkg, '<name>AiAgentScorerDefinition</name>'),
    );
    // The destructive manifest is left alphabetical — no delete ordering is
    // documented, so nothing is moved there.
    const del = built.destructiveXml!;
    expect(idx(del, '<name>AiAgentScorerDefinition</name>')).toBeLessThan(
      idx(del, '<name>GenAiPromptTemplate</name>'),
    );

    // A scorer-only package has nothing to follow — its block stays put.
    const only = buildDeployZip(
      [comp('AiAgentScorerDefinition', 'Tone_Check', scorer(version(1, 'Draft')))],
      [],
      V44,
      noMeta,
    );
    expect(only.packageXml).toContain('<name>AiAgentScorerDefinition</name>');
    expect(only.packageXml).not.toContain('<name>GenAiPromptTemplate</name>');

    // Everything else is untouched by the table: a package with no scorer is
    // plain alphabetical.
    const plain = buildDeployZip(
      [
        comp('GenAiPromptTemplate', 'Tone_Prompt', '<GenAiPromptTemplate/>'),
        comp('Bot', 'Order_Agent', '<Bot/>'),
      ],
      [],
      V44,
      noMeta,
    );
    expect(idx(plain.packageXml, '<name>Bot</name>')).toBeLessThan(
      idx(plain.packageXml, '<name>GenAiPromptTemplate</name>'),
    );
  });

  it('BETA SUITE fires on add AND modify; modify adds WHOLE-DOCUMENT REPLACE with the test-case suffix', () => {
    const added = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('AiTestingDefinition', 'Order_Tests', suite(singleCase(1)))],
      [],
    );
    const addText = warningsOf(added);
    expect(addText).toMatch(/BETA SUITE, RUNS NOTHING/);
    expect(addText).toContain(
      'this deploy stores an Agentforce Studio test suite; it executes no test. Runs happen ' +
        'through run_agent_eval (on the org probed a deployed suite appeared in the Studio Tests ' +
        'tab only after its first run, never in Testing Center); Salesforce marks both the ' +
        'type and its ' +
        'runner Beta (grammar and runner can change). Contrail does not validate scorer ' +
        "names; per Salesforce's library the org refuses an unknown name at deploy — not " +
        'yet live-confirmed, so a green deploy never proves a scorer ran.',
    );
    expect(addText).not.toMatch(/WHOLE-DOCUMENT REPLACE/);

    const modified = analyzeChanges(
      dbMod('aiTestingDefinitions/Order_Tests.aiTestingDefinition'),
      storeWith('<AiTestingDefinition>old</AiTestingDefinition>'),
      conn,
      [comp('AiTestingDefinition', 'Order_Tests', suite(singleCase(1)))],
      [],
    );
    const modText = warningsOf(modified);
    expect(modified.changes[0]!.change).toBe('modify');
    expect(modText).toMatch(/BETA SUITE/);
    expect(modText).toMatch(/WHOLE-DOCUMENT REPLACE/);
    expect(modText).toContain(
      "this deploy fully replaces the org's AiTestingDefinition; anything not present in " +
        'the proposed content is removed. A <testCase> omitted here is removed from the ' +
        'suite org-side.',
    );

    // The legacy type joins the whole-document list with the SAME suffix (a
    // parity gap since S30) — and the BETA arm is Studio-only.
    const legacy = analyzeChanges(
      dbMod('aiEvaluationDefinitions/Legacy_Tests.aiEvaluationDefinition'),
      storeWith('<AiEvaluationDefinition>old</AiEvaluationDefinition>'),
      conn,
      [
        comp(
          'AiEvaluationDefinition',
          'Legacy_Tests',
          '<AiEvaluationDefinition><subjectName>Order_Agent</subjectName></AiEvaluationDefinition>',
        ),
      ],
      [],
    );
    const legacyText = warningsOf(legacy);
    expect(legacyText).toMatch(/WHOLE-DOCUMENT REPLACE/);
    expect(legacyText).toContain(
      "this deploy fully replaces the org's AiEvaluationDefinition; anything not present in " +
        'the proposed content is removed. A <testCase> omitted here is removed from the ' +
        'suite org-side.',
    );
    expect(legacyText).not.toMatch(/BETA SUITE/);
  });

  it('MIXED-TURN advisory fires only when single- and multi-turn cases share a suite', () => {
    const run = (cases: string) =>
      warningsOf(
        analyzeChanges(
          dbAdd,
          storeNone,
          conn,
          [comp('AiTestingDefinition', 'Order_Tests', suite(cases))],
          [],
        ),
      );
    expect(run(singleCase(1) + singleCase(2))).not.toMatch(/MIXED SINGLE- AND MULTI-TURN/);
    expect(run(multiCase(1) + multiCase(2))).not.toMatch(/MIXED SINGLE- AND MULTI-TURN/);
    const mixed = run(singleCase(1) + multiCase(2));
    expect(mixed).toMatch(/MIXED SINGLE- AND MULTI-TURN CASES/);
    expect(mixed).toContain('1 case(s) carry <conversationHistory> and 1 do not');
    // Hedged on purpose: "reported to stall", "no cancel endpoint" — and no
    // claim about when a stalled run releases its slot.
    expect(mixed).toContain('has been reported to stall');
    expect(mixed).toContain('the Studio runner has no cancel endpoint');
    expect(mixed).not.toMatch(/slot/);
  });

  it('scorer modify: APPEND-ONLY arm names omitted versions and status regressions; add is silent; never WHOLE-DOCUMENT REPLACE', () => {
    const added = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('AiAgentScorerDefinition', 'Tone_Check', scorer(version(1, 'Draft')))],
      [],
    );
    expect(warningsOf(added)).not.toMatch(/APPEND-ONLY/);
    expect(warningsOf(added)).not.toMatch(/WHOLE-DOCUMENT REPLACE/);

    const regressing = analyzeChanges(
      dbMod('aiAgentScorerDefinitions/Tone_Check.aiAgentScorerDefinition'),
      storeWith(scorer(version(1, 'Available') + version(2, 'Draft'))),
      conn,
      [comp('AiAgentScorerDefinition', 'Tone_Check', scorer(version(1, 'Draft')))],
      [],
    );
    const text = warningsOf(regressing);
    expect(regressing.changes[0]!.change).toBe('modify');
    expect(text).toMatch(/SCORER VERSIONS ARE APPEND-ONLY/);
    expect(text).toContain('omitted here: 2');
    expect(text).toContain('regressed here: 1 (Available → Draft)');
    expect(text).toContain('Retrieve-first, carry every existing version forward, edit only Draft versions.');
    expect(text).not.toMatch(/WHOLE-DOCUMENT REPLACE/);
    // Documented facts only — never a claim about what the org does with the
    // omission (unverified until the live probe).
    expect(text).not.toMatch(/FAILS|REFUSED/);

    const carried = analyzeChanges(
      dbMod('aiAgentScorerDefinitions/Tone_Check.aiAgentScorerDefinition'),
      storeWith(scorer(version(1, 'Available') + version(2, 'Draft'))),
      conn,
      [
        comp(
          'AiAgentScorerDefinition',
          'Tone_Check',
          scorer(version(1, 'Available') + version(2, 'Draft') + version(3, 'Draft')),
        ),
      ],
      [],
    );
    const carriedText = warningsOf(carried);
    expect(carriedText).toMatch(/APPEND-ONLY/);
    expect(carriedText).not.toContain('omitted here');
    expect(carriedText).not.toContain('regressed here');
    // Forward motion is not a regression.
    const promoted = analyzeChanges(
      dbMod('aiAgentScorerDefinitions/Tone_Check.aiAgentScorerDefinition'),
      storeWith(scorer(version(1, 'Draft'))),
      conn,
      [comp('AiAgentScorerDefinition', 'Tone_Check', scorer(version(1, 'Available')))],
      [],
    );
    expect(warningsOf(promoted)).not.toContain('regressed here');
  });

  it('std_ scorer names draw the SYSTEM-PROVISIONED advisory on add and modify; custom names do not', () => {
    const expected =
      'SYSTEM-PROVISIONED SCORER — Salesforce creates std_* scorers for each agent (last ' +
      'modified by Automated Process); an edit may be overwritten or refused org-side. ' +
      'Author your own ' +
      'scorer name for custom logic.';
    const added = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('AiAgentScorerDefinition', 'std_Quality_Score_Order_Agent', scorer(version(1, 'Available')))],
      [],
    );
    expect(added.changes[0]!.warnings).toContain(expected);

    const modified = analyzeChanges(
      dbMod('aiAgentScorerDefinitions/std_Quality_Score_Order_Agent.aiAgentScorerDefinition'),
      storeWith(scorer(version(1, 'Available'))),
      conn,
      [
        comp(
          'AiAgentScorerDefinition',
          'std_Quality_Score_Order_Agent',
          scorer(version(1, 'Available') + version(2, 'Draft')),
        ),
      ],
      [],
    );
    expect(modified.changes[0]!.warnings).toContain(expected);
    expect(warningsOf(modified)).toMatch(/APPEND-ONLY/);

    const custom = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('AiAgentScorerDefinition', 'Tone_Check', scorer(version(1, 'Draft')))],
      [],
    );
    expect(warningsOf(custom)).not.toMatch(/SYSTEM-PROVISIONED/);
    // Prefix match is anchored and case-sensitive: "Standard_Tone" is a custom name.
    const standard = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('AiAgentScorerDefinition', 'Standard_Tone', scorer(version(1, 'Draft')))],
      [],
    );
    expect(warningsOf(standard)).not.toMatch(/SYSTEM-PROVISIONED/);
  });

  it('AiEvaluationDefinition, AiTestingDefinition and AiAgentScorerDefinition deliberately produce NO permission needs', () => {
    const res = analyzePermissionCoverage([
      comp('AiEvaluationDefinition', 'Legacy_Tests', '<AiEvaluationDefinition/>'),
      comp('AiTestingDefinition', 'Order_Tests', suite(singleCase(1))),
      comp('AiAgentScorerDefinition', 'Tone_Check', scorer(version(1, 'Draft'))),
    ]);
    expect(res.uncovered).toHaveLength(0);
    expect(res.warning).toBeNull();
  });

  it('deployZipEntryPath matches the builder for both types', async () => {
    const { deployZipEntryPath } = await import('../deploy/package.js');
    expect(deployZipEntryPath('AiTestingDefinition', 'Order_Tests')).toEqual({
      path: 'aiTestingDefinitions/Order_Tests.aiTestingDefinition',
      child: false,
    });
    expect(deployZipEntryPath('AiAgentScorerDefinition', 'Tone_Check')).toEqual({
      path: 'aiAgentScorerDefinitions/Tone_Check.aiAgentScorerDefinition',
      child: false,
    });
  });
});

describe('S45: retrieveMemberFor mirrors the component arms of buildDeployZip', () => {
  it('file, bundle, foldered and child types resolve to the member the deploy manifest carries', () => {
    expect(retrieveMemberFor('ApexClass', 'Foo')).toEqual({ type: 'ApexClass', member: 'Foo' });
    expect(retrieveMemberFor('LightningComponentBundle', 'myCmp')).toEqual({
      type: 'LightningComponentBundle',
      member: 'myCmp',
    });
    expect(retrieveMemberFor('Report', 'Ops/Pipeline')).toEqual({
      type: 'Report',
      member: 'Ops/Pipeline',
    });
    // A folder component addresses as a member of its CONTENT type (manifestType).
    expect(retrieveMemberFor('ReportFolder', 'Ops')).toEqual({ type: 'Report', member: 'Ops' });
    // Children come down inside their container, addressed by the parent name.
    expect(retrieveMemberFor('CustomField', 'Invoice__c.Amount__c')).toEqual({
      type: 'CustomObject',
      member: 'Invoice__c',
    });
    expect(retrieveMemberFor('ValidationRule', 'Invoice__c.Positive_Amount')).toEqual({
      type: 'CustomObject',
      member: 'Invoice__c',
    });
    expect(retrieveMemberFor('CustomLabel', 'Greeting')).toEqual({
      type: 'CustomLabels',
      member: 'CustomLabels',
    });
    expect(retrieveMemberFor('BotVersion', 'MyBot.v1')).toEqual({ type: 'Bot', member: 'MyBot' });
  });

  it('a type Contrail cannot author (destructive-only) and an undotted child name resolve to null', () => {
    expect(retrieveMemberFor('PresenceUserConfig', 'Agents')).toBeNull();
    expect(retrieveMemberFor('NotAType', 'x')).toBeNull();
    expect(retrieveMemberFor('CustomField', '')).toBeNull();
  });
});

describe('S46: a type named like an Object.prototype property is simply unregistered', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
  const dbNone = { getArtifact: () => null } as unknown as ContrailDb;
  const storeNone = { readCurrentFile: () => null } as unknown as SnapshotStore;
  // Each passes the type grammar (letters only); "__proto__" does not.
  const PROTO_TYPES = ['constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const STRAYS = [
    { type: 'constructor', api_name: 'Stray_One' },
    { type: 'toString', api_name: 'Stray_Two' },
  ];

  it('no type-table lookup finds an inherited member: unregistered, no retrieve mirror, no zip entry', () => {
    for (const type of PROTO_TYPES) {
      expect(isRegisteredType(type), type).toBe(false);
      expect(retrieveMemberFor(type, 'Stray'), type).toBeNull();
      expect(retrieveMemberFor(type, 'Parent.Stray'), type).toBeNull();
      expect(deployZipEntryPath(type, 'Stray'), type).toBeNull();
      expect(deployZipEntryPath(type, 'Parent.Stray'), type).toBeNull();
      // Not a child type: the snapshot copy is the file itself, never a block extraction.
      const store = { readCurrentFile: () => '<Doc/>' } as unknown as SnapshotStore;
      expect(readOldContent(store, conn, type, 'Parent.Stray', 'x/Parent.x'), type).toBe('<Doc/>');
      expect(() => parseEnvelopeFor(type, 'Stray', '{}'), type).toThrow(
        `${type} is not a bundle (envelope) type`,
      );
    }
    expect(isRegisteredType('__proto__')).toBe(false);
  });

  it('validate path: a component of such a type is refused as not deployable — never a TypeError', () => {
    for (const { type } of STRAYS) {
      expect(() => buildDeployZip([comp(type, 'Stray', '<Stray/>')], [], V, noMeta)).toThrow(
        `Type "${type}" is not deployable through Contrail yet`,
      );
    }
  });

  it('validate path: destructive members of type "constructor" and "toString" keep their literal manifest entry and are flagged UNREGISTERED TYPE DELETE', () => {
    const built = buildDeployZip(
      [comp('ApexClass', 'Foo', 'public class Foo {}')],
      STRAYS,
      V,
      noMeta,
    );
    expect(built.destructiveXml).toContain(
      '<members>Stray_One</members>\n        <name>constructor</name>',
    );
    expect(built.destructiveXml).toContain('<members>Stray_Two</members>\n        <name>toString</name>');
    // Nothing of theirs lands in the deploy itself.
    expect(built.files).toEqual([
      'classes/Foo.cls',
      'classes/Foo.cls-meta.xml',
      'destructiveChangesPost.xml',
      'package.xml',
    ]);
    const { destructive } = analyzeChanges(dbNone, storeNone, conn, [], STRAYS);
    for (const [i, { type }] of STRAYS.entries()) {
      expect(destructive[i]!.warnings.join(' ')).toContain(
        `UNREGISTERED TYPE DELETE — Contrail cannot read ${type} or list its dependents`,
      );
    }
  });
});

describe('S46 D3: the permission warning says what Contrail knows about each component', () => {
  const cls = comp('ApexClass', 'InvoiceService', 'public class InvoiceService {}');
  const page = comp('ApexPage', 'Invoice_Portal', '<apex:page/>');
  const tab = comp('CustomTab', 'Invoice__c', '<CustomTab/>');
  /** A permission set that grants nothing these tests ask about. */
  const emptySet = comp('PermissionSet', 'Invoice_Access', '<PermissionSet></PermissionSet>');
  const LIST =
    'ApexClass:InvoiceService (Apex class access); ApexPage:Invoice_Portal (Visualforce page access)';

  /** `presence` answering from a `Type:api_name` table; a missing key is "not known". */
  const presenceFrom =
    (known: Record<string, boolean | null>) =>
    (type: string, apiName: string): boolean | null | undefined =>
      known[`${type}:${apiName}`];
  const all = (value: boolean | null) =>
    presenceFrom({ 'ApexClass:InvoiceService': value, 'ApexPage:Invoice_Portal': value });

  it('no permission set or profile in the package: the three sentences, verbatim', () => {
    const fresh = analyzePermissionCoverage([cls, page], all(false));
    expect(fresh.uncovered.map((u) => u.presence)).toEqual(['new', 'new']);
    expect(fresh.warning).toBe(
      'This package adds 2 component(s) that need permissions but includes no permission set ' +
        'or profile to grant them — they will deploy but stay invisible or inaccessible until ' +
        'you set permissions (deploy a permission set alongside, or grant FLS/access ' +
        `afterward): ${LIST}.`,
    );

    const inOrg = analyzePermissionCoverage([cls, page], all(true));
    expect(inOrg.uncovered.map((u) => u.presence)).toEqual(['in_org', 'in_org']);
    expect(inOrg.warning).toBe(
      'This package includes 2 component(s) that are already in the org and need permissions ' +
        'to be usable, and no permission set or profile for them — who can use them depends on ' +
        `the permissions already in the org, which Contrail did not check: ${LIST}.`,
    );
    // The fix itself: a component the org already has is never said to be
    // added, and nothing is predicted about who can use it.
    expect(inOrg.warning).not.toContain('adds');
    expect(inOrg.warning).not.toContain('invisible');

    const unplaced = analyzePermissionCoverage([cls, page], all(null));
    expect(unplaced.uncovered.map((u) => u.presence)).toEqual(['unknown', 'unknown']);
    expect(unplaced.warning).toBe(
      'This package includes 2 component(s) that need permissions to be usable and no ' +
        'permission set or profile to grant them. Contrail did not confirm whether they ' +
        'already exist in the org — any that are new will deploy but stay invisible or ' +
        'inaccessible until you set permissions (deploy a permission set alongside, or grant ' +
        `FLS/access afterward): ${LIST}.`,
    );
    expect(unplaced.warning).not.toContain('adds');
  });

  it('a permission set or profile in the package that does not grant them: the three sentences, verbatim', () => {
    const fresh = analyzePermissionCoverage([cls, page, emptySet], all(false));
    expect(fresh.has_permission_container).toBe(true);
    expect(fresh.warning).toBe(
      'These new components are not granted by the permission set/profile in this package and ' +
        `will be invisible or inaccessible to users until permissions are set: ${LIST}.`,
    );

    const inOrg = analyzePermissionCoverage([cls, page, emptySet], all(true));
    expect(inOrg.warning).toBe(
      'These components are already in the org and are not granted by the permission ' +
        'set/profile in this package — who can use them depends on the permissions already in ' +
        `the org, which Contrail did not check: ${LIST}.`,
    );
    expect(inOrg.warning).not.toContain('new components');

    const unplaced = analyzePermissionCoverage([cls, page, emptySet], all(null));
    expect(unplaced.warning).toBe(
      'These components are not granted by the permission set/profile in this package, and ' +
        'Contrail did not confirm whether they already exist in the org — any that are new ' +
        `will be invisible or inaccessible to users until permissions are set: ${LIST}.`,
    );
    expect(unplaced.warning).not.toContain('new components');
  });

  it('a mixed package: one sentence per group, in the order new, in the org, not placed — each counting only its own', () => {
    const cov = analyzePermissionCoverage(
      [cls, page, tab],
      presenceFrom({ 'ApexClass:InvoiceService': true, 'ApexPage:Invoice_Portal': false }),
    );
    expect(cov.uncovered).toEqual([
      { type: 'ApexClass', api_name: 'InvoiceService', permission: 'Apex class access', presence: 'in_org' },
      { type: 'ApexPage', api_name: 'Invoice_Portal', permission: 'Visualforce page access', presence: 'new' },
      { type: 'CustomTab', api_name: 'Invoice__c', permission: 'tab visibility', presence: 'unknown' },
    ]);
    expect(cov.warning).toBe(
      'This package adds 1 component(s) that need permissions but includes no permission set ' +
        'or profile to grant them — they will deploy but stay invisible or inaccessible until ' +
        'you set permissions (deploy a permission set alongside, or grant FLS/access ' +
        'afterward): ApexPage:Invoice_Portal (Visualforce page access). ' +
        'This package includes 1 component(s) that are already in the org and need permissions ' +
        'to be usable, and no permission set or profile for them — who can use them depends on ' +
        'the permissions already in the org, which Contrail did not check: ' +
        'ApexClass:InvoiceService (Apex class access). ' +
        'This package includes 1 component(s) that need permissions to be usable and no ' +
        'permission set or profile to grant them. Contrail did not confirm whether they ' +
        'already exist in the org — any that are new will deploy but stay invisible or ' +
        'inaccessible until you set permissions (deploy a permission set alongside, or grant ' +
        'FLS/access afterward): CustomTab:Invoice__c (tab visibility).',
    );
  });

  it('no presence callback (a dry run, or the live check unavailable): every component is not placed and nothing is said to be added', () => {
    const cov = analyzePermissionCoverage([cls, page]);
    expect(cov.uncovered.map((u) => u.presence)).toEqual(['unknown', 'unknown']);
    expect(cov.warning).toBe(
      'This package includes 2 component(s) that need permissions to be usable and no ' +
        'permission set or profile to grant them. Contrail did not confirm whether they ' +
        'already exist in the org — any that are new will deploy but stay invisible or ' +
        'inaccessible until you set permissions (deploy a permission set alongside, or grant ' +
        `FLS/access afterward): ${LIST}.`,
    );
    expect(cov.warning).not.toContain('adds');
    expect(analyzePermissionCoverage([cls, page, emptySet]).warning).not.toContain(
      'new components',
    );
  });

  it('an inline field answers for itself first, then through its object: the fields of a new object are new', () => {
    const gadget = comp(
      'CustomObject',
      'Gadget__c',
      '<CustomObject><label>G</label>' +
        '<fields><fullName>Serial__c</fullName><type>Text</type></fields></CustomObject>',
    );
    const field = (cov: ReturnType<typeof analyzePermissionCoverage>) =>
      cov.uncovered.find((u) => u.type === 'CustomField');

    // The object is absent and nothing is known about the field itself.
    const newObject = analyzePermissionCoverage(
      [gadget],
      presenceFrom({ 'CustomObject:Gadget__c': false }),
    );
    expect(newObject.uncovered.map((u) => `${u.type}:${u.api_name}:${u.presence}`)).toEqual([
      'CustomObject:Gadget__c:new',
      'CustomField:Gadget__c.Serial__c:new',
    ]);
    expect(newObject.warning).toMatch(/^This package adds 2 component\(s\)/);

    // The object is in the org and the field cannot be placed: the field is
    // NOT assumed to exist with its object, and not assumed new either.
    const oldObject = analyzePermissionCoverage(
      [gadget],
      presenceFrom({ 'CustomObject:Gadget__c': true }),
    );
    expect(field(oldObject)).toMatchObject({ presence: 'unknown' });
    expect(oldObject.warning).not.toContain('adds');

    // The field's own answer wins over its owner's, both ways.
    const ownTrue = analyzePermissionCoverage(
      [gadget],
      presenceFrom({ 'CustomObject:Gadget__c': false, 'CustomField:Gadget__c.Serial__c': true }),
    );
    expect(field(ownTrue)).toMatchObject({ presence: 'in_org' });
    const ownFalse = analyzePermissionCoverage(
      [gadget],
      presenceFrom({ 'CustomObject:Gadget__c': true, 'CustomField:Gadget__c.Serial__c': false }),
    );
    expect(field(ownFalse)).toMatchObject({ presence: 'new' });
  });

  it('a credential principal is new with a new ExternalCredential, and not placed inside one the org already has', () => {
    const cred = comp(
      'ExternalCredential',
      'Billing_Auth',
      '<ExternalCredential><externalCredentialParameters>' +
        '<parameterName>Basic</parameterName><parameterType>NamedPrincipal</parameterType>' +
        '</externalCredentialParameters></ExternalCredential>',
    );
    const fresh = analyzePermissionCoverage(
      [cred],
      presenceFrom({ 'ExternalCredential:Billing_Auth': false }),
    );
    expect(fresh.uncovered).toEqual([
      {
        type: 'ExternalCredential',
        api_name: 'Billing_Auth-Basic',
        permission: 'external credential principal access (externalCredentialPrincipalAccesses)',
        presence: 'new',
      },
    ]);
    const existing = analyzePermissionCoverage(
      [cred],
      presenceFrom({ 'ExternalCredential:Billing_Auth': true }),
    );
    expect(existing.uncovered[0]).toMatchObject({ presence: 'unknown' });
    expect(existing.warning).toContain('did not confirm whether they already exist');
  });

  it('presence never changes WHAT is uncovered: a granted component stays out whatever the org holds', () => {
    const granting = comp(
      'PermissionSet',
      'Invoice_Access',
      '<PermissionSet><classAccesses><apexClass>InvoiceService</apexClass>' +
        '<enabled>true</enabled></classAccesses></PermissionSet>',
    );
    for (const value of [true, false, null]) {
      const cov = analyzePermissionCoverage(
        [cls, granting],
        presenceFrom({ 'ApexClass:InvoiceService': value }),
      );
      expect(cov.uncovered).toEqual([]);
      expect(cov.warning).toBeNull();
    }
  });
});

describe('S47: Omnistudio Data Mappers (OmniDataTransform)', () => {
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
  const V47 = '68.0';
  const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
  const storeNone = {
    readCurrentFile: () => null,
    listCurrentFiles: () => [],
  } as unknown as SnapshotStore;
  const dbMod = (filePath: string) =>
    ({ getArtifact: () => ({ filePath }) }) as unknown as ContrailDb;
  const storeWith = (old: string) =>
    ({ readCurrentFile: () => old, listCurrentFiles: () => [] }) as unknown as SnapshotStore;
  const warningsOf = (res: ReturnType<typeof analyzeChanges>) =>
    res.changes[0]!.warnings.join(' ');

  // Element grammar per Salesforce's OmniDataTransform type page (Industries
  // developer guide): header elements alphabetical, the repeated
  // <omniDataTransformItem> rows between nullInputsIncludedInOutput and
  // outputType, item children alphabetical, item <name> = the mapper's name,
  // uniqueName = <name>_<versionNumber>. Doc-derived — these strings pin
  // Contrail's own arms, not a retrieved file.
  const row = (name: string, input: string, output: string) =>
    `    <omniDataTransformItem>\n        <disabled>false</disabled>\n` +
    `        <filterGroup>0.0</filterGroup>\n        <inputFieldName>${input}</inputFieldName>\n` +
    `        <name>${name}</name>\n        <outputCreationSequence>1.0</outputCreationSequence>\n` +
    `        <outputFieldName>${output}</outputFieldName>\n` +
    `        <outputObjectName>json</outputObjectName>\n    </omniDataTransformItem>\n`;
  const mapper = (name: string, uniqueName: string | null, rows: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <active>true</active>\n    <inputType>JSON</inputType>\n    <name>${name}</name>\n` +
    `    <nullInputsIncludedInOutput>false</nullInputsIncludedInOutput>\n${rows}` +
    `    <outputType>JSON</outputType>\n    <type>Extract</type>\n` +
    (uniqueName === null ? '' : `    <uniqueName>${uniqueName}</uniqueName>\n`) +
    `    <versionNumber>1.0</versionNumber>\n</OmniDataTransform>\n`;
  const extract = mapper(
    'AccountSummaryExtract',
    'AccountSummaryExtract_1',
    row('AccountSummaryExtract', 'Account:Name', 'AccountName'),
  );
  const ADVISORY =
    "OMNISTUDIO DATA MAPPER — deploys only where the org's Omnistudio Metadata setting is " +
    'on (per Salesforce Help). Its <active> value decides whether it lands active (per a ' +
    'Salesforce blog — not yet confirmed here). Formula items need the Data Mapper Designer ' +
    "(formulaConverted is Designer-computed); check the result in the Designer's Preview.";
  const MODIFY =
    'MODIFY OF AN EXISTING DATA MAPPER — whether the org updates it in place (per Salesforce ' +
    "Help, an active version can't be edited once Data Mapper Versioning is on) is not " +
    'confirmed, nor whether mapping rows omitted here are removed org-side; carry every row ' +
    'from a fresh retrieve.';
  const MIXED =
    "MIXED PACKAGE — Salesforce says Omnistudio components can't share a deploy with setup " +
    'metadata (permission sets, profiles, fields, FlexiPages, Expression Sets); if the org ' +
    'refuses, deploy the Data Mappers on their own.';

  it('places omniDataTransforms/<Name>_<version>.rpt with a literal member and NO meta sidecar', () => {
    const built = buildDeployZip(
      [comp('OmniDataTransform', 'AccountSummaryExtract_1', extract)],
      [],
      V47,
      noMeta,
    );
    expect(built.files).toEqual(['omniDataTransforms/AccountSummaryExtract_1.rpt', 'package.xml']);
    expect(built.files.filter((f) => f.endsWith('-meta.xml'))).toEqual([]);
    expect(built.packageXml).toContain(
      '<members>AccountSummaryExtract_1</members>\n        <name>OmniDataTransform</name>',
    );
    // The body is written byte-for-byte — no envelope, no rewrite.
    expect(zipText(built.zip, 'omniDataTransforms/AccountSummaryExtract_1.rpt')).toBe(extract);
  });

  it('deployZipEntryPath matches the builder; retrieveMemberFor and isRegisteredType see the type', () => {
    expect(deployZipEntryPath('OmniDataTransform', 'AccountSummaryExtract_1')).toEqual({
      path: 'omniDataTransforms/AccountSummaryExtract_1.rpt',
      child: false,
    });
    expect(retrieveMemberFor('OmniDataTransform', 'AccountSummaryExtract_1')).toEqual({
      type: 'OmniDataTransform',
      member: 'AccountSummaryExtract_1',
    });
    expect(isRegisteredType('OmniDataTransform')).toBe(true);
    // The metadata type is the mapper; its item sObject is NOT a type.
    expect(isRegisteredType('OmniDataTransformItem')).toBe(false);
  });

  it('the indexer reads omniDataTransforms/<Name>_1.rpt as one row, version suffix intact, and skips a -meta.xml', () => {
    const files = new Map<string, Uint8Array>([
      ['omniDataTransforms/AccountSummaryExtract_1.rpt', strToU8(extract)],
      ['omniDataTransforms/AccountSummaryExtract_1.rpt-meta.xml', strToU8('<stray/>')],
    ]);
    const rows = indexSnapshotFiles(files, [], '2026-11-20T00:00:00.000Z');
    expect(rows.map((r) => `${r.type}:${r.apiName}:${r.filePath}`)).toEqual([
      'OmniDataTransform:AccountSummaryExtract_1:omniDataTransforms/AccountSummaryExtract_1.rpt',
    ]);
  });

  it('name grammar: letters and digits, optionally _<version>; anything else is refused with the reason', () => {
    for (const name of ['AccountSummaryExtract_1', 'Abc_1', 'Abc', 'Abc2_12']) {
      expect(isValidComponentName('OmniDataTransform', name), name).toBe(true);
      expect(() =>
        buildDeployZip([comp('OmniDataTransform', name, extract)], [], V47, noMeta),
      ).not.toThrow();
    }
    for (const name of ['Abc_Def', 'Abc-1', 'Abc 1', '_1', 'Abc_1_2', 'Abc_', 'Abc.1']) {
      expect(isValidComponentName('OmniDataTransform', name), name).toBe(false);
      expect(
        () => buildDeployZip([comp('OmniDataTransform', name, extract)], [], V47, noMeta),
        name,
      ).toThrow(
        `invalid OmniDataTransform name "${name}" — letters and digits, optionally ` +
          `_<version> (e.g. AccountSummaryExtract_1). Per Salesforce Help, Data Mapper names ` +
          `hold letters and digits only once Omnistudio Metadata is on; Salesforce's guides ` +
          `name the files <Name>_<version> (exact fullName rule not yet confirmed).`,
      );
    }
    // The grammar is the type's, so it holds on the destructive path too.
    expect(() =>
      buildDeployZip([], [{ type: 'OmniDataTransform', api_name: 'Abc-1' }], V47, noMeta),
    ).toThrow('invalid OmniDataTransform name "Abc-1"');
    // Other types keep the generic grammar.
    expect(isValidComponentName('ApexClass', 'Abc_Def')).toBe(true);
  });

  it('a stray envelope aimed at it fails locally and honestly', () => {
    expect(() =>
      buildDeployZip(
        [
          comp(
            'OmniDataTransform',
            'AccountSummaryExtract_1',
            '{"contrail_bundle":1,"files":{"AccountSummaryExtract_1.rpt":"<OmniDataTransform/>"}}',
          ),
        ],
        [],
        V47,
        noMeta,
      ),
    ).toThrow(/single-file type/);
  });

  it('the OMNISTUDIO DATA MAPPER advisory fires on add AND modify; modify adds the hedged arm, never WHOLE-DOCUMENT REPLACE', () => {
    const added = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('OmniDataTransform', 'AccountSummaryExtract_1', extract)],
      [],
    );
    expect(added.changes[0]!.change).toBe('add');
    expect(added.changes[0]!.warnings).toEqual([ADVISORY]);

    const modified = analyzeChanges(
      dbMod('omniDataTransforms/AccountSummaryExtract_1.rpt'),
      storeWith(mapper('AccountSummaryExtract', 'AccountSummaryExtract_1', '')),
      conn,
      [comp('OmniDataTransform', 'AccountSummaryExtract_1', extract)],
      [],
    );
    expect(modified.changes[0]!.change).toBe('modify');
    // The change-dependent arm leads; the change-independent advisory follows.
    expect(modified.changes[0]!.warnings).toEqual([MODIFY, ADVISORY]);
    // Removal of omitted rows is NOT confirmed — the generic sentence that
    // states it as fact must never appear for this type.
    expect(warningsOf(modified)).not.toMatch(/WHOLE-DOCUMENT REPLACE/);
    expect(warningsOf(modified)).not.toContain('is removed.');
    // Nor is an in-place update: no heading states that the modify REPLACES.
    expect(warningsOf(modified)).not.toMatch(/REPLACE/);

    // The engine re-runs the change-dependent arms against the live copy:
    // the modify arm is change-dependent, the advisory is not.
    const arms = (change: 'add' | 'modify' | 'unchanged_content') =>
      changeDependentWarnings({
        type: 'OmniDataTransform',
        api_name: 'AccountSummaryExtract_1',
        change,
        proposed: extract,
        before: change === 'add' ? null : extract,
      });
    expect(arms('modify')).toEqual([MODIFY]);
    expect(arms('add')).toEqual([]);
    expect(arms('unchanged_content')).toEqual([]);
  });

  it('UNIQUENAME MISMATCH: only when the header uniqueName differs from api_name — advisory, never a refusal', () => {
    const run = (apiName: string, content: string) =>
      analyzeChanges(dbAdd, storeNone, conn, [comp('OmniDataTransform', apiName, content)], []);
    const mismatch = run('AccountSummaryExtract', extract);
    expect(mismatch.changes[0]!.warnings).toContain(
      "UNIQUENAME MISMATCH — api_name AccountSummaryExtract differs from the file's uniqueName " +
        "AccountSummaryExtract_1; Salesforce's guides name Data Mapper files <Name>_<version> " +
        '(fullName rule not yet confirmed).',
    );
    expect(() =>
      buildDeployZip([comp('OmniDataTransform', 'AccountSummaryExtract', extract)], [], V47, noMeta),
    ).not.toThrow();
    expect(warningsOf(run('AccountSummaryExtract_1', extract))).not.toMatch(/UNIQUENAME/);
    // No <uniqueName> in the file: nothing to compare.
    expect(
      warningsOf(run('AccountSummaryExtract_1', mapper('AccountSummaryExtract', null, ''))),
    ).not.toMatch(/UNIQUENAME/);
    // Only the header's value counts — an item row carrying one is ignored.
    const rowOnly = mapper(
      'AccountSummaryExtract',
      null,
      row('AccountSummaryExtract', 'Account:Name', 'AccountName').replace(
        '<name>',
        '<uniqueName>Other_2</uniqueName><name>',
      ),
    );
    expect(warningsOf(run('AccountSummaryExtract_1', rowOnly))).not.toMatch(/UNIQUENAME/);
  });

  it('UNIQUENAME MISMATCH reads the header in linear time: about 1 MB of malformed rows or names answers fast, and the same', () => {
    // The lazy row strip re-read to the end of the text once per row opener
    // with no closer, and the lazy value pattern was cubic in the white space
    // after a <uniqueName> with no closer: seconds to minutes of a blocked
    // server for the first two shapes. Each answers what the patterns did.
    const MB = 1_000_000;
    const head = (rest: string) =>
      `<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
      `    <name>AccountSummaryExtract</name>\n${rest}`;
    const decoyRow = row('AccountSummaryExtract', 'Account:Name', 'AccountName').replace(
      '<name>',
      '<uniqueName>Row_9</uniqueName><name>',
    );
    const shapes: Array<[string, string, string | null]> = [
      // An opener with no closer leaves the rest in place: no header value.
      [
        'row openers with no closer',
        head('<omniDataTransformItem>'.repeat(Math.floor(MB / 23))),
        null,
      ],
      [
        '<uniqueName> openers with no closer, each followed by white space',
        head(`<uniqueName>${' '.repeat(200)}`.repeat(Math.floor(MB / 212))),
        null,
      ],
      [
        'closed rows carrying their own uniqueName, then the header value',
        head(
          decoyRow.repeat(Math.floor(MB / decoyRow.length)) +
            '    <type>Extract</type>\n    <uniqueName> AccountSummaryExtract_2 </uniqueName>\n' +
            '</OmniDataTransform>\n',
        ),
        'AccountSummaryExtract_2',
      ],
    ];
    for (const [what, content, uniqueName] of shapes) {
      expect(content.length, what).toBeGreaterThan(MB * 0.95);
      const started = performance.now();
      const res = analyzeChanges(
        dbAdd,
        storeNone,
        conn,
        [comp('OmniDataTransform', 'AccountSummaryExtract_1', content)],
        [],
      );
      const took = performance.now() - started;
      if (uniqueName === null) {
        expect(warningsOf(res), what).not.toMatch(/UNIQUENAME/);
      } else {
        expect(warningsOf(res), what).toContain(`differs from the file's uniqueName ${uniqueName};`);
      }
      expect(took, `${what}: ${Math.round(took)} ms`).toBeLessThan(1000);
    }
  });

  it('MIXED PACKAGE: on every Data Mapper entry when any other type shares the package; absent when they deploy alone', () => {
    const alone = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [
        comp('OmniDataTransform', 'AccountSummaryExtract_1', extract),
        comp('OmniDataTransform', 'AccountSummaryTransform_1', extract),
      ],
      [{ type: 'OmniDataTransform', api_name: 'OldSummaryExtract_1' }],
    );
    for (const entry of [...alone.changes, ...alone.destructive]) {
      expect(entry.warnings, entry.api_name).not.toContain(MIXED);
    }

    const withSetup = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [
        comp('OmniDataTransform', 'AccountSummaryExtract_1', extract),
        comp('PermissionSet', 'Summary_Access', '<PermissionSet/>'),
      ],
      [{ type: 'OmniDataTransform', api_name: 'OldSummaryExtract_1' }],
    );
    expect(withSetup.changes[0]!.warnings).toContain(MIXED);
    expect(withSetup.destructive[0]!.warnings).toContain(MIXED);
    // Said on the Data Mapper entries only.
    expect(withSetup.changes[1]!.warnings).not.toContain(MIXED);

    // A deletion of another type mixes the package too.
    const withDeletion = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('OmniDataTransform', 'AccountSummaryExtract_1', extract)],
      [{ type: 'CustomField', api_name: 'Account.Old_Region__c' }],
    );
    expect(withDeletion.changes[0]!.warnings).toContain(MIXED);
    expect(withDeletion.destructive[0]!.warnings).not.toContain(MIXED);

    // No Data Mapper, no advisory.
    const none = analyzeChanges(
      dbAdd,
      storeNone,
      conn,
      [comp('PermissionSet', 'Summary_Access', '<PermissionSet/>')],
      [{ type: 'CustomField', api_name: 'Account.Old_Region__c' }],
    );
    expect(JSON.stringify(none)).not.toContain('MIXED PACKAGE');
  });

  it('OmniDataTransform deliberately produces NO permission needs', () => {
    const res = analyzePermissionCoverage([
      comp('OmniDataTransform', 'AccountSummaryExtract_1', extract),
    ]);
    expect(res.uncovered).toHaveLength(0);
    expect(res.warning).toBeNull();
  });
});

describe('Deploy content is scanned in linear time (S47 review follow-up)', () => {
  // Each shape is about 1 MB of malformed markup an agent could hand
  // validate_deploy (readOldContent reads the snapshot copy instead). The
  // lazy patterns these sites used took seconds to minutes on such text,
  // blocking every tool on the server meanwhile: quadratic in openers with
  // no closer after them, cubic in the white space after an opener whose
  // value is not followed by its closer. Each shape must answer in well
  // under a second, and with the answer those patterns gave.
  const MB = 1_000_000;
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
  const dbAdd = { getArtifact: () => null } as unknown as ContrailDb;
  const storeNone = {
    readCurrentFile: () => null,
    listCurrentFiles: () => [],
  } as unknown as SnapshotStore;
  /** `unit` repeated to fill `bytes`. */
  const fill = (unit: string, bytes = MB) => unit.repeat(Math.floor(bytes / unit.length));
  /** An opener whose value is not followed by its closer: the next "<" opens another element. */
  const stuck = (tag: string) => `<${tag}>${' '.repeat(200)}x${' '.repeat(200)}<b/>`;
  const timed = <T>(run: () => T): [T, number] => {
    const started = performance.now();
    const answer = run();
    return [answer, performance.now() - started];
  };
  const fast = (what: string, took: number) =>
    expect(took, `${what}: ${Math.round(took)} ms`).toBeLessThan(1000);

  it('S34 <target>: values not followed by their closer, then the real one', () => {
    // The second shape packs the openers close together. The old pattern
    // was fast on it, but a reader that looked for the closer anywhere
    // after each opener would not be.
    const shapes: Array<[string, string]> = [
      ['values not followed by their closer', fill(stuck('target'))],
      ['openers packed close together', fill('<target>x<b/>')],
    ];
    for (const [what, decoys] of shapes) {
      const meta =
        '<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">' +
        '<bundleType>AGENT</bundleType>' +
        decoys +
        '<target> Bot.v2 </target></AiAuthoringBundle>';
      expect(meta.length, what).toBeGreaterThan(MB * 0.95);
      const files = {
        'My_Agent.agent': 'system:\n  instructions: |\n    Probe.\n',
        'My_Agent.bundle-meta.xml': meta,
      };
      const bundle = comp(
        'AiAuthoringBundle',
        'My_Agent',
        JSON.stringify({ contrail_bundle: 1, files }),
      );
      const [res, took] = timed(() => analyzeChanges(dbAdd, storeNone, conn, [bundle], []));
      expect(res.changes[0]!.warnings.join(' '), what).toContain(
        'pins this bundle to runtime version "Bot.v2";',
      );
      fast(what, took);
    }
  });

  it('S44 <testCase>: openers with no closer after one single-turn and one multi-turn case', () => {
    const suite =
      '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">' +
      '<testCase><number>1</number></testCase>' +
      '<testCase><conversationHistory><role>user</role></conversationHistory><number>2</number></testCase>' +
      fill('<testCase>');
    expect(suite.length).toBeGreaterThan(MB * 0.95);
    const [res, took] = timed(() =>
      analyzeChanges(dbAdd, storeNone, conn, [comp('AiTestingDefinition', 'Suite', suite)], []),
    );
    expect(res.changes[0]!.warnings.join(' ')).toContain(
      '1 case(s) carry <conversationHistory> and 1 do not.',
    );
    fast('testCase', took);
  });

  it('S33 credential principals: parameter blocks with no closer, and values not followed by their closer', () => {
    const shapes: Array<[string, string, string[]]> = [
      [
        'parameter blocks with no closer',
        '<ExternalCredential><externalCredentialParameters><parameterName>Basic</parameterName>' +
          '<parameterType>NamedPrincipal</parameterType></externalCredentialParameters>' +
          fill('<externalCredentialParameters>'),
        ['Cred-Basic'],
      ],
      [
        'values not followed by their closer',
        '<ExternalCredential><externalCredentialParameters>' +
          fill(stuck('parameterType'), MB / 2) +
          fill(stuck('parameterName'), MB / 2) +
          '<parameterName> Ops </parameterName><parameterType>PerUserPrincipal</parameterType>' +
          '</externalCredentialParameters></ExternalCredential>',
        ['Cred-Ops'],
      ],
    ];
    for (const [what, content, principals] of shapes) {
      expect(content.length, what).toBeGreaterThan(MB * 0.95);
      const [res, took] = timed(() =>
        analyzePermissionCoverage([comp('ExternalCredential', 'Cred', content)]),
      );
      expect(res.uncovered.map((u) => u.api_name), what).toEqual(principals);
      fast(what, took);
    }
  });

  it('S44 scorer versions: version blocks with no closer after the one kept', () => {
    const before =
      '<AiAgentScorerDefinition>' +
      '<scorerVersion><status>Available</status><versionNumber>1</versionNumber></scorerVersion>' +
      '<scorerVersion><status>Draft</status><versionNumber>2</versionNumber></scorerVersion>' +
      '</AiAgentScorerDefinition>';
    const proposed =
      '<AiAgentScorerDefinition>' +
      '<scorerVersion><status>Draft</status><versionNumber>1</versionNumber></scorerVersion>' +
      fill('<scorerVersion>');
    expect(proposed.length).toBeGreaterThan(MB * 0.95);
    const [warnings, took] = timed(() =>
      changeDependentWarnings({
        type: 'AiAgentScorerDefinition',
        api_name: 'Tone_Check',
        change: 'modify',
        proposed,
        before,
      }),
    );
    expect(warnings.join(' ')).toContain('(org-side versions omitted here: 2)');
    expect(warnings.join(' ')).toContain('(regressed here: 1 (Available → Draft))');
    fast('scorerVersion', took);
  });

  it('inline fields: field blocks with no closer after a real one', () => {
    const object =
      '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">' +
      '<fields><fullName>F__c</fullName><type>Text</type></fields>' +
      fill('<fields>');
    expect(object.length).toBeGreaterThan(MB * 0.95);
    const [res, took] = timed(() =>
      analyzePermissionCoverage([comp('CustomObject', 'Obj__c', object)]),
    );
    expect(res.uncovered.map((u) => `${u.type}:${u.api_name}`)).toEqual([
      'CustomObject:Obj__c',
      'CustomField:Obj__c.F__c',
    ]);
    fast('fields', took);
  });

  it('permission blocks: grant blocks with no closer after the grant that covers', () => {
    const ps =
      '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">' +
      '<fieldPermissions><editable>false</editable><field>Obj__c.F__c</field>' +
      '<readable>true</readable></fieldPermissions>' +
      fill('<fieldPermissions>') +
      '</PermissionSet>';
    expect(ps.length).toBeGreaterThan(MB * 0.95);
    const field = '<fields><fullName>F__c</fullName><type>Text</type></fields>';
    const [res, took] = timed(() =>
      analyzePermissionCoverage([
        comp('CustomField', 'Obj__c.F__c', field),
        comp('PermissionSet', 'Ops', ps),
      ]),
    );
    expect(res.uncovered).toEqual([]);
    fast('fieldPermissions', took);
  });

  it('tab visibility: values not followed by their closer, then the real one', () => {
    // Upper-case tags on purpose: the visibility pattern was case-insensitive.
    // The real Hidden tag is upper-case too, so a reader that ignored case
    // would miss it and wrongly count the tab as visible.
    const shapes: Array<[string, string, string[]]> = [
      ['Hidden', 'VISIBILITY', ['Obj__c']],
      ['DefaultOn', 'visibility', []],
    ];
    for (const [visibility, tag, uncovered] of shapes) {
      const ps =
        '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><tabSettings><tab>Obj__c</tab>' +
        fill(stuck('VISIBILITY')) +
        `<${tag}>${visibility}</${tag}></tabSettings></PermissionSet>`;
      expect(ps.length, visibility).toBeGreaterThan(MB * 0.95);
      const [res, took] = timed(() =>
        analyzePermissionCoverage([
          comp('CustomTab', 'Obj__c', '<CustomTab/>'),
          comp('PermissionSet', 'Ops', ps),
        ]),
      );
      expect(res.uncovered.map((u) => u.api_name), visibility).toEqual(uncovered);
      fast(visibility, took);
    }
  });

  it('readOldContent: child blocks with no closer after the one asked for', () => {
    const block = '<fields><fullName>F__c</fullName><type>Text</type></fields>';
    const file =
      '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">' + block + fill('<fields>');
    expect(file.length).toBeGreaterThan(MB * 0.95);
    const store = { readCurrentFile: () => file } as unknown as SnapshotStore;
    const [old, took] = timed(() =>
      readOldContent(store, conn, 'CustomField', 'Obj__c.F__c', 'objects/Obj__c.object'),
    );
    expect(old).toBe(block);
    fast('readOldContent', took);
  });

  it('the readers answer what the patterns they replace did, edge cases included', () => {
    // The patterns are the reference. These inputs exercise the rules the
    // readers' comments name: an opener counts only if the next "<" begins
    // its closer, an empty value is passed over unless emptyOk, a value of
    // white space alone answers its last character, and only ASCII letters
    // fold under ignoreCase.
    const inputs = [
      '',
      '<t>x</t>',
      '<t> x y </t>',
      '<t></t><t>x</t>',
      '<t>\t \n</t>',
      '<t>\t \n</t><t>x</t>',
      '<t>\u00a0\u2028x\ufeff</t>',
      '<t>\u200bx\u200b</t>',
      '<t>x<b/></t><t>y</t>',
      '<t>x',
      '<t><t>x</t>',
      '<T>v</T><t>w</t>',
      '<t>a</T><T>b</t>',
      '<tx>a</tx><t>b</t>',
      '<t>a</t><t>b</t>z<t>c',
      '<t>ſ</t>',
    ];
    for (const s of inputs) {
      const at = JSON.stringify(s);
      expect(xmlBlocks(s, 't'), at).toEqual(s.match(/<t>[\s\S]*?<\/t>/g) ?? []);
      expect(withoutXmlBlocks(s, 't'), at).toBe(s.replace(/<t>[\s\S]*?<\/t>/g, ''));
      expect(xmlTagValue(s, 't'), at).toBe(s.match(/<t>\s*([^<]+?)\s*<\/t>/)?.[1]);
      expect(xmlTagValue(s, 't', { emptyOk: true }), at).toBe(
        s.match(/<t>\s*([^<]*?)\s*<\/t>/)?.[1],
      );
      expect(xmlTagValue(s, 't', { ignoreCase: true }), at).toBe(
        s.match(/<t>\s*([^<]+?)\s*<\/t>/i)?.[1],
      );
      expect(xmlTagValue(s, 't', { emptyOk: true, ignoreCase: true }), at).toBe(
        s.match(/<t>\s*([^<]*?)\s*<\/t>/i)?.[1],
      );
    }
    // The same rules, spelled out.
    expect(xmlTagValue('<t>\t \n</t>', 't')).toBe('\n');
    expect(xmlTagValue('<t>\t \n</t>', 't', { emptyOk: true })).toBe('');
    expect(xmlTagValue('<t></t><t>x</t>', 't')).toBe('x');
    expect(xmlTagValue('<t></t><t>x</t>', 't', { emptyOk: true })).toBe('');
    expect(xmlTagValue('<T>v</T>', 't')).toBeUndefined();
    expect(xmlTagValue('<T>v</T>', 't', { ignoreCase: true })).toBe('v');
  });
});

describe('Permission coverage, c: references and child blocks in linear time (slow-path follow-up)', () => {
  // Each shape is about 1 MB: a large but legitimate package, or markup an
  // agent could hand validate_deploy. The code these sites used took seconds
  // on such input (needs × grants, a rescan per opener with no closer, an
  // index lookup per token), and it runs synchronously, so every tool on the
  // server waited. Each must answer in well under a second, and with the
  // answer that code gave.
  const MB = 1_000_000;
  const conn = { id: 'conn-1', alias: 'dev' } as ConnectionRecord;
  const storeNone = {
    readCurrentFile: () => null,
    listCurrentFiles: () => [],
  } as unknown as SnapshotStore;
  /** `unit` repeated to fill `bytes`. */
  const fill = (unit: string, bytes = MB) => unit.repeat(Math.floor(bytes / unit.length));
  const timed = <T>(run: () => T): [T, number] => {
    const started = performance.now();
    const answer = run();
    return [answer, performance.now() - started];
  };
  const fast = (what: string, took: number) =>
    expect(took, `${what}: ${Math.round(took)} ms`).toBeLessThan(1000);
  const uncoveredNames = (components: ProposedComponent[]) =>
    analyzePermissionCoverage(components).uncovered.map((u) => `${u.type}:${u.api_name}`);

  it('permission coverage: an 800-field object against a 7,000-grant profile', () => {
    // An admin profile granting fields on 40 objects, 20 of them on this
    // object's fields; one more grant spelled in another case inside white
    // space, one under a capitalised tag, and one switched off.
    const fields = Array.from(
      { length: 800 },
      (_, i) => `<fields><fullName>F${i}__c</fullName><type>Text</type><length>80</length></fields>`,
    ).join('\n');
    const grants = [
      ...Array.from(
        { length: 7000 },
        (_, i) =>
          `<fieldPermissions><editable>true</editable><field>Obj${i % 40}__c.F${i}__c</field>` +
          '<readable>true</readable></fieldPermissions>',
      ),
      '<fieldPermissions><field> obj0__c.f1__c </field><readable>TRUE</readable></fieldPermissions>',
      '<fieldPermissions><FIELD>Obj0__c.F3__c</FIELD><readable>true</readable></fieldPermissions>',
      '<fieldPermissions><field>Obj0__c.F7__c</field><readable>false</readable></fieldPermissions>',
      ...Array.from(
        { length: 3000 },
        () => '<userPermissions><enabled>true</enabled><name>ApiEnabled</name></userPermissions>',
      ),
    ].join('\n');
    const components = [
      comp('CustomObject', 'Obj0__c', `<CustomObject>${fields}</CustomObject>`),
      comp('Profile', 'Admin', `<Profile>${grants}</Profile>`),
    ];
    expect(components[1]!.content.length).toBeGreaterThan(MB);
    const [uncovered, took] = timed(() => uncoveredNames(components));
    // 800 fields less 22 granted, plus the object itself.
    expect(uncovered).toHaveLength(779);
    expect(uncovered).toContain('CustomObject:Obj0__c');
    expect(uncovered).toContain('CustomField:Obj0__c.F7__c');
    for (const granted of ['F0', 'F1', 'F3', 'F40', 'F760']) {
      expect(uncovered).not.toContain(`CustomField:Obj0__c.${granted}__c`);
    }
    fast('800 fields against 7,000 grants', took);
  });

  it('permission coverage: a grant block packed with name openers that never close', () => {
    const block =
      '<fieldPermissions><field>Obj__c.F0__c</field>' +
      fill('<field>x<b/>') +
      '<readable>true</readable></fieldPermissions>';
    const components = [
      ...Array.from({ length: 2000 }, (_, i) => comp('CustomField', `Obj__c.F${i}__c`, '')),
      comp('PermissionSet', 'PS', `<PermissionSet>${block}</PermissionSet>`),
    ];
    const [uncovered, took] = timed(() => uncoveredNames(components));
    expect(uncovered).toHaveLength(1999);
    expect(uncovered).not.toContain('CustomField:Obj__c.F0__c');
    fast('2,000 needs against a block of about 83,000 openers', took);
  });

  it('permission coverage: one grant block naming 20,000 fields', () => {
    // Every need's own pattern, run over the one block from its start,
    // reached half the block on average: quadratic. A plain API name is
    // answered by the index alone.
    const block =
      '<fieldPermissions>' +
      Array.from({ length: 20_000 }, (_, i) => `<field>Obj__c.F${i}__c</field>`).join('') +
      '<readable>true</readable></fieldPermissions>';
    const fields = Array.from(
      { length: 20_001 },
      (_, i) => `<fields><fullName>F${i}__c</fullName></fields>`,
    ).join('');
    const components = [
      comp('CustomObject', 'Obj__c', `<CustomObject>${fields}</CustomObject>`),
      comp('PermissionSet', 'PS', `<PermissionSet>${block}</PermissionSet>`),
    ];
    const [uncovered, took] = timed(() => uncoveredNames(components));
    expect(uncovered).toEqual(['CustomObject:Obj__c', 'CustomField:Obj__c.F20000__c']);
    fast('20,000 needs against one block naming them all', took);
  });

  it('Aura controllers: 49 bundles against a 12,000-grant permission set', () => {
    // The controller advisory walked every grant block, building a pattern
    // for each, once per bundle; it now asks the package's grant index. A
    // package holds at most 50 components, so that cost stayed bounded
    // (about 0.24 s for this shape, against about 0.04 s now): the time
    // check cannot tell them apart. What this test pins is the answer.
    const auraMeta =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<AuraDefinitionBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
      '    <apiVersion>66.0</apiVersion>\n</AuraDefinitionBundle>\n';
    const bundles = Array.from({ length: 49 }, (_, i) =>
      comp(
        'AuraDefinitionBundle',
        `pop${i}`,
        JSON.stringify({
          contrail_bundle: 1,
          files: {
            [`pop${i}.cmp`]: `<aura:component controller="Ctl${i}"/>`,
            [`pop${i}.cmp-meta.xml`]: auraMeta,
          },
        }),
      ),
    );
    // Ctl0 … Ctl24 granted (one of them in another case), the rest not.
    const grants = Array.from(
      { length: 12_000 },
      (_, i) =>
        `<classAccesses><apexClass>${i === 3 ? 'CTL3' : `Ctl${i < 25 ? i : i + 1000}`}</apexClass>` +
        '<enabled>true</enabled></classAccesses>',
    ).join('');
    expect(grants.length).toBeGreaterThan(MB * 0.95);
    const dbNone = { getArtifact: () => null, edgesTo: () => [] } as unknown as ContrailDb;
    const [res, took] = timed(() =>
      analyzeChanges(
        dbNone,
        storeNone,
        conn,
        [...bundles, comp('PermissionSet', 'PS', `<PermissionSet>${grants}</PermissionSet>`)],
        [],
      ),
    );
    const warned = res.changes
      .filter((c) => c.warnings.some((w) => w.startsWith('server-side controller')))
      .map((c) => c.api_name);
    expect(warned).toEqual(Array.from({ length: 24 }, (_, i) => `pop${i + 25}`));
    fast('49 controllers against 12,000 grants', took);
  });

  it('permission coverage answers what the per-need pattern did, case folding included', () => {
    // The pattern every grant was tested with, run here as the reference.
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reference = (permissionSet: string, name: string) =>
      xmlBlocks(permissionSet, 'customPermissions').some(
        (b) =>
          new RegExp(`<name>\\s*${esc(name)}\\s*</name>`, 'i').test(b) &&
          /<enabled>\s*true\s*<\/enabled>/i.test(b),
      );
    const coveredBy = (granted: string, needed: string) =>
      analyzePermissionCoverage([
        comp('CustomPermission', needed, ''),
        comp(
          'PermissionSet',
          'PS',
          `<customPermissions><enabled>true</enabled><name>${granted}</name></customPermissions>`,
        ),
      ]).uncovered.length === 0;
    // [the name a grant carries, the name the package needs]
    const pairs: Array<[string, string]> = [
      ['Perm_A', 'PERM_a'],
      ['é', 'É'],
      ['µ', 'μ'],
      ['ı', 'I'],
      ['I', 'ı'],
      ['ſ', 's'],
      ['\u212a', 'k'],
      ['ß', 'ẞ'],
      ['Cred-', 'Cred-\n'],
      ['Cred-\n\n', 'Cred-\n'],
      [' \t', '\t'],
      ['a<b', 'a<b'],
      ['x y', 'X Y'],
      ['x  y', 'x y'],
    ];
    for (const [granted, needed] of pairs) {
      const ps = `<customPermissions><enabled>true</enabled><name>${granted}</name></customPermissions>`;
      expect(coveredBy(granted, needed), JSON.stringify([granted, needed])).toBe(
        reference(ps, needed),
      );
    }
    // Some of those answers, spelled out: the i flag is not a plain
    // case-insensitive compare.
    expect(coveredBy('µ', 'μ')).toBe(true);
    expect(coveredBy('ı', 'I')).toBe(false);
    expect(coveredBy('ſ', 's')).toBe(false);
    expect(coveredBy('\u212a', 'k')).toBe(false);
    expect(coveredBy('Cred-', 'Cred-\n')).toBe(false);
    expect(coveredBy('Cred-\n\n', 'Cred-\n')).toBe(true);
    expect(coveredBy('a<b', 'a<b')).toBe(true);
  });

  it('c: references: 1 MB of names missing from the index, of one name it holds, and of its spellings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-crefs-'));
    const db = new ContrailDb(join(dir, 'test.db'));
    try {
      db.replaceArtifactsForTypes(
        conn.id,
        ['LightningComponentBundle'],
        ['navCard', 'navigationCardPanel'].map((apiName) => ({
          connectionId: conn.id,
          type: 'LightningComponentBundle',
          apiName,
          filePath: `lwc/${apiName}/${apiName}.js`,
          contentHash: 'h',
          lastModifiedDate: null,
          lastModifiedBy: null,
          retrievedAt: '2026-11-21T00:00:00.000Z',
          content: '',
        })),
      );
      // A real index, so each lookup costs what it costs in a validate.
      let lookups = 0;
      const counted = {
        getArtifact: (connectionId: string, type: string, apiName: string) => {
          lookups += 1;
          return db.getArtifact(connectionId, type, apiName);
        },
      } as unknown as ContrailDb;
      const page = (body: string) => comp('FlexiPage', 'Home', `<FlexiPage>${body}</FlexiPage>`);

      const distinct = Array.from({ length: 95_000 }, (_, i) => `c:Cmp${i}`).join(' ');
      expect(distinct.length).toBeGreaterThan(MB);
      const [missing, t1] = timed(() =>
        analyzeChanges(counted, storeNone, conn, [page(distinct)], []),
      );
      expect(missing.changes[0]!.warnings.join(' ')).toContain(
        'references Cmp0, Cmp1, Cmp2, Cmp3, Cmp4 (c: namespace)',
      );
      expect(lookups).toBeLessThan(20);
      fast('95,000 distinct names missing from the index', t1);

      lookups = 0;
      const [held, t2] = timed(() =>
        analyzeChanges(counted, storeNone, conn, [page(fill('c:navCard '))], []),
      );
      expect(held.changes[0]!.warnings.join(' ')).not.toContain('(c: namespace)');
      expect(lookups).toBeLessThan(20);
      fast('100,000 references to one name the index holds', t2);

      // 45,000 different spellings of one name the index holds: its lookup
      // ignores case, so they share one answer.
      const base = 'navigationCardPanel';
      const spellings = Array.from({ length: 45_000 }, (_, i) =>
        [...base].map((ch, j) => ((i >> j) & 1 ? ch.toUpperCase() : ch.toLowerCase())).join(''),
      );
      expect(new Set(spellings).size).toBe(45_000);
      lookups = 0;
      const [spelled, t3] = timed(() =>
        analyzeChanges(
          counted,
          storeNone,
          conn,
          [page(spellings.map((s) => `c:${s}`).join(' '))],
          [],
        ),
      );
      expect(spelled.changes[0]!.warnings.join(' ')).not.toContain('(c: namespace)');
      expect(lookups).toBeLessThan(20);
      fast('45,000 spellings of one name the index holds', t3);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('child blocks: openers packed close together with no closer after a real block', () => {
    const real = '<fields><fullName>Real__c</fullName></fields>';
    const xml = real + fill('<fields>');
    const [blocks, t1] = timed(() => extractChildBlocks(xml, 'fields'));
    expect(blocks).toEqual([real]);
    fast('extractChildBlocks', t1);
    const [found, t2] = timed(() => findChildBlock(xml, 'fields', 'real__c'));
    expect(found).toBe(real);
    fast('findChildBlock', t2);
    const [names, t3] = timed(() => childBlockNames(xml, 'fields'));
    expect([...names]).toEqual(['real__c']);
    fast('childBlockNames', t3);
  });

  it('the new readers answer what the patterns they replace did, edge cases included', () => {
    const inputs = [
      '',
      '<t>',
      '<t>a</t>',
      '<t>a</t><t>b</t>',
      '<t><t>a</t>',
      '<t>a<b/></t><t>c</t>',
      '<T>v</T><t>w</t>',
      '<t>a</T><T>b</t>',
      '<tx>a</tx><t>b</t>',
      '<t> </t>',
      '<t></t>',
      '<t>a</t>z<t>c',
      '</t><t>x</t>',
      '<t>ſ</t><T>K</T>',
    ];
    for (const s of inputs) {
      const at = JSON.stringify(s);
      expect(xmlBlockText(s, 't'), at).toBe(s.match(/<t>([\s\S]*?)<\/t>/)?.[1]);
      expect(xmlTagTexts(s, 't'), at).toEqual([...s.matchAll(/<t>([^<]*)<\/t>/g)].map((m) => m[1]));
      expect(xmlTagTexts(s, 't', { ignoreCase: true }), at).toEqual(
        [...s.matchAll(/<t>([^<]*)<\/t>/gi)].map((m) => m[1]),
      );
      expect(extractChildBlocks(s, 't'), at).toEqual(s.match(/<t>[\s\S]*?<\/t>/g) ?? []);
    }
    // childBlockNames answers findChildBlock's question, for every name.
    const doc =
      '<f><fullName>A</fullName></f><f><fullName> b </fullName></f>' +
      '<f><fullName></fullName><fullName>C</fullName></f><f><label>x</label></f>' +
      '<f><fullName>   </fullName></f><f><fullName>D</fullName>';
    const names = childBlockNames(doc, 'f');
    for (const q of ['a', 'A', 'b', ' b ', 'c', 'C', 'x', '', ' ', 'd']) {
      expect(names.has(q.toLowerCase()), JSON.stringify(q)).toBe(
        findChildBlock(doc, 'f', q) !== null,
      );
    }
  });
});
