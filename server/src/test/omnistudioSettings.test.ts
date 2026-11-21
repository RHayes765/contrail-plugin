import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { RetrieveMessage, RetrieveStatus } from '../salesforce/metadataSoap.js';
import {
  omniStudioRefreshText,
  omniStudioValidateText,
  readOmniStudioMetadataSetting,
  type OmniStudioSettingsSoap,
} from '../salesforce/omnistudioSettings.js';

/**
 * S47: the Omnistudio Metadata setting read — one Settings:OmniStudio
 * retrieve, polled with includeZip, the field read from the returned file;
 * on / off / field absent / file absent / retrieve failure / timeout /
 * cancellation, every one of them an answer and never a throw — and the
 * validate and refresh texts built from it.
 */

const MD = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const settingsXml = (field: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<OmniStudioSettings ${MD}>\n` +
  `    <enableOmniCleanMetadataPref>false</enableOmniCleanMetadataPref>\n${field}` +
  '</OmniStudioSettings>\n';
const FIELD_ON = '    <enableOmniStudioMetadata>true</enableOmniStudioMetadata>\n';
const FIELD_OFF = '    <enableOmniStudioMetadata>false</enableOmniStudioMetadata>\n';

function zipOf(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = { 'unpackaged/package.xml': strToU8('<Package/>') };
  for (const [rel, body] of Object.entries(files)) entries[`unpackaged/${rel}`] = strToU8(body);
  return Buffer.from(zipSync(entries));
}

function status(over: Partial<RetrieveStatus>): RetrieveStatus {
  return {
    id: '09S-settings',
    done: true,
    status: 'Succeeded',
    success: true,
    fileProperties: [],
    messages: [],
    ...over,
  };
}

interface Stub {
  soap: OmniStudioSettingsSoap;
  manifests: Array<Record<string, string[]>>;
  polls: Array<{ id: string; includeZip: boolean }>;
}

/** A SOAP pick that answers `pending` unfinished polls, then `last` (or throws). */
function stub(opts: {
  last?: RetrieveStatus;
  pending?: number;
  retrieve?: () => Promise<string>;
  checkThrows?: unknown;
}): Stub {
  const manifests: Array<Record<string, string[]>> = [];
  const polls: Array<{ id: string; includeZip: boolean }> = [];
  const soap: OmniStudioSettingsSoap = {
    retrieve: async (members) => {
      manifests.push(members);
      return opts.retrieve ? opts.retrieve() : '09S-settings';
    },
    checkRetrieveStatus: async (id, includeZip) => {
      polls.push({ id, includeZip });
      if (opts.checkThrows !== undefined) throw opts.checkThrows;
      if (polls.length <= (opts.pending ?? 0) || !opts.last) {
        return status({ done: false, status: 'InProgress', success: false });
      }
      return opts.last;
    },
  };
  return { soap, manifests, polls };
}

const OPTS = { timeoutMs: 2_000, pollIntervalMs: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('S47: readOmniStudioMetadataSetting', () => {
  it('on: retrieves Settings:OmniStudio, polls with includeZip to the end, reads true', async () => {
    const s = stub({
      pending: 2,
      last: status({ zipFile: zipOf({ 'settings/OmniStudio.settings': settingsXml(FIELD_ON) }) }),
    });
    expect(await readOmniStudioMetadataSetting(s.soap, OPTS)).toEqual({ state: 'on' });
    expect(s.manifests).toEqual([{ Settings: ['OmniStudio'] }]);
    expect(s.polls).toHaveLength(3);
    expect(s.polls.every((p) => p.id === '09S-settings' && p.includeZip)).toBe(true);
  });

  it('off: reads false — no reason, nothing else in the zip consulted', async () => {
    // The decoy is zipped FIRST and says true: a matcher that took any
    // .settings file (the first one found) would answer 'on'.
    const s = stub({
      last: status({
        zipFile: zipOf({
          'settings/Other.settings': settingsXml(FIELD_ON),
          'settings/OmniStudio.settings': settingsXml(FIELD_OFF),
        }),
      }),
    });
    expect(await readOmniStudioMetadataSetting(s.soap, OPTS)).toEqual({ state: 'off' });
  });

  it('field absent: unknown, and the reason says so', async () => {
    const s = stub({
      last: status({ zipFile: zipOf({ 'settings/OmniStudio.settings': settingsXml('') }) }),
    });
    expect(await readOmniStudioMetadataSetting(s.soap, OPTS)).toEqual({
      state: 'unknown',
      reason:
        "the org's OmniStudioSettings has no enableOmniStudioMetadata field (no Omnistudio licence?)",
    });
  });

  it('settings file absent: unknown, carrying what the org said about it', async () => {
    const messages: RetrieveMessage[] = [
      {
        fileName: 'unpackaged/package.xml',
        problem: "Entity of type 'Settings' named 'OmniStudio' cannot be found",
      },
    ];
    const s = stub({ last: status({ zipFile: zipOf({}), messages }) });
    expect(await readOmniStudioMetadataSetting(s.soap, OPTS)).toEqual({
      state: 'unknown',
      reason:
        'the settings retrieve returned no OmniStudio settings file: ' +
        "Entity of type 'Settings' named 'OmniStudio' cannot be found",
    });
    const bare = stub({ last: status({ zipFile: zipOf({}) }) });
    expect(await readOmniStudioMetadataSetting(bare.soap, OPTS)).toEqual({
      state: 'unknown',
      reason: 'the settings retrieve returned no OmniStudio settings file',
    });
  });

  it('retrieve error: a fault, a failed retrieve and a zip-less success are each unknown with the reason', async () => {
    const fault = stub({
      retrieve: async () => {
        throw new Error('INVALID_SESSION_ID: session expired');
      },
    });
    expect(await readOmniStudioMetadataSetting(fault.soap, OPTS)).toEqual({
      state: 'unknown',
      reason: 'the settings retrieve failed: INVALID_SESSION_ID: session expired',
    });
    expect(fault.polls).toHaveLength(0);

    const failed = stub({
      last: status({ status: 'Failed', success: false, errorMessage: 'boom' }),
    });
    expect(await readOmniStudioMetadataSetting(failed.soap, OPTS)).toEqual({
      state: 'unknown',
      reason: 'the settings retrieve failed: boom',
    });

    const noZip = stub({ last: status({}) });
    expect(await readOmniStudioMetadataSetting(noZip.soap, OPTS)).toEqual({
      state: 'unknown',
      reason: 'the settings retrieve failed: Succeeded',
    });
  });

  it('timeout: a retrieve that never finishes answers unknown on time and stops polling', async () => {
    const s = stub({});
    const t0 = Date.now();
    const result = await readOmniStudioMetadataSetting(s.soap, { timeoutMs: 40, pollIntervalMs: 2 });
    expect(result).toEqual({ state: 'unknown', reason: 'timed out after 40 ms' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    const polled = s.polls.length;
    expect(polled).toBeGreaterThan(0);
    await sleep(30);
    expect(s.polls.length).toBeLessThanOrEqual(polled + 1);
  });

  it('timeout: a SOAP call that hangs still answers unknown on time', async () => {
    const s = stub({ retrieve: () => new Promise<string>(() => {}) });
    const t0 = Date.now();
    const result = await readOmniStudioMetadataSetting(s.soap, { timeoutMs: 40, pollIntervalMs: 2 });
    expect(result).toEqual({ state: 'unknown', reason: 'timed out after 40 ms' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(s.polls).toHaveLength(0);
  });

  it('cancellation: an aborted signal reads nothing; an abort mid-poll answers at once', async () => {
    const before = new AbortController();
    before.abort();
    const idle = stub({});
    expect(
      await readOmniStudioMetadataSetting(idle.soap, { ...OPTS, signal: before.signal }),
    ).toEqual({ state: 'unknown', reason: 'cancelled' });
    expect(idle.manifests).toHaveLength(0);

    const mid = new AbortController();
    const s = stub({});
    const pending = readOmniStudioMetadataSetting(s.soap, {
      timeoutMs: 5_000,
      pollIntervalMs: 2,
      signal: mid.signal,
    });
    await sleep(15);
    mid.abort();
    const t0 = Date.now();
    expect(await pending).toEqual({ state: 'unknown', reason: 'cancelled' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('never throws: a non-Error fault, a throwing poll, an unreadable zip and an unprintable thrown value are all unknown', async () => {
    const odd = stub({
      retrieve: async () => {
        throw 'socket hang up';
      },
    });
    await expect(readOmniStudioMetadataSetting(odd.soap, OPTS)).resolves.toEqual({
      state: 'unknown',
      reason: 'the settings retrieve failed: socket hang up',
    });

    const poll = stub({ checkThrows: new Error('malformed checkRetrieveStatus response') });
    await expect(readOmniStudioMetadataSetting(poll.soap, OPTS)).resolves.toEqual({
      state: 'unknown',
      reason: 'the settings retrieve failed: malformed checkRetrieveStatus response',
    });

    const corrupt = stub({ last: status({ zipFile: Buffer.from('not a zip at all') }) });
    const read = await readOmniStudioMetadataSetting(corrupt.soap, OPTS);
    expect(read.state).toBe('unknown');
    expect(read.reason).toMatch(/^the settings retrieve's zip could not be read: /);

    // Thrown values String() cannot convert: still an answer, never a rejection.
    const unprintable: unknown[] = [
      Object.create(null),
      {
        toString() {
          throw new Error('no words');
        },
      },
      Object.assign(new Error('placeholder'), { message: Object.create(null) }),
    ];
    for (const thrown of unprintable) {
      const s = stub({
        retrieve: async () => {
          throw thrown;
        },
      });
      await expect(readOmniStudioMetadataSetting(s.soap, OPTS)).resolves.toEqual({
        state: 'unknown',
        reason: 'the settings retrieve failed: an error with no readable message',
      });
    }
    const unprintablePoll = stub({ checkThrows: Object.create(null) });
    await expect(readOmniStudioMetadataSetting(unprintablePoll.soap, OPTS)).resolves.toEqual({
      state: 'unknown',
      reason: 'the settings retrieve failed: an error with no readable message',
    });
  });
});

describe('S47: the Omnistudio Metadata texts', () => {
  it('validate: OFF names the org, the setting, its one-way nature and the blind spot; on says nothing', () => {
    const page = omniStudioValidateText('uat-sandbox', { state: 'off' }, 'page');
    expect(page).toBe(
      'OMNISTUDIO METADATA IS OFF in "uat-sandbox" — Salesforce Help says the Metadata API ' +
        "can't deploy Omnistudio components until an admin turns on Omnistudio Metadata " +
        "(Setup → Omnistudio Settings; it can't be turned off again). Data Mappers that exist " +
        'there as records are invisible to Contrail, so ADD / NOT IN TARGET below does not ' +
        'prove none exists.',
    );
    // A failed validation has no rows to point at.
    const note = omniStudioValidateText('uat-sandbox', { state: 'off' }, 'note')!;
    expect(note.startsWith('OMNISTUDIO METADATA IS OFF in "uat-sandbox"')).toBe(true);
    expect(note.endsWith('records are invisible to Contrail.')).toBe(true);
    expect(note).not.toContain('below');
    // A passed dry run's rows say "add" from the snapshot, never the org.
    const dry = omniStudioValidateText('uat-sandbox', { state: 'off' }, 'dry')!;
    expect(dry.startsWith('OMNISTUDIO METADATA IS OFF in "uat-sandbox"')).toBe(true);
    const dryTail =
      'records are invisible to Contrail, so a change of "add" here does not prove none exists.';
    expect(dry.endsWith(dryTail)).toBe(true);
    expect(dry).not.toContain('below');
    expect(omniStudioValidateText('uat-sandbox', { state: 'on' }, 'page')).toBeNull();
    expect(omniStudioValidateText('uat-sandbox', { state: 'on' }, 'note')).toBeNull();
    expect(omniStudioValidateText('uat-sandbox', { state: 'on' }, 'dry')).toBeNull();
  });

  it('validate: unknown is a neutral note naming the reason, with the rows caveat as a condition', () => {
    const unread = { state: 'unknown', reason: 'timed out after 30000 ms' } as const;
    const lead =
      'Omnistudio Metadata setting not read in "uat-sandbox" (timed out after 30000 ms). Per ' +
      'Salesforce Help, the Metadata API deploys Omnistudio components only where that ' +
      'setting is on.';
    // Above the page's rows: they may be blind to what the org holds.
    const page = omniStudioValidateText('uat-sandbox', unread, 'page');
    expect(page).toBe(
      `${lead} If it is off, Data Mappers that exist there as records are invisible to ` +
        'Contrail, so ADD / NOT IN TARGET below does not prove none exists.',
    );
    // A passed dry run's rows say "add" — the same caveat, its own words.
    const dry = omniStudioValidateText('uat-sandbox', unread, 'dry');
    expect(dry).toBe(
      `${lead} If it is off, Data Mappers that exist there as records are invisible to ` +
        'Contrail, so a change of "add" here does not prove none exists.',
    );
    // A failed validation's note has no rows to point at.
    expect(omniStudioValidateText('uat-sandbox', unread, 'note')).toBe(lead);
    // Neutral: no shouted heading, and never the OFF warning.
    for (const text of [page, dry]) {
      expect(text).not.toMatch(/[A-Z]{4,} [A-Z]{4,}/);
      expect(text).not.toContain('IS OFF');
    }
    const bare = omniStudioValidateText('uat-sandbox', { state: 'unknown' }, 'note');
    expect(bare).toBe(lead.replace('timed out after 30000 ms', 'no reason given'));
  });

  it('refresh: off explains the empty listing, unknown is neutral, on says nothing', () => {
    expect(omniStudioRefreshText({ state: 'off' })).toBe(
      "OmniDataTransform: 0 listed — the org's Omnistudio Metadata setting is off, so its " +
        "Data Mappers are records the Metadata API can't list or retrieve.",
    );
    expect(omniStudioRefreshText({ state: 'unknown', reason: 'cancelled' })).toBe(
      "OmniDataTransform: 0 listed, and the org's Omnistudio Metadata setting could not be " +
        'read (cancelled); where that setting is off, Data Mappers are records the Metadata ' +
        "API can't list, so 0 may not mean none.",
    );
    expect(omniStudioRefreshText({ state: 'on' })).toBeNull();
  });
});
