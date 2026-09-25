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
