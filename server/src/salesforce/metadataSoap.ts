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

/**
 * S29: folder-based content types → their listMetadata folder-enumeration
 * type. listMetadata for these REQUIRES a per-folder query; a bare
 * {type:'Report'} query returns nothing (silently). The folder types
 * themselves exist only for listMetadata — in package.xml manifests folders
 * address as members of the content type (see FILE_TYPES.manifestType).
 */
export const FOLDERED_TYPES: Record<string, { folderType: string; unfiledFolder?: string }> = {
  // unfiled$public is a system pseudo-folder that folder enumeration does not
  // return; queried explicitly. Dashboards have no unfiled equivalent.
  Report: { folderType: 'ReportFolder', unfiledFolder: 'unfiled$public' },
  Dashboard: { folderType: 'DashboardFolder' },
};

/** Inverse of FOLDERED_TYPES: folder-enumeration type → its content type. */
export const FOLDER_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(FOLDERED_TYPES).map(([content, cfg]) => [cfg.folderType, content]),
);

interface ListQuery {
  type: string;
  folder?: string;
}

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

  /**
   * List metadata inventory. Foldered types (FOLDERED_TYPES) expand
   * transparently: pass 1 lists the flat types plus each foldered type's
   * folder-enumeration type, pass 2 issues one {type, folder} query per
   * discovered folder (plus unfiled$public for reports). The union comes
   * back: folder props typed ReportFolder/DashboardFolder, content props
   * typed Report/Dashboard with folder-qualified 'Folder/Name' fullNames
   * (normalized here if the org returns them bare). Cost for an org with N
   * folders is ceil(N/3) extra round trips — acceptable for
   * explicit-refresh-only types; never silently skipped.
   */
  async listMetadata(types: string[]): Promise<FileProperties[]> {
    return (await this.listAll(types, false)).props;
  }

  /**
   * S30: like listMetadata, but a type the org/API version does not know
   * (INVALID_TYPE — an older API version, or an unlicensed feature like the
   * Agentforce types on a non-Agentforce org) degrades to a per-type report
   * instead of poisoning the whole call. Every other fault still throws.
   * Callers doing multi-type inventory (refresh, staleness, drift) use this
   * so one unsupported type never sinks the healthy ones.
   */
  async listMetadataDetailed(
    types: string[],
  ): Promise<{ props: FileProperties[]; unsupportedTypes: string[] }> {
    return this.listAll(types, true);
  }

  private async listAll(
    types: string[],
    degradeInvalidTypes: boolean,
  ): Promise<{ props: FileProperties[]; unsupportedTypes: string[] }> {
    const flat: ListQuery[] = [];
    const foldered: string[] = [];
    const seen = new Set<string>();
    const wantFlat = (t: string) => {
      if (!seen.has(t)) {
        seen.add(t);
        flat.push({ type: t });
      }
    };
    for (const t of types) {
      if (FOLDERED_TYPES[t]) {
        foldered.push(t);
        wantFlat(FOLDERED_TYPES[t].folderType);
      } else {
        // Includes folder types asked for on their own — they enumerate flat.
        wantFlat(t);
      }
    }

    const unsupported = new Set<string>();
    const all = await this.listQueries(flat, degradeInvalidTypes, unsupported);

    if (foldered.length > 0) {
      const folderQueries: ListQuery[] = [];
      for (const t of foldered) {
        const cfg = FOLDERED_TYPES[t];
        if (!cfg || unsupported.has(cfg.folderType)) continue;
        const folders = all
          .filter((p) => p.type === cfg.folderType)
          .map((p) => p.fullName);
        if (cfg.unfiledFolder && !folders.includes(cfg.unfiledFolder)) {
          folders.push(cfg.unfiledFolder);
        }
        for (const f of folders) folderQueries.push({ type: t, folder: f });
      }
      if (folderQueries.length > 0) {
        log('info', 'listing foldered metadata per folder', { queries: folderQueries.length });
        for (const p of await this.listQueries(folderQueries, degradeInvalidTypes, unsupported)) {
          all.push(p);
        }
      }
    }
    // A foldered content type whose folder-enumeration type was unsupported
    // is itself unsupported (its per-folder pass never ran).
    for (const t of foldered) {
      const cfg = FOLDERED_TYPES[t];
      if (cfg && unsupported.has(cfg.folderType)) unsupported.add(t);
    }
    return { props: all, unsupportedTypes: [...unsupported].filter((t) => types.includes(t)) };
  }

  /** listMetadata accepts at most 3 queries per call; chunk transparently. */
  private async listQueries(
    queries: ListQuery[],
    degradeInvalidTypes: boolean,
    unsupported: Set<string>,
  ): Promise<FileProperties[]> {
    const all: FileProperties[] = [];
    for (let i = 0; i < queries.length; i += 3) {
      const chunk = queries.slice(i, i + 3);
      try {
        all.push(...(await this.listChunk(chunk)));
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (!degradeInvalidTypes || !/INVALID_TYPE/i.test(msg)) throw err;
        // One unknown type faults the whole chunk — retry each query alone so
        // the healthy types' inventory survives, and record the bad ones.
        for (const q of chunk) {
          try {
            all.push(...(await this.listChunk([q])));
          } catch (err2) {
            const msg2 = String(err2 instanceof Error ? err2.message : err2);
            if (!/INVALID_TYPE/i.test(msg2)) throw err2;
            unsupported.add(q.type);
          }
        }
      }
    }
    return all;
  }

  private async listChunk(chunk: ListQuery[]): Promise<FileProperties[]> {
    const queriesXml = chunk
      .map(
        (q) =>
          `<met:queries>${
            // WSDL sequence order: folder BEFORE type.
            q.folder ? `<met:folder>${escapeXml(q.folder)}</met:folder>` : ''
          }<met:type>${escapeXml(q.type)}</met:type></met:queries>`,
      )
      .join('');
    const body = `<met:listMetadata>${queriesXml}<met:asOfVersion>${this.versionNumber}</met:asOfVersion></met:listMetadata>`;
    const parsed = await this.call(body);
    const result = xmlDig(parsed, 'Envelope', 'Body', 'listMetadataResponse', 'result');
    // Defensive normalization: per-folder results are expected to come back
    // folder-qualified already; prefix bare names ONLY when the chunk holds
    // exactly one folder for that type (ambiguous chunks trust the org).
    const foldersByType = new Map<string, Set<string>>();
    for (const q of chunk) {
      if (q.folder) {
        const set = foldersByType.get(q.type) ?? new Set<string>();
        set.add(q.folder);
        foldersByType.set(q.type, set);
      }
    }
    const all: FileProperties[] = [];
    for (const item of asArray(result as Record<string, string> | Record<string, string>[])) {
      if (item && typeof item === 'object' && item.fullName && item.type) {
        const folderSet = foldersByType.get(item.type);
        const folder = folderSet?.size === 1 ? [...folderSet][0] : undefined;
        const fullName =
          folder && !item.fullName.includes('/') ? `${folder}/${item.fullName}` : item.fullName;
        all.push({
          type: item.type,
          fullName,
          fileName: item.fileName ?? '',
          id: item.id ?? '',
          lastModifiedDate: item.lastModifiedDate ?? '',
          lastModifiedByName: item.lastModifiedByName ?? '',
          manageableState: item.manageableState,
          namespacePrefix: item.namespacePrefix,
        });
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
    options: { checkOnly: boolean; testLevel?: TestLevel; runTests: string[] },
  ): Promise<string> {
    const runTestsXml = options.runTests
      .map((t) => `<met:runTests>${escapeXml(t)}</met:runTests>`)
      .join('');
    // DeployOptions elements must follow the WSDL sequence order —
    // checkOnly, rollbackOnError, runTests, singlePackage, testLevel — or
    // Salesforce rejects/misparses the request (runTests before singlePackage).
    //
    // An UNSPECIFIED testLevel is OMITTED, never defaulted: production orgs
    // reject an explicit NoTestRun outright, while an omitted element gets
    // the org's own default behavior — no tests for a package without Apex,
    // RunLocalTests when Apex is present. Sending "NoTestRun" for a no-Apex
    // production deploy was a hard failure the org itself would have waved
    // through with the element absent.
    const body =
      `<met:deploy><met:ZipFile>${zip.toString('base64')}</met:ZipFile>` +
      `<met:DeployOptions>` +
      `<met:checkOnly>${options.checkOnly}</met:checkOnly>` +
      `<met:rollbackOnError>true</met:rollbackOnError>` +
      runTestsXml +
      `<met:singlePackage>true</met:singlePackage>` +
      (options.testLevel
        ? `<met:testLevel>${escapeXml(options.testLevel)}</met:testLevel>`
        : '') +
      `</met:DeployOptions></met:deploy>`;
    const parsed = await this.call(body);
    const id = xmlDig(parsed, 'Envelope', 'Body', 'deployResponse', 'result', 'id');
    if (typeof id !== 'string' || !id) {
      throw new ContrailError('deploy did not return an async operation id', 'soap_protocol');
    }
    return id;
  }

  /**
   * Quick deploy: ask the org to deploy the package it ALREADY validated,
   * identified by the validation's async id. Tests are not re-run — the org
   * reuses the validation's results — and the bytes deployed are, by the
   * org's own guarantee, exactly the validated ones. Only available when the
   * validation ran tests and is recent (~10 days); the org refuses otherwise,
   * and the caller falls back to a full deploy. The result IS the new
   * deploy's async id.
   */
  async deployRecentValidation(validationId: string): Promise<string> {
    const body =
      `<met:deployRecentValidation><met:validationId>${escapeXml(validationId)}` +
      `</met:validationId></met:deployRecentValidation>`;
    const parsed = await this.call(body);
    const id = xmlDig(parsed, 'Envelope', 'Body', 'deployRecentValidationResponse', 'result');
    if (typeof id !== 'string' || !id) {
      throw new ContrailError(
        'deployRecentValidation did not return a deploy id',
        'soap_protocol',
      );
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
