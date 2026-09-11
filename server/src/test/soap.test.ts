import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetadataSoapClient } from '../salesforce/metadataSoap.js';
import type { AccessTokenManager } from '../salesforce/tokens.js';
import type { ConnectionRecord } from '../core/types.js';
import { emptyGrantSet } from '../core/grants.js';

const CONN: ConnectionRecord = {
  id: 'c1',
  workspaceId: 'default',
  alias: 'test',
  instanceUrl: 'https://inst.stub.salesforce.com',
  loginUrl: 'https://login.salesforce.com',
  orgId: '00D1',
  orgName: 'Test',
  orgType: 'developer',
  isSandbox: false,
  username: null,
  userId: null,
  grants: emptyGrantSet(),
  createdAt: '',
  updatedAt: '',
  lastUsedAt: null,
};

function fakeTokenMgr(tokens: string[]): AccessTokenManager {
  let i = 0;
  return {
    getAccessToken: async () => tokens[Math.min(i, tokens.length - 1)]!,
    invalidate: () => {
      i += 1;
    },
  } as unknown as AccessTokenManager;
}

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MetadataSoapClient', () => {
  it('builds listMetadata calls (chunked by 3) and parses FileProperties', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(
        soapEnvelope(
          `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
             <result><fullName>Foo</fullName><type>ApexClass</type>
               <fileName>classes/Foo.cls</fileName><id>01p1</id>
               <lastModifiedDate>2026-08-01T00:00:00.000Z</lastModifiedDate>
               <lastModifiedByName>Ryley</lastModifiedByName></result>
           </listMetadataResponse>`,
        ),
      );
    });
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v63.0');
    const props = await client.listMetadata(['ApexClass', 'Flow', 'CustomObject', 'CustomLabels']);
    // 4 types → 2 SOAP calls (3 + 1)
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('<met:type>ApexClass</met:type>');
    expect(bodies[0]).toContain('<met:sessionId>AT</met:sessionId>');
    expect(bodies[1]).toContain('<met:type>CustomLabels</met:type>');
    // each call returns the canned row
    expect(props).toHaveLength(2);
    expect(props[0]).toMatchObject({
      type: 'ApexClass',
      fullName: 'Foo',
      lastModifiedByName: 'Ryley',
    });
  });

  it('S29: foldered types expand to per-folder queries, folder BEFORE type', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body);
      bodies.push(body);
      // Folder enumeration returns two report folders; per-folder calls
      // return one folder-qualified report each.
      if (body.includes('<met:type>ReportFolder</met:type>')) {
        return new Response(
          soapEnvelope(
            `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><fullName>Ops</fullName><type>ReportFolder</type><fileName>reports/Ops</fileName><id>00l1</id>
                 <lastModifiedDate>2026-09-01T00:00:00.000Z</lastModifiedDate><lastModifiedByName>Ryley</lastModifiedByName></result>
               <result><fullName>Sales</fullName><type>ReportFolder</type><fileName>reports/Sales</fileName><id>00l2</id>
                 <lastModifiedDate>2026-09-01T00:00:00.000Z</lastModifiedDate><lastModifiedByName>Ryley</lastModifiedByName></result>
             </listMetadataResponse>`,
          ),
        );
      }
      // A chunked call carries up to 3 folder queries — answer each one.
      const folders = [...body.matchAll(/<met:folder>([^<]+)<\/met:folder>/g)]
        .map((m) => m[1]!)
        .filter((f) => f !== 'unfiled$public');
      if (folders.length > 0) {
        const results = folders
          .map(
            (folder) =>
              `<result><fullName>${folder}/Weekly</fullName><type>Report</type>
                 <fileName>reports/${folder}/Weekly.report</fileName><id>00O1</id>
                 <lastModifiedDate>2026-09-02T00:00:00.000Z</lastModifiedDate><lastModifiedByName>Ryley</lastModifiedByName></result>`,
          )
          .join('');
        return new Response(
          soapEnvelope(
            `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">${results}</listMetadataResponse>`,
          ),
        );
      }
      return new Response(
        soapEnvelope(
          `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata"></listMetadataResponse>`,
        ),
      );
    });
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v63.0');
    const props = await client.listMetadata(['Report']);

    // Pass 1: one flat call querying the folder-enumeration type, no folder element.
    expect(bodies[0]).toContain('<met:type>ReportFolder</met:type>');
    expect(bodies[0]).not.toContain('<met:folder>');
    // Pass 2: 3 folder queries (Ops, Sales, unfiled$public) → one chunked call,
    // with <met:folder> BEFORE <met:type> (WSDL sequence order).
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatch(
      /<met:queries><met:folder>Ops<\/met:folder><met:type>Report<\/met:type><\/met:queries>/,
    );
    expect(bodies[1]).toContain('<met:folder>Sales</met:folder>');
    expect(bodies[1]).toContain('<met:folder>unfiled$public</met:folder>');

    const byName = new Map(props.map((p) => [`${p.type}:${p.fullName}`, p]));
    expect(byName.has('ReportFolder:Ops')).toBe(true);
    expect(byName.has('ReportFolder:Sales')).toBe(true);
    expect(byName.has('Report:Ops/Weekly')).toBe(true);
    expect(byName.has('Report:Sales/Weekly')).toBe(true);
  });

  it('S29: asking for Report and ReportFolder together enumerates folders once', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(
        soapEnvelope(
          `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata"></listMetadataResponse>`,
        ),
      );
    });
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v63.0');
    await client.listMetadata(['Report', 'ReportFolder']);
    const folderTypeQueries = bodies
      .join('')
      .match(/<met:type>ReportFolder<\/met:type>/g);
    expect(folderTypeQueries).toHaveLength(1);
    // No folders found → only the unfiled$public content query follows.
    expect(bodies[1]).toContain('<met:folder>unfiled$public</met:folder>');
  });

  it('escapes member names in retrieve requests', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(
        soapEnvelope(
          `<retrieveResponse xmlns="http://soap.sforce.com/2006/04/metadata">
             <result><id>09S1</id><done>false</done><state>Queued</state></result>
           </retrieveResponse>`,
        ),
      );
    });
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v63.0');
    const id = await client.retrieve({ ApexClass: ['*'], Flow: ["Evil<'&>Name"] });
    expect(id).toBe('09S1');
    expect(body).toContain('<met:members>*</met:members>');
    expect(body).toContain('Evil&lt;&apos;&amp;&gt;Name');
    expect(body).not.toContain("Evil<'&>Name");
  });

  it('parses checkRetrieveStatus with a base64 zip', async () => {
    const zipB64 = Buffer.from('PK-fake-zip').toString('base64');
    vi.stubGlobal('fetch', async () =>
      new Response(
        soapEnvelope(
          `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
             <result><done>true</done><status>Succeeded</status><success>true</success>
               <id>09S1</id><zipFile>${zipB64}</zipFile>
               <fileProperties><fullName>Foo</fullName><type>ApexClass</type>
                 <fileName>classes/Foo.cls</fileName><id>01p1</id>
                 <lastModifiedDate>2026-08-01T00:00:00.000Z</lastModifiedDate>
                 <lastModifiedByName>Ryley</lastModifiedByName></fileProperties>
             </result>
           </checkRetrieveStatusResponse>`,
        ),
      ),
    );
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v63.0');
    const status = await client.checkRetrieveStatus('09S1', true);
    expect(status.done).toBe(true);
    expect(status.success).toBe(true);
    expect(status.zipFile?.toString()).toBe('PK-fake-zip');
    expect(status.fileProperties).toHaveLength(1);
  });

  it('refreshes the session once on INVALID_SESSION_ID and retries', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      if (String(init?.body).includes('<met:sessionId>STALE</met:sessionId>')) {
        return new Response(
          soapEnvelope(
            `<soapenv:Fault><faultcode>sf:INVALID_SESSION_ID</faultcode>
             <faultstring>Invalid Session ID</faultstring></soapenv:Fault>`,
          ),
          { status: 500 },
        );
      }
      return new Response(
        soapEnvelope(
          `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata"></listMetadataResponse>`,
        ),
      );
    });
    const client = new MetadataSoapClient(fakeTokenMgr(['STALE', 'FRESH']), CONN, 'v63.0');
    const props = await client.listMetadata(['ApexClass']);
    expect(calls).toBe(2);
    expect(props).toEqual([]);
  });

  it('surfaces non-session faults as errors', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        soapEnvelope(
          `<soapenv:Fault><faultcode>sf:INSUFFICIENT_ACCESS</faultcode>
           <faultstring>no metadata api for you</faultstring></soapenv:Fault>`,
        ),
        { status: 500 },
      ),
    );
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v63.0');
    await expect(client.listMetadata(['ApexClass'])).rejects.toThrow(/no metadata api for you/);
  });
});

