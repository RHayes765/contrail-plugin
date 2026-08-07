import type { AccessTokenManager } from './tokens.js';
import type { ConnectionRecord } from '../core/types.js';
import { ContrailError } from '../core/errors.js';
import { asArray, escapeXml, parseXml, xmlDig } from './xml.js';
import { log } from '../core/log.js';

/**
 * First-party Metadata API client (SOAP). This is the layer generic MCP
 * wrappers don't have: listMetadata for inventory/staleness, retrieve +
 * checkRetrieveStatus for snapshot zips. Deploy operations join in P0.4.
 */

export interface FileProperties {
  type: string;
  fullName: string;
  fileName: string;
  id: string;
  lastModifiedDate: string;
  lastModifiedByName: string;
  manageableState?: string;
  namespacePrefix?: string;
}

export interface RetrieveStatus {
  id: string;
  done: boolean;
  status: string;
  success: boolean;
  errorMessage?: string;
  zipFile?: Buffer;
  fileProperties: FileProperties[];
}

export interface DeployComponentFailure {
  componentType: string;
  fullName: string;
  problemType: string;
  problem: string;
  lineNumber?: string;
}

export interface DeployTestFailure {
  name: string;
  methodName: string;
  message: string;
  stackTrace: string;
}

export interface DeployResult {
  id: string;
  done: boolean;
  status: string;
  success: boolean;
  checkOnly: boolean;
  stateDetail?: string;
  errorMessage?: string;
  numberComponentsTotal: number;
  numberComponentsDeployed: number;
  numberComponentErrors: number;
  numberTestsTotal: number;
  numberTestsCompleted: number;
  numberTestErrors: number;
  componentFailures: DeployComponentFailure[];
  testFailures: DeployTestFailure[];
  codeCoverageWarnings: string[];
}

export type TestLevel = 'NoTestRun' | 'RunLocalTests' | 'RunSpecifiedTests' | 'RunAllTestsInOrg';

export class MetadataSoapClient {
  /** Metadata API version number, e.g. "63.0" (no leading v). */
  private readonly versionNumber: string;

  constructor(
    private readonly tokenMgr: AccessTokenManager,
    private readonly conn: ConnectionRecord,
    apiVersion: string,
  ) {
    this.versionNumber = apiVersion.replace(/^v/, '');
  }

  /** listMetadata accepts at most 3 type queries per call; chunk transparently. */
  async listMetadata(types: string[]): Promise<FileProperties[]> {
    const all: FileProperties[] = [];
    for (let i = 0; i < types.length; i += 3) {
      const chunk = types.slice(i, i + 3);
      const queries = chunk
        .map((t) => `<met:queries><met:type>${escapeXml(t)}</met:type></met:queries>`)
        .join('');
      const body = `<met:listMetadata>${queries}<met:asOfVersion>${this.versionNumber}</met:asOfVersion></met:listMetadata>`;
      const parsed = await this.call(body);
      const result = xmlDig(parsed, 'Envelope', 'Body', 'listMetadataResponse', 'result');
      for (const item of asArray(result as Record<string, string> | Record<string, string>[])) {
        if (item && typeof item === 'object' && item.fullName && item.type) {
          all.push({
            type: item.type,
            fullName: item.fullName,
            fileName: item.fileName ?? '',
            id: item.id ?? '',
            lastModifiedDate: item.lastModifiedDate ?? '',
            lastModifiedByName: item.lastModifiedByName ?? '',
            manageableState: item.manageableState,
            namespacePrefix: item.namespacePrefix,
          });
        }
      }
    }
    return all;
  }

  /** Kick off an unpackaged retrieve; returns the async operation id. */
  async retrieve(members: Record<string, string[]>): Promise<string> {
    const typesXml = Object.entries(members)
      .map(
        ([type, names]) =>
          `<met:types>${names
            .map((n) => `<met:members>${escapeXml(n)}</met:members>`)
            .join('')}<met:name>${escapeXml(type)}</met:name></met:types>`,
      )
      .join('');
    const body =
      `<met:retrieve><met:retrieveRequest>` +
      `<met:apiVersion>${this.versionNumber}</met:apiVersion>` +
      `<met:unpackaged>${typesXml}<met:version>${this.versionNumber}</met:version></met:unpackaged>` +
      `</met:retrieveRequest></met:retrieve>`;
    const parsed = await this.call(body);
    const id = xmlDig(parsed, 'Envelope', 'Body', 'retrieveResponse', 'result', 'id');
    if (typeof id !== 'string' || !id) {
      throw new ContrailError('retrieve did not return an async operation id', 'soap_protocol');
    }
    return id;
  }

