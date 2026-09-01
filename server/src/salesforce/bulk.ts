import type { RestClient } from './rest.js';

/**
 * Bulk API 2.0 ingest driver — the thinnest possible layer over the REST
 * endpoints. Stateless functions; no fs, no db, no config. The lifecycle a
 * caller drives: createIngestJob → uploadIngestBatch (the CSV bytes, verbatim)
 * → closeIngestJob (UploadComplete) → poll getIngestJob to a terminal state →
 * fetchFailedResults / fetchUnprocessedRecords when rows failed.
 *
 * MIRROR UNIT (desktop counterpart: packages/engine/src/salesforce/bulk.ts).
 */

export type IngestOperation = 'insert' | 'upsert' | 'delete';

export type IngestJobState =
  | 'Open'
  | 'UploadComplete'
  | 'InProgress'
  | 'JobComplete'
  | 'Failed'
  | 'Aborted';

export interface IngestJobInfo {
  id: string;
  state: IngestJobState;
  numberRecordsProcessed: number;
  numberRecordsFailed: number;
  errorMessage: string | null;
}

const TERMINAL_STATES: ReadonlySet<IngestJobState> = new Set(['JobComplete', 'Failed', 'Aborted']);

export function isTerminalIngestState(state: IngestJobState): boolean {
  return TERMINAL_STATES.has(state);
}

function jobsBase(apiVersion: string): string {
  return `/services/data/${apiVersion}/jobs/ingest`;
}

export async function createIngestJob(
  rest: RestClient,
  apiVersion: string,
  opts: {
    object: string;
    operation: IngestOperation;
    /** Required for upsert (pass 'Id' to update by id). */
    externalIdFieldName?: string;
    /** Must match the CSV's actual record delimiter or rows misparse org-side. */
    lineEnding: 'LF' | 'CRLF';
  },
): Promise<string> {
  const res = await rest.request(jobsBase(apiVersion), {
    method: 'POST',
    body: JSON.stringify({
      object: opts.object,
      operation: opts.operation,
      ...(opts.externalIdFieldName ? { externalIdFieldName: opts.externalIdFieldName } : {}),
      contentType: 'CSV',
      columnDelimiter: 'COMMA',
      lineEnding: opts.lineEnding,
    }),
  });
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error('Salesforce did not return an ingest job id');
  return body.id;
}

export async function uploadIngestBatch(
  rest: RestClient,
  apiVersion: string,
  jobId: string,
  csv: Buffer,
): Promise<void> {
  // The frozen bytes, verbatim — body must be a Buffer (never a stream: the
  // 401 retry in RestClient.request replays the init).
  await rest.request(`${jobsBase(apiVersion)}/${jobId}/batches`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/csv; charset=UTF-8' },
    body: csv,
  });
}

export async function closeIngestJob(
  rest: RestClient,
  apiVersion: string,
  jobId: string,
): Promise<void> {
  await rest.request(`${jobsBase(apiVersion)}/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'UploadComplete' }),
  });
}

export async function getIngestJob(
  rest: RestClient,
  apiVersion: string,
  jobId: string,
): Promise<IngestJobInfo> {
  const res = await rest.request(`${jobsBase(apiVersion)}/${jobId}`);
  const body = (await res.json()) as {
    id?: string;
    state?: string;
    numberRecordsProcessed?: number;
    numberRecordsFailed?: number;
    errorMessage?: string | null;
  };
  return {
    id: body.id ?? jobId,
    state: (body.state ?? 'InProgress') as IngestJobState,
    numberRecordsProcessed: body.numberRecordsProcessed ?? 0,
    numberRecordsFailed: body.numberRecordsFailed ?? 0,
    errorMessage: body.errorMessage ?? null,
  };
}

/** Best-effort: a job we have given up waiting on should stop consuming the org's limits. */
export async function abortIngestJob(
  rest: RestClient,
  apiVersion: string,
  jobId: string,
): Promise<void> {
  try {
    await rest.request(`${jobsBase(apiVersion)}/${jobId}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'Aborted' }),
    });
  } catch {
    // The abort is a courtesy to the org; the timeout it accompanies is the
    // real outcome and must not be masked by a failed cancel.
  }
}

/** The failed rows as CSV (original columns + sf__Id / sf__Error). */
export async function fetchFailedResults(
  rest: RestClient,
  apiVersion: string,
  jobId: string,
): Promise<string> {
  const res = await rest.request(`${jobsBase(apiVersion)}/${jobId}/failedResults/`, {
    headers: { Accept: 'text/csv' },
  });
  return res.text();
}

/** Rows the job never attempted (e.g. everything after a hard job failure), as CSV. */
export async function fetchUnprocessedRecords(
  rest: RestClient,
  apiVersion: string,
  jobId: string,
): Promise<string> {
  const res = await rest.request(`${jobsBase(apiVersion)}/${jobId}/unprocessedrecords/`, {
    headers: { Accept: 'text/csv' },
  });
  return res.text();
}