describe('S30: listMetadataDetailed INVALID_TYPE degrade', () => {
  function stubWithInvalidType(): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body);
      calls.push(body);
      if (body.includes('<met:type>GenAiPlannerBundle</met:type>')) {
        return new Response(
          soapEnvelope(
            `<soapenv:Fault><faultcode>sf:INVALID_TYPE</faultcode>
             <faultstring>INVALID_TYPE: Cannot use: GenAiPlannerBundle in this version</faultstring></soapenv:Fault>`,
          ),
          { status: 500 },
        );
      }
      const type = body.match(/<met:type>(\w+)<\/met:type>/)?.[1] ?? 'ApexClass';
      return new Response(
        soapEnvelope(
          `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
             <result><fullName>Item_${type}</fullName><type>${type}</type>
               <fileName>x</fileName><id>1</id>
               <lastModifiedDate>2026-09-01T00:00:00.000Z</lastModifiedDate>
               <lastModifiedByName>Ryley</lastModifiedByName></result>
           </listMetadataResponse>`,
        ),
      );
    });
    return { calls };
  }

  it('a faulting chunk retries per query; healthy types survive, bad ones are reported', async () => {
    const { calls } = stubWithInvalidType();
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v66.0');
    const { props, unsupportedTypes } = await client.listMetadataDetailed([
      'ApexClass',
      'GenAiPlannerBundle',
      'Flow',
    ]);
    expect(unsupportedTypes).toEqual(['GenAiPlannerBundle']);
    const names = props.map((p) => `${p.type}:${p.fullName}`).sort();
    expect(names).toEqual(['ApexClass:Item_ApexClass', 'Flow:Item_Flow']);
    // 1 chunk call (faulted) + 3 per-query retries.
    expect(calls.length).toBe(4);
  });

  it('plain listMetadata keeps its throwing contract for INVALID_TYPE', async () => {
    stubWithInvalidType();
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v66.0');
    await expect(client.listMetadata(['ApexClass', 'GenAiPlannerBundle'])).rejects.toThrow(
      /INVALID_TYPE/,
    );
  });

  it('non-INVALID_TYPE faults still throw through the detailed path', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        soapEnvelope(
          `<soapenv:Fault><faultcode>sf:INSUFFICIENT_ACCESS</faultcode>
           <faultstring>no metadata api for you</faultstring></soapenv:Fault>`,
        ),
        { status: 500 },
      ),
    );
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v66.0');
    await expect(client.listMetadataDetailed(['ApexClass'])).rejects.toThrow(
      /no metadata api for you/,
    );
  });
});
