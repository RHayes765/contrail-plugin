import { describe, expect, it } from 'vitest';
import {
  buildKnownArtifacts,
  extractAiEvaluationDefinitionRefs,
  extractAiTestingDefinitionRefs,
  extractApexRefs,
  extractFlowRefs,
  extractObjectXmlRefs,
  extractPermissionSetRefs,
  extractAllEdges,
  type KnownArtifacts,
} from '../deps/extract.js';
import { isStudioCatalogScorer } from '../core/agentforceScorers.js';
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
    // S41: c:-reference resolution maps.
    aura: new Map([['voicecallpop', 'voiceCallPop'], ['navhelper', 'navHelper']]),
    lwc: new Map([['refundpanel', 'refundPanel']]),
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

describe('S41: Aura edges', () => {
  it('extractAuraRefs: markup, wiring, controller, design, labels — resolved by kind', async () => {
    const { extractAuraRefs } = await import('../deps/extract.js');
    const content = [
      '<!-- contrail:file aura/hostCmp/hostCmp.cmp -->',
      '<aura:component controller="VoicePopController" implements="flexipage:availableForAllPageTypes,c:voiceCallPop" extends="c:refundPanel">',
      '  <aura:handler event="c:voiceCallPop" action="{!c.go}"/>',
      '  <aura:registerEvent name="x" type="c:voiceCallPop"/>',
      '  <aura:dependency resource="markup://c:navHelper"/>',
      '  <c:refundPanel/>',
      '  <c:ghostCmp/>',
      '  {!$Label.c.RC_Error}',
      '</aura:component>',
      '<!-- contrail:file aura/hostCmp/hostCmpController.js -->',
      '({ go: function () { $A.createComponent("c:voiceCallPop", {}, function () {}); } })',
      '<!-- contrail:file aura/hostCmp/hostCmp.design -->',
      '<design:component><design:attribute name="o" datasource="apex://PickerController"/>' +
        '<sfdc:object>VoiceCall</sfdc:object></design:component>',
    ].join('\n');
    const refs = extractAuraRefs(content, known());
    const keys = refs.map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toContain('AuraDefinitionBundle:voiceCallPop'); // handler/registerEvent/createComponent
    expect(keys).toContain('AuraDefinitionBundle:navHelper'); // aura:dependency
    expect(keys).toContain('LightningComponentBundle:refundPanel'); // <c:…> resolved to the LWC
    expect(keys).toContain('ApexClass:VoicePopController'); // controller=
    expect(keys).toContain('ApexClass:PickerController'); // design datasource
    expect(keys).toContain('CustomObject:VoiceCall'); // sfdc:object
    expect(keys).toContain('CustomLabel:RC_Error'); // $Label.c
    // Unknown to BOTH maps: no edge — a wrongly-typed dangling edge is worse
    // than a missing one, and refresh re-extracts against the fuller index.
    expect(keys.join(' ')).not.toContain('ghostCmp');
    // Standard interface markers are placement facts, never edges.
    expect(keys.join(' ')).not.toContain('availableForAllPageTypes');
  });

  it('a dotted (namespaced) controller produces no local Apex edge', async () => {
    const { extractAuraRefs } = await import('../deps/extract.js');
    const refs = extractAuraRefs('<aura:component controller="RCSV.CallCtl"/>', known());
    expect(refs).toHaveLength(0);
  });

  it('extractFlexiPageRefs: componentName c:x resolves Aura vs LWC', async () => {
    const { extractFlexiPageRefs } = await import('../deps/extract.js');
    const xml =
      '<FlexiPage><componentName>c:voiceCallPop</componentName>' +
      '<componentName>c:refundPanel</componentName>' +
      '<componentName>flexipage:tab</componentName></FlexiPage>';
    const keys = extractFlexiPageRefs(xml, known()).map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toEqual([
      'AuraDefinitionBundle:voiceCallPop',
      'LightningComponentBundle:refundPanel',
    ]);
  });

  it('extractFlowRefs: component actions and screen extensions', () => {
    const xml =
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">' +
      '<actionCalls><name>nav</name><actionName>c:navHelper</actionName>' +
      '<actionType>component</actionType></actionCalls>' +
      '<screens><fields><name>pop</name>' +
      '<extensionName>c:refundPanel</extensionName></fields></screens></Flow>';
    const keys = extractFlowRefs(xml, known()).map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toContain('AuraDefinitionBundle:navHelper');
    expect(keys).toContain('LightningComponentBundle:refundPanel');
  });

  it('QuickAction lightningComponent and CustomTab auraComponent are typed by their own tags', async () => {
    const { extractQuickActionRefs, extractCustomTabRefs } = await import('../deps/extract.js');
    const qa = extractQuickActionRefs(
      '<QuickAction><lightningComponent>c:voiceCallPop</lightningComponent></QuickAction>',
      'VoiceCall.Pop',
    ).map((r) => `${r.toType}:${r.toName}`);
    expect(qa).toContain('AuraDefinitionBundle:voiceCallPop');
    const tab = extractCustomTabRefs(
      '<CustomTab><auraComponent>c:consoleApp</auraComponent></CustomTab>',
    ).map((r) => `${r.toType}:${r.toName}`);
    expect(tab).toEqual(['AuraDefinitionBundle:consoleApp']);
  });

  it('joinable end-to-end: utility-bar FlexiPage → indexed Aura bundle', () => {
    const files = new Map<string, Uint8Array>([
      ['aura/voiceCallPop/voiceCallPop.cmp', strToU8('<aura:component implements="lightning:backgroundUtilityItem"/>')],
      ['aura/voiceCallPop/voiceCallPop.cmp-meta.xml', strToU8('<AuraDefinitionBundle/>')],
      [
        'flexipages/Sales_Console_UtilityBar.flexipage',
        strToU8('<FlexiPage><componentName>c:voiceCallPop</componentName></FlexiPage>'),
      ],
    ]);
    const artifacts = indexSnapshotFiles(files, [], '2026-11-04T00:00:00.000Z');
    const edges = extractAllEdges('conn-1', artifacts);
    const keys = edges.map((e) => `${e.fromType}:${e.fromName}>${e.toType}:${e.toName}`);
    // The S41 headline edge: the utility bar's used_by answer for the pop.
    expect(keys).toContain(
      'FlexiPage:Sales_Console_UtilityBar>AuraDefinitionBundle:voiceCallPop',
    );
  });
});

