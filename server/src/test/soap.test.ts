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

  it('S41 (§3.14): every deploy pins rollbackOnError=true — an ENGINE INVARIANT', async () => {
    // The API default is FALSE: without this element a partially failed
    // production deploy would commit the components that succeeded. Aura
    // bundle replaces (and everything else) are atomic ONLY because of it.
    let body = '';
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(
        soapEnvelope(
          `<deployResponse xmlns="http://soap.sforce.com/2006/04/metadata">
             <result><id>0Af1</id></result>
           </deployResponse>`,
        ),
      );
    });
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v63.0');
    await client.deploy(Buffer.from('zip'), { checkOnly: false, runTests: [] });
    expect(body).toContain('<met:rollbackOnError>true</met:rollbackOnError>');
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

describe('S45: DeployResult org-side stamps + listMetadataQueries', () => {
  function deployStatusResponse(withDates: boolean): string {
    return soapEnvelope(
      `<checkDeployStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
         <result><id>0Af1</id><done>true</done><status>Succeeded</status>
           <success>true</success><checkOnly>true</checkOnly>
           ${
             withDates
               ? '<createdDate>2026-11-14T15:04:05.000Z</createdDate>' +
                 '<completedDate>2026-11-14T15:04:09.000Z</completedDate>'
               : ''
           }
           <numberComponentsTotal>1</numberComponentsTotal>
           <numberComponentsDeployed>1</numberComponentsDeployed>
           <numberComponentErrors>0</numberComponentErrors>
           <numberTestsTotal>0</numberTestsTotal>
           <numberTestsCompleted>0</numberTestsCompleted>
           <numberTestErrors>0</numberTestErrors>
           <details><runTestResult><numTestsRun>0</numTestsRun>
             <numFailures>0</numFailures></runTestResult></details>
         </result>
       </checkDeployStatusResponse>`,
    );
  }

  it('checkDeployStatus parses createdDate/completedDate as strings; undefined when the org omits them', async () => {
    let withDates = true;
    vi.stubGlobal('fetch', async () => new Response(deployStatusResponse(withDates)));
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v66.0');

    const stamped = await client.checkDeployStatus('0Af1');
    expect(stamped.createdDate).toBe('2026-11-14T15:04:05.000Z');
    expect(stamped.completedDate).toBe('2026-11-14T15:04:09.000Z');
    // Org time, comparable as epoch ms (the degrade-path moved check does exactly this).
    expect(Date.parse(stamped.createdDate!)).toBeLessThan(Date.parse(stamped.completedDate!));
    expect(stamped.success).toBe(true);
    expect(stamped.checkOnly).toBe(true);

    withDates = false;
    const bare = await client.checkDeployStatus('0Af1');
    expect(bare.createdDate).toBeUndefined();
    expect(bare.completedDate).toBeUndefined();
    expect(bare.done).toBe(true);
  });

  it('listMetadataQueries lists exactly the given queries: a foldered member by ITS folder, <met:folder> before <met:type>, no folder enumeration', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(
        soapEnvelope(
          `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
             <result><fullName>Pipeline</fullName><type>Report</type>
               <fileName>reports/Ops/Pipeline.report</fileName><id>00O1</id>
               <lastModifiedDate>2026-11-01T00:00:00.000Z</lastModifiedDate>
               <lastModifiedByName>Ryley</lastModifiedByName></result>
             <result><fullName>Foo</fullName><type>ApexClass</type>
               <fileName>classes/Foo.cls</fileName><id>01p1</id>
               <lastModifiedDate>2026-11-02T00:00:00.000Z</lastModifiedDate>
               <lastModifiedByName>Ryley</lastModifiedByName></result>
           </listMetadataResponse>`,
        ),
      );
    });
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v66.0');
    const { props, unsupportedTypes } = await client.listMetadataQueries([
      { type: 'Report', folder: 'Ops' },
      { type: 'ApexClass' },
      { type: 'Report', folder: 'Ops' }, // a duplicate collapses — one query, one round trip
    ]);

    expect(bodies).toHaveLength(1);
    // WSDL sequence order: folder BEFORE type; the flat query carries no folder.
    expect(bodies[0]).toMatch(
      /<met:listMetadata><met:queries><met:folder>Ops<\/met:folder><met:type>Report<\/met:type><\/met:queries><met:queries><met:type>ApexClass<\/met:type><\/met:queries><met:asOfVersion>/,
    );
    // Never the whole tree: no ReportFolder enumeration, no unfiled$public pass.
    expect(bodies[0]).not.toContain('ReportFolder');
    expect(bodies[0]).not.toContain('unfiled$public');
    expect(unsupportedTypes).toEqual([]);
    // A bare org name is folder-qualified (exactly one folder for that type in the chunk).
    expect(props.map((p) => `${p.type}:${p.fullName}`).sort()).toEqual([
      'ApexClass:Foo',
      'Report:Ops/Pipeline',
    ]);
    expect(props.find((p) => p.type === 'Report')?.lastModifiedDate).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });

  it('listMetadataQueries degrades INVALID_TYPE per query like listMetadataDetailed; other faults throw', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body);
      calls.push(body);
      if (body.includes('<met:type>BotVersion</met:type>')) {
        return new Response(
          soapEnvelope(
            `<soapenv:Fault><faultcode>sf:INVALID_TYPE</faultcode>
             <faultstring>INVALID_TYPE: Cannot use: BotVersion in this version</faultstring></soapenv:Fault>`,
          ),
          { status: 500 },
        );
      }
      const type = body.match(/<met:type>(\w+)<\/met:type>/)?.[1] ?? 'CustomField';
      return new Response(
        soapEnvelope(
          `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
             <result><fullName>Invoice__c.Amount__c</fullName><type>${type}</type>
               <fileName>objects/Invoice__c.object</fileName><id>00N1</id>
               <lastModifiedDate>2026-09-01T00:00:00.000Z</lastModifiedDate>
               <lastModifiedByName>Ryley</lastModifiedByName></result>
           </listMetadataResponse>`,
        ),
      );
    });
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v66.0');
    const { props, unsupportedTypes } = await client.listMetadataQueries([
      { type: 'BotVersion' },
      { type: 'CustomField' },
    ]);
    expect(unsupportedTypes).toEqual(['BotVersion']);
    expect(props.map((p) => p.type)).toEqual(['CustomField']);
    // 1 faulted chunk + 2 per-query retries.
    expect(calls).toHaveLength(3);

    vi.stubGlobal('fetch', async () =>
      new Response(
        soapEnvelope(
          `<soapenv:Fault><faultcode>sf:INSUFFICIENT_ACCESS</faultcode>
           <faultstring>no metadata api for you</faultstring></soapenv:Fault>`,
        ),
        { status: 500 },
      ),
    );
    await expect(client.listMetadataQueries([{ type: 'CustomField' }])).rejects.toThrow(
      /no metadata api for you/,
    );
  });
});

