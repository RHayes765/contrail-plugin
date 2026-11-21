import { strFromU8, unzipSync } from 'fflate';
import type { MetadataSoapClient, RetrieveMessage } from './metadataSoap.js';

/**
 * S47: the org's Omnistudio Metadata setting
 * (OmniStudioSettings.enableOmniStudioMetadata), read by one Settings
 * retrieve. Salesforce Help: until that setting is on, the Metadata API
 * can't deploy Omnistudio components, and once on it can't be turned off.
 * Live-probed on one sandbox with the setting off: listMetadata of
 * OmniDataTransform returned 0 and a retrieve by name said "cannot be
 * found" while active Data Mapper records existed. So validate_deploy reads
 * the setting when a package holds a Data Mapper, and refresh_snapshot reads
 * it when a Data Mapper listing comes back empty.
 *
 * Mirror unit: byte-identical in both repos. Imports only fflate and a type
 * from ./metadataSoap.js; the SOAP client is handed in. Never throws: a
 * fault, a failed or field-less retrieve, a timeout and a cancellation are
 * all `unknown` with a reason.
 */

/** A small bound: the read runs beside a validation and must never hold it up long. */
export const OMNISTUDIO_SETTING_TIMEOUT_MS = 30_000;

export interface OmniStudioMetadataSetting {
  state: 'on' | 'off' | 'unknown';
  /** unknown only: why the setting could not be read. */
  reason?: string;
}

/** The SOAP surface of the read. */
export type OmniStudioSettingsSoap = Pick<MetadataSoapClient, 'retrieve' | 'checkRetrieveStatus'>;

export interface OmniStudioSettingOptions {
  /** Bounds the whole read — the retrieve call, every poll and the unzip. */
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}

const SETTINGS_FILE = 'settings/OmniStudio.settings';

const unknown = (reason: string): OmniStudioMetadataSetting => ({ state: 'unknown', reason });

/**
 * Retrieve Settings:OmniStudio, poll it to its end, and read
 * enableOmniStudioMetadata from the returned file. The deadline races the
 * whole read, so a hung SOAP call still answers `unknown` on time; the
 * polling then stops at its next tick and its late result is discarded.
 */
