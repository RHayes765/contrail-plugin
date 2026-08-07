import type { AccessTokenManager } from './tokens.js';
import type { ConnectionRecord } from '../core/types.js';
import { ContrailError } from '../core/errors.js';

/**
 * REST + Tooling API client for one connection. Row-capped query helpers with
 * queryMore pagination; one automatic retry on 401 after invalidating the
 * cached access token.
 */
export class RestClient {
  constructor(
    private readonly tokenMgr: AccessTokenManager,
    private readonly conn: ConnectionRecord,
    private readonly apiVersion: string,
  ) {}

  async query<T = Record<string, unknown>>(soql: string, maxRows = 2000): Promise<T[]> {
    return (await this.runQuery<T>(`/services/data/${this.apiVersion}/query`, soql, maxRows))
      .records;
  }

  /** Like query(), but also returns the org-side total row count (pre-cap). */
  async queryWithCount<T = Record<string, unknown>>(
    soql: string,
    maxRows = 2000,
  ): Promise<{ records: T[]; totalSize: number | null }> {
    return this.runQuery<T>(`/services/data/${this.apiVersion}/query`, soql, maxRows);
  }

  async toolingQuery<T = Record<string, unknown>>(soql: string, maxRows = 2000): Promise<T[]> {
    return (
      await this.runQuery<T>(`/services/data/${this.apiVersion}/tooling/query`, soql, maxRows)
    ).records;
  }

  async describeSObject(name: string): Promise<Record<string, unknown>> {
    const res = await this.request(
      `/services/data/${this.apiVersion}/sobjects/${encodeURIComponent(name)}/describe`,
    );
    return (await res.json()) as Record<string, unknown>;
  }

  async describeGlobal(): Promise<{ sobjects: Array<Record<string, unknown>> }> {
    const res = await this.request(`/services/data/${this.apiVersion}/sobjects`);
    return (await res.json()) as { sobjects: Array<Record<string, unknown>> };
  }

  private async runQuery<T>(
    basePath: string,
    soql: string,
    maxRows: number,
  ): Promise<{ records: T[]; totalSize: number | null }> {
    const records: T[] = [];
    let totalSize: number | null = null;
    let path: string | null = `${basePath}?q=${encodeURIComponent(soql)}`;
    while (path && records.length < maxRows) {
      const res = await this.request(path);
      const data = (await res.json()) as {
        records?: T[];
        totalSize?: number;
        done?: boolean;
        nextRecordsUrl?: string;
      };
      if (totalSize === null && typeof data.totalSize === 'number') totalSize = data.totalSize;
      records.push(...(data.records ?? []));
      path = data.done === false && data.nextRecordsUrl ? data.nextRecordsUrl : null;
    }
    return { records: records.slice(0, maxRows), totalSize };
  }

  /** Authenticated request against the connection's instance; 401 → refresh once and retry. */
  async request(path: string, init?: RequestInit): Promise<Response> {
    let res = await this.rawRequest(path, init);
    if (res.status === 401) {
      this.tokenMgr.invalidate(this.conn.id);
      res = await this.rawRequest(path, init);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new ContrailError(
        `Salesforce API error ${res.status} on ${path.split('?')[0]}: ${truncate(body, 500)}`,
        'salesforce_api_error',
      );
    }
    return res;
  }

  private async rawRequest(path: string, init?: RequestInit): Promise<Response> {
    const accessToken = await this.tokenMgr.getAccessToken(this.conn);
    const url = path.startsWith('http') ? path : new URL(path, this.conn.instanceUrl).toString();
    return fetch(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Salesforce query responses decorate every record with an "attributes" envelope — noise for the model. */
export function stripAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripAttributes(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'attributes') continue;
      out[k] = stripAttributes(v);
    }
    return out;
  }
  return value;
}
