import { ContrailError } from '../core/errors.js';

/**
 * RFC 4180 validating scanner for bulk-load CSVs.
 *
 * MIRROR UNIT (desktop counterpart: packages/engine/src/deploy/csv.ts).
 *
 * This is deliberately NOT a parser: bulk rows go file → org verbatim and must
 * never be materialized as data structures (or worse, model context). What the
 * approval ritual needs is an honest header list and row count for the page,
 * and enough validation that a malformed file fails HERE — at propose, with a
 * position — instead of as a mysterious org-side job failure. Quote-aware
 * throughout: commas and newlines inside quoted fields are data, not
 * delimiters, so counting rows means walking the quoting state machine.
 */

export interface CsvScan {
  /** Header row, fields decoded (quotes stripped, "" unescaped). */
  headers: string[];
  /** Data rows (records after the header). */
  rowCount: number;
  /** Record delimiter, uniform across the file — Bulk jobs must declare it. */
  lineEnding: 'LF' | 'CRLF';
  /** A UTF-8 BOM was present (the freeze step strips it — Bulk 2.0 would read it into the first header). */
  hadBom: boolean;
  warnings: string[];
}

export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function scanCsv(bytes: Buffer): CsvScan {
  const hadBom = bytes.length >= 3 && bytes.subarray(0, 3).equals(UTF8_BOM);
  const text = (hadBom ? bytes.subarray(3) : bytes).toString('utf8');
  if (text.trim().length === 0) throw new ContrailError('the CSV file is empty', 'bad_csv');

  const warnings: string[] = [];
  const warnOnce = (msg: string): void => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  let headers: string[] | null = null;
  let headerFieldCount = 0;
  let rowCount = 0;
  let lineEnding: 'LF' | 'CRLF' | null = null;

  // One pass. Field text is accumulated only for the header row — data rows
  // just count fields at quote-depth 0 and never keep their content.
  let inQuotes = false;
  let field = '';
  let fieldHasContent = false;
  let fieldsInRecord = 1;
  let recordHasContent = false;
  let recordStartLine = 1;
  let line = 1;
  const headerFields: string[] = [];

  const finishHeader = (): void => {
    headerFields.push(field);
    headers = headerFields.map((h) => h.trim());
    headerFieldCount = headers.length;
    const empty = headers.findIndex((h) => h.length === 0);
    if (empty >= 0) {
      throw new ContrailError(
        `empty column name in the header (column ${empty + 1}) — usually a stray trailing comma`,
        'bad_csv',
      );
    }
    const lower = headers.map((h) => h.toLowerCase());
    const dupe = lower.find((h, i) => lower.indexOf(h) !== i);
    if (dupe !== undefined) {
      throw new ContrailError(`duplicate column name in the header: ${dupe}`, 'bad_csv');
    }
    if (headers.length === 1 && /[;\t]/.test(headers[0]!)) {
      warnOnce(
        'the header parsed as a single column containing ";" or tabs — Bulk API 2.0 loads are ' +
          'comma-delimited; if this file is semicolon- or tab-delimited, re-export it with commas',
      );
    }
  };

  const endRecord = (atEof: boolean): void => {
    if (!recordHasContent && fieldsInRecord === 1) {
      // A truly blank line: tolerated as trailing whitespace at EOF, an error
      // anywhere else (Bulk rejects empty records, better to fail here).
      if (atEof) return;
      throw new ContrailError(
        `blank line at line ${recordStartLine} — remove it (Bulk rejects empty records)`,
        'bad_csv',
      );
    }
    if (headers === null) {
      finishHeader();
    } else {
      rowCount += 1;
      if (fieldsInRecord !== headerFieldCount) {
        throw new ContrailError(
          `row ${rowCount} (line ${recordStartLine}) has ${fieldsInRecord} field(s) but the ` +
            `header has ${headerFieldCount} — Bulk would fail this row; fix the file first`,
          'bad_csv',
        );
      }
    }
    field = '';
    fieldHasContent = false;
    fieldsInRecord = 1;
    recordHasContent = false;
    recordStartLine = line;
  };

  const noteLineEnding = (kind: 'LF' | 'CRLF'): void => {
    if (lineEnding === null) lineEnding = kind;
    else if (lineEnding !== kind) {
      throw new ContrailError(
        `mixed line endings (both LF and CRLF record delimiters, first conflict at line ${line}) — ` +
          'a Bulk job declares ONE line ending; normalize the file',
        'bad_csv',
      );
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          if (headers === null) field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        if (headers === null) field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (!fieldHasContent) {
        // Opening quote at field start (RFC 4180). A quoted field — even an
        // empty "" — makes both the field and the record real.
        inQuotes = true;
        fieldHasContent = true;
        recordHasContent = true;
      } else {
        // A quote mid-field, or text after a closing quote — invalid RFC 4180
        // but seen in hand-edited files. Passed through as data, flagged once.
        warnOnce(`stray double-quote inside a field (first at line ${line}) — check the file's quoting`);
        if (headers === null) field += '"';
      }
      continue;
    }
    if (ch === ',') {
      if (headers === null) {
        headerFields.push(field);
        field = '';
      }
      fieldsInRecord += 1;
      fieldHasContent = false;
      recordHasContent = true;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] !== '\n') {
        throw new ContrailError(
          `bare CR record delimiter at line ${line} — only LF or CRLF endings are supported`,
          'bad_csv',
        );
      }
      noteLineEnding('CRLF');
      line += 1;
      endRecord(i + 2 >= text.length);
      i += 1;
      continue;
    }
    if (ch === '\n') {
      noteLineEnding('LF');
      line += 1;
      endRecord(i + 1 >= text.length);
      continue;
    }
    if (headers === null) field += ch;
    fieldHasContent = true;
    recordHasContent = true;
  }

  if (inQuotes) {
    throw new ContrailError(
      `unbalanced quote — a quoted field opened near line ${recordStartLine} never closes`,
      'bad_csv',
    );
  }
  // Final record when the file has no trailing newline.
  if (recordHasContent || fieldsInRecord > 1) endRecord(false);

  if (headers === null) throw new ContrailError('the CSV file has no header row', 'bad_csv');
  if (rowCount === 0) {
    throw new ContrailError('the CSV has a header but zero data rows — nothing to load', 'bad_csv');
  }
  if (hadBom) {
    warnings.push(
      'a UTF-8 BOM was detected and removed in the frozen copy (Bulk would corrupt the first column name)',
    );
  }

  return {
    headers,
    rowCount,
    // A single final record with no newline at all defaults to LF for the job.
    lineEnding: lineEnding ?? 'LF',
    hadBom,
    warnings,
  };
}
