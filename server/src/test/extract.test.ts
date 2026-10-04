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

describe('S29: report & dashboard extractors', () => {
  it('Report → its ReportType; Dashboard → its folder-qualified reports', async () => {
    const { extractReportRefs, extractDashboardRefs } = await import('../deps/extract.js');
    const reportRefs = extractReportRefs(
      '<Report><reportType>Invoices_with_Accounts</reportType><name>Weekly</name></Report>',
    );
    expect(reportRefs).toEqual([
      { toType: 'ReportType', toName: 'Invoices_with_Accounts' },
    ]);

    const dashRefs = extractDashboardRefs(
      '<Dashboard><leftSection><components><report>Ops/Weekly</report></components>' +
        '<components><report>Sales/Pipeline</report></components></leftSection>' +
        '<rightSection><components><report>Ops/Weekly</report></components></rightSection></Dashboard>',
    );
    expect(dashRefs).toEqual([
      { toType: 'Report', toName: 'Ops/Weekly' },
      { toType: 'Report', toName: 'Sales/Pipeline' },
    ]);
  });

  it('indexed foldered artifacts produce joinable edges through extractAllEdges', () => {
    const files = new Map(
      Object.entries({
        'reports/Ops/Weekly.report': strToU8(
          '<Report><reportType>Invoices_with_Accounts</reportType></Report>',
        ),
        'dashboards/Exec/Overview.dashboard': strToU8(
          '<Dashboard><components><report>Ops/Weekly</report></components></Dashboard>',
        ),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-09-08T00:00:00.000Z');
    const edges = extractAllEdges('conn1', artifacts);
    const keys = edges.map((e) => `${e.fromType}:${e.fromName}>${e.toType}:${e.toName}`);
    expect(keys).toContain('Report:Ops/Weekly>ReportType:Invoices_with_Accounts');
    // The dashboard edge's toName is the folder-qualified index key — joinable.
    expect(keys).toContain('Dashboard:Exec/Overview>Report:Ops/Weekly');
  });
});

describe('S30: agent-graph extractors', () => {
  it('topic → actions, planner bundle → topics + actions, bot → planner', async () => {
    const { extractGenAiPluginRefs, extractGenAiPlannerRefs, extractBotRefs } = await import(
      '../deps/extract.js'
    );
    expect(
      extractGenAiPluginRefs(
        '<GenAiPlugin><genAiFunctions><functionName>Get_Status</functionName></genAiFunctions>' +
          '<genAiFunctions><functionName>Create_Case</functionName></genAiFunctions></GenAiPlugin>',
      ),
    ).toEqual([
      { toType: 'GenAiFunction', toName: 'Get_Status' },
      { toType: 'GenAiFunction', toName: 'Create_Case' },
    ]);

    expect(
      extractGenAiPlannerRefs(
        '<GenAiPlannerBundle><localTopicLinks><genAiPluginName>Orders</genAiPluginName></localTopicLinks>' +
          '<localTopics><genAiFunctions><functionName>Get_Status</functionName></genAiFunctions></localTopics>' +
          '</GenAiPlannerBundle>',
      ),
    ).toEqual([
      { toType: 'GenAiPlugin', toName: 'Orders' },
      { toType: 'GenAiFunction', toName: 'Get_Status' },
    ]);

    expect(
      extractBotRefs(
        '<Bot><botVersions><conversationDefinitionPlanners>' +
          '<genAiPlannerName>Agent_v4</genAiPlannerName>' +
          '</conversationDefinitionPlanners></botVersions></Bot>',
      ),
    ).toEqual([{ toType: 'GenAiPlannerBundle', toName: 'Agent_v4' }]);
  });

  it('indexed agent artifacts produce joinable edges through extractAllEdges', () => {
    const files = new Map(
      Object.entries({
        'bots/Support.bot': strToU8(
          '<Bot><botVersions><fullName>v1</fullName><conversationDefinitionPlanners>' +
            '<genAiPlannerName>Support_v1</genAiPlannerName></conversationDefinitionPlanners>' +
            '</botVersions></Bot>',
        ),
        'genAiPlugins/Orders.genAiPlugin': strToU8(
          '<GenAiPlugin><genAiFunctions><functionName>Get_Status</functionName></genAiFunctions></GenAiPlugin>',
        ),
        'genAiPlannerBundles/Support_v1/Support_v1.genAiPlannerBundle': strToU8(
          '<GenAiPlannerBundle><localTopicLinks><genAiPluginName>Orders</genAiPluginName></localTopicLinks></GenAiPlannerBundle>',
        ),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-09-10T00:00:00.000Z');
    const edges = extractAllEdges('conn1', artifacts);
    const keys = edges.map((e) => `${e.fromType}:${e.fromName}>${e.toType}:${e.toName}`);
    expect(keys).toContain('Bot:Support>GenAiPlannerBundle:Support_v1');
    expect(keys).toContain('GenAiPlannerBundle:Support_v1>GenAiPlugin:Orders');
    expect(keys).toContain('GenAiPlugin:Orders>GenAiFunction:Get_Status');
  });
});

describe('S33: credential-family extractors', () => {
  it('NamedCredential → ExternalCredential + AuthProvider; ExternalCredential → AuthProvider', async () => {
    const { extractNamedCredentialRefs, extractExternalCredentialRefs } = await import(
      '../deps/extract.js'
    );
    // Live-confirmed shape: the Authentication parameter names the external
    // credential; legacy NCs carry a top-level authProvider instead.
    const nc = extractNamedCredentialRefs(
      '<NamedCredential><namedCredentialParameters><externalCredential>Billing_Auth</externalCredential>' +
        '<parameterName>ExternalCredential</parameterName><parameterType>Authentication</parameterType>' +
        '</namedCredentialParameters><authProvider>Acme_SSO</authProvider></NamedCredential>',
    );
    const ncKeys = nc.map((r) => `${r.toType}:${r.toName}`).sort();
    expect(ncKeys).toEqual(['AuthProvider:Acme_SSO', 'ExternalCredential:Billing_Auth']);

    const ec = extractExternalCredentialRefs(
      '<ExternalCredential><externalCredentialParameters><authProvider>Acme_SSO</authProvider>' +
        '<parameterType>AuthProvider</parameterType></externalCredentialParameters></ExternalCredential>',
    );
    expect(ec.map((r) => `${r.toType}:${r.toName}`)).toEqual(['AuthProvider:Acme_SSO']);
  });

  it("Apex callout:Name references survive string-literal stripping", async () => {
    const { extractApexRefs, buildKnownArtifacts } = await import('../deps/extract.js');
    const body =
      "public class BillingClient {\n" +
      "  void call() {\n" +
      "    HttpRequest r = new HttpRequest();\n" +
      "    r.setEndpoint('callout:Billing_API/v2/invoices');\n" +
      "  }\n" +
      "}";
    const refs = extractApexRefs(body, buildKnownArtifacts([]), 'BillingClient');
    expect(refs.map((r) => `${r.toType}:${r.toName}`)).toContain('NamedCredential:Billing_API');
  });

  it('indexed credential artifacts produce joinable edges through extractAllEdges', () => {
    const files = new Map(
      Object.entries({
        'namedCredentials/Billing_API.namedCredential': strToU8(
          '<NamedCredential><namedCredentialParameters><externalCredential>Billing_Auth</externalCredential>' +
            '<parameterName>ExternalCredential</parameterName><parameterType>Authentication</parameterType>' +
            '</namedCredentialParameters></NamedCredential>',
        ),
        'externalCredentials/Billing_Auth.externalCredential': strToU8(
          '<ExternalCredential><externalCredentialParameters><authProvider>Acme_SSO</authProvider>' +
            '</externalCredentialParameters></ExternalCredential>',
        ),
        'authproviders/Acme_SSO.authprovider': strToU8('<AuthProvider/>'),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-09-24T00:00:00.000Z');
    const edges = extractAllEdges('conn1', artifacts);
    const keys = edges.map((e) => `${e.fromType}:${e.fromName}>${e.toType}:${e.toName}`);
    expect(keys).toContain('NamedCredential:Billing_API>ExternalCredential:Billing_Auth');
    expect(keys).toContain('ExternalCredential:Billing_Auth>AuthProvider:Acme_SSO');
  });
});

describe('S36: permission & UI-action extractors', () => {
  it('PermissionSet customPermissions blocks → CustomPermission edges', async () => {
    const { extractPermissionSetRefs } = await import('../deps/extract.js');
    const refs = extractPermissionSetRefs(
      '<PermissionSet><customPermissions><enabled>true</enabled>' +
        '<name>Can_Approve_Refunds</name></customPermissions>' +
        '<customPermissions><enabled>false</enabled><name>Can_See_Costs</name>' +
        '</customPermissions></PermissionSet>',
    );
    const keys = refs.map((r) => `${r.toType}:${r.toName}`);
    // The dependency exists whether or not the grant is enabled.
    expect(keys).toContain('CustomPermission:Can_Approve_Refunds');
    expect(keys).toContain('CustomPermission:Can_See_Costs');
  });

  it('PermissionSetGroup → member and muted permission sets (its own root element)', async () => {
    const { extractPermissionSetGroupRefs } = await import('../deps/extract.js');
    // Live-confirmed tag and element order: mutingPermissionSets (not
    // "muted…") precedes permissionSets in the WSDL sequence.
    const refs = extractPermissionSetGroupRefs(
      '<PermissionSetGroup><label>Support</label>' +
        '<mutingPermissionSets>Support_Mutes</mutingPermissionSets>' +
        '<permissionSets>Support_Base</permissionSets>' +
        '<permissionSets>Refund_Access</permissionSets>' +
        '<status>Updated</status></PermissionSetGroup>',
    );
    const keys = refs.map((r) => `${r.toType}:${r.toName}`).sort();
    expect(keys).toEqual([
      'MutingPermissionSet:Support_Mutes',
      'PermissionSet:Refund_Access',
      'PermissionSet:Support_Base',
    ]);
  });

  it('QuickAction → flow / LWC / page targets and its dotted __c parent', async () => {
    const { extractQuickActionRefs } = await import('../deps/extract.js');
    const flowAction = extractQuickActionRefs(
      '<QuickAction><type>Flow</type><flowDefinition>Refund_Wizard</flowDefinition></QuickAction>',
      'Invoice__c.Start_Refund',
    );
    const flowKeys = flowAction.map((r) => `${r.toType}:${r.toName}`).sort();
    expect(flowKeys).toEqual(['CustomObject:Invoice__c', 'Flow:Refund_Wizard']);

    const lwcAction = extractQuickActionRefs(
      '<QuickAction><type>LightningWebComponent</type>' +
        '<lightningWebComponent>refundPanel</lightningWebComponent></QuickAction>',
      'Account.Open_Refunds',
    );
    // Standard parents (Account) never join the index — object edge only
    // for __c parents.
    expect(lwcAction.map((r) => `${r.toType}:${r.toName}`)).toEqual([
      'LightningComponentBundle:refundPanel',
    ]);

    const vfAction = extractQuickActionRefs(
      '<QuickAction><type>VisualforcePage</type><page>Refund_Portal</page></QuickAction>',
      'Global_Refund',
    );
    expect(vfAction.map((r) => `${r.toType}:${r.toName}`)).toEqual(['ApexPage:Refund_Portal']);
  });

  it('LWC bundle content → imports, composition tags, and @salesforce module refs', async () => {
    const { extractLwcRefs } = await import('../deps/extract.js');
    // Shaped like the indexer's concatenated bundle content; every pattern
    // below was observed in a real org's bundles (live corpus, 2026-10-02).
    const content =
      '<!-- contrail:file lwc/refundPanel/refundPanel.js -->\n' +
      "import { LightningElement } from 'lwc';\n" +
      "import { reduceErrors } from 'c/ldsUtils';\n" +
      'import getRefunds from "@salesforce/apex/RefundController.getRefunds";\n' +
      "import CAN_APPROVE from '@salesforce/customPermission/Can_Approve_Refunds';\n" +
      "import NAME_FIELD from '@salesforce/schema/Invoice__c.Name__c';\n" +
      // Relationship traversal pins the OBJECT only — never a bogus
      // Invoice__c.Account__r "field".
      'import ACCT_NAME from "@salesforce/schema/Invoice__c.Account__r.Name";\n' +
      "import greeting from '@salesforce/label/c.Refund_Greeting';\n" +
      "import channel from '@salesforce/messageChannel/RefundSelected__c';\n" +
      'const dyn = import("c/refundChart");\n' +
      '<!-- contrail:file lwc/refundPanel/refundPanel.html -->\n' +
      '<template><c-error-panel></c-error-panel><c-paginator></c-paginator>' +
      '<c-fsc_flow-picker3></c-fsc_flow-picker3></template>\n';
    const keys = extractLwcRefs(content).map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toContain('LightningComponentBundle:ldsUtils');
    // Underscores are legal in component names and survive the kebab→camel
    // join (digits too).
    expect(keys).toContain('LightningComponentBundle:fsc_flowPicker3');
    expect(keys).toContain('LightningComponentBundle:refundChart');
    expect(keys).toContain('LightningComponentBundle:errorPanel');
    expect(keys).toContain('LightningComponentBundle:paginator');
    expect(keys).toContain('ApexClass:RefundController');
    expect(keys).toContain('CustomPermission:Can_Approve_Refunds');
    expect(keys).toContain('CustomObject:Invoice__c');
    expect(keys).toContain('CustomField:Invoice__c.Name__c');
    expect(keys).toContain('CustomLabel:Refund_Greeting');
    expect(keys.some((k) => k.includes('Account__r'))).toBe(false);
    // messageChannel/resourceUrl types are unregistered — no edges.
    expect(keys.some((k) => k.includes('RefundSelected'))).toBe(false);
  });

  it('checkPermission and $Permission references resolve from the RAW bodies', async () => {
    const { extractApexRefs, extractObjectXmlRefs, extractFlowRefs, buildKnownArtifacts } =
      await import('../deps/extract.js');
    // The permission name is a string literal — blanked by the Apex noise
    // stripper, so the scan runs on the raw body (callout: precedent).
    const apex = extractApexRefs(
      'public class RefundService {\n' +
        '  Boolean ok = FeatureManagement.checkPermission(\'Can_Approve_Refunds\');\n' +
        '}',
      buildKnownArtifacts([]),
      'RefundService',
    );
    expect(apex.map((r) => `${r.toType}:${r.toName}`)).toContain(
      'CustomPermission:Can_Approve_Refunds',
    );

    const vr = extractObjectXmlRefs(
      '<ValidationRule><errorConditionFormula>NOT($Permission.Can_Approve_Refunds)' +
        '</errorConditionFormula></ValidationRule>',
      'Invoice__c',
      buildKnownArtifacts([]),
    );
    expect(vr.map((r) => `${r.toType}:${r.toName}`)).toContain(
      'CustomPermission:Can_Approve_Refunds',
    );

    const flow = extractFlowRefs(
      '<Flow><decisions><rules><conditions><leftValueReference>' +
        '$Permission.Can_Approve_Refunds</leftValueReference></conditions></rules>' +
        '</decisions></Flow>',
    );
    expect(flow.map((r) => `${r.toType}:${r.toName}`)).toContain(
      'CustomPermission:Can_Approve_Refunds',
    );
  });

  it('indexed S36 artifacts produce joinable edges through extractAllEdges', () => {
    const files = new Map(
      Object.entries({
        'permissionsets/Refund_Access.permissionset': strToU8(
          '<PermissionSet><customPermissions><enabled>true</enabled>' +
            '<name>Can_Approve_Refunds</name></customPermissions></PermissionSet>',
        ),
        'permissionsetgroups/Support_Agents.permissionsetgroup': strToU8(
          '<PermissionSetGroup><permissionSets>Refund_Access</permissionSets></PermissionSetGroup>',
        ),
        'customPermissions/Can_Approve_Refunds.customPermission': strToU8('<CustomPermission/>'),
        'quickActions/Account.Open_Refunds.quickAction': strToU8(
          '<QuickAction><lightningWebComponent>refundPanel</lightningWebComponent></QuickAction>',
        ),
        'lwc/refundPanel/refundPanel.js': strToU8("import { reduceErrors } from 'c/ldsUtils';"),
        'lwc/refundPanel/refundPanel.js-meta.xml': strToU8('<LightningComponentBundle/>'),
        'lwc/ldsUtils/ldsUtils.js': strToU8('export function reduceErrors() {}'),
        'lwc/ldsUtils/ldsUtils.js-meta.xml': strToU8('<LightningComponentBundle/>'),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-10-02T00:00:00.000Z');
    const edges = extractAllEdges('conn1', artifacts);
    const keys = edges.map((e) => `${e.fromType}:${e.fromName}>${e.toType}:${e.toName}`);
    expect(keys).toContain('PermissionSet:Refund_Access>CustomPermission:Can_Approve_Refunds');
    expect(keys).toContain('PermissionSetGroup:Support_Agents>PermissionSet:Refund_Access');
    // Dotted QuickAction fromName joins the dotted index key.
    expect(keys).toContain(
      'QuickAction:Account.Open_Refunds>LightningComponentBundle:refundPanel',
    );
    expect(keys).toContain(
      'LightningComponentBundle:refundPanel>LightningComponentBundle:ldsUtils',
    );
  });
});