  async checkRetrieveStatus(id: string, includeZip: boolean): Promise<RetrieveStatus> {
    const body =
      `<met:checkRetrieveStatus><met:asyncProcessId>${escapeXml(id)}</met:asyncProcessId>` +
      `<met:includeZip>${includeZip}</met:includeZip></met:checkRetrieveStatus>`;
    const parsed = await this.call(body);
    const result = xmlDig(parsed, 'Envelope', 'Body', 'checkRetrieveStatusResponse', 'result') as
      | Record<string, unknown>
      | undefined;
    if (!result) throw new ContrailError('malformed checkRetrieveStatus response', 'soap_protocol');
    const zipB64 = typeof result.zipFile === 'string' ? result.zipFile : undefined;
    return {
      id,
      done: result.done === 'true' || result.done === true,
      status: String(result.status ?? ''),
      success: result.success === 'true' || result.success === true,
      errorMessage:
        typeof result.errorMessage === 'string' && result.errorMessage
          ? result.errorMessage
          : undefined,
      zipFile: zipB64 ? Buffer.from(zipB64, 'base64') : undefined,
      fileProperties: asArray(result.fileProperties as Record<string, string>[]).map((p) => ({
        type: p.type ?? '',
        fullName: p.fullName ?? '',
        fileName: p.fileName ?? '',
        id: p.id ?? '',
        lastModifiedDate: p.lastModifiedDate ?? '',
        lastModifiedByName: p.lastModifiedByName ?? '',
        manageableState: p.manageableState,
        namespacePrefix: p.namespacePrefix,
      })),
    };
  }

  /**
   * Start a deploy of a package zip. checkOnly=true is a validation — nothing
   * is committed; rollbackOnError is always true so partial failures never
   * leave an org half-deployed.
   */
  async deploy(
    zip: Buffer,
    options: { checkOnly: boolean; testLevel: TestLevel; runTests: string[] },
  ): Promise<string> {
    const runTestsXml = options.runTests
      .map((t) => `<met:runTests>${escapeXml(t)}</met:runTests>`)
      .join('');
    // DeployOptions elements must follow the WSDL sequence order —
    // checkOnly, rollbackOnError, runTests, singlePackage, testLevel — or
    // Salesforce rejects/misparses the request (runTests before singlePackage).
    const body =
      `<met:deploy><met:ZipFile>${zip.toString('base64')}</met:ZipFile>` +
      `<met:DeployOptions>` +
      `<met:checkOnly>${options.checkOnly}</met:checkOnly>` +
      `<met:rollbackOnError>true</met:rollbackOnError>` +
      runTestsXml +
      `<met:singlePackage>true</met:singlePackage>` +
      `<met:testLevel>${escapeXml(options.testLevel)}</met:testLevel>` +
      `</met:DeployOptions></met:deploy>`;
    const parsed = await this.call(body);
    const id = xmlDig(parsed, 'Envelope', 'Body', 'deployResponse', 'result', 'id');
    if (typeof id !== 'string' || !id) {
      throw new ContrailError('deploy did not return an async operation id', 'soap_protocol');
    }
    return id;
  }

  /** Best-effort cancel of an in-flight deploy (used on timeout). */
  async cancelDeploy(id: string): Promise<void> {
    try {
      await this.call(
        `<met:cancelDeploy><met:asyncProcessId>${escapeXml(id)}</met:asyncProcessId></met:cancelDeploy>`,
      );
    } catch (err) {
      log('warn', 'cancelDeploy failed', { id, err: String(err) });
    }
  }