describe('S44: Studio test & scorer extractors', () => {
  // Grammar per Salesforce's open-source agents library; the subjectName /
  // agentApiName join to BotDefinition.DeveloperName is assumed from that
  // library, not yet live-confirmed from a retrieved suite.
  const agentSuite =
    '<AiTestingDefinition><name>Order_Tests</name><subjectName>Order_Agent</subjectName>' +
    '<subjectType>AGENT</subjectType><subjectVersion>v2</subjectVersion>' +
    '<testCase><number>1</number><inputs><utterance>hi</utterance></inputs>' +
    '<scorer><name>topic_sequence_match</name><expectedValue>agent_router</expectedValue></scorer>' +
    '<scorer><name>bot_response_rating</name><expectedValue>polite</expectedValue></scorer>' +
    '<scorer><name>Tone_Check</name></scorer></testCase></AiTestingDefinition>';
  const promptSuite =
    '<AiTestingDefinition><name>Tone_Prompt_Tests</name><subjectName>Tone_Prompt</subjectName>' +
    '<subjectType>PROMPT</subjectType><testCase><number>1</number><inputs>' +
    '<promptInput><referenceName>Input:text</referenceName><value>hello</value></promptInput>' +
    '</inputs><scorer><name>response_match</name><expectedValue>Hi there</expectedValue></scorer>' +
    '<scorer><name>coherence</name></scorer></testCase></AiTestingDefinition>';
  const customScorer =
    '<AiAgentScorerDefinition><dataType>Text</dataType><inputScope>Session</inputScope>' +
    '<scorerType>OpenEnded</scorerType>' +
    '<scorerVersion><engine><engineRef>Old_Prompt</engineRef><engineType>PromptTemplate</engineType>' +
    '</engine><label>v1</label><status>Archived</status><versionNumber>1</versionNumber></scorerVersion>' +
    '<scorerVersion><agentAssociation><agentApiName>Order_Agent</agentApiName>' +
    '<inputScope>Session</inputScope><isActive>false</isActive><samplingRate>1.0</samplingRate>' +
    '</agentAssociation><engine><engineRef>Tone_Prompt</engineRef><engineType>PromptTemplate</engineType>' +
    '</engine><label>v2</label><status>Draft</status><versionNumber>2</versionNumber></scorerVersion>' +
    '<semanticType>Quality</semanticType></AiAgentScorerDefinition>';

  it('AiTestingDefinition → Bot (AGENT) or GenAiPromptTemplate (PROMPT) subject; custom scorers → AiAgentScorerDefinition; catalog names → NONE', async () => {
    const { extractAiTestingDefinitionRefs } = await import('../deps/extract.js');
    expect(extractAiTestingDefinitionRefs(agentSuite)).toEqual([
      { toType: 'Bot', toName: 'Order_Agent' },
      { toType: 'AiAgentScorerDefinition', toName: 'Tone_Check' },
    ]);
    // Catalog names produce NOTHING — exact equality is the pin.
    expect(extractAiTestingDefinitionRefs(promptSuite)).toEqual([
      { toType: 'GenAiPromptTemplate', toName: 'Tone_Prompt' },
    ]);
  });

  it('catalog membership is exact-case: a custom scorer named Coherence keeps its edge', async () => {
    const { extractAiTestingDefinitionRefs } = await import('../deps/extract.js');
    const xml =
      '<AiTestingDefinition><subjectName>Order_Agent</subjectName><subjectType>AGENT</subjectType>' +
      '<testCase><number>1</number><scorer><name>Coherence</name></scorer>' +
      '<scorer><name>coherence</name></scorer></testCase></AiTestingDefinition>';
    const keys = extractAiTestingDefinitionRefs(xml).map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toContain('AiAgentScorerDefinition:Coherence');
    expect(keys).not.toContain('AiAgentScorerDefinition:coherence');
  });

  it('a <scorer scorerType="Custom"> attribute form still yields the custom-scorer edge', async () => {
    const { extractAiTestingDefinitionRefs } = await import('../deps/extract.js');
    const xml =
      '<AiTestingDefinition><subjectName>Order_Agent</subjectName><subjectType>AGENT</subjectType>' +
      '<testCase><number>1</number><scorer scorerType="Custom"><name>Tone_Check</name></scorer>' +
      '</testCase></AiTestingDefinition>';
    const keys = extractAiTestingDefinitionRefs(xml).map((r) => `${r.toType}:${r.toName}`);
    expect(keys).toContain('AiAgentScorerDefinition:Tone_Check');
    // The suite's own top-level <name> is outside any <scorer> block.
    expect(keys).not.toContain('AiAgentScorerDefinition:Order_Tests');
  });

  it('AiAgentScorerDefinition → engineRef templates and agentApiName bots, regardless of status or isActive', async () => {
    const { extractAiAgentScorerDefinitionRefs } = await import('../deps/extract.js');
    const keys = extractAiAgentScorerDefinitionRefs(customScorer)
      .map((r) => `${r.toType}:${r.toName}`)
      .sort();
    expect(keys).toEqual([
      'Bot:Order_Agent',
      'GenAiPromptTemplate:Old_Prompt',
      'GenAiPromptTemplate:Tone_Prompt',
    ]);
    // A managed template's namespaced engineRef passes through as-is (recall).
    const managed =
      '<AiAgentScorerDefinition><scorerVersion><engine>' +
      '<engineRef>agentforce_session_tracing__quality_score</engineRef>' +
      '<engineType>PromptTemplate</engineType></engine></scorerVersion></AiAgentScorerDefinition>';
    expect(extractAiAgentScorerDefinitionRefs(managed)).toEqual([
      { toType: 'GenAiPromptTemplate', toName: 'agentforce_session_tracing__quality_score' },
    ]);
  });

  it('AiEvaluationDefinition (legacy) → its Bot subject — the parity edge missing since S30', async () => {
    const { extractAiEvaluationDefinitionRefs } = await import('../deps/extract.js');
    expect(
      extractAiEvaluationDefinitionRefs(
        '<AiEvaluationDefinition><subjectType>AGENT</subjectType>' +
          '<subjectName>Order_Agent</subjectName><subjectVersion>v1</subjectVersion>' +
          '<testCase><number>1</number></testCase></AiEvaluationDefinition>',
      ),
    ).toEqual([{ toType: 'Bot', toName: 'Order_Agent' }]);
    // No subjectType → still Bot (AGENT is the documented default shape).
    expect(
      extractAiEvaluationDefinitionRefs(
        '<AiEvaluationDefinition><subjectName>Order_Agent</subjectName></AiEvaluationDefinition>',
      ),
    ).toEqual([{ toType: 'Bot', toName: 'Order_Agent' }]);
  });

  it('indexed suite, scorer, template and bot produce joinable edges through extractAllEdges', () => {
    const files = new Map(
      Object.entries({
        'bots/Order_Agent.bot': strToU8('<Bot><botVersions><fullName>v1</fullName></botVersions></Bot>'),
        'genAiPromptTemplates/Tone_Prompt.genAiPromptTemplate': strToU8('<GenAiPromptTemplate/>'),
        'aiAgentScorerDefinitions/Tone_Check.aiAgentScorerDefinition': strToU8(customScorer),
        'aiTestingDefinitions/Order_Tests.aiTestingDefinition': strToU8(agentSuite),
        'aiEvaluationDefinitions/Legacy_Tests.aiEvaluationDefinition': strToU8(
          '<AiEvaluationDefinition><subjectType>AGENT</subjectType>' +
            '<subjectName>Order_Agent</subjectName></AiEvaluationDefinition>',
        ),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-11-08T00:00:00.000Z');
    const edges = extractAllEdges('conn1', artifacts);
    const keys = edges.map((e) => `${e.fromType}:${e.fromName}>${e.toType}:${e.toName}`);
    expect(keys).toContain('AiTestingDefinition:Order_Tests>Bot:Order_Agent');
    expect(keys).toContain('AiTestingDefinition:Order_Tests>AiAgentScorerDefinition:Tone_Check');
    expect(keys).toContain('AiAgentScorerDefinition:Tone_Check>GenAiPromptTemplate:Tone_Prompt');
    expect(keys).toContain('AiAgentScorerDefinition:Tone_Check>Bot:Order_Agent');
    expect(keys).toContain('AiEvaluationDefinition:Legacy_Tests>Bot:Order_Agent');
    expect(keys.some((k) => k.endsWith('>AiAgentScorerDefinition:topic_sequence_match'))).toBe(false);
    expect(keys.some((k) => k.endsWith('>AiAgentScorerDefinition:bot_response_rating'))).toBe(false);
  });
});

describe('S47: Data Mapper (OmniDataTransform) extractor', () => {
  // Element grammar per Salesforce's OmniDataTransform type page: item
  // children alphabetical, item <name> = the mapper's name, the rows between
  // nullInputsIncludedInOutput and outputType. Doc-derived — no retrieved
  // file exists yet, so these pin Contrail's reading, not the org's shape.
  const row = (fields: Record<string, string>) =>
    '<omniDataTransformItem>' +
    Object.entries({ disabled: 'false', name: 'SummaryMapper', ...fields })
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('') +
    '</omniDataTransformItem>';
  const mapper = (type: string, rows: string[]) =>
    '<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">' +
    '<active>true</active><name>SummaryMapper</name>' +
    '<nullInputsIncludedInOutput>false</nullInputsIncludedInOutput>' +
    rows.join('') +
    `<outputType>JSON</outputType><type>${type}</type>` +
    '<uniqueName>SummaryMapper_1</uniqueName><versionNumber>1.0</versionNumber>' +
    '</OmniDataTransform>';
  const knownSet = () =>
    buildKnownArtifacts([
      { type: 'CustomObject', apiName: 'Account' },
      { type: 'CustomObject', apiName: 'Invoice__c' },
      { type: 'CustomField', apiName: 'Account.Region__c' },
      { type: 'CustomField', apiName: 'Invoice__c.Amount__c' },
      { type: 'CustomField', apiName: 'Invoice__c.Status__c' },
    ]);
  const keysOf = (refs: Array<{ toType: string; toName: string }>) =>
    refs.map((r) => `${r.toType}:${r.toName}`).sort();

  it('Extract: object edges from inputObjectName; json outputs and inputFieldName give NO edge', async () => {
    const { extractOmniDataTransformRefs } = await import('../deps/extract.js');
    const xml = mapper('Extract', [
      // A query step: the sObject it reads, filtered by two of its fields.
      row({
        filterOperator: '=',
        filterValue: 'AccountId',
        inputFieldName: 'Id',
        inputObjectName: 'Account',
        outputFieldName: 'Account',
        outputObjectName: 'json',
      }),
      // The filter field Account.Region__c IS in the index, yet adds no edge:
      // filter rows' inputFieldName is deliberately not read.
      row({
        filterOperator: '=',
        filterValue: 'RegionCode',
        inputFieldName: 'Region__c',
        inputObjectName: 'Account',
        outputFieldName: 'Account',
        outputObjectName: 'json',
      }),
      // Output rows: alias paths in, JSON out — never sObject field names.
      row({
        inputFieldName: 'Account:Region__c',
        outputFieldName: 'Region',
        outputObjectName: 'json',
      }),
      row({ inputFieldName: 'Amount__c', outputFieldName: 'Amount__c', outputObjectName: 'JSON' }),
    ]);
    expect(keysOf(extractOmniDataTransformRefs(xml, knownSet()))).toEqual(['CustomObject:Account']);
  });

  it('Load: outputObjectName + outputFieldName give object AND field edges, joined in the index casing', async () => {
    const { extractOmniDataTransformRefs } = await import('../deps/extract.js');
    const xml = mapper('Load', [
      row({ inputFieldName: 'Total', outputFieldName: 'amount__c', outputObjectName: 'invoice__c' }),
      row({ inputFieldName: 'State', outputFieldName: 'Status__c', outputObjectName: 'Invoice__c' }),
    ]);
    expect(keysOf(extractOmniDataTransformRefs(xml, knownSet()))).toEqual([
      'CustomField:Invoice__c.Amount__c',
      'CustomField:Invoice__c.Status__c',
      'CustomObject:Invoice__c',
    ]);
    // Field edges are Load-only: the same row on a Transform names the object only.
    const transform = mapper('Transform', [
      row({ inputFieldName: 'Total', outputFieldName: 'Amount__c', outputObjectName: 'Invoice__c' }),
    ]);
    expect(keysOf(extractOmniDataTransformRefs(transform, knownSet()))).toEqual([
      'CustomObject:Invoice__c',
    ]);
  });

  it('lookups: lookupObjectName plus lookupByFieldName / lookupReturnedFieldName', async () => {
    const { extractOmniDataTransformRefs } = await import('../deps/extract.js');
    const xml = mapper('Transform', [
      row({
        inputFieldName: 'RegionCode',
        lookupByFieldName: 'Region__c',
        lookupObjectName: 'Account',
        lookupReturnedFieldName: 'Name',
        outputFieldName: 'AccountName',
        outputObjectName: 'json',
      }),
      row({
        inputFieldName: 'InvoiceNumber',
        lookupByFieldName: 'Name',
        lookupObjectName: 'Invoice__c',
        lookupReturnedFieldName: 'Status__c',
        outputFieldName: 'InvoiceStatus',
        outputObjectName: 'json',
      }),
    ]);
    // Account.Name and Invoice__c.Name are not in the index: no edge for them
    // (join only to known). Invoice__c.Status__c comes from the returned field.
    expect(keysOf(extractOmniDataTransformRefs(xml, knownSet()))).toEqual([
      'CustomField:Account.Region__c',
      'CustomField:Invoice__c.Status__c',
      'CustomObject:Account',
      'CustomObject:Invoice__c',
    ]);
  });

  it('only plain identifiers that the index holds join — paths and unknown names add nothing', async () => {
    const { extractOmniDataTransformRefs } = await import('../deps/extract.js');
    const xml = mapper('Load', [
      row({ inputFieldName: 'A', outputFieldName: 'Parent__r.Name', outputObjectName: 'Invoice__c' }),
      row({ inputFieldName: 'B', outputFieldName: 'Amount__c', outputObjectName: 'Opportunity' }),
      row({ inputFieldName: 'C', outputFieldName: 'Amount__c', outputObjectName: 'Invoice:Line' }),
    ]);
    expect(keysOf(extractOmniDataTransformRefs(xml, knownSet()))).toEqual([
      'CustomObject:Invoice__c',
    ]);
    // Malformed XML degrades to no edges, never a throw.
    expect(
      extractOmniDataTransformRefs('<OmniDataTransform><omniDataTransformItem>', knownSet()),
    ).toEqual([]);
  });

  it('reads rows and values in linear time: about 1 MB of malformed rows answers fast, and the same', async () => {
    // The lazy row pattern re-read to the end of the text once per row
    // opener with no closer, and the lazy value pattern was cubic in the
    // white space after an opener whose value is not followed by its closer:
    // seconds of a blocked snapshot refresh for each shape below.
    const { extractOmniDataTransformRefs } = await import('../deps/extract.js');
    const MB = 1_000_000;
    const fill = (unit: string) => unit.repeat(Math.floor(MB / unit.length));
    const stuck = `<outputObjectName>${' '.repeat(200)}x${' '.repeat(200)}<b/>`;
    const load = (rows: string) =>
      '<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">' +
      `<name>SummaryMapper</name>${rows}<type>Load</type></OmniDataTransform>`;
    const shapes: Array<[string, string]> = [
      [
        'row openers with no closer after a real row',
        load(
          row({ inputFieldName: 'Total', outputFieldName: 'Amount__c', outputObjectName: 'Invoice__c' }) +
            fill('<omniDataTransformItem>'),
        ),
      ],
      [
        'values not followed by their closer, then the real one',
        load(
          '<omniDataTransformItem>' +
            fill(stuck) +
            '<outputFieldName>Amount__c</outputFieldName>' +
            '<outputObjectName> Invoice__c </outputObjectName></omniDataTransformItem>',
        ),
      ],
    ];
    for (const [what, xml] of shapes) {
      expect(xml.length, what).toBeGreaterThan(MB * 0.95);
      const started = performance.now();
      const refs = extractOmniDataTransformRefs(xml, knownSet());
      const took = performance.now() - started;
      expect(keysOf(refs), what).toEqual(['CustomField:Invoice__c.Amount__c', 'CustomObject:Invoice__c']);
      expect(took, `${what}: ${Math.round(took)} ms`).toBeLessThan(1000);
    }
  });

  it('an indexed Load mapper joins its object and field through extractAllEdges', () => {
    const files = new Map(
      Object.entries({
        'objects/Invoice__c.object': strToU8(INVOICE_OBJECT_XML),
        'omniDataTransforms/InvoiceLoad_1.rpt': strToU8(
          mapper('Load', [
            row({
              inputFieldName: 'Total',
              outputFieldName: 'Amount__c',
              outputObjectName: 'Invoice__c',
            }),
          ]),
        ),
      }),
    );
    const artifacts = indexSnapshotFiles(files, [], '2026-11-20T00:00:00.000Z');
    const keys = extractAllEdges('conn1', artifacts).map(
      (e) => `${e.fromType}:${e.fromName}>${e.toType}:${e.toName}`,
    );
    expect(keys).toContain('OmniDataTransform:InvoiceLoad_1>CustomObject:Invoice__c');
    expect(keys).toContain('OmniDataTransform:InvoiceLoad_1>CustomField:Invoice__c.Amount__c');
  });
});

describe('S44 test suites read in linear time (slow-path follow-up)', () => {
  // A suite is text an agent deployed, read again on every snapshot
  // refresh. The patterns these readers used started again from every
  // <scorer opener with no ">" or no closer after it and read to the end
  // (quadratic), and tried every split of the white space after a subject
  // opener whose value was not followed by its closer (cubic). Each shape
  // must answer in well under a second, with the edges those patterns gave.
  const MB = 1_000_000;
  const fill = (unit: string, bytes = MB) => unit.repeat(Math.floor(bytes / unit.length));
  const timedKeys = (read: () => Array<{ toType: string; toName: string }>) => {
    const started = performance.now();
    const keys = read().map((r) => `${r.toType}:${r.toName}`);
    return [keys, performance.now() - started] as const;
  };
  /** The edges the patterns these readers replace gave. */
  const reference = (xml: string, scorers: boolean): string[] => {
    const refs = new Map<string, string>();
    const add = (type: string, raw: string) => {
      const name = raw.trim();
      if (name) refs.set(`${type}:${name.toLowerCase()}`, `${type}:${name}`);
    };
    const subject = xml.match(/<subjectName>\s*([^<]+?)\s*<\/subjectName>/)?.[1];
    if (subject) {
      const kind = xml.match(/<subjectType>\s*([^<]+?)\s*<\/subjectType>/)?.[1]?.toUpperCase();
      add(kind === 'PROMPT' ? 'GenAiPromptTemplate' : 'Bot', subject);
    }
    if (scorers) {
      for (const m of xml.matchAll(/<scorer(?:\s[^>]*)?>([\s\S]*?)<\/scorer>/g)) {
        const name = m[1]!.match(/<name>\s*([^<]+?)\s*<\/name>/)?.[1];
        if (name && !isStudioCatalogScorer(name)) add('AiAgentScorerDefinition', name);
      }
    }
    return [...refs.values()];
  };

  it('scorer openers with no ">" or no closer after them, packed close together', () => {
    const head =
      '<AiTestingDefinition><subjectName>Support_Agent</subjectName><testCase>' +
      '<scorer scorerType="Custom"><name>Tone_Check</name></scorer></testCase>';
    const tails: Array<[string, string]> = [
      ['openers with no ">" after them', fill('<scorer ')],
      ['openers with no closer after them', fill('<scorer>')],
      ['openers with attributes and no closer after them', fill('<scorer a="1">')],
    ];
    for (const [what, tail] of tails) {
      const [keys, took] = timedKeys(() => extractAiTestingDefinitionRefs(head + tail));
      expect(keys, what).toEqual(['Bot:Support_Agent', 'AiAgentScorerDefinition:Tone_Check']);
      expect(took, `${what}: ${Math.round(took)} ms`).toBeLessThan(1000);
    }
  });

  it('subject values not followed by their closer, then the real one', () => {
    const stuck = `<subjectName>${' '.repeat(200)}x${' '.repeat(200)}<b/>`;
    const tail =
      '<subjectName> Support_Agent </subjectName><subjectType> prompt </subjectType>' +
      '</AiTestingDefinition>';
    const xml = `<AiTestingDefinition>${fill(stuck)}${tail}`;
    for (const read of [extractAiTestingDefinitionRefs, extractAiEvaluationDefinitionRefs]) {
      const [keys, took] = timedKeys(() => read(xml));
      expect(keys, read.name).toEqual(['GenAiPromptTemplate:Support_Agent']);
      expect(took, `${read.name}: ${Math.round(took)} ms`).toBeLessThan(1000);
    }
  });

  it('the readers give the edges those patterns gave, edge cases included', () => {
    const inputs = [
      '<scorer><name>A</name></scorer>',
      '<scorer\n x="<a>"><name>B</name></scorer>',
      '<scorer ><name>C</name>',
      '<scorerType>T</scorerType><scorer><name>D</name></scorer>',
      '<scorer x><name>E</name></scorer><scorer>',
      '<scorer><scorer><name>F</name></scorer></scorer>',
      '<scorer><name> </name></scorer><scorer><name>coherence</name></scorer>',
      '<scorer x="1"<name>G</name>></scorer>',
      '<scorer\t><name>H</name></scorer><scorer><name>h</name></scorer>',
      '<subjectName></subjectName><subjectName>S</subjectName><subjectType>AGENT</subjectType>',
      '<subjectName> </subjectName><subjectType>PROMPT</subjectType>',
      '<subjectType>Prompt</subjectType><subjectName>P</subjectName>',
      '<scorer',
    ];
    for (const xml of inputs) {
      const at = JSON.stringify(xml);
      const tested = extractAiTestingDefinitionRefs(xml).map((r) => `${r.toType}:${r.toName}`);
      expect(tested, at).toEqual(reference(xml, true));
      const legacy = extractAiEvaluationDefinitionRefs(xml).map((r) => `${r.toType}:${r.toName}`);
      expect(legacy, at).toEqual(reference(xml, false));
    }
  });
});