export async function readOmniStudioMetadataSetting(
  soap: OmniStudioSettingsSoap,
  opts: OmniStudioSettingOptions,
): Promise<OmniStudioMetadataSetting> {
  if (opts.signal?.aborted) return unknown('cancelled');
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cut = new Promise<OmniStudioMetadataSetting>((resolve) => {
    timer = setTimeout(
      () => resolve(unknown(`timed out after ${opts.timeoutMs} ms`)),
      opts.timeoutMs,
    );
    timer.unref?.();
    onAbort = () => resolve(unknown('cancelled'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([readSetting(soap, opts.pollIntervalMs, stop.signal), cut]);
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    stop.abort();
  }
}

async function readSetting(
  soap: OmniStudioSettingsSoap,
  pollIntervalMs: number,
  stop: AbortSignal,
): Promise<OmniStudioMetadataSetting> {
  try {
    const id = await soap.retrieve({ Settings: ['OmniStudio'] });
    for (;;) {
      if (stop.aborted) return unknown('cancelled');
      const status = await soap.checkRetrieveStatus(id, true);
      if (status.done) {
        if (!status.success || !status.zipFile) {
          const why = status.errorMessage ?? status.status;
          return unknown(`the settings retrieve failed: ${clip(why)}`);
        }
        return settingFromZip(status.zipFile, status.messages ?? []);
      }
      await delay(pollIntervalMs, stop);
    }
  } catch (err) {
    return unknown(`the settings retrieve failed: ${clip(errorMessage(err))}`);
  }
}

function settingFromZip(zip: Uint8Array, messages: RetrieveMessage[]): OmniStudioMetadataSetting {
  let xml: string | undefined;
  try {
    const entries = unzipSync(zip, { filter: (f) => f.name.endsWith(SETTINGS_FILE) });
    const key = Object.keys(entries).find((k) => k.endsWith(SETTINGS_FILE));
    if (key !== undefined) xml = strFromU8(entries[key]!);
  } catch (err) {
    return unknown(`the settings retrieve's zip could not be read: ${clip(errorMessage(err))}`);
  }
  if (xml === undefined) {
    // The org's own words, when it sent any, say why the file is missing.
    const said = messages.map((m) => m.problem).join('; ');
    return unknown(
      `the settings retrieve returned no OmniStudio settings file${said ? `: ${clip(said)}` : ''}`,
    );
  }
  const m = /<enableOmniStudioMetadata>\s*(true|false)\s*<\/enableOmniStudioMetadata>/.exec(xml);
  if (!m) {
    return unknown(
      "the org's OmniStudioSettings has no enableOmniStudioMetadata field (no Omnistudio licence?)",
    );
  }
  return { state: m[1] === 'true' ? 'on' : 'off' };
}

/**
 * validate_deploy's line for a package that holds an OmniDataTransform: the
 * OFF warning, a neutral note naming the reason when the setting could not
 * be read, nothing when it is on. 'page' rides the approval page's top
 * warnings (above the ADD / NOT IN TARGET rows); 'note' is appended to a
 * failed validation's note, where there are no rows to point at; 'dry'
 * rides a passed dry run's result, whose rows say "add" from the local
 * snapshot (a dry run never re-reads the org). The neutral note's 'page'
 * and 'dry' forms carry the OFF warning's caveat about those rows as a
 * condition — the setting may be off — as the refresh text does.
 */
export function omniStudioValidateText(
  alias: string,
  setting: OmniStudioMetadataSetting,
  where: 'page' | 'note' | 'dry',
): string | null {
  if (setting.state === 'on') return null;
  if (setting.state === 'off') {
    return (
      `OMNISTUDIO METADATA IS OFF in "${alias}" — Salesforce Help says the Metadata API can't ` +
      `deploy Omnistudio components until an admin turns on Omnistudio Metadata (Setup → ` +
      `Omnistudio Settings; it can't be turned off again). Data Mappers that exist there as ` +
      `records are invisible to Contrail` +
      (where === 'page'
        ? ', so ADD / NOT IN TARGET below does not prove none exists.'
        : where === 'dry'
        ? ', so a change of "add" here does not prove none exists.'
        : '.')
    );
  }
  const reason = setting.reason ?? 'no reason given';
  return (
    `Omnistudio Metadata setting not read in "${alias}" (${reason}). Per Salesforce Help, ` +
    `the Metadata API deploys Omnistudio components only where that setting is on.` +
    (where === 'page'
      ? ' If it is off, Data Mappers that exist there as records are invisible to Contrail, ' +
        'so ADD / NOT IN TARGET below does not prove none exists.'
      : where === 'dry'
      ? ' If it is off, Data Mappers that exist there as records are invisible to Contrail, ' +
        'so a change of "add" here does not prove none exists.'
      : '')
  );
}

/**
 * refresh_snapshot's warning when an OmniDataTransform listing came back
 * empty: why, when the setting is off; a neutral note when it could not be
 * read; nothing when it is on (0 then means none).
 */
export function omniStudioRefreshText(setting: OmniStudioMetadataSetting): string | null {
  if (setting.state === 'off') {
    return (
      "OmniDataTransform: 0 listed — the org's Omnistudio Metadata setting is off, so its Data " +
      "Mappers are records the Metadata API can't list or retrieve."
    );
  }
  if (setting.state === 'unknown') {
    return (
      "OmniDataTransform: 0 listed, and the org's Omnistudio Metadata setting could not be read " +
      `(${setting.reason ?? 'no reason given'}); where that setting is off, Data Mappers are ` +
      "records the Metadata API can't list, so 0 may not mean none."
    );
  }
  return null;
}

function clip(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Never throws, so the read never does: a thrown value String() cannot
 * convert (a null-prototype object, a toString that throws) answers a fixed
 * text instead of turning the catch that called this into a rejection.
 */
function errorMessage(err: unknown): string {
  try {
    return String(err instanceof Error ? err.message : err);
  } catch {
    return 'an error with no readable message';
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}