describe('S46 D1f: checkRetrieveStatus carries the retrieve messages', () => {
  function retrieveStatusResponse(messagesXml: string): string {
    const zipB64 = Buffer.from('PK-fake-zip').toString('base64');
    return soapEnvelope(
      `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
         <result><done>true</done>
           <fileProperties><fullName>unpackaged/package.xml</fullName><type>Package</type>
             <fileName>unpackaged/package.xml</fileName><id></id>
             <lastModifiedDate>2026-11-17T00:00:00.000Z</lastModifiedDate>
             <lastModifiedByName>Dana Admin</lastModifiedByName></fileProperties>
           <id>09S1</id>${messagesXml}
           <status>Succeeded</status><success>true</success>
           <zipFile>${zipB64}</zipFile>
         </result>
       </checkRetrieveStatusResponse>`,
    );
  }
  const message = (problem: string): string =>
    `<messages><fileName>unpackaged/package.xml</fileName><problem>${problem}</problem></messages>`;

  async function statusFor(messagesXml: string) {
    vi.stubGlobal('fetch', async () => new Response(retrieveStatusResponse(messagesXml)));
    const client = new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v68.0');
    return client.checkRetrieveStatus('09S1', true);
  }

  it('one <messages> element: a single-element list, the text as the org sent it', async () => {
    const status = await statusFor(
      message("Entity of type 'CustomField' named 'Account.No_Such_Field__c' cannot be found"),
    );
    expect(status.messages).toEqual([
      {
        fileName: 'unpackaged/package.xml',
        problem: "Entity of type 'CustomField' named 'Account.No_Such_Field__c' cannot be found",
      },
    ]);
    // A message changes nothing else about the status: it is a note, not a verdict.
    expect(status.success).toBe(true);
    expect(status.status).toBe('Succeeded');
    expect(status.zipFile?.toString()).toBe('PK-fake-zip');
    expect(status.fileProperties).toHaveLength(1);
  });

  it('two <messages> elements keep their order; one with no problem text is dropped', async () => {
    const status = await statusFor(
      message("Entity of type 'CustomField' named 'Account.No_Such_Field__c' cannot be found") +
        '<messages><fileName>unpackaged/package.xml</fileName></messages>' +
        '<messages><problem>Entity of type &apos;CustomLabel&apos; named &apos;No_Such_Label&apos; cannot be found</problem></messages>',
    );
    expect(status.messages).toEqual([
      {
        fileName: 'unpackaged/package.xml',
        problem: "Entity of type 'CustomField' named 'Account.No_Such_Field__c' cannot be found",
      },
      { fileName: '', problem: "Entity of type 'CustomLabel' named 'No_Such_Label' cannot be found" },
    ]);
  });

  it('no <messages> element: an empty list', async () => {
    const status = await statusFor('');
    expect(status.messages).toEqual([]);
    expect(status.success).toBe(true);
    expect(status.fileProperties).toHaveLength(1);
  });
});
