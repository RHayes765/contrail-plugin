import type { AccessTokenManager } from './tokens.js';
import type { ConnectionRecord } from '../core/types.js';
import { ContrailError } from '../core/errors.js';

/** One ordered operation inside a Composite API call (see RestClient.composite). */
export interface CompositeSubrequest {
  method: 'POST' | 'PATCH' | 'DELETE';
  /** Full path, e.g. /services/data/v63.0/sobjects/Account — may carry "@{ref.id}" tokens. */
  url: string;
  referenceId: string;
  body?: Record<string, unknown>;
}

/** One subrequest's outcome. Insert bodies carry {id, success, errors}; update/delete are null. */
export interface CompositeSubresponse {
  referenceId: string;
  httpStatusCode: number;
  body: unknown;
}

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

  /**
   * The full Composite API: up to 25 ordered subrequests in ONE call, with
   * native "@{referenceId.id}" substitution — a later subrequest can use an
   * earlier insert's created id, resolved org-side. allOrNone=true is genuine
   * cross-step atomicity (any failure rolls back every subrequest);
   * allOrNone=false keeps successes and fails only dependents.
   *
   * NOT the /composite/sobjects collections endpoint: that one is a single
   * operation over many records; this one is many operations in sequence.
   * Success is per-subrequest httpStatusCode — the top-level response is 200
   * even when subrequests failed, so callers must never look for a `success`
   * flag here.
   */
  async composite(
    subrequests: CompositeSubrequest[],
    allOrNone: boolean,
  ): Promise<{ compositeResponse: CompositeSubresponse[] }> {
    const res = await this.request(`/services/data/${this.apiVersion}/composite`, {
      method: 'POST',
      body: JSON.stringify({ allOrNone, compositeRequest: subrequests }),
    });
    return (await res.json()) as { compositeResponse: CompositeSubresponse[] };
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
    // Callers may override Content-Type/Accept (the Bulk API speaks text/csv),
    // but Authorization is pinned last and stays non-overridable. Caller headers
    // must be plain objects (spreading a Headers instance yields nothing), and
    // bodies must be string/Buffer, never streams — the 401 retry in request()
    // replays init verbatim, and a consumed stream would replay empty.
    return fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
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
