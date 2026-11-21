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

  it('warns when a single-column header smells like the OTHER delimiter, per mode', () => {
    const scan = scanCsv(buf('Name;Amount;Stage\na;1;x\n'));
    expect(scan.headers).toHaveLength(1);
    expect(scan.warnings.some((w) => w.includes('NAMED .tsv'))).toBe(true);
    // S40: the inverse — comma content scanned in TAB mode (a mislabeled .tsv)
    // must warn too, and the advice must name the .csv rename, not a re-export.
    const tabScan = scanCsv(buf('Name,Industry\nAcme,Tech\n'), '\t');
    expect(tabScan.headers).toHaveLength(1);
    expect(tabScan.warnings.some((w) => w.includes('NAMED .csv'))).toBe(true);
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

describe('wide headers in linear time (slow-path follow-up)', () => {
  // bulk_load_propose scans the file before any approval, and a header can
  // carry many thousands of columns. The duplicate-name check compared each
  // column with every one before it: 140,000 columns took 15 s, with every
  // tool on the server waiting. It must answer in well under a second and
  // name the same column.
  const cols = Array.from({ length: 140_000 }, (_, i) => `c${i}`);
  const scanTimed = (text: string): [() => unknown, number] => {
    const started = performance.now();
    let outcome: () => unknown;
    try {
      const scan = scanCsv(buf(text));
      outcome = () => scan;
    } catch (err) {
      outcome = () => {
        throw err;
      };
    }
    return [outcome, performance.now() - started];
  };

  it('140,000 distinct columns, then the same header with the first repeated at the end', () => {
    const row = cols.map(() => '').join(',');
    const [distinct, t1] = scanTimed(`${cols.join(',')}\n${row}\n`);
    expect((distinct() as { headers: string[] }).headers).toHaveLength(140_000);
    expect(t1, `distinct: ${Math.round(t1)} ms`).toBeLessThan(1000);

    const [repeated, t2] = scanTimed(`${[...cols, 'C0'].join(',')}\n${row},\n`);
    expect(repeated).toThrow(/duplicate column name in the header: c0$/);
    expect(t2, `repeated: ${Math.round(t2)} ms`).toBeLessThan(1000);
  });

  it('names the first column whose name came earlier, case aside', () => {
    expect(() => scanCsv(buf('A,b,B,a\nw,x,y,z\n'))).toThrow(
      /duplicate column name in the header: b$/,
    );
  });

  it('a stray quote in each of 100,000 rows', () => {
    // An inch mark in every row. The warning names its line, so each row
    // adds a message, and checking the list for each one was quadratic: over
    // two minutes for these 1.1 MB.
    const [scan, took] = scanTimed(`Name,Size\n${'Widget,12"\n'.repeat(100_000)}`);
    const { rowCount, warnings } = scan() as { rowCount: number; warnings: string[] };
    expect(rowCount).toBe(100_000);
    expect(warnings).toHaveLength(100_000);
    expect(warnings[0]).toBe(
      "stray double-quote inside a field (first at line 2) — check the file's quoting",
    );
    expect(took, `${Math.round(took)} ms`).toBeLessThan(1000);
  });

  it('one 20,000,000-character header field', () => {
    // Built a character at a time, this header held a string piece per
    // character: about 1.8 s and 680 MB of heap, and gigabytes at the
    // 100 MB file cap. The heap check only catches that if no collection
    // runs in between, so the time is the main guard.
    const heapBefore = process.memoryUsage().heapUsed;
    const [scan, took] = scanTimed(`${'h'.repeat(20_000_000)}\nv\n`);
    const grew = process.memoryUsage().heapUsed - heapBefore;
    const { headers } = scan() as { headers: string[] };
    expect(headers).toHaveLength(1);
    expect(headers[0]).toHaveLength(20_000_000);
    expect(took, `${Math.round(took)} ms`).toBeLessThan(1000);
    expect(grew, `${Math.round(grew / 1e6)} MB`).toBeLessThan(300_000_000);
  });

  it('header fields keep their quoting rules, read in slices', () => {
    // Opening and closing quotes dropped, "" read as one quote, a stray
    // quote and text after a closing quote kept, a delimiter or line end
    // inside quotes kept as data.
    const scan = scanCsv(
      buf('"a""b",c"d,"e,f"g,"h\r\ni",j\r\n1,2,3,4,5\r\n'),
    );
    expect(scan.headers).toEqual(['a"b', 'c"d', 'e,fg', 'h\r\ni', 'j']);
    expect(scan.lineEnding).toBe('CRLF');
    expect(scanCsv(buf('x,"y"\n1,2')).headers).toEqual(['x', 'y']);
  });
});