  async checkDeployStatus(id: string): Promise<DeployResult> {
    const body =
      `<met:checkDeployStatus><met:asyncProcessId>${escapeXml(id)}</met:asyncProcessId>` +
      `<met:includeDetails>true</met:includeDetails></met:checkDeployStatus>`;
    const parsed = await this.call(body);
    const result = xmlDig(parsed, 'Envelope', 'Body', 'checkDeployStatusResponse', 'result') as
      | Record<string, unknown>
      | undefined;
    if (!result) throw new ContrailError('malformed checkDeployStatus response', 'soap_protocol');

    const details = (result.details ?? {}) as Record<string, unknown>;
    const runTestResult = (details.runTestResult ?? {}) as Record<string, unknown>;
    const bool = (v: unknown) => v === true || v === 'true';
    const num = (v: unknown) => (typeof v === 'string' ? Number(v) || 0 : typeof v === 'number' ? v : 0);

    return {
      id,
      done: bool(result.done),
      status: String(result.status ?? ''),
      success: bool(result.success),
      checkOnly: bool(result.checkOnly),
      stateDetail: typeof result.stateDetail === 'string' ? result.stateDetail : undefined,
      errorMessage: typeof result.errorMessage === 'string' ? result.errorMessage : undefined,
      numberComponentsTotal: num(result.numberComponentsTotal),
      numberComponentsDeployed: num(result.numberComponentsDeployed),
      numberComponentErrors: num(result.numberComponentErrors),
      numberTestsTotal: num(result.numberTestsTotal),
      numberTestsCompleted: num(result.numberTestsCompleted),
      numberTestErrors: num(result.numberTestErrors),
      componentFailures: asArray(details.componentFailures as Record<string, string>[]).map(
        (f) => ({
          componentType: f.componentType ?? '',
          fullName: f.fullName ?? '',
          problemType: f.problemType ?? '',
          problem: f.problem ?? '',
          lineNumber: f.lineNumber,
        }),
      ),
      testFailures: asArray(
        (runTestResult.failures ?? []) as Record<string, string>[],
      ).map((f) => ({
        name: f.name ?? '',
        methodName: f.methodName ?? '',
        message: f.message ?? '',
        stackTrace: f.stackTrace ?? '',
      })),
      codeCoverageWarnings: asArray(
        (runTestResult.codeCoverageWarnings ?? []) as Record<string, string>[],
      )
        .map((w) => w.message ?? '')
        .filter(Boolean),
    };
  }

  /** One SOAP round trip; INVALID_SESSION_ID triggers a single token refresh + retry. */
  private async call(bodyXml: string, isRetry = false): Promise<Record<string, unknown>> {
    const accessToken = await this.tokenMgr.getAccessToken(this.conn);
    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `xmlns:met="http://soap.sforce.com/2006/04/metadata">` +
      `<soapenv:Header><met:SessionHeader><met:sessionId>${escapeXml(
        accessToken,
      )}</met:sessionId></met:SessionHeader></soapenv:Header>` +
      `<soapenv:Body>${bodyXml}</soapenv:Body></soapenv:Envelope>`;

    const url = new URL(`/services/Soap/m/${this.versionNumber}`, this.conn.instanceUrl);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
        body: envelope,
      });
    } catch (err) {
      throw new ContrailError(
        `Could not reach the Metadata API at ${url.host}: ${String(err)}`,
        'salesforce_unreachable',
      );
    }
    const text = await res.text();
    const parsed = parseXml(text);
    const fault = xmlDig(parsed, 'Envelope', 'Body', 'Fault') as
      | { faultcode?: string; faultstring?: string }
      | undefined;
    if (fault) {
      const code = String(fault.faultcode ?? '');
      if (code.includes('INVALID_SESSION_ID') && !isRetry) {
        log('info', 'metadata SOAP session expired; refreshing token and retrying');
        this.tokenMgr.invalidate(this.conn.id);
        return this.call(bodyXml, true);
      }
      throw new ContrailError(
        `Metadata API fault: ${fault.faultstring ?? code ?? 'unknown fault'}`,
        'soap_fault',
      );
    }
    if (!res.ok) {
      throw new ContrailError(`Metadata API HTTP ${res.status}`, 'soap_http_error');
    }
    return parsed;
  }
}
