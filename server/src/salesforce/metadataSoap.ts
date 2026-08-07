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
