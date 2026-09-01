import { describe, expect, it } from 'vitest';
import { scanCsv, UTF8_BOM } from '../deploy/csv.js';

/**
 * The validating scanner behind bulk_load_propose. What matters: honest row
 * counts and headers for the approval page (quote-aware — embedded commas and
 * newlines are data), and malformed files failing HERE with a position instead
 * of as a mysterious org-side job failure.
 */

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('what it reads', () => {
  it('counts rows and parses headers on a plain LF file', () => {
    const scan = scanCsv(buf('Name,External_Id__c\nAcme,A-1\nGlobex,A-2\n'));
    expect(scan.headers).toEqual(['Name', 'External_Id__c']);
    expect(scan.rowCount).toBe(2);
    expect(scan.lineEnding).toBe('LF');
    expect(scan.hadBom).toBe(false);
    expect(scan.warnings).toEqual([]);
  });

  it('detects CRLF endings — the Bulk job must declare them', () => {
    const scan = scanCsv(buf('Id\r\n001000000000001AAA\r\n001000000000002AAA\r\n'));
    expect(scan.rowCount).toBe(2);
    expect(scan.lineEnding).toBe('CRLF');
  });

  it('treats quoted commas, newlines, and doubled quotes as data, not structure', () => {
    const scan = scanCsv(
      buf('Name,Description\n"Acme, Inc.","line one\nline two"\n"He said ""hi""",plain\n'),
    );
    expect(scan.headers).toEqual(['Name', 'Description']);
    expect(scan.rowCount).toBe(2);
  });

  it('decodes a quoted header with an embedded comma', () => {
    const scan = scanCsv(buf('"Weird, Header",Name\na,b\n'));
    expect(scan.headers).toEqual(['Weird, Header', 'Name']);
  });

  it('flags a UTF-8 BOM (the freeze strips it — Bulk reads it into the first column name)', () => {
    const scan = scanCsv(Buffer.concat([UTF8_BOM, buf('Id\nx1\n')]));
    expect(scan.hadBom).toBe(true);
    expect(scan.headers).toEqual(['Id']);
    expect(scan.warnings.some((w) => w.includes('BOM'))).toBe(true);
  });

  it('tolerates a missing trailing newline and a trailing blank line', () => {
    expect(scanCsv(buf('Id\nx1')).rowCount).toBe(1);
    expect(scanCsv(buf('Id\r\nx1\r\n\r\n')).rowCount).toBe(1);
  });

  it('warns when a single-column header smells semicolon- or tab-delimited', () => {
    const scan = scanCsv(buf('Name;Amount;Stage\na;1;x\n'));
    expect(scan.headers).toHaveLength(1);
    expect(scan.warnings.some((w) => w.includes('comma-delimited'))).toBe(true);
  });
});

describe('what it refuses', () => {
  const bad = (content: string, re: RegExp): void => {
    expect(() => scanCsv(buf(content))).toThrow(re);
  };

  it('empty file, header-only file, missing header', () => {
    bad('', /empty/);
    bad('   \n', /empty|blank/);
    bad('Name,Amount\n', /zero data rows/);
  });

  it('mixed line endings — a job declares exactly one', () => {
    bad('Id\r\nx1\nx2\r\n', /mixed line endings/i);
  });

  it('unbalanced quotes, with a position to hunt from', () => {
    bad('Name\n"never closed\n', /unbalanced quote/);
  });

  it('a blank line in the middle of the file', () => {
    bad('Id\nx1\n\nx2\n', /blank line at line 3/);
  });

  it('ragged rows — field count must match the header', () => {
    bad('Name,Amount\nAcme,1\nGlobex\n', /row 2 .* has 1 field/);
    bad('Name,Amount\nAcme,1,extra\n', /has 3 field/);
  });

  it('empty and duplicate header columns', () => {
    bad('Name,,Amount\na,b,c\n', /empty column name.*column 2/);
    bad('Name,name\na,b\n', /duplicate column name/);
  });

  it('bare CR delimiters (classic-Mac exports)', () => {
    bad('Id\rx1\r', /bare CR/);
  });
});
